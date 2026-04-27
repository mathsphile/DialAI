'use strict';

const WebSocket = require('ws');
const { logger, runWithCallContext } = require('../utils/logger');
const {
  base64MulawToBase64PCM16k,
  base64PCMToBase64Mulaw,
  isSpeech,
  normaliseVolume,
} = require('../utils/audioConverter');
const { createSession }  = require('./elevenLabsAgentService');
const { callHandler }    = require('./callHandler');
const cache              = require('../utils/cache');

const log = logger.forModule('audioStreamBridge');

const AUDIO_FLUSH_INTERVAL_MS = 200;
const MAX_WS_PER_IP           = 5;
const MAX_CONCURRENT_CALLS    = 50;
const SPEECH_DETECTION_THRESHOLD = 250;
const EXOTEL_FRAME_MS = 100;

const ipConnections = new Map();

function incrementIpCount(ip) {
  const count = (ipConnections.get(ip) || 0) + 1;
  ipConnections.set(ip, count);
  return count;
}

function decrementIpCount(ip) {
  const count = Math.max(0, (ipConnections.get(ip) || 0) - 1);
  if (count === 0) ipConnections.delete(ip);
  else ipConnections.set(ip, count);
}

class BridgeSession {
  constructor(twilioWs, clientIp, provider = 'exotel', mediaSampleRate = 8000) {
    this.twilioWs   = twilioWs;
    this.clientIp   = clientIp;
    this.provider   = provider;
    this.mediaSampleRate = mediaSampleRate;
    this.streamSid  = null;
    this.callSid    = null;
    this.callerNum  = null;
    this.elSession  = null;
    this.isStarted     = false;
    this.isStopped     = false;
    this.isELConnected = false;
    this.language   = process.env.DEFAULT_LANGUAGE || 'hi';
    this._audioAccumulator  = [];
    this._accumulatorBytes  = 0;
    this._flushTimer        = null;
    this._outboundQueue     = [];
    this._outboundTimer     = null;
    this._inboundFrames     = 0;
    this._speechFrames      = 0;
    this._agentSpeaking     = false;
    this._log = logger.forModule('BridgeSession');
    this._outboundSequence = 1;
    this._outboundChunk = 1;
    this._outboundTimestampMs = 0;
    this._lastInboundSequence = 0;
  }

  async onTwilioStart(startPayload) {
    const customParameters = startPayload.customParameters || startPayload.custom_parameters || {};
    this.streamSid  = startPayload.streamSid || startPayload.stream_sid;
    this.callSid    = startPayload.callSid || startPayload.call_sid;
    this.callerNum  = customParameters.callerNumber || customParameters.caller_number || startPayload.from || null;
    this.provider   = 'exotel';
    this.mediaSampleRate = 8000;
    this.isStarted  = true;

    this._log.info('Media stream started', { callSid: this.callSid, provider: this.provider });
    await runWithCallContext({ callSid: this.callSid }, () => this._connectElevenLabs());
  }

  onTwilioMedia(mediaPayload) {
    if (this.isStopped || !this.isStarted) return;
    const base64Audio = mediaPayload.payload;
    if (base64Audio) this._accumulateAudio(base64Audio);
  }

  onTwilioStop() {
    this.destroy('telephony-stop');
  }

  noteInboundSequence(seq) {
    const parsed = parseInt(seq, 10);
    if (parsed > this._lastInboundSequence) this._lastInboundSequence = parsed;
  }

  destroy(reason = 'unknown') {
    if (this.isStopped) return;
    this.isStopped = true;
    clearTimeout(this._flushTimer);
    clearInterval(this._outboundTimer);
    if (this.elSession) this.elSession.close();
    if (this.twilioWs) this.twilioWs.close();
    if (this.clientIp) decrementIpCount(this.clientIp);
    this._log.info('Bridge session destroyed', { callSid: this.callSid, reason });
  }

  async _connectElevenLabs() {
    try {
      this.elSession = await createSession({ callSid: this.callSid, callerNumber: this.callerNum, language: this.language });
      this.isELConnected = true;
      this.elSession.on('audio', (base64PCM, _id, sampleRate) => this._onElevenLabsAudio(base64PCM, sampleRate));
      this.elSession.on('close', () => this.destroy('elevenlabs-closed'));
      this._startOutboundDrain();
    } catch (err) {
      this._log.error('Failed to connect ElevenLabs', { err: err.message });
      this.destroy('elevenlabs-failed');
    }
  }

  _accumulateAudio(base64Audio) {
    const pcmBuf = base64MulawToBase64PCM16k(base64Audio);
    if (!pcmBuf) return;
    const normalised = normaliseVolume(pcmBuf, 3500);
    this._audioAccumulator.push(normalised);
    this._accumulatorBytes += normalised.length;
    if (this._accumulatorBytes >= 6400) this._flushAudioToElevenLabs();
    else if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flushAudioToElevenLabs(), AUDIO_FLUSH_INTERVAL_MS);
  }

  _flushAudioToElevenLabs() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (this._audioAccumulator.length === 0 || !this.isELConnected) return;
    const combined = Buffer.concat(this._audioAccumulator);
    this.elSession.sendAudio(combined.toString('base64'));
    this._audioAccumulator = [];
    this._accumulatorBytes = 0;
  }

  _onElevenLabsAudio(base64PCM, sampleRate) {
    const outbound = base64PCMToBase64Mulaw(base64PCM, sampleRate);
    if (outbound) this._outboundQueue.push(outbound);
  }

  _startOutboundDrain() {
    this._outboundTimer = setInterval(() => {
      const payload = this._outboundQueue.shift();
      if (payload && this.twilioWs.readyState === WebSocket.OPEN) {
        this.twilioWs.send(JSON.stringify({
          event: 'media',
          stream_sid: this.streamSid,
          media: { payload, chunk: String(this._outboundChunk++), timestamp: String(this._outboundTimestampMs) }
        }));
        this._outboundTimestampMs += EXOTEL_FRAME_MS;
      }
    }, 20);
  }
}

function createBridge(httpServer, { path = '/media-stream' } = {}) {
  const wss = new WebSocket.Server({ server: httpServer, path });
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    if (incrementIpCount(clientIp) > MAX_WS_PER_IP) {
       decrementIpCount(clientIp);
       return ws.close();
    }
    const session = new BridgeSession(ws, clientIp);
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') await session.onTwilioStart(msg.start);
      else if (msg.event === 'media') session.onTwilioMedia(msg.media);
      else if (msg.event === 'stop') session.onTwilioStop();
    });
    ws.on('close', () => session.destroy('ws-closed'));
  });
  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({}), BridgeSession };
