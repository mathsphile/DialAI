'use strict';

/**
 * health.js – Health & Diagnostics Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /health          → Quick liveness check (load-balancer / uptime monitor)
 * GET /health/detailed → Full system status (protected by HEALTH_SECRET)
 * GET /health/metrics  → Prometheus-compatible text metrics (optional)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const os      = require('os');
const process = require('process');

const router  = express.Router();

// Lazy-loaded to avoid circular deps at startup
let cacheModule       = null;
let activeCallsGetter = null;

/**
 * Register a callback that returns live call/stream stats.
 * Called from server.js after bridge is initialised.
 *
 * @param {() => object} fn
 */
function registerStatsProvider(fn) {
  activeCallsGetter = fn;
}

function getCache() {
  if (!cacheModule) cacheModule = require('../utils/cache');
  return cacheModule;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const START_TIME = Date.now();

function uptimeSeconds() {
  return Math.floor((Date.now() - START_TIME) / 1000);
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function bytesToMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function memorySnapshot() {
  const mem = process.memoryUsage();
  return {
    rss_mb       : bytesToMB(mem.rss),
    heap_used_mb : bytesToMB(mem.heapUsed),
    heap_total_mb: bytesToMB(mem.heapTotal),
    external_mb  : bytesToMB(mem.external),
  };
}

function cpuSnapshot() {
  const cpus = os.cpus();
  return {
    model : cpus[0]?.model ?? 'unknown',
    cores : cpus.length,
    load_avg_1m: os.loadavg()[0].toFixed(2),
  };
}

function envFlags() {
  return {
    node_env          : process.env.NODE_ENV || 'development',
    telephony_provider: process.env.TELEPHONY_PROVIDER || 'twilio',
    elevenlabs_agent  : process.env.ELEVENLABS_AGENT_ID ? 'configured' : 'not-configured',
    twilio_number     : process.env.TWILIO_PHONE_NUMBER
      ? `***${process.env.TWILIO_PHONE_NUMBER.slice(-4)}`
      : 'not-set',
    cache_ttl_s       : process.env.CACHE_TTL_SECONDS || '300',
    log_level         : process.env.LOG_LEVEL || 'info',
  };
}

// ─── Middleware: secret guard for /health/detailed ────────────────────────────

function requireSecret(req, res, next) {
  const secret = process.env.HEALTH_SECRET;
  if (!secret) return next(); // no secret configured → open

  const provided =
    req.headers['x-health-secret'] ||
    req.query.secret;

  if (provided !== secret) {
    return res.status(403).json({
      status : 'forbidden',
      message: 'Provide the correct X-Health-Secret header or ?secret= query param.',
    });
  }
  return next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Minimal liveness probe.  Returns 200 while the process is alive.
 * Designed for AWS ALB / GCP LB / Kubernetes readiness probes.
 */
router.get('/', (_req, res) => {
  res.status(200).json({
    status   : 'ok',
    service  : 'dialai-bharat',
    timestamp: new Date().toISOString(),
    uptime_s : uptimeSeconds(),
  });
});

/**
 * GET /health/detailed
 * Full system status breakdown. Protected by HEALTH_SECRET env var.
 */
router.get('/detailed', requireSecret, (req, res) => {
  const callStats = activeCallsGetter ? activeCallsGetter() : {};
  const cache     = getCache();

  const status = {
    status   : 'ok',
    service  : 'dialai-bharat',
    version  : process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),

    uptime: {
      seconds  : uptimeSeconds(),
      human    : formatUptime(uptimeSeconds()),
      started_at: new Date(START_TIME).toISOString(),
    },

    process: {
      pid      : process.pid,
      node_ver : process.version,
      platform : process.platform,
      arch     : process.arch,
      memory   : memorySnapshot(),
      cpu      : cpuSnapshot(),
    },

    environment: envFlags(),

    calls: callStats,

    cache: cache.getStats(),

    services: {
      elevenlabs: {
        api_key_set : !!process.env.ELEVENLABS_API_KEY,
        agent_id_set: !!process.env.ELEVENLABS_AGENT_ID,
        model       : process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        voice_id    : process.env.ELEVENLABS_VOICE_ID
          ? `***${process.env.ELEVENLABS_VOICE_ID.slice(-6)}`
          : 'not-set',
      },
      twilio: {
        account_sid_set : !!process.env.TWILIO_ACCOUNT_SID,
        auth_token_set  : !!process.env.TWILIO_AUTH_TOKEN,
        phone_number    : process.env.TWILIO_PHONE_NUMBER
          ? `***${process.env.TWILIO_PHONE_NUMBER.slice(-4)}`
          : 'not-set',
        validate_webhook: process.env.TWILIO_VALIDATE_WEBHOOK === 'true',
      },
    },

    audio: {
      twilio_sample_rate    : parseInt(process.env.TWILIO_SAMPLE_RATE     || '8000',  10),
      elevenlabs_sample_rate: parseInt(process.env.ELEVENLABS_SAMPLE_RATE || '16000', 10),
      twilio_encoding       : process.env.AUDIO_ENCODING_TWILIO     || 'mulaw',
      elevenlabs_encoding   : process.env.AUDIO_ENCODING_ELEVENLABS || 'pcm',
      flush_interval_ms     : parseInt(process.env.AUDIO_FLUSH_INTERVAL_MS || '100', 10),
    },

    limits: {
      max_concurrent_calls: parseInt(process.env.MAX_CONCURRENT_CALLS || '50', 10),
      max_ws_per_ip       : parseInt(process.env.MAX_WS_PER_IP        || '5',  10),
    },
  };

  // Degrade gracefully if anything is critically misconfigured
  if (!process.env.ELEVENLABS_API_KEY || !process.env.TWILIO_ACCOUNT_SID) {
    status.status = 'degraded';
    status.warnings = [];
    if (!process.env.ELEVENLABS_API_KEY) {
      status.warnings.push('ELEVENLABS_API_KEY is not set');
    }
    if (!process.env.TWILIO_ACCOUNT_SID) {
      status.warnings.push('TWILIO_ACCOUNT_SID is not set');
    }
  }

  res.status(status.status === 'ok' ? 200 : 207).json(status);
});

/**
 * GET /health/metrics
 * Prometheus-style plain-text metrics endpoint.
 * Useful when scraping with Prometheus or Grafana Agent.
 */
router.get('/metrics', requireSecret, (req, res) => {
  const callStats = activeCallsGetter ? activeCallsGetter() : {};
  const cache     = getCache().getStats();
  const mem       = process.memoryUsage();

  const lines = [
    `# HELP dialai_uptime_seconds Server uptime in seconds`,
    `# TYPE dialai_uptime_seconds gauge`,
    `dialai_uptime_seconds ${uptimeSeconds()}`,
    ``,
    `# HELP dialai_active_calls Currently bridged live calls`,
    `# TYPE dialai_active_calls gauge`,
    `dialai_active_calls ${callStats.active ?? 0}`,
    ``,
    `# HELP dialai_total_calls_handled Total calls handled since start`,
    `# TYPE dialai_total_calls_handled counter`,
    `dialai_total_calls_handled ${callStats.totalHandled ?? 0}`,
    ``,
    `# HELP dialai_cache_hits Total cache hits`,
    `# TYPE dialai_cache_hits counter`,
    `dialai_cache_hits ${cache.hits}`,
    ``,
    `# HELP dialai_cache_misses Total cache misses`,
    `# TYPE dialai_cache_misses counter`,
    `dialai_cache_misses ${cache.misses}`,
    ``,
    `# HELP dialai_cache_keys Current number of cached keys`,
    `# TYPE dialai_cache_keys gauge`,
    `dialai_cache_keys ${cache.currentKeys}`,
    ``,
    `# HELP dialai_heap_used_bytes Node.js heap used`,
    `# TYPE dialai_heap_used_bytes gauge`,
    `dialai_heap_used_bytes ${mem.heapUsed}`,
    ``,
    `# HELP dialai_rss_bytes Node.js RSS memory`,
    `# TYPE dialai_rss_bytes gauge`,
    `dialai_rss_bytes ${mem.rss}`,
  ];

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(lines.join('\n') + '\n');
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { router, registerStatsProvider };
