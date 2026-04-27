"use strict";

// ─── Provider ─────────────────────────────────────────────────────────────────
const TELEPHONY_PROVIDER = (
  process.env.TELEPHONY_PROVIDER || "twilio"
).toLowerCase();
const IS_EXOTEL = TELEPHONY_PROVIDER === "exotel";

/**
 * callHandler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the lifecycle of every inbound phone call for DialAI Bharat.
 *
 * Responsibilities
 * ────────────────
 *  1. Generate TwiML responses that instruct Twilio to:
 *       a. Play a brief "connecting" tone / message
 *       b. Open a bidirectional Media Stream WebSocket to this server
 *  2. Track active and historical call records in memory
 *  3. Emit lifecycle events (started, answered, ended, failed) for logging
 *  4. Enforce the MAX_CONCURRENT_CALLS limit
 *  5. Handle call-status webhook callbacks from Twilio
 *
 * Data flow
 * ─────────
 *   Twilio POST /twiml/incoming
 *       └─► callHandler.handleIncoming()
 *               └─► returns TwiML XML
 *                       └─► Twilio opens WS to /media-stream
 *                               └─► audioStreamBridge picks it up
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { EventEmitter } = require("events");
const { logger } = require("../utils/logger");

const log = logger.forModule("callHandler");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_CALLS = parseInt(
  process.env.MAX_CONCURRENT_CALLS || "50",
  10,
);
const SERVER_URL =
  process.env.SERVER_URL || "https://your-server.ngrok-free.app";

// Strip trailing slash from SERVER_URL
const BASE_URL = SERVER_URL.replace(/\/$/, "");

// WebSocket URL – same for both Twilio and Exotel (both use wss://)
const MEDIA_STREAM_URL =
  BASE_URL.replace(/^https?:\/\//, "wss://") + "/media-stream";

function getMediaStreamUrl() {
  if (!IS_EXOTEL) return MEDIA_STREAM_URL;
  const separator = MEDIA_STREAM_URL.includes("?") ? "&" : "?";
  const sampleRate = process.env.EXOTEL_SAMPLE_RATE || "8000";
  return `${MEDIA_STREAM_URL}${separator}sample-rate=${sampleRate}`;
}

// ─── Call Status Enum ─────────────────────────────────────────────────────────

const CallStatus = Object.freeze({
  RINGING: "ringing",
  IN_PROGRESS: "in-progress",
  BRIDGED: "bridged", // Media Stream + ElevenLabs connected
  COMPLETED: "completed",
  FAILED: "failed",
  NO_ANSWER: "no-answer",
  BUSY: "busy",
  CANCELED: "canceled",
});

// ─── Call Record Factory ──────────────────────────────────────────────────────

/**
 * Create a new call record object.
 *
 * @param {object} params
 * @param {string} params.callSid      Twilio Call SID (CA…)
 * @param {string} params.from         Caller number (E.164)
 * @param {string} params.to           Called number (E.164)
 * @param {string} [params.direction]  'inbound' | 'outbound'
 * @returns {object} Mutable call record
 */
function createCallRecord({ callSid, from, to, direction = "inbound" }) {
  return {
    callSid,
    from: anonymiseNumber(from),
    to,
    direction,
    status: CallStatus.RINGING,
    language: null, // detected after first user speech
    streamSid: null, // set when Media Stream connects
    conversationId: null, // set when ElevenLabs session opens
    startedAt: Date.now(),
    answeredAt: null,
    bridgedAt: null,
    endedAt: null,
    durationMs: null,
    transcripts: [], // [{ role, text, lang, timestamp }]
    errorMessage: null,
    retryCount: 0,
  };
}

/**
 * Mask all but the last 4 digits of a phone number for GDPR / privacy.
 *
 * @param {string} number  E.164 format
 * @returns {string}
 */
function anonymiseNumber(number) {
  if (!number || number.length < 4) return "****";
  return number.slice(0, -4).replace(/\d/g, "*") + number.slice(-4);
}

// ─── CallHandler class ────────────────────────────────────────────────────────

class CallHandler extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, object>} callSid → call record */
    this._active = new Map();

    /** @type {Map<string, object>} callSid → call record (completed calls, capped) */
    this._history = new Map();
    this._historyMaxSize = 1000;

    /** Running totals */
    this._counters = {
      totalHandled: 0,
      totalFailed: 0,
      totalCompleted: 0,
    };
  }

  // ── Getters / stats ───────────────────────────────────────────────────────

  get activeCount() {
    return this._active.size;
  }
  get totalHandled() {
    return this._counters.totalHandled;
  }
  get totalFailed() {
    return this._counters.totalFailed;
  }
  get totalCompleted() {
    return this._counters.totalCompleted;
  }

  getStats() {
    return {
      active: this.activeCount,
      totalHandled: this._counters.totalHandled,
      totalFailed: this._counters.totalFailed,
      totalCompleted: this._counters.totalCompleted,
      historySize: this._history.size,
    };
  }

  getRecord(callSid) {
    return this._active.get(callSid) || this._history.get(callSid) || null;
  }

  // ── Incoming call handler ─────────────────────────────────────────────────

  /**
   * Ensure an active call record exists for this CallSid.
   *
   * @param {object} params
   * @returns {object}
   */
  ensureActiveCall(params) {
    const {
      CallSid: callSid,
      From: from = "",
      To: to = "",
      Direction: direction = "inbound",
      CallStatus: initialStatus = "",
    } = params;

    if (!callSid) {
      throw new Error("Missing CallSid in telephony webhook payload");
    }

    const existing = this._active.get(callSid);
    if (existing) {
      if (!existing.from || existing.from === "****") {
        existing.from = anonymiseNumber(from);
      }
      if (!existing.to) {
        existing.to = to;
      }
      if (!existing.direction) {
        existing.direction = direction;
      }
      return existing;
    }

    if (this._active.size >= MAX_CONCURRENT_CALLS) {
      throw new Error("At capacity");
    }

    const callRecord = createCallRecord({ callSid, from, to, direction });
    if (initialStatus) {
      callRecord.status = initialStatus;
    }

    this._active.set(callSid, callRecord);
    this._counters.totalHandled++;

    log.info("Inbound call registered", {
      callSid,
      from: callRecord.from,
      to,
      active: this._active.size,
    });

    this.emit("call:started", callRecord);
    return callRecord;
  }

  /**
   * Handle a new inbound call from Twilio.
   * Validates capacity, registers the call record, and returns TwiML XML.
   *
   * @param {object} twilioParams  Parsed body from Twilio's POST webhook
   * @returns {{ twiml: string, callRecord: object }}
   * @throws {Error} If server is at capacity
   */
  handleIncoming(twilioParams) {
    const {
      CallSid: callSid,
    } = twilioParams;

    if (!callSid) {
      throw new Error("Missing CallSid in Twilio webhook payload");
    }

    // ── Capacity check ────────────────────────────────────────────────────
    if (!this._active.has(callSid) && this._active.size >= MAX_CONCURRENT_CALLS) {
      log.warn("At capacity – rejecting inbound call", {
        callSid,
        active: this._active.size,
        max: MAX_CONCURRENT_CALLS,
      });
      const busyTwiml = this._buildBusyTwiML();
      return { twiml: busyTwiml, callRecord: null };
    }

    const callRecord = this.ensureActiveCall(twilioParams);

    // ── Build TwiML ───────────────────────────────────────────────────────
    const twiml = this._buildMediaStreamTwiML(callSid);

    return { twiml, callRecord };
  }

  // ── Status webhook handler ────────────────────────────────────────────────

  /**
   * Process a Twilio call-status callback (sent for every status transition).
   *
   * @param {object} params  Twilio status callback POST body
   */
  handleStatusUpdate(params) {
    const {
      CallSid: callSid,
      CallStatus: status,
      CallDuration: durationSec,
      ErrorCode: errorCode,
      ErrorMessage: errorMessage,
    } = params;

    if (!callSid || !status) return;

    const record = this._active.get(callSid);
    if (!record) {
      // Could be a delayed callback for an already-archived call
      log.debug("Status update for unknown/archived call", { callSid, status });
      return;
    }

    const prevStatus = record.status;
    record.status = status;

    log.info("Call status update", { callSid, prevStatus, status, errorCode });

    switch (status) {
      case "in-progress":
        record.answeredAt = Date.now();
        this.emit("call:answered", record);
        break;

      case "completed":
        record.endedAt = Date.now();
        record.durationMs = durationSec
          ? parseInt(durationSec, 10) * 1000
          : record.endedAt - record.startedAt;
        this._counters.totalCompleted++;
        this._archiveRecord(callSid, record);
        this.emit("call:completed", record);

        log.info("Call completed", {
          callSid,
          durationMs: record.durationMs,
          transcripts: record.transcripts.length,
          language: record.language,
        });
        break;

      case "failed":
      case "busy":
      case "no-answer":
      case "canceled":
        record.endedAt = Date.now();
        record.errorMessage =
          errorMessage || `Call ended with status: ${status}`;
        this._counters.totalFailed++;
        this._archiveRecord(callSid, record);
        this.emit("call:failed", record);

        log.warn("Call did not complete", {
          callSid,
          status,
          errorCode,
          errorMessage,
        });
        break;

      default:
        // ringing, queued, etc. – no action needed
        break;
    }
  }

  // ── Record mutation helpers ───────────────────────────────────────────────

  /**
   * Mark a call as having its Media Stream connected.
   *
   * @param {string} callSid
   * @param {string} streamSid  Twilio Stream SID (MZ…)
   */
  markBridged(callSid, streamSid) {
    const record = this._active.get(callSid);
    if (!record) return;

    record.status = CallStatus.BRIDGED;
    record.streamSid = streamSid;
    record.bridgedAt = Date.now();

    log.info("Call bridged to ElevenLabs", { callSid, streamSid });
    this.emit("call:bridged", record);
  }

  /**
   * Attach the ElevenLabs conversation ID to the call record.
   *
   * @param {string} callSid
   * @param {string} conversationId
   */
  setConversationId(callSid, conversationId) {
    const record = this._active.get(callSid);
    if (!record) return;
    record.conversationId = conversationId;
    log.debug("Conversation ID set", { callSid, conversationId });
  }

  /**
   * Update the detected language for a call.
   *
   * @param {string} callSid
   * @param {string} language  'hi' | 'bn' | 'en'
   */
  setLanguage(callSid, language) {
    const record = this._active.get(callSid);
    if (!record) return;
    if (record.language !== language) {
      record.language = language;
      log.debug("Language detected", { callSid, language });
    }
  }

  /**
   * Append a transcript entry to the call record.
   *
   * @param {string} callSid
   * @param {object} entry  { role: 'user'|'agent', text: string, lang?: string }
   */
  addTranscript(callSid, entry) {
    const record = this._active.get(callSid);
    if (!record) return;

    record.transcripts.push({
      role: entry.role,
      text: entry.text,
      lang: entry.lang || record.language || "unknown",
      timestamp: Date.now(),
    });

    // Auto-detect and update language from user speech
    if (entry.role === "user" && entry.lang && !record.language) {
      record.language = entry.lang;
    }
  }

  /**
   * Increment the retry counter for a call (poor audio / reconnect attempts).
   *
   * @param {string} callSid
   * @returns {number} New retry count
   */
  incrementRetry(callSid) {
    const record = this._active.get(callSid);
    if (!record) return 0;
    record.retryCount++;
    log.debug("Retry incremented", { callSid, retryCount: record.retryCount });
    return record.retryCount;
  }

  /**
   * Terminate and archive a call record without a Twilio status callback.
   * Used when the WebSocket closes unexpectedly.
   *
   * @param {string} callSid
   * @param {string} [reason]
   */
  forceEnd(callSid, reason = "ws-closed") {
    const record = this._active.get(callSid);
    if (!record) return;

    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    record.errorMessage = reason;

    const isOk = reason === "ws-closed" || reason === "completed";
    if (isOk) {
      this._counters.totalCompleted++;
    } else {
      this._counters.totalFailed++;
    }

    this._archiveRecord(callSid, record);
    this.emit("call:ended", record);

    log.info("Call force-ended", {
      callSid,
      reason,
      durationMs: record.durationMs,
      transcripts: record.transcripts.length,
    });
  }

  // ── TwiML builders ────────────────────────────────────────────────────────

  /**
   * Build the XML response that opens a Media Stream WebSocket.
   * Works for both Twilio (TwiML) and Exotel (ExoML) – the
   * <Connect><Stream> verb is identical in both dialects.
   *
   * @param {string} callSid
   * @returns {string} XML string
   */
  _buildMediaStreamTwiML(callSid) {
    const wsUrl = getMediaStreamUrl();
    const provider = IS_EXOTEL ? "exotel" : "twilio";

    log.debug("Building Media Stream XML", { callSid, wsUrl, provider });

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}"/>
      <Parameter name="provider" value="${provider}"/>
      <Parameter name="version"  value="1.0"/>
    </Stream>
  </Connect>
</Response>`.trim();
  }

  /**
   * Build a "busy / at-capacity" XML response.
   * Twilio supports Amazon Polly voices; Exotel uses plain <Say>.
   *
   * @returns {string} XML string
   */
  _buildBusyTwiML() {
    if (IS_EXOTEL) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN">
    Namaskar. Abhi sabhi lines busy hain. Kripya thodi der baad call karein. Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN" voice="Polly.Aditi">
    Namaskar. Abhi sabhi lines busy hain. Kripya thodi der baad call karein. Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
  }

  /**
   * Build a fatal-error fallback XML response.
   *
   * @returns {string} XML string
   */
  static buildErrorTwiML() {
    if (IS_EXOTEL) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN">
    Khed hai, abhi kuch technical samasya aa rahi hai. Kripya dobara call karein.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN" voice="Polly.Aditi">
    Khed hai, abhi kuch technical samasya aa rahi hai. Kripya dobara call karein.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Move a call record from active → history.
   * Caps history at _historyMaxSize using FIFO eviction.
   *
   * @param {string} callSid
   * @param {object} record
   */
  _archiveRecord(callSid, record) {
    this._active.delete(callSid);

    if (this._history.size >= this._historyMaxSize) {
      // Delete oldest entry
      const firstKey = this._history.keys().next().value;
      this._history.delete(firstKey);
    }

    this._history.set(callSid, record);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const callHandler = new CallHandler();

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  callHandler,
  CallHandler,
  CallStatus,
  anonymiseNumber,
};
