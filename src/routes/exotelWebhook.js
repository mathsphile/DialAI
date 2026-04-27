'use strict';

/**
 * exotelWebhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express routes for all Exotel HTTP callbacks – India-first telephony.
 *
 * Endpoints
 * ─────────
 *   GET|POST /exotel/incoming   ← Exotel calls this when someone dials the helpline
 *   GET|POST /exotel/status     ← Exotel call-status callback
 *   GET|POST /exotel/fallback   ← Called if /exotel/incoming fails
 *   GET  /exotel/test       ← Dev smoke-test (returns sample ExoML)
 *
 * Exotel vs Twilio – key differences handled here
 * ─────────────────────────────────────────────────
 *   • Status fields : Exotel passthru uses `CallStatus` / `DialCallStatus`
 *                     and Voicebot passthru may add `Stream[Status]`
 *   • Duration field: `Stream[Duration]`, `DialCallDuration`, or `RecordingDuration`
 *   • Auth          : Secret token in URL query param (no HMAC signature)
 *   • XML           : ExoML – same <Connect><Stream> syntax as TwiML ✅
 *   • WebSocket     : Same Media Streaming protocol as Twilio ✅  (no bridge changes)
 *   • Voice         : No Polly – use plain <Say> with `language` attr
 *
 * Exotel IP whitelist (optional hardening, set EXOTEL_VALIDATE_IP=true):
 *   52.172.0.0/16  |  52.66.0.0/16  |  13.126.0.0/16  |  3.6.0.0/16
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

const { callHandler } = require('../services/callHandler');
const { logger }      = require('../utils/logger');

const router = express.Router();
const log    = logger.forModule('exotelWebhook');

// ─── Configuration ────────────────────────────────────────────────────────────

const WEBHOOK_SECRET   = process.env.EXOTEL_WEBHOOK_SECRET || '';
const VALIDATE_IP      = process.env.EXOTEL_VALIDATE_IP === 'true';
const SERVER_URL       = (process.env.SERVER_URL || '').replace(/\/$/, '');

// Exotel's published outbound IP CIDR blocks (as of 2024)
const EXOTEL_IP_PREFIXES = [
  '52.172.', '52.66.', '13.126.', '3.6.',
  '13.233.', '35.154.', '65.0.',
];

// ─── WebSocket URL ────────────────────────────────────────────────────────────

const MEDIA_STREAM_URL = SERVER_URL.replace(/^https?:\/\//, 'wss://') + '/media-stream';

function buildExotelStreamUrl({ from = '', to = '' } = {}) {
  const sampleRate = process.env.EXOTEL_SAMPLE_RATE || '8000';
  const params = new URLSearchParams({
    'sample-rate': sampleRate,
  });

  if (from) params.set('caller_number', from);
  if (to) params.set('called_number', to);

  const separator = MEDIA_STREAM_URL.includes('?') ? '&' : '?';
  return `${MEDIA_STREAM_URL}${separator}${params.toString()}`;
}

// ─── Middleware: secret-token guard ──────────────────────────────────────────

/**
 * Validate an optional shared secret appended to the Exotel webhook URL.
 *
 * Configure in Exotel dashboard:
 *   Passthru URL: https://your-server.com/exotel/incoming?token=YOUR_SECRET
 *
 * If EXOTEL_WEBHOOK_SECRET is blank, validation is skipped (dev mode).
 */
function secretGuard(req, res, next) {
  if (!WEBHOOK_SECRET) return next();

  const provided = req.query.token || req.headers['x-exotel-token'];
  if (provided !== WEBHOOK_SECRET) {
    log.warn('Exotel webhook: invalid secret token', {
      ip     : req.ip,
      path   : req.path,
      provided: provided ? provided.slice(0, 6) + '…' : '(none)',
    });
    return res.status(403).type('text/plain').send('Forbidden');
  }
  return next();
}

// ─── Middleware: Exotel IP whitelist (optional) ───────────────────────────────

function ipGuard(req, res, next) {
  if (!VALIDATE_IP) return next();

  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    ''
  );

  const allowed = EXOTEL_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
  if (!allowed) {
    log.warn('Exotel webhook: IP not in whitelist', { ip });
    return res.status(403).type('text/plain').send('Forbidden');
  }
  return next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendExoML(res, xml, status = 200) {
  res.status(status).type('text/xml').send(xml);
}

function maskNumber(n) {
  if (!n || n.length < 4) return '****';
  return n.replace(/\d(?=\d{4})/g, '*');
}

function getWebhookPayload(req) {
  if (req.method === 'GET') {
    return req.query || {};
  }
  return req.body || {};
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return '';
}

function parseJsonSafely(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normaliseExotelStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'cancelled') return 'canceled';
  return value;
}

function extractStreamMetadata(payload) {
  const streamValue = payload.Stream;
  const streamObject = (
    streamValue && typeof streamValue === 'object'
      ? streamValue
      : parseJsonSafely(streamValue)
  ) || {};

  return {
    status: firstNonEmpty(
      payload['Stream[Status]'],
      streamObject.Status,
      streamObject.status,
    ),
    duration: firstNonEmpty(
      payload['Stream[Duration]'],
      streamObject.Duration,
      streamObject.duration,
    ),
    streamSid: firstNonEmpty(
      payload['Stream[StreamSID]'],
      streamObject.StreamSID,
      streamObject.stream_sid,
    ),
    recordingUrl: firstNonEmpty(
      payload['Stream[RecordingUrl]'],
      streamObject.RecordingUrl,
      streamObject.recording_url,
    ),
    streamUrl: firstNonEmpty(
      payload['Stream[StreamUrl]'],
      streamObject.StreamUrl,
      streamObject.stream_url,
    ),
    disconnectedBy: firstNonEmpty(
      payload['Stream[DisconnectedBy]'],
      streamObject.DisconnectedBy,
      streamObject.disconnected_by,
    ),
    detailedStatus: firstNonEmpty(
      payload['Stream[DetailedStatus]'],
      streamObject.DetailedStatus,
      streamObject.detailed_status,
    ),
    error: firstNonEmpty(
      payload['Stream[Error]'],
      streamObject.Error,
      streamObject.error,
    ),
  };
}

function normaliseExotelCallback(req) {
  const payload = getWebhookPayload(req);
  const stream = extractStreamMetadata(payload);

  return {
    raw: payload,
    stream,
    callSid: firstNonEmpty(payload.CallSid, payload.call_sid),
    from: firstNonEmpty(payload.CallFrom, payload.From, payload.from),
    to: firstNonEmpty(payload.CallTo, payload.To, payload.to),
    direction: firstNonEmpty(payload.Direction, payload.direction, 'incoming'),
    callType: firstNonEmpty(payload.CallType, payload.call_type),
    callStatus: normaliseExotelStatus(
      firstNonEmpty(payload.CallStatus, payload.Status, payload.status),
    ),
    dialCallStatus: normaliseExotelStatus(payload.DialCallStatus),
    streamStatus: normaliseExotelStatus(stream.status),
    duration: firstNonEmpty(
      stream.duration,
      payload.DialCallDuration,
      payload.RecordingDuration,
      payload.CallDuration,
      '0',
    ),
  };
}

/**
 * Guess language from Indian mobile number.
 * +91 70/71/72/73/74 → West Bengal → Bengali hint
 * Everything else   → Hindi (default for India)
 */
function guessLanguageFromNumber(from) {
  if (typeof from !== 'string') return 'hi';
  const local = from.replace(/^\+91/, '').replace(/^0/, '');
  // West Bengal Jio/Airtel prefixes (rough heuristic)
  if (/^(70|71|72|73|74|90|91|98|97)/.test(local) && from.startsWith('+9133')) return 'bn';
  return process.env.DEFAULT_LANGUAGE || 'hi';
}

// ─── Route: GET|POST /exotel/incoming ─────────────────────────────────────────

/**
 * Exotel entrypoint.
 *
 * Two supported flows:
 *   1. Voicebot Applet dynamic URL resolution:
 *        GET /exotel/incoming   → returns { url: "wss://..." }
 *   2. Legacy passthru/status callbacks:
 *        GET|POST /exotel/incoming with call fields
 *
 * Exotel callback fields (selected):
 *   CallSid          Unique call identifier (same name as Twilio ✅)
 *   From             Caller number  e.g. +919XXXXXXXXX
 *   To               Your Exophone  e.g. 040XXXXXXXX
 *   Status           ringing | in-progress | completed | busy | failed
 *   Direction        inbound | outbound
 *   CallType         trans | incomplete
 *
 * Configure in Exotel dashboard:
 *   App → New App → Passthru → Passthru URL: https://your-server/exotel/incoming
 */
router.route('/incoming')
  .get(ipGuard, secretGuard, handleIncomingResolver)
  .post(ipGuard, secretGuard, handleIncomingWebhook);

function handleIncomingResolver(req, res) {
  const callback = normaliseExotelCallback(req);
  const url = buildExotelStreamUrl({
    from: callback.from,
    to: callback.to,
  });

  log.info('Resolved Exotel voicebot stream URL', {
    callSid: callback.callSid,
    from: maskNumber(callback.from),
    to: maskNumber(callback.to),
    direction: callback.direction,
    ip: req.ip,
    url,
  });

  res.set('Cache-Control', 'no-store');
  return res.json({ url });
}

function handleIncomingWebhook(req, res) {
  const callback = normaliseExotelCallback(req);
  const {
    callSid,
    from,
    to,
    callStatus,
    direction,
  } = callback;

  log.info('Exotel inbound call', {
    callSid,
    from     : maskNumber(from),
    to       : maskNumber(to),
    status   : callStatus,
    direction,
    ip       : req.ip,
  });

  if (!callSid) {
    log.error('Missing CallSid in /exotel/incoming');
    return sendExoML(res, buildErrorExoML(), 400);
  }

  try {
    const { twiml, callRecord } = callHandler.handleIncoming({
      CallSid: callSid,
      From: from,
      To: to,
      Direction: direction,
      CallStatus: callStatus,
    });

    if (callRecord) {
      callRecord.language = guessLanguageFromNumber(from);
    }

    // Legacy/compatibility path: if Exotel is configured to expect XML here,
    // return the media-stream response instead of dropping the call.
    return sendExoML(res, twiml);

  } catch (err) {
    log.error('Error in /exotel/incoming', { err: err.message, callSid });
    return sendExoML(res, buildErrorExoML());
  }
}

// ─── Route: GET|POST /exotel/status ───────────────────────────────────────────

/**
 * Exotel status-callback endpoint.
 *
 * Configure in Exotel dashboard:
 *   App → Status Callback URL: https://your-server/exotel/status
 *
 * Exotel status values: ringing | in-progress | completed | busy |
 *                        no-answer | failed | canceled
 *
 * Note: Exotel sends `Status` not `CallStatus` – we normalise below.
 */
router.route('/status')
  .get(ipGuard, secretGuard, handleStatusWebhook)
  .post(ipGuard, secretGuard, handleStatusWebhook);

function handleStatusWebhook(req, res) {
  const callback = normaliseExotelCallback(req);
  const {
    callSid,
    callStatus,
    dialCallStatus,
    streamStatus,
    duration,
    from,
    to,
    stream,
  } = callback;
  const status = streamStatus || callStatus || dialCallStatus;

  log.info('Exotel status callback', {
    callSid,
    status  : status || '(none)',
    callStatus: callStatus || 'N/A',
    dialCallStatus: dialCallStatus || 'N/A',
    streamStatus: streamStatus || 'N/A',
    duration: duration || 'N/A',
    disconnectedBy: stream.disconnectedBy || 'N/A',
    from    : maskNumber(from),
    to      : maskNumber(to),
  });

  if (callSid && status) {
    const errorMessage = firstNonEmpty(
      stream.error,
      stream.detailedStatus,
      stream.disconnectedBy ? `Disconnected by ${stream.disconnectedBy}` : '',
    );

    callHandler.handleStatusUpdate({
      CallSid: callSid,
      CallStatus: status,
      CallDuration: duration,
      ErrorCode: '',
      ErrorMessage: errorMessage,
    });
  } else if (callSid) {
    log.info('Ignoring Exotel callback without a usable status', { callSid });
    log.warn(
      'Exotel callback arrived without stream status; this usually means the call flow hit a Passthru applet instead of a Voicebot applet, or Exotel never opened the WebSocket',
      {
        callSid,
        from: maskNumber(from),
        to: maskNumber(to),
        hasStreamSid: Boolean(stream.streamSid),
        hasStreamUrl: Boolean(stream.streamUrl),
      },
    );
  }

  return res.status(204).end();
}

// ─── Route: GET|POST /exotel/fallback ─────────────────────────────────────────

/**
 * Fallback – Exotel hits this if /exotel/incoming returns a 5xx or times out.
 *
 * Configure in Exotel dashboard:
 *   App → Fallback URL: https://your-server/exotel/fallback
 */
router.route('/fallback')
  .get(handleFallbackWebhook)
  .post(handleFallbackWebhook);

function handleFallbackWebhook(req, res) {
  const payload = getWebhookPayload(req);
  const { CallSid = 'unknown' } = payload;
  log.warn('Exotel fallback webhook triggered', { callSid: CallSid });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN">
    Khed hai, abhi kuch technical samasya aa rahi hai.
    Kripya 2 minute baad dobara call karein. Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();

  return sendExoML(res, xml);
}

// ─── Route: GET /exotel/test ──────────────────────────────────────────────────

/**
 * Dev smoke-test – returns sample ExoML to verify your ngrok tunnel.
 * Disabled in production.
 */
router.get('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const wsUrl = buildExotelStreamUrl() || 'wss://your-server.ngrok-free.app/media-stream?sample-rate=8000';

  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- DialAI Bharat – Exotel ExoML (test mode) -->
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid"  value="EXtest123"/>
      <Parameter name="provider" value="exotel"/>
      <Parameter name="version"  value="1.0"/>
    </Stream>
  </Connect>
</Response>`.trim();

  log.info('Exotel test endpoint hit', { ip: req.ip });
  return sendExoML(res, sample);
});

// ─── ExoML builders ───────────────────────────────────────────────────────────

/**
 * Generic error ExoML – spoken in Hindi, then hangs up.
 * Exotel <Say> does not support Polly voices; plain language attr is used.
 */
function buildErrorExoML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN">
    Khed hai, abhi kuch technical samasya aa rahi hai.
    Kripya thodi der baad dobara call karein. Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { router, buildErrorExoML };
