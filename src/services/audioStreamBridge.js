'use strict';

const WebSocket = require('ws');
const { logger, runWithCallContext } = require('../utils/logger');
const { mulawToLinear16, base64PCMToBase64Mulaw } = require('../utils/audioConverter');
const { createSession }  = require('./elevenLabsAgentService');

const log = logger.forModule('audioStreamBridge');

class BridgeSession {
  constructor(ws) {
    this.ws = ws;
    this.sid = null;
    this.el = null;
    this.queue = [];
    this.timer = null;
    this.ts = 0;
  }

  async start(data) {
    try {
      this.sid = data.streamSid || data.stream_sid;
      log.info('Media Stream Started Event', { sid: this.sid });
      
      await runWithCallContext({ callSid: this.sid }, async () => {
        log.info('Connecting to ElevenLabs...');
        this.el = await createSession({ callSid: this.sid });
        log.info('ElevenLabs Session Ready');

        this.el.on('audio', (pcm, id, rate) => {
          const mulaw = base64PCMToBase64Mulaw(pcm, rate);
          if (!mulaw) return;
          const buf = Buffer.from(mulaw, 'base64');
          for (let i = 0; i < buf.length; i += 160) {
            this.queue.push(buf.slice(i, i + 160).toString('base64'));
          }
        });

        this.el.on('close', () => this.stop('elevenlabs-closed'));
        this.el.on('error', (err) => log.error('ElevenLabs Error', { err: err.message }));
        
        this._drain();
      });
    } catch (err) {
      log.error('BridgeSession Start Error', { err: err.message, stack: err.stack });
      this.stop('start-error');
    }
  }

  _drain() {
    this.timer = setInterval(() => {
      try {
        const payload = this.queue.shift();
        if (payload && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            event: 'media',
            stream_sid: this.sid,
            media: { payload, timestamp: String(this.ts) }
          }));
          this.ts += 20;
        }
      } catch (err) {
        log.error('Drain Error', { err: err.message });
      }
    }, 20);
  }

  stop(reason) {
    clearInterval(this.timer);
    if (this.el) {
      try { this.el.close(); } catch(e) {}
      this.el = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(); } catch(e) {}
    }
    log.info('Stream Stopped', { reason, sid: this.sid });
  }
}

function createBridge(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/media-stream' });
  
  wss.on('connection', (ws, req) => {
    log.info('New WebSocket Connection Established', { 
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      url: req.url 
    });
    
    const session = new BridgeSession(ws);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'start') {
          await session.start(msg.start);
        } else if (msg.event === 'media') {
          if (session.el && msg.media && msg.media.payload) {
            const pcm = mulawToLinear16(Buffer.from(msg.media.payload, 'base64'));
            session.el.sendAudio(pcm.toString('base64'));
          }
        } else if (msg.event === 'stop') {
          session.stop('telephony-stop');
        }
      } catch (err) {
        log.error('WebSocket Message Processing Error', { err: err.message, data: data.toString().slice(0, 100) });
      }
    });

    ws.on('close', (code, reason) => {
      log.info('WebSocket Connection Closed', { code, reason: reason.toString() });
      session.stop('ws-closed');
    });

    ws.on('error', (err) => {
      log.error('WebSocket Error', { err: err.message });
      session.stop('ws-error');
    });
  });

  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({}) };
