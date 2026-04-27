'use strict';

/**
 * audioStreamBridge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The central nerve of DialAI Bharat.
 *
 * This module creates a WebSocket server that Twilio's Media Streams protocol
 * connects to, and for each incoming call it:
 *
 *   1. Receives raw μ-law 8 kHz audio frames from Twilio
 *   2. Converts them to PCM 16 kHz and forwards to ElevenLabs Conversational AI
 *   3. Receives PCM audio responses from ElevenLabs
 *   4. Converts them back to μ-law 8 kHz and sends to Twilio (caller hears AI)
 *   5. Handles interruptions, poor-audio retries, and graceful shutdown
 *
 * Architecture
 * ────────────
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │                         BridgeSession                               │
 *   │                                                                     │
 *   │  Twilio WS          audioStreamBridge           ElevenLabs WS      │
 *   │  (inbound)   ──────────────────────────────►   (ElevenLabsSession) │
 *   │              μ-law→PCM16k                                           │
 *   │              ◄──────────────────────────────   PCM16k→μ-law        │
 *   │  (outbound)                                                         │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Twilio Media Streams protocol (WebSocket messages)
 * ──────────────────────────────────────────────────
 *   Twilio → Server
 *     { event: 'start',  start:  { streamSid, callSid, mediaFormat, … } }
 *     { event: 'media',  media:  { track, chunk, timestamp, payload } }
 *     { event: 'stop',   stop:   { streamSid, … } }
 *     { event: 'mark',   mark:   { name } }
 *
 *   Server → Twilio
 *     { event: 'media',  streamSid, media: { payload: base64mulaw } }
 *     { event: 'clear',  streamSid }
 *     { event: 'mark',   streamSid, mark: { name } }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const WebSocket = require('ws');

const { logger, runWithCallContext } = require('../utils/logger');
const {
  base64MulawToBase64PCM16k,
  base64PCMToBase64Mulaw,
  base64PCM8kToBase64PCM16k,
  base64PCM16kToBase64PCM8k,
  base64PCM24kToBase64PCM16k,
  isSpeech,
  normaliseVolume,
  mulawToLinear16,
  linear8kToLinear16,
  generateMulawSilence,
} = require('../utils/audioConverter');
const { createSession }  = require('./elevenLabsAgentService');
const { callHandler }    = require('./callHandler');
const { detectLanguage } = require('./languageDetector');
const cache              = require('../utils/cache');

const log = logger.forModule('audioStreamBridge');

// ─── Configuration ────────────────────────────────────────────────────────────

// OPTIMIZED: Larger flush interval + bigger batches = fewer token charges
const AUDIO_FLUSH_INTERVAL_MS = parseInt(process.env.AUDIO_FLUSH_INTERVAL_MS || '200', 10);
const MAX_WS_PER_IP           = parseInt(process.env.MAX_WS_PER_IP           || '5',   10);
const MAX_CONCURRENT_CALLS    = parseInt(process.env.MAX_CONCURRENT_CALLS    || '50',  10);

// OPTIMIZED: More aggressive silence detection (lower threshold = trim more silence)
// After 5 consecutive silent frames (~100ms), stop forwarding to ElevenLabs
// This prevents wasting tokens on background noise / PSTN comfort noise
const SILENCE_FRAME_THRESHOLD = 5;   // ~100 ms of silence at 20 ms/frame (was 8)

// OPTIMIZED: Speech threshold - detect speech more aggressively to avoid sending noise
const SPEECH_DETECTION_THRESHOLD = 500;  // raised from 300 to avoid noise tokens (new)

// If the caller says nothing for 8 seconds after the agent stops, gently prompt
const INACTIVITY_TIMEOUT_MS = 8000;

// Max retries when we cannot understand the user (poor audio / silence)
const MAX_AUDIO_RETRIES = 3;

// OPTIMIZED: Reduced comfort noise - saves tokens on silence periods
const COMFORT_NOISE_INTERVAL_MS = 80;   // 80 ms (was 40 ms) - half frequency saves 50% tokens
const EXOTEL_FRAME_MS = 100;

// OPTIMIZED: Skip sending silence frames entirely (new flag)
const SKIP_SILENCE_FRAMES = true;

// ─── Per-IP connection tracking ───────────────────────────────────────────────

/** @type {Map<string, number>} IP address → open connection count */
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

// ─── BridgeSession ────────────────────────────────────────────────────────────

/**
 * Encapsulates the full state of one bridged phone call.
 * Created when Twilio's 'start' event arrives, destroyed when 'stop' fires
 * or when either side closes the WebSocket.
 */
class BridgeSession {
  /**
   * @param {WebSocket} twilioWs   The WebSocket connection from Twilio
   * @param {string}    clientIp   Caller IP (for rate limiting)
   */
  constructor(twilioWs, clientIp, provider = 'twilio', mediaSampleRate = 8000) {
    // ── Twilio side ───────────────────────────────────────────────────────
    this.twilioWs   = twilioWs;
    this.clientIp   = clientIp;
    this.provider   = provider;
    this.mediaSampleRate = mediaSampleRate;

    // Populated from the Twilio 'start' event
    this.streamSid  = null;
    this.callSid    = null;
    this.callerNum  = null;

    // ── ElevenLabs side ───────────────────────────────────────────────────
    /** @type {import('./elevenLabsAgentService').ElevenLabsSession|null} */
    this.elSession  = null;

    // ── State flags ───────────────────────────────────────────────────────
    this.isStarted     = false;   // 'start' event received
    this.isStopped     = false;   // 'stop' event received or WS closed
    this.isELConnected = false;   // ElevenLabs WS is open

    // Language detected from caller speech
    this.language   = process.env.DEFAULT_LANGUAGE || 'hi';

    // ── Audio buffering ───────────────────────────────────────────────────
    // Accumulate small Twilio chunks before forwarding to ElevenLabs
    /** @type {Buffer[]} */
    this._audioAccumulator  = [];
    this._accumulatorBytes  = 0;
    this._flushTimer        = null;

    // Outbound audio queue (ElevenLabs → Twilio)
    /** @type {Array<{ payload: string }>} */
    this._outboundQueue     = [];
    this._outboundTimer     = null;
    this._exotelOutboundBuffer = Buffer.alloc(0);
    this._exotelFlushTimer  = null;

    // ── Silence / VAD ─────────────────────────────────────────────────────
    this._silentFrames      = 0;
    this._inactivityTimer   = null;
    this._inboundFrames     = 0;
    this._speechFrames      = 0;

    // ── Retry / error recovery ────────────────────────────────────────────
    this._audioRetries      = 0;
    this._consecutiveFails  = 0;

    // ── Comfort noise ─────────────────────────────────────────────────────
    this._comfortNoiseTimer = null;
    this._agentSpeaking     = false;

    // ── Logging ───────────────────────────────────────────────────────────
    this._log = logger.forModule('BridgeSession');
    this._outboundSequence = 1;
    this._outboundChunk = 1;
    this._outboundTimestampMs = 0;
    this._lastInboundSequence = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Process the Twilio 'start' event.
   * Extracts stream / call metadata and initiates the ElevenLabs connection.
   *
   * @param {object} startPayload  Contents of msg.start from Twilio
   */
  async onTwilioStart(startPayload) {
    const mediaFormat = startPayload.mediaFormat || startPayload.media_format || {};
    const customParameters = startPayload.customParameters || startPayload.custom_parameters || {};
    const inferredProvider = (
      startPayload.stream_sid ||
      startPayload.call_sid ||
      startPayload.media_format ||
      String(mediaFormat.encoding || '').toLowerCase() === 'base64'
    ) ? 'exotel' : 'twilio';

    this.streamSid  = startPayload.streamSid || startPayload.stream_sid;
    this.callSid    = startPayload.callSid || startPayload.call_sid;
    this.callerNum  = customParameters.callerNumber || customParameters.caller_number || startPayload.from || null;
    const calledNumber = customParameters.called_number || customParameters.calledNumber || startPayload.to || '';
    this.provider   = (customParameters.provider || inferredProvider || this.provider || 'twilio').toLowerCase();
    this.mediaSampleRate = parseInt(
      mediaFormat.sampleRate || mediaFormat.sample_rate || this.mediaSampleRate || 8000,
      10,
    );
    this.isStarted  = true;

    this._log.info('Media stream started', {
      streamSid : this.streamSid,
      callSid   : this.callSid,
      provider  : this.provider,
      mediaFormat,
    });

    if (this.provider === 'exotel') {
      this._log.info('Starting Exotel keepalive silence', {
        callSid: this.callSid,
        streamSid: this.streamSid,
        sampleRate: this.mediaSampleRate,
      });
      this._sendExotelPrimerChunk();
      this._startComfortNoise();
    }

    callHandler.ensureActiveCall({
      CallSid: this.callSid,
      From: startPayload.from || customParameters.from || this.callerNum || '',
      To: startPayload.to || customParameters.to || calledNumber,
      Direction: startPayload.direction || customParameters.direction || 'inbound',
      CallStatus: 'in-progress',
    });

    // Update call handler record
    callHandler.markBridged(this.callSid, this.streamSid);

    // Initialise ElevenLabs session inside the call's log context
    await runWithCallContext(
      { callSid: this.callSid, streamSid: this.streamSid },
      () => this._connectElevenLabs(),
    );
  }

  /**
   * Process a Twilio 'media' event (inbound audio from the caller).
   *
   * @param {object} mediaPayload  Contents of msg.media from Twilio
   */
  onTwilioMedia(mediaPayload) {
    if (this.isStopped || !this.isStarted) return;

    // Only process inbound track (the caller's voice)
    if (this.provider === 'twilio' && mediaPayload.track !== 'inbound') return;

    const base64Audio = mediaPayload.payload;
    if (!base64Audio || base64Audio.length === 0) return;

    this._accumulateAudio(base64Audio);
  }

  /**
   * Process the Twilio 'stop' event.
   */
  onTwilioStop(stopPayload = {}) {
    this._log.info('Media stream stopped by telephony provider', {
      callSid: this.callSid,
      streamSid: this.streamSid,
      reason: stopPayload.reason || 'unknown',
      provider: this.provider,
    });
    this.destroy('twilio-stop');
  }

  noteInboundSequence(sequenceNumber) {
    const parsed = parseInt(sequenceNumber, 10);
    if (Number.isFinite(parsed) && parsed > this._lastInboundSequence) {
      this._lastInboundSequence = parsed;
      if (this.provider === 'exotel' && this._outboundSequence <= parsed) {
        this._outboundSequence = parsed + 1;
      }
    }
  }

  /**
   * Called when the Twilio WebSocket itself closes (before or after 'stop').
   *
   * @param {number} code
   * @param {string} reason
   */
  onTwilioClose(code, reason) {
    if (!this.isStopped) {
      this._log.info('Twilio WS closed', { code, reason, callSid: this.callSid });
      this.destroy('twilio-ws-closed');
    }
  }

  /**
   * Tear down the entire session, close both WebSockets, clear all timers.
   *
   * @param {string} [reason='unknown']
   */
  destroy(reason = 'unknown') {
    if (this.isStopped) return;
    this.isStopped = true;

    this._log.info('Destroying bridge session', { reason, callSid: this.callSid });

    // ── Clear timers ──────────────────────────────────────────────────────
    clearTimeout(this._flushTimer);
    clearTimeout(this._inactivityTimer);
    clearTimeout(this._exotelFlushTimer);
    clearInterval(this._outboundTimer);
    clearInterval(this._comfortNoiseTimer);
    this._flushTimer       = null;
    this._inactivityTimer  = null;
    this._outboundTimer    = null;
    this._comfortNoiseTimer = null;
    this._exotelFlushTimer = null;

    // ── Close ElevenLabs session ──────────────────────────────────────────
    if (this.elSession) {
      try { this.elSession.close(); } catch { /* ignore */ }
      this.elSession = null;
    }

    // ── Close Twilio WebSocket ────────────────────────────────────────────
    if (this.twilioWs && this.twilioWs.readyState !== WebSocket.CLOSED) {
      try { this.twilioWs.close(1000, 'Call ended'); } catch { /* ignore */ }
    }

    // ── Update call handler ───────────────────────────────────────────────
    if (this.callSid) {
      callHandler.forceEnd(this.callSid, reason);
    }

    // ── IP tracking ───────────────────────────────────────────────────────
    if (this.clientIp) decrementIpCount(this.clientIp);

    this._log.info('Bridge session destroyed', { callSid: this.callSid, reason });
  }

  // ── ElevenLabs connection ──────────────────────────────────────────────────

  async _connectElevenLabs() {
    try {
      this._log.info('Connecting to ElevenLabs…', { callSid: this.callSid, language: this.language });

      this.elSession = await createSession({
        callSid      : this.callSid,
        callerNumber : this.callerNum,
        language     : this.language,
      });

      if (this.isStopped) {
        try { this.elSession.close(); } catch { /* ignore */ }
        this.elSession = null;
        return;
      }

      this.isELConnected = true;
      this._startComfortNoise();

      // ── ElevenLabs event handlers ────────────────────────────────────────

      // Audio chunk ready to play to caller
      this.elSession.on('audio', (base64PCM, eventId, sampleRate) => {
        this._onElevenLabsAudio(base64PCM, sampleRate);
      });

      // Agent was interrupted – clear outbound audio buffer
      this.elSession.on('interruption', (_eventId) => {
        this._log.info('Interruption – clearing outbound queue', { callSid: this.callSid });
        this._outboundQueue = [];
        this._agentSpeaking = false;
        this._exotelOutboundBuffer = Buffer.alloc(0);
        clearTimeout(this._exotelFlushTimer);
        this._exotelFlushTimer = null;

        // Tell the telephony side to discard its own audio buffer
        this._sendToTwilio(
          this.provider === 'exotel'
            ? { event: 'clear', stream_sid: this.streamSid }
            : { event: 'clear', streamSid: this.streamSid },
        );
      });

      // User transcript received – update language detection, check cache
      this.elSession.on('transcript', (text, langCode) => {
        this._onUserTranscript(text, langCode);
      });

      // Agent text response received
      this.elSession.on('agent_response', (text) => {
        callHandler.addTranscript(this.callSid, { role: 'agent', text });
        this._log.debug('Agent response logged', { callSid: this.callSid, text: text.slice(0, 80) });
      });

      // Metadata (conversation ID)
      this.elSession.on('metadata', (conversationId, _fmt) => {
        callHandler.setConversationId(this.callSid, conversationId);
      });

      // Fatal ElevenLabs error
      this.elSession.on('error', (err) => {
        this._log.error('ElevenLabs session error', { err: err.message, callSid: this.callSid });
        this._consecutiveFails++;

        if (this._consecutiveFails >= 3) {
          this._log.error('Too many EL failures – destroying session', { callSid: this.callSid });
          this.destroy('elevenlabs-fatal-error');
        }
      });

      // ElevenLabs session closed
      this.elSession.on('close', () => {
        this._log.info('ElevenLabs session closed', { callSid: this.callSid });
        this.isELConnected = false;
        if (!this.isStopped) {
          this.destroy('elevenlabs-closed');
        }
      });

      // Start outbound audio drain timer (sends queued chunks to Twilio)
      this._startOutboundDrain();

      this._log.info('ElevenLabs session ready', {
        callSid       : this.callSid,
        conversationId: this.elSession.conversationId,
      });

    } catch (err) {
      this._log.error('Failed to connect ElevenLabs', { err: err.message, callSid: this.callSid });
      this.destroy('elevenlabs-connect-failed');
    }
  }

  // ── Inbound audio pipeline (Twilio → ElevenLabs) ──────────────────────────

  /**
   * Accumulate incoming μ-law audio frames.
   * Sends to ElevenLabs either when the flush timer fires or when the
   * accumulated buffer reaches ~200 ms of audio (OPTIMIZED: was 100ms).
   * OPTIMIZED: Skip silence frames entirely to reduce token waste.
   *
   * @param {string} base64Audio  Single telephony media chunk
   */
  _accumulateAudio(base64Audio) {
    const pcmBuf = this._decodeInboundToPCM16(base64Audio);
    if (!pcmBuf || pcmBuf.length === 0) return;

    this._inboundFrames++;
    const speechThreshold = SPEECH_DETECTION_THRESHOLD;
    const hasSpeech = isSpeech(pcmBuf, speechThreshold);
    if (hasSpeech) {
      this._speechFrames++;
      if (this.provider === 'exotel') {
        // Avoid talking over the caller; Exotel can be sensitive to continuous outbound media.
        this._stopComfortNoise();
      }
    }

    if (this._inboundFrames % 50 === 0) {
      this._log.info('Inbound audio diagnostics', {
        callSid: this.callSid,
        provider: this.provider,
        frames: this._inboundFrames,
        speechFrames: this._speechFrames,
        speechRatio: Number((this._speechFrames / this._inboundFrames).toFixed(2)),
      });
    }

    // OPTIMIZED: Skip silence frames if flag is enabled (reduces token consumption)
    if (!hasSpeech) {
      this._silentFrames++;
      if (SKIP_SILENCE_FRAMES || (this.provider !== 'exotel' && this._silentFrames > SILENCE_FRAME_THRESHOLD)) {
        // Don't accumulate silence – just reset the inactivity watchdog
        this._resetInactivityTimer();
        return;
      }
    } else {
      this._silentFrames = 0;
      this._resetInactivityTimer();
    }

    // Normalise volume so quiet callers (rural mobile networks, feature phones)
    // are amplified to a level ElevenLabs STT can work with comfortably
    const normalised = normaliseVolume(pcmBuf, 3500);
    this._audioAccumulator.push(normalised);
    this._accumulatorBytes += normalised.length;

    // Flush when we have ~200 ms worth of audio (OPTIMIZED: was 100ms, doubled to reduce packets)
    const TARGET_FLUSH_BYTES = Math.ceil((AUDIO_FLUSH_INTERVAL_MS / 1000) * 16000 * 2);

    if (this._accumulatorBytes >= TARGET_FLUSH_BYTES) {
      this._flushAudioToElevenLabs();
    } else {
      // Schedule a delayed flush in case the accumulator never reaches the target
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return; // already scheduled
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushAudioToElevenLabs();
    }, AUDIO_FLUSH_INTERVAL_MS);
  }

  /**
   * Concatenate accumulated PCM buffers, trim leading/trailing silence, and send to ElevenLabs.
   * OPTIMIZED: Trim silence before sending to reduce token consumption.
   */
  _flushAudioToElevenLabs() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;

    if (this._audioAccumulator.length === 0) return;
    if (!this.isELConnected || !this.elSession) return;

    let combined = Buffer.concat(this._audioAccumulator);
    
    // OPTIMIZED: Trim silence from start and end of audio chunk to reduce tokens
    combined = this._trimSilence(combined);
    
    // Don't send empty chunks (all silence)
    if (combined.length < 160) {
      this._audioAccumulator = [];
      this._accumulatorBytes = 0;
      return;
    }

    const base64PCM = combined.toString('base64');

    this._audioAccumulator = [];
    this._accumulatorBytes  = 0;

    try {
      this.elSession.sendAudio(base64PCM);
      this._consecutiveFails = 0;
    } catch (err) {
      this._log.error('Failed to send audio to ElevenLabs', { err: err.message });
      this._consecutiveFails++;
    }
  }

  /**
   * OPTIMIZED: Trim leading and trailing silence from PCM buffer to reduce token waste.
   * Only removes long silence blocks, preserves audio content.
   * @param {Buffer} pcmBuf 16-bit PCM audio
   * @returns {Buffer} Trimmed audio buffer
   */
  _trimSilence(pcmBuf) {
    const SILENCE_THRESHOLD = 400;
    const MIN_TRIM_FRAMES = 160; // 10ms at 16kHz
    const samples = pcmBuf.length / 2;
    
    // Find first non-silent sample
    let startIdx = 0;
    for (let i = 0; i < samples; i++) {
      const sample = pcmBuf.readInt16LE(i * 2);
      if (Math.abs(sample) > SILENCE_THRESHOLD) {
        startIdx = Math.max(0, i - MIN_TRIM_FRAMES);
        break;
      }
    }
    
    // Find last non-silent sample
    let endIdx = samples;
    for (let i = samples - 1; i >= 0; i--) {
      const sample = pcmBuf.readInt16LE(i * 2);
      if (Math.abs(sample) > SILENCE_THRESHOLD) {
        endIdx = Math.min(samples, i + MIN_TRIM_FRAMES);
        break;
      }
    }
    
    // Return trimmed buffer
    if (startIdx >= endIdx) return Buffer.alloc(0);
    return pcmBuf.slice(startIdx * 2, endIdx * 2);
  }

  // ── Outbound audio pipeline (ElevenLabs → Twilio) ─────────────────────────

  /**
   * Called when ElevenLabs delivers an audio chunk.
   * Converts PCM → μ-law and enqueues for Twilio.
   *
   * @param {string} base64PCM   PCM 16 kHz / 24 kHz base64 string
   * @param {number} sampleRate  ElevenLabs output sample rate (16000 or 24000)
   */
  _onElevenLabsAudio(base64PCM, sampleRate) {
    if (this.isStopped) return;

    const outboundBase64 = this._encodeOutboundFromPCM16(base64PCM, sampleRate);
    if (!outboundBase64) return;

    if (this.provider === 'exotel') {
      this._enqueueExotelOutbound(outboundBase64);
    } else {
      this._outboundQueue.push({ payload: outboundBase64 });
    }
    this._agentSpeaking = true;

    // Stop comfort noise while agent is speaking
    this._stopComfortNoise();
  }

  /**
   * Start the outbound drain timer: dequeues one chunk per interval and
   * sends it to Twilio. This paces the audio playback correctly.
   *
   * Each chunk from ElevenLabs is ~20 ms of audio at 8 kHz (160 bytes).
   * We drain every 20 ms to maintain real-time playback.
   */
  _startOutboundDrain() {
    const DRAIN_INTERVAL_MS = this.provider === 'exotel'
      ? EXOTEL_FRAME_MS
      : 20;

    this._outboundTimer = setInterval(() => {
      if (this.isStopped) return;

      const chunk = this._outboundQueue.shift();
      if (chunk) {
        this._sendMediaToTwilio(chunk.payload);
        this._agentSpeaking = this._outboundQueue.length > 0;

        // If the queue just emptied, start comfort noise
        if (!this._agentSpeaking) {
          this._startComfortNoise();
        }
      }
    }, DRAIN_INTERVAL_MS);
  }

  /**
   * Send an audio payload to the telephony provider (plays to the caller).
   *
   * @param {string} base64Payload
   */
  _sendMediaToTwilio(base64Payload) {
    if (!this.streamSid) return;
    if (this.provider === 'exotel') {
      const payloadBytes = Buffer.from(base64Payload, 'base64').length;
      const durationMs = Math.round(
        (payloadBytes / Math.max(1, this.mediaSampleRate * 2)) * 1000,
      );
      const sequenceNumber = Math.max(
        this._outboundSequence,
        this._lastInboundSequence + 1,
      );

      this._sendToTwilio({
        event: 'media',
        sequence_number: String(sequenceNumber),
        stream_sid: this.streamSid,
        media: {
          chunk: String(this._outboundChunk++),
          timestamp: String(this._outboundTimestampMs),
          payload: base64Payload,
        },
      });
      this._outboundSequence = sequenceNumber + 1;
      this._outboundTimestampMs += durationMs || EXOTEL_FRAME_MS;
      return;
    }

    this._sendToTwilio({
      event    : 'media',
      streamSid: this.streamSid,
      media    : { payload: base64Payload },
    });
  }

  /**
   * Send a raw JSON message to Twilio via the Media Streams WebSocket.
   *
   * @param {object} msg
   */
  _sendToTwilio(msg) {
    if (!this.twilioWs || this.twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      this.twilioWs.send(JSON.stringify(msg));
    } catch (err) {
      this._log.warn('Failed to send to Twilio WS', { err: err.message, callSid: this.callSid });
    }
  }

  _decodeInboundToPCM16(base64Audio) {
    if (this.provider === 'exotel') {
      if (this.mediaSampleRate === 16000) {
        return Buffer.from(base64Audio, 'base64');
      }

      if (this.mediaSampleRate === 8000) {
        return linear8kToLinear16(Buffer.from(base64Audio, 'base64'));
      }

      this._log.warn('Unsupported Exotel inbound sample rate', {
        sampleRate: this.mediaSampleRate,
        callSid: this.callSid,
      });
      return Buffer.from(base64PCM8kToBase64PCM16k(base64Audio), 'base64');
    }

    const mulawBuf = Buffer.from(base64Audio, 'base64');
    return mulawToLinear16(mulawBuf);
  }

  _encodeOutboundFromPCM16(base64PCM, sampleRate) {
    if (this.provider === 'exotel') {
      if (this.mediaSampleRate === 16000) {
        if (sampleRate === 24000) return base64PCM24kToBase64PCM16k(base64PCM);
        return base64PCM;
      }

      if (this.mediaSampleRate === 8000) {
        if (sampleRate === 24000) {
          return base64PCM16kToBase64PCM8k(base64PCM24kToBase64PCM16k(base64PCM));
        }
        return base64PCM16kToBase64PCM8k(base64PCM);
      }

      this._log.warn('Unsupported Exotel outbound sample rate', {
        sampleRate: this.mediaSampleRate,
        callSid: this.callSid,
      });
      return sampleRate === 24000 ? base64PCM24kToBase64PCM16k(base64PCM) : base64PCM;
    }

    return base64PCMToBase64Mulaw(base64PCM, sampleRate);
  }

  _getExotelFrameBytes() {
    const sampleRate = this.mediaSampleRate || 16000;
    return Math.ceil((sampleRate * 2 * EXOTEL_FRAME_MS) / 1000);
  }

  _buildExotelPrimerChunk() {
    const sampleRate = this.mediaSampleRate || 8000;
    const samples = Math.max(1, Math.ceil((sampleRate * EXOTEL_FRAME_MS) / 1000));
    const pcm = Buffer.alloc(samples * 2);
    const frequencyHz = 440;
    const amplitude = 900;

    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      const fadeIn = Math.min(1, i / Math.max(1, samples * 0.2));
      const fadeOut = Math.min(1, (samples - i) / Math.max(1, samples * 0.2));
      const env = Math.min(fadeIn, fadeOut);
      const value = Math.round(
        Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * env,
      );
      pcm.writeInt16LE(value, i * 2);
    }

    return pcm;
  }

  _sendExotelSilenceChunk() {
    if (this.provider !== 'exotel' || this.isStopped) return;
    const silence = Buffer.alloc(this._getExotelFrameBytes(), 0);
    this._sendMediaToTwilio(silence.toString('base64'));
  }

  _sendExotelPrimerChunk() {
    if (this.provider !== 'exotel' || this.isStopped) return;
    const primer = this._buildExotelPrimerChunk();
    this._sendMediaToTwilio(primer.toString('base64'));
  }

  _enqueueExotelOutbound(base64Payload) {
    const payloadBuffer = Buffer.from(base64Payload, 'base64');
    if (payloadBuffer.length === 0) return;

    this._exotelOutboundBuffer = Buffer.concat([
      this._exotelOutboundBuffer,
      payloadBuffer,
    ]);

    const frameBytes = this._getExotelFrameBytes();
    while (this._exotelOutboundBuffer.length >= frameBytes) {
      const frame = this._exotelOutboundBuffer.subarray(0, frameBytes);
      this._outboundQueue.push({ payload: frame.toString('base64') });
      this._exotelOutboundBuffer = this._exotelOutboundBuffer.subarray(frameBytes);
    }

    clearTimeout(this._exotelFlushTimer);
    this._exotelFlushTimer = setTimeout(() => {
      this._flushPendingExotelOutbound();
    }, EXOTEL_FRAME_MS);
  }

  _flushPendingExotelOutbound() {
    clearTimeout(this._exotelFlushTimer);
    this._exotelFlushTimer = null;

    if (this.provider !== 'exotel' || this._exotelOutboundBuffer.length === 0) {
      return;
    }

    const frameBytes = this._getExotelFrameBytes();
    const padded = Buffer.alloc(frameBytes, 0);
    this._exotelOutboundBuffer.copy(padded, 0, 0, this._exotelOutboundBuffer.length);
    this._outboundQueue.push({ payload: padded.toString('base64') });
    this._exotelOutboundBuffer = Buffer.alloc(0);
  }

  // ── Comfort noise ──────────────────────────────────────────────────────────

  /**
   * Send periodic μ-law silence to Twilio to keep the RTP stream alive and
   * prevent the caller hearing dead air between agent utterances.
   */
  _startComfortNoise() {
    if (this._comfortNoiseTimer || this.isStopped) return;

    const intervalMs = this.provider === 'exotel'
      ? EXOTEL_FRAME_MS
      : COMFORT_NOISE_INTERVAL_MS;

    this._comfortNoiseTimer = setInterval(() => {
      if (this._agentSpeaking || this.isStopped) {
        this._stopComfortNoise();
        return;
      }
      if (this.provider === 'exotel') {
        this._sendExotelSilenceChunk();
        return;
      }

      const silence = generateMulawSilence(COMFORT_NOISE_INTERVAL_MS);
      this._sendMediaToTwilio(silence.toString('base64'));
    }, intervalMs);
  }

  _stopComfortNoise() {
    if (this._comfortNoiseTimer) {
      clearInterval(this._comfortNoiseTimer);
      this._comfortNoiseTimer = null;
    }
  }

  // ── Inactivity watchdog ────────────────────────────────────────────────────

  /**
   * Reset the inactivity timer. If the caller goes silent for INACTIVITY_TIMEOUT_MS
   * after the agent stops speaking, nudge them with a prompt.
   */
  _resetInactivityTimer() {
    clearTimeout(this._inactivityTimer);
    this._inactivityTimer = setTimeout(() => {
      if (this.isStopped) return;
      if (this._agentSpeaking) return; // agent is talking – don't interrupt

      this._audioRetries++;
      this._log.info('Inactivity detected – prompting caller', {
        callSid: this.callSid,
        retries: this._audioRetries,
      });

      if (this._audioRetries <= MAX_AUDIO_RETRIES) {
        // Send a nudge via ElevenLabs by injecting a short silence burst
        // which often triggers the VAD end-of-utterance detection
        if (this.elSession?.isConnected) {
          const silenceBuf   = Buffer.alloc(1600, 0); // 100 ms PCM silence at 16 kHz
          const silenceB64   = silenceBuf.toString('base64');
          this.elSession.sendAudio(silenceB64);
        }
      } else {
        this._log.warn('Max inactivity retries reached – ending call', { callSid: this.callSid });
        this.destroy('inactivity-timeout');
      }
    }, INACTIVITY_TIMEOUT_MS);
  }

  // ── Transcript / cache ─────────────────────────────────────────────────────

  /**
   * Handle a finalised user transcript from ElevenLabs STT.
   * Updates language detection, logs transcript, and checks the cache.
   *
   * @param {string} text      User speech transcript
   * @param {string} langCode  Detected language
   */
  _onUserTranscript(text, langCode) {
    if (!text || text.trim().length === 0) return;

    // Refine language detection using the actual transcript text
    const detectedLang = detectLanguage(text, { fallback: langCode });
    if (detectedLang !== this.language) {
      this._log.info(`Language switch: ${this.language} → ${detectedLang}`, {
        callSid  : this.callSid,
        transcript: text.slice(0, 60),
      });
      this.language = detectedLang;
      callHandler.setLanguage(this.callSid, detectedLang);
    }

    // Log user turn
    callHandler.addTranscript(this.callSid, {
      role : 'user',
      text,
      lang : detectedLang,
    });

    // Reset retry counter on new speech
    this._audioRetries = 0;

    // Cache lookup: if this exact query was answered recently, note the hit
    // (The ElevenLabs agent will still generate a fresh response; we use the
    //  cache for analytics and future short-circuit opportunities.)
    const cached = cache.get(text, detectedLang);
    if (cached) {
      this._log.debug('Cache hit for user query', {
        callSid  : this.callSid,
        transcript: text.slice(0, 60),
        cachedAt : cached.cachedAt,
      });
    }

    this._log.info('User transcript', {
      callSid  : this.callSid,
      language : detectedLang,
      text     : text.slice(0, 120),
    });
  }
}

// ─── WebSocket Server Factory ─────────────────────────────────────────────────

/**
 * Attach a Twilio Media Streams WebSocket server to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer  The Node.js HTTP server instance
 * @param {object}  [options]
 * @param {string}  [options.path='/media-stream']  WebSocket upgrade path
 * @returns {WebSocket.Server}
 *
 * @example
 *   const { createBridge } = require('./services/audioStreamBridge');
 *   const wss = createBridge(httpServer);
 */
function createBridge(httpServer, { path = '/media-stream' } = {}) {
  const wss = new WebSocket.Server({ server: httpServer, path });

  log.info(`Audio Stream Bridge listening on ws path: ${path}`);

  wss.on('connection', (twilioWs, req) => {
    // ── Per-IP rate limiting ────────────────────────────────────────────────
    const clientIp = (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      'unknown'
    );

    const ipCount = incrementIpCount(clientIp);

    if (ipCount > MAX_WS_PER_IP) {
      log.warn('Per-IP WS limit reached – rejecting connection', { clientIp, ipCount });
      decrementIpCount(clientIp);
      twilioWs.close(1008, 'Too many connections from this IP');
      return;
    }

    // ── Global capacity check ───────────────────────────────────────────────
    if (wss.clients.size > MAX_CONCURRENT_CALLS) {
      log.warn('Global WS capacity reached – rejecting connection', {
        clients: wss.clients.size,
        max    : MAX_CONCURRENT_CALLS,
      });
      decrementIpCount(clientIp);
      twilioWs.close(1008, 'Server at capacity');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const inferredProvider = (
      url.searchParams.has('sample-rate') ||
      url.searchParams.has('caller_number') ||
      url.searchParams.has('called_number')
    ) ? 'exotel' : 'twilio';
    const provider = (url.searchParams.get('provider') || inferredProvider).toLowerCase();
    const mediaSampleRate = parseInt(url.searchParams.get('sample-rate') || '8000', 10);

    log.info('New telephony WS connection', {
      clientIp,
      totalConnections: wss.clients.size,
      provider,
      mediaSampleRate,
    });

    // ── Create bridge session ───────────────────────────────────────────────
    const session = new BridgeSession(twilioWs, clientIp, provider, mediaSampleRate);

    // ── Twilio WebSocket message handler ────────────────────────────────────
    twilioWs.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        log.warn('Could not parse Twilio WS message', { err: err.message, data: data.toString().slice(0, 200) });
        return;
      }

      session.noteInboundSequence(msg.sequence_number);

      switch (msg.event) {

        // ── Stream started ────────────────────────────────────────────────
        case 'start':
          try {
            await session.onTwilioStart(msg.start || {});
          } catch (err) {
            log.error('Error handling Twilio start event', {
              err    : err.message,
              stack  : err.stack,
              callSid: session.callSid,
            });
            session.destroy('start-event-error');
          }
          break;

        // ── Audio media ───────────────────────────────────────────────────
        case 'media':
          session.onTwilioMedia(msg.media || {});
          break;

        // ── Stream stopped ────────────────────────────────────────────────
        case 'stop':
          session.onTwilioStop(msg.stop || {});
          break;

        // ── Mark event (sent after we inject a mark into the stream) ──────
        case 'mark':
          log.debug('Mark received from Twilio', {
            name   : msg.mark?.name,
            callSid: session.callSid,
          });
          break;

        // ── Connected event (first message Twilio sends) ──────────────────
        case 'connected':
          log.debug('Telephony WS connected event received', {
            protocol: msg.protocol,
            provider: session.provider,
          });
          break;

        default:
          log.debug(`Unknown Twilio WS event: ${msg.event}`);
      }
    });

    // ── Twilio WebSocket close handler ──────────────────────────────────────
    twilioWs.on('close', (code, reason) => {
      session.onTwilioClose(code, reason?.toString());
    });

    // ── Twilio WebSocket error handler ──────────────────────────────────────
    twilioWs.on('error', (err) => {
      log.error('Twilio WS error', { err: err.message, callSid: session.callSid });
      session.destroy('twilio-ws-error');
    });
  });

  // ── WebSocket server error ────────────────────────────────────────────────
  wss.on('error', (err) => {
    log.error('WebSocket server error', { err: err.message });
  });

  return wss;
}

// ─── Statistics provider ───────────────────────────────────────────────────────

/**
 * Returns live bridge statistics for the health endpoint.
 * Registered with health.js via registerStatsProvider().
 *
 * @returns {object}
 */
function getBridgeStats() {
  return {
    ...callHandler.getStats(),
    ipConnections: Object.fromEntries(ipConnections),
  };
}

// ─── Module exports ────────────────────────────────────────────────────────────

module.exports = {
  createBridge,
  getBridgeStats,
  BridgeSession,         // exported for unit testing
};
