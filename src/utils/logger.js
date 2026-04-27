'use strict';

/**
 * DialAI – Structured Logger
 * ------------------------------------
 * Winston-based logger with:
 *  • Console + rotating-file transports
 *  • Call-ID / Stream-ID correlation via AsyncLocalStorage
 *  • Colour-coded log levels for dev readability
 *  • JSON structured output for production log aggregators
 */

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, errors, json, metadata } = format;
const path   = require('path');
const fs     = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

// ─── Correlation context (call-scoped) ────────────────────────────────────────
const callContext = new AsyncLocalStorage();

/**
 * Run fn() inside a call-scoped log context.
 * Any logger calls inside fn() will automatically include the metadata.
 *
 * @param {{ callSid?: string, streamSid?: string, conversationId?: string }} ctx
 * @param {Function} fn
 */
function runWithCallContext(ctx, fn) {
  return callContext.run(ctx, fn);
}

/** Returns the current call context, or an empty object. */
function getCallContext() {
  return callContext.getStore() || {};
}

// ─── Log directory ─────────────────────────────────────────────────────────────
const LOG_DIR  = process.env.LOG_DIR  || path.join(process.cwd(), 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const TO_FILE   = process.env.LOG_TO_FILE !== 'false';   // default true
const IS_PROD   = process.env.NODE_ENV === 'production';

if (TO_FILE && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ─── Custom formats ────────────────────────────────────────────────────────────

/** Injects call-context fields into every log entry. */
const injectCallContext = format((info) => {
  const ctx = getCallContext();
  if (ctx.callSid)        info.callSid        = ctx.callSid;
  if (ctx.streamSid)      info.streamSid      = ctx.streamSid;
  if (ctx.conversationId) info.conversationId = ctx.conversationId;
  if (ctx.language)       info.language       = ctx.language;
  return info;
});

/** Human-readable format for development console. */
const devFormat = printf(({ level, message, timestamp: ts, callSid, streamSid, stack, ...rest }) => {
  let base = `${ts} [${level}]`;
  if (callSid)   base += ` [call:${callSid.slice(-8)}]`;
  if (streamSid) base += ` [stream:${streamSid.slice(-8)}]`;
  base += `  ${stack || message}`;

  // Append any extra metadata (excluding internal Winston fields)
  const SKIP = new Set(['splat', 'service']);
  const extra = Object.entries(rest).filter(([k]) => !SKIP.has(k));
  if (extra.length > 0) {
    base += `  ${JSON.stringify(Object.fromEntries(extra))}`;
  }
  return base;
});

// ─── Transport factory ──────────────────────────────────────────────────────────
function makeFileTransport(filename, level) {
  return new transports.File({
    filename : path.join(LOG_DIR, filename),
    level,
    maxsize : 10 * 1024 * 1024,   // 10 MB per file
    maxFiles: 7,                   // keep 7 rotated files
    tailable: true,
    format  : combine(timestamp(), injectCallContext(), errors({ stack: true }), json()),
  });
}

// ─── Logger instance ────────────────────────────────────────────────────────────
const logger = createLogger({
  level      : LOG_LEVEL,
  defaultMeta: { service: 'dialai' },
  exitOnError: false,
  transports : [
    // ── Console ──────────────────────────────────────────────────────────────
    new transports.Console({
      format: IS_PROD
        ? combine(timestamp(), injectCallContext(), errors({ stack: true }), json())
        : combine(
            colorize({ all: true }),
            timestamp({ format: 'HH:mm:ss.SSS' }),
            injectCallContext(),
            errors({ stack: true }),
            devFormat,
          ),
    }),

    // ── Files (optional) ──────────────────────────────────────────────────────
    ...(TO_FILE
      ? [
          makeFileTransport('combined.log', 'info'),
          makeFileTransport('error.log',    'error'),
        ]
      : []),
  ],
});

// ─── Convenience child-logger factory ──────────────────────────────────────────
/**
 * Returns a child logger pre-tagged with a module name.
 *
 * @param {string} module  e.g. 'audioStreamBridge'
 * @returns {import('winston').Logger}
 *
 * @example
 *   const log = logger.child({ module: 'audioStreamBridge' });
 *   log.info('connected');
 */
logger.forModule = function forModule(module) {
  return this.child({ module });
};

// ─── Unhandled rejection / exception catching ───────────────────────────────────
if (!IS_PROD) {
  // In dev, print full stack; in prod these are captured by a process manager
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', { reason: String(reason), stack: reason?.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

// ─── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
  logger,
  runWithCallContext,
  getCallContext,
};
