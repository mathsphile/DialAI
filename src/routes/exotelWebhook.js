'use strict';

const express = require('express');
const { logger } = require('../utils/logger');

const router = express.Router();
const log = logger.forModule('exotelWebhook');

router.get('/incoming', (req, res) => {
  const serverUrl = process.env.SERVER_URL || `https://${req.get('host')}`;
  const wsUrl = serverUrl.replace(/^https?:\/\//, 'wss://') + '/media-stream';
  
  log.info('Exotel Voicebot Request', { sid: req.query.CallSid, wsUrl });
  
  // Return the simple JSON format that Exotel Voicebot expects
  res.status(200).json({ url: wsUrl });
});

router.post('/incoming', (req, res) => {
  const serverUrl = process.env.SERVER_URL || `https://${req.get('host')}`;
  const wsUrl = serverUrl.replace(/^https?:\/\//, 'wss://') + '/media-stream';
  const callSid = req.body.CallSid || 'unknown';

  log.info('Exotel Passthru Request', { sid: callSid });

  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect><Stream url="${wsUrl}"><Parameter name="callSid" value="${callSid}" /></Stream></Connect>
</Response>`;

  res.status(200).type('text/xml').send(response);
});

router.post('/status', (req, res) => res.status(204).end());

module.exports = { router };
