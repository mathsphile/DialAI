'use strict';

const express = require('express');
const os      = require('os');
const process = require('process');
const router  = express.Router();

let cacheModule       = null;
let activeCallsGetter = null;

function registerStatsProvider(fn) {
  activeCallsGetter = fn;
}

function getCache() {
  if (!cacheModule) cacheModule = require('../utils/cache');
  return cacheModule;
}

const START_TIME = Date.now();
const uptimeSeconds = () => Math.floor((Date.now() - START_TIME) / 1000);

function envFlags() {
  return {
    node_env          : process.env.NODE_ENV || 'development',
    telephony_provider: 'exotel',
    elevenlabs_agent  : process.env.ELEVENLABS_AGENT_ID ? 'configured' : 'not-configured',
    exotel_sid        : process.env.EXOTEL_SID ? 'set' : 'not-set',
  };
}

function requireSecret(req, res, next) {
  const secret = process.env.HEALTH_SECRET;
  if (!secret) return next();
  const provided = req.headers['x-health-secret'] || req.query.secret;
  if (provided !== secret) return res.status(403).json({ error: 'forbidden' });
  next();
}

router.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'dialai', uptime_s: uptimeSeconds() });
});

router.get('/detailed', requireSecret, (req, res) => {
  const callStats = activeCallsGetter ? activeCallsGetter() : {};
  const cache     = getCache();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_s: uptimeSeconds(),
    environment: envFlags(),
    calls: callStats,
    cache: cache.getStats(),
    services: {
      elevenlabs: {
        agent_id: process.env.ELEVENLABS_AGENT_ID || 'not-set',
        model: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      },
      exotel: {
        sid_set: !!process.env.EXOTEL_SID,
        api_key_set: !!process.env.EXOTEL_API_KEY,
      }
    }
  });
});

module.exports = { router, registerStatsProvider };
