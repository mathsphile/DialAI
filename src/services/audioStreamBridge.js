'use strict';

const WebSocket = require('ws');
const { logger, runWithCallContext } = require('../utils/logger');
const {
  mulawToLinear16,
  base64PCMToBase64Mulaw,
  normaliseVolume,
} = require('../utils/audioConverter');
const { createSession }  = require('./elevenLabsAgentService');
const { callHandler }    = require('./callHandler');

const log = logger.forModule('audioStreamBridge');

const AUDIO_FLUSH_INTERVAL_MS = 200;
const MAX_WS_PER_IP           = 10;
const MAX_CONCURRENT_CALLS    = 50;
const EXOTEL_FRAME_MS         = 100;

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
  constructor(twilioWs, clientIp) {
    this.twilioWs   = twilioWs;
    this.clientIp   = clientIp;
    this.streamSid  = null;
    this.callSid    = null;
    this.elSession  = null;
    this.isStarted     = false;
    this.isStopped     = false;
    this.isELConnected = false;
    this._audioAccumulator  = [];
    this._accumulatorBytes  = 0;
    this._flushTimer        = null;
    this._outboundQueue     = [];
    this._outboundTimer     = null;
    this._log = logger.forModule('BridgeSession');
    this._outboundChunk = 1;
    this._outboundTimestampMs = 0;
  }

  async onStart(startPayload) {
    this.streamSid  = startPayload.streamSid || startPayload.stream_sid;
    this.callSid    = startPayload.callSid || startPayload.call_sid;
    this.isStarted  = true;
    this._log.info('Media stream started', { callSid: this.callSid });
    await runWithCallContext({ callSid: this.callSid }, () => this._connectElevenLabs());
  }

  onMedia(mediaPayload) {
    if (this.isStopped || !this.isStarted || !mediaPayload.payload) return;
    
    // Decode base64 mulaw to Buffer
    const mulawBuf = Buffer.from(mediaPayload.payload, 'base64');
    // Convert to PCM16 Buffer
    const pcmBuf = mulawToLinear16(mulawBuf);
    
    const normalised = normaliseVolume(pcmBuf, 3500);
    this._audioAccumulator.push(normalised);
    this._accumulatorBytes += normalised.length;
    
    if (this._accumulatorBytes >= 6400) {
      this._flush();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush(), AUDIO_FLUSH_INTERVAL_MS);
    }
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._audioAccumulator.length === 0 || !this.isELConnected) return;
    
    const combined = Buffer.concat(this._audioAccumulator);
    this.elSession.sendAudio(combined.toString('base64'));
    this._audioAccumulator = [];
    this._accumulatorBytes = 0;
  }

  async _connectElevenLabs() {
    try {
      this.elSession = await createSession({ callSid: this.callSid });
      this.isELConnected = true;
      this.elSession.on('audio', (base64PCM, _id, sampleRate) => {
        const outbound = base64PCMToBase64Mulaw(base64PCM, sampleRate);
        if (outbound) this._outboundQueue.push(outbound);
      });
      this.elSession.on('close', () => this.destroy('elevenlabs-closed'));
      this._startOutboundDrain();
    } catch (err) {
      this._log.error('ElevenLabs connection failed', { err: err.message });
      this.destroy('elevenlabs-failed');
    }
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

  destroy(reason = 'unknown') {
    if (this.isStopped) return;
    this.isStopped = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    if (this._outboundTimer) clearInterval(this._outboundTimer);
    if (this.elSession) this.elSession.close();
    if (this.twilioWs) this.twilioWs.close();
    decrementIpCount(this.clientIp);
    this._log.info('Bridge session destroyed', { callSid: this.callSid, reason });
  }
}

function createBridge(httpServer, { path = '/media-stream' } = {}) {
  const wss = new WebSocket.Server({ server: httpServer, path });
  wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (incrementIpCount(clientIp) > MAX_WS_PER_IP) {
       decrementIpCount(clientIp);
       return ws.close(1008, 'Rate limit exceeded');
    }
    const session = new BridgeSession(ws, clientIp);
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'start') await session.onStart(msg.start);
        else if (msg.event === 'media') session.onMedia(msg.media);
        else if (msg.event === 'stop') session.destroy('telephony-stop');
      } catch (e) { log.error('WS Message Error', { err: e.message }); }
    });
    ws.on('close', () => session.destroy('ws-closed'));
    ws.on('error', (e) => session.destroy('ws-error: ' + e.message));
  });
  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({ active: ipConnections.size }), BridgeSession };
