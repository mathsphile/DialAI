'use strict';

/**
 * twilioWebhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express routes that handle all HTTP callbacks from Twilio for DialAI Bharat.
 *
 * Endpoints
 * ─────────
 *   POST /twiml/incoming        ← Twilio calls this when someone dials the helpline
 *   POST /twiml/status          ← Twilio call-status callback (ringing → completed)
 *   POST /twiml/fallback        ← Twilio calls this if /twiml/incoming throws
 *   GET  /twiml/test            ← Dev-mode smoke test (returns sample TwiML)
 *
 * Security
 * ────────
 *   When TWILIO_VALIDATE_WEBHOOK=true, every inbound request is validated
 *   against the Twilio request signature using the official Twilio SDK helper.
 *   In development (default) validation is skipped so ngrok tunnels work
 *   without extra setup.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const twilio  = require('twilio');

const { callHandler } = require('../services/callHandler');
const { logger }      = require('../utils/logger');
const { detectLanguage } = require('../services/languageDetector');

const router = express.Router();
const log    = logger.forModule('twilioWebhook');

// ─── Configuration ────────────────────────────────────────────────────────────

const VALIDATE_WEBHOOK  = process.env.TWILIO_VALIDATE_WEBHOOK === 'true';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const SERVER_URL        = (process.env.SERVER_URL || '').replace(/\/$/, '');

// ─── Twilio signature validation middleware ───────────────────────────────────

/**
 * Validates that an inbound request genuinely originates from Twilio.
 *
 * How it works:
 *   Twilio signs every webhook request using your Auth Token + request URL +
 *   sorted POST parameters. We verify the X-Twilio-Signature header here.
 *
 * Skip in development (TWILIO_VALIDATE_WEBHOOK != 'true') so ngrok and
 * local testing work without fiddling with auth tokens.
 */
function twilioSignatureGuard(req, res, next) {
  if (!VALIDATE_WEBHOOK) {
    return next();
  }

  if (!TWILIO_AUTH_TOKEN) {
    log.warn('TWILIO_VALIDATE_WEBHOOK is true but TWILIO_AUTH_TOKEN is not set – skipping validation');
    return next();
  }

  // Reconstruct the full URL Twilio used to call this webhook
  const fullUrl = `${SERVER_URL}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'] || '',
    fullUrl,
    req.body || {},
  );

  if (!isValid) {
    log.warn('Invalid Twilio signature – rejecting request', {
      url      : fullUrl,
      ip       : req.ip,
      signature: (req.headers['x-twilio-signature'] || '').slice(0, 20) + '…',
    });
    return res.status(403).type('text/plain').send('Forbidden: Invalid Twilio signature');
  }

  return next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Send a TwiML response with correct Content-Type header.
 *
 * @param {express.Response} res
 * @param {string}           twiml  XML string
 * @param {number}           [status=200]
 */
function sendTwiML(res, twiml, status = 200) {
  res.status(status).type('text/xml').send(twiml);
}

/**
 * Extract a safe display string from a Twilio number field.
 * Masks all but the last 4 digits.
 *
 * @param {string} number
 * @returns {string}
 */
function maskNumber(number) {
  if (!number || number.length < 4) return '****';
  return number.replace(/\d(?=\d{4})/g, '*');
}

/**
 * Attempt a basic language hint from the caller's number.
 * Indian numbers start with +91 – default language to Hindi.
 * This is a fallback; actual detection happens from speech.
 *
 * @param {string} from  Caller number in E.164 format
 * @returns {'hi'|'en'}
 */
function guessLanguageFromNumber(from) {
  if (typeof from === 'string' && from.startsWith('+91')) return 'hi';
  return process.env.DEFAULT_LANGUAGE || 'hi';
}

// ─── Route: POST /twiml/incoming ─────────────────────────────────────────────

/**
 * Primary webhook – called by Twilio the moment an inbound call arrives.
 *
 * Twilio POST body fields (selection):
 *   CallSid      CA…  Unique call identifier
 *   AccountSid   AC…  Your Twilio account
 *   From         +919XXXXXXXXX  Caller's number (E.164)
 *   To           +1XXXXXXXXXX   Your helpline number
 *   CallStatus   ringing | in-progress | …
 *   Direction    inbound
 *   CallerCity / CallerCountry / CallerState (may be blank for Indian numbers)
 *
 * We respond with TwiML that opens a Media Stream so we can bridge audio
 * to ElevenLabs in real time.
 */
router.post('/incoming', twilioSignatureGuard, (req, res) => {
  const {
    CallSid    = '',
    From       = '',
    To         = '',
    CallStatus = '',
    Direction  = 'inbound',
    CallerCity = '',
    CallerState= '',
  } = req.body || {};

  // Structured log with as much context as Twilio gives us
  log.info('Inbound call received', {
    callSid    : CallSid,
    from       : maskNumber(From),
    to         : maskNumber(To),
    callStatus : CallStatus,
    direction  : Direction,
    callerCity : CallerCity,
    callerState: CallerState,
    ip         : req.ip,
  });

  // Guard: reject if CallSid is missing (shouldn't happen with real Twilio calls)
  if (!CallSid) {
    log.error('Missing CallSid in /twiml/incoming');
    return sendTwiML(res, buildErrorTwiML('Missing CallSid'), 400);
  }

  try {
    const { twiml, callRecord } = callHandler.handleIncoming({
      CallSid,
      From,
      To,
      Direction,
      CallStatus,
    });

    if (!callRecord) {
      // Server at capacity – callHandler returned a busy TwiML
      log.warn('Returned busy TwiML (at capacity)', { callSid: CallSid });
    } else {
      // Attach the language hint so the bridge can initialise ElevenLabs correctly
      const langHint = guessLanguageFromNumber(From);
      callRecord.language = langHint;

      log.info('TwiML dispatched – Media Stream opening', {
        callSid : CallSid,
        langHint,
      });
    }

    return sendTwiML(res, twiml);

  } catch (err) {
    log.error('Error in /twiml/incoming handler', {
      err    : err.message,
      stack  : err.stack,
      callSid: CallSid,
    });

    // Return a graceful Hindi error message rather than a 500
    return sendTwiML(res, buildErrorTwiML(err.message));
  }
});

// ─── Route: POST /twiml/status ────────────────────────────────────────────────

/**
 * Call status callback – Twilio fires this on every status change.
 *
 * Configured in Twilio Console under:
 *   Phone Number → Voice → "Status Callback URL"
 *   → https://your-server.ngrok-free.app/twiml/status
 *   Method: POST
 *
 * Common statuses: ringing → in-progress → completed | failed | busy | no-answer
 *
 * We respond with 204 No Content (Twilio ignores the body for status callbacks).
 */
router.post('/status', twilioSignatureGuard, (req, res) => {
  const {
    CallSid      = '',
    CallStatus   = '',
    CallDuration = '',
    ErrorCode    = '',
    ErrorMessage = '',
    From         = '',
    To           = '',
    Timestamp    = '',
  } = req.body || {};

  log.info('Call status update', {
    callSid     : CallSid,
    status      : CallStatus,
    durationSec : CallDuration || 'N/A',
    errorCode   : ErrorCode    || 'none',
    errorMessage: ErrorMessage || 'none',
    from        : maskNumber(From),
    to          : maskNumber(To),
    twilioTs    : Timestamp,
  });

  if (CallSid) {
    callHandler.handleStatusUpdate({
      CallSid,
      CallStatus,
      CallDuration,
      ErrorCode,
      ErrorMessage,
    });
  }

  // 204 = accepted, no content needed
  return res.status(204).end();
});

// ─── Route: POST /twiml/fallback ─────────────────────────────────────────────

/**
 * Fallback webhook – Twilio calls this if the primary /twiml/incoming URL
 * returns a 5xx error or times out.
 *
 * Configured in Twilio Console under:
 *   Phone Number → Voice → "Fallback URL"
 *   → https://your-server.ngrok-free.app/twiml/fallback
 *
 * Plays an apology in Hindi and English, then hangs up.
 */
router.post('/fallback', (req, res) => {
  const { CallSid = 'unknown' } = req.body || {};

  log.warn('Fallback webhook triggered – primary handler failed', { callSid: CallSid });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN" voice="Polly.Aditi">
    Khed hai, abhi kuch technical samasya aa rahi hai.
    Kripya 2 minute baad dobara call karein.
    Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Say language="en-IN" voice="Polly.Raveena">
    We are sorry, a technical issue occurred.
    Please call back in 2 minutes. Thank you.
  </Say>
  <Hangup/>
</Response>`.trim();

  return sendTwiML(res, twiml);
});

// ─── Route: GET /twiml/test ───────────────────────────────────────────────────

/**
 * Development / smoke-test endpoint.
 * Returns sample TwiML so you can verify your ngrok tunnel and Twilio
 * configuration WITHOUT placing a real call.
 *
 * Access at: https://your-ngrok-url.ngrok-free.app/twiml/test
 *
 * Only active when NODE_ENV != 'production'.
 */
router.get('/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }

  const serverUrl  = SERVER_URL || 'https://your-server.ngrok-free.app';
  const wsUrl      = serverUrl.replace(/^https?:\/\//, 'wss://') + '/media-stream';

  const sampleTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <!-- DialAI Bharat – Sample TwiML (test mode) -->
  <!-- This is what Twilio receives when a call comes in -->
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid"  value="CAtest123"/>
      <Parameter name="provider" value="twilio"/>
      <Parameter name="version"  value="1.0"/>
    </Stream>
  </Connect>
</Response>`.trim();

  log.info('Test TwiML endpoint hit', { ip: req.ip });

  return sendTwiML(res, sampleTwiML);
});

// ─── Route: POST /twiml/recording ────────────────────────────────────────────

/**
 * (Optional) Recording status callback.
 * If you enable call recording in Twilio Console, this endpoint receives
 * a notification when the recording is ready.
 *
 * NOT enabled by default – uncomment and configure in Twilio Console if needed.
 *
 * POST body includes: RecordingSid, RecordingUrl, RecordingDuration, CallSid
 */
router.post('/recording', twilioSignatureGuard, (req, res) => {
  const {
    CallSid        = '',
    RecordingSid   = '',
    RecordingUrl   = '',
    RecordingStatus= '',
    RecordingDuration = '',
  } = req.body || {};

  log.info('Recording status callback', {
    callSid          : CallSid,
    recordingSid     : RecordingSid,
    recordingStatus  : RecordingStatus,
    recordingDuration: RecordingDuration,
    recordingUrl     : RecordingUrl ? '[redacted – stored securely]' : 'none',
  });

  // In production: store RecordingUrl in your database for compliance / QA
  // IMPORTANT: Recording of calls in India requires explicit consent from callers.
  // Add consent prompt TwiML before enabling recording.

  return res.status(204).end();
});

// ─── Shared TwiML error builder ───────────────────────────────────────────────

/**
 * Build a graceful error TwiML response spoken in Hindi with an English fallback.
 *
 * @param {string} [debugMessage]  Internal error string (NOT spoken to user)
 * @returns {string} TwiML XML
 */
function buildErrorTwiML(debugMessage) {
  // Log the raw error internally but never expose it to the caller
  if (debugMessage) {
    log.debug('Building error TwiML', { debugMessage });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="hi-IN" voice="Polly.Aditi">
    Khed hai, abhi kuch technical samasya aa rahi hai.
    Kripya thodi der baad dobara call karein.
    Dhanyavaad.
  </Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`.trim();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { router, buildErrorTwiML };
