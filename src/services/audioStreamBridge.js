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
    this.prefillNeeded = 6; // Wait for 120ms (6 * 20ms) before starting to speak
    this.isDraining = false;
  }

  async start(data) {
    try {
      this.sid = data.streamSid || data.stream_sid || 'unknown';
      log.info('Media Stream Started', { sid: this.sid });
      
      await runWithCallContext({ callSid: this.sid }, async () => {
        this.el = await createSession({ callSid: this.sid });
        log.info('Nova Ready');

        this.el.on('audio', (pcm, id, rate) => {
          const mulaw = base64PCMToBase64Mulaw(pcm, rate);
          if (!mulaw) return;
          const buf = Buffer.from(mulaw, 'base64');
          
          // Slice into standard 20ms chunks
          for (let i = 0; i < buf.length; i += 160) {
            this.queue.push(buf.slice(i, i + 160));
          }
        });

        this.el.on('close', () => this.stop('el-closed'));
        this._startDrainLoop();
      });
    } catch (err) {
      log.error('Start Error', { err: err.message });
      this.stop('start-error');
    }
  }

  _startDrainLoop() {
    // 20ms pacing loop to send audio in smooth 80ms packets
    this.timer = setInterval(() => {
      try {
        if (this.isStopped) return;

        // JITTER BUFFER LOGIC:
        // Wait for initial prefill before starting playback (prevents first-word chop)
        if (!this.isDraining && this.queue.length >= this.prefillNeeded) {
          this.isDraining = true;
        }

        // Only send if we've started draining AND have at least 1 chunk available
        if (this.isDraining && this.queue.length > 0) {
          // Group up to 4 chunks into one 80ms packet for stable streaming
          let chunksToCombine = [];
          for (let i = 0; i < 4 && this.queue.length > 0; i++) {
            chunksToCombine.push(this.queue.shift());
          }

          if (chunksToCombine.length > 0) {
            const combined = Buffer.concat(chunksToCombine);
            const duration = Math.round((combined.length / 8000) * 1000);
            
            if (this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({
                event: 'media',
                stream_sid: this.sid,
                media: { 
                  payload: combined.toString('base64'), 
                  timestamp: String(this.ts) 
                }
              }));
              this.ts += duration;
            }
          }
        }
      } catch (err) { }
    }, 80); // Run every 80ms to match the 80ms chunks
  }

  stop(reason) {
    this.isStopped = true;
    clearInterval(this.timer);
    if (this.el) { this.el.close(); this.el = null; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.close(); }
    log.info('Stream Stopped', { reason });
  }
}

function createBridge(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/media-stream' });
  wss.on('connection', (ws) => {
    log.info('EXOTEL CONNECTED');
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
