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
    this.sid = data.streamSid || data.stream_sid;
    log.info('Media Stream Connected', { sid: this.sid });
    await runWithCallContext({ callSid: this.sid }, async () => {
      this.el = await createSession({ callSid: this.sid });
      this.el.on('audio', (pcm, id, rate) => {
        const mulaw = base64PCMToBase64Mulaw(pcm, rate);
        if (!mulaw) return;
        const buf = Buffer.from(mulaw, 'base64');
        for (let i = 0; i < buf.length; i += 160) {
          this.queue.push(buf.slice(i, i + 160).toString('base64'));
        }
      });
      this.el.on('close', () => this.stop('el-closed'));
      this._drain();
    });
  }

  _drain() {
    this.timer = setInterval(() => {
      const payload = this.queue.shift();
      if (payload && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          event: 'media',
          stream_sid: this.sid,
          media: { payload, timestamp: String(this.ts) }
        }));
        this.ts += 20;
      }
    }, 20);
  }

  stop(reason) {
    clearInterval(this.timer);
    if (this.el) this.el.close();
    if (this.ws) this.ws.close();
    log.info('Stream Stopped', { reason });
  }
}

function createBridge(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/media-stream' });
  wss.on('connection', (ws) => {
    log.info('New WebSocket Connection Attempt');
    const session = new BridgeSession(ws);
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'start') await session.start(msg.start);
        else if (msg.event === 'media' && session.el) {
          const pcm = mulawToLinear16(Buffer.from(msg.media.payload, 'base64'));
          session.el.sendAudio(pcm.toString('base64'));
        } else if (msg.event === 'stop') session.stop('telephony-stop');
      } catch (e) {}
    });
    ws.on('close', () => session.stop('ws-closed'));
  });
  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({}) };
