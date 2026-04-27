"use strict";

/**
 * callHandler.js – Exotel-only Call Management
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { EventEmitter } = require("events");
const { logger } = require("../utils/logger");

const log = logger.forModule("callHandler");

const MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS || "50", 10);
const SERVER_URL = process.env.SERVER_URL || "https://your-server.ngrok-free.app";
const BASE_URL = SERVER_URL.replace(/\/$/, "");
const MEDIA_STREAM_URL = BASE_URL.replace(/^https?:\/\//, "wss://") + "/media-stream";

function getMediaStreamUrl() {
  const separator = MEDIA_STREAM_URL.includes("?") ? "&" : "?";
  const sampleRate = process.env.EXOTEL_SAMPLE_RATE || "8000";
  return `${MEDIA_STREAM_URL}${separator}sample-rate=${sampleRate}`;
}

const CallStatus = Object.freeze({
  RINGING: "ringing",
  IN_PROGRESS: "in-progress",
  BRIDGED: "bridged",
  COMPLETED: "completed",
  FAILED: "failed",
  NO_ANSWER: "no-answer",
  BUSY: "busy",
  CANCELED: "canceled",
});

function createCallRecord({ callSid, from, to, direction = "inbound" }) {
  return {
    callSid,
    from: anonymiseNumber(from),
    to,
    direction,
    status: CallStatus.RINGING,
    language: null,
    streamSid: null,
    conversationId: null,
    startedAt: Date.now(),
    answeredAt: null,
    bridgedAt: null,
    endedAt: null,
    durationMs: null,
    transcripts: [],
    errorMessage: null,
    retryCount: 0,
  };
}

function anonymiseNumber(number) {
  if (!number || number.length < 4) return "****";
  return number.slice(0, -4).replace(/\d/g, "*") + number.slice(-4);
}

class CallHandler extends EventEmitter {
  constructor() {
    super();
    this._active = new Map();
    this._history = new Map();
    this._historyMaxSize = 1000;
    this._counters = { totalHandled: 0, totalFailed: 0, totalCompleted: 0 };
  }

  getStats() {
    return {
      active: this._active.size,
      totalHandled: this._counters.totalHandled,
      totalFailed: this._counters.totalFailed,
      totalCompleted: this._counters.totalCompleted,
    };
  }

  ensureActiveCall(params) {
    const { CallSid: callSid, From: from = "", To: to = "", Direction: direction = "inbound", CallStatus: initialStatus = "" } = params;
    if (!callSid) throw new Error("Missing CallSid");

    let record = this._active.get(callSid);
    if (!record) {
      if (this._active.size >= MAX_CONCURRENT_CALLS) throw new Error("At capacity");
      record = createCallRecord({ callSid, from, to, direction });
      if (initialStatus) record.status = initialStatus;
      this._active.set(callSid, record);
      this._counters.totalHandled++;
      log.info("Inbound call registered", { callSid, from: record.from });
      this.emit("call:started", record);
    }
    return record;
  }

  handleIncoming(params) {
    const { CallSid: callSid } = params;
    if (!callSid) throw new Error("Missing CallSid");

    if (!this._active.has(callSid) && this._active.size >= MAX_CONCURRENT_CALLS) {
      return { twiml: this._buildBusyExoML(), callRecord: null };
    }

    const callRecord = this.ensureActiveCall(params);
    return { twiml: this._buildMediaStreamExoML(callSid), callRecord };
  }

  handleStatusUpdate(params) {
    const { CallSid: callSid, CallStatus: status, CallDuration: durationSec, ErrorMessage: errorMessage } = params;
    if (!callSid || !status) return;

    const record = this._active.get(callSid);
    if (!record) return;

    record.status = status;
    if (status === "in-progress") {
      record.answeredAt = Date.now();
    } else if (["completed", "failed", "busy", "no-answer", "canceled"].includes(status)) {
      record.endedAt = Date.now();
      record.durationMs = durationSec ? parseInt(durationSec, 10) * 1000 : record.endedAt - record.startedAt;
      if (status === "completed") this._counters.totalCompleted++;
      else this._counters.totalFailed++;
      this._archiveRecord(callSid, record);
    }
  }

  markBridged(callSid, streamSid) {
    const record = this._active.get(callSid);
    if (record) {
      record.status = CallStatus.BRIDGED;
      record.streamSid = streamSid;
      record.bridgedAt = Date.now();
    }
  }

  setConversationId(callSid, conversationId) {
    const record = this._active.get(callSid);
    if (record) record.conversationId = conversationId;
  }

  addTranscript(callSid, entry) {
    const record = this._active.get(callSid);
    if (record) {
      record.transcripts.push({ ...entry, timestamp: Date.now() });
      if (entry.role === "user" && entry.lang && !record.language) record.language = entry.lang;
    }
  }

  forceEnd(callSid, reason = "ws-closed") {
    const record = this._active.get(callSid);
    if (record) {
      record.endedAt = Date.now();
      record.errorMessage = reason;
      this._counters.totalCompleted++;
      this._archiveRecord(callSid, record);
    }
  }

  _buildMediaStreamExoML(callSid) {
    const wsUrl = getMediaStreamUrl();
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}"/>
      <Parameter name="provider" value="exotel"/>
    </Stream>
  </Connect>
</Response>`.trim();
  }

  _buildBusyExoML() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN">Sabhi lines busy hain. Kripya baad mein call karein.</Say>
  <Hangup/>
</Response>`.trim();
  }

  _archiveRecord(callSid, record) {
    this._active.delete(callSid);
    if (this._history.size >= this._historyMaxSize) {
      this._history.delete(this._history.keys().next().value);
    }
    this._history.set(callSid, record);
  }
}

const callHandler = new CallHandler();
module.exports = { callHandler, CallStatus };
