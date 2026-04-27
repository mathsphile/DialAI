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
    this.drainStartTime = 0;
    this.totalPackets = 0;
  }

  async start(data) {
    try {
      this.sid = data.streamSid || data.stream_sid || 'unknown';
      log.info('Media Stream Started', { sid: this.sid });
      
      await runWithCallContext({ callSid: this.sid }, async () => {
        this.el = await createSession({ callSid: this.sid });
        log.info('Nova Ready');

        this.el.on('audio', (pcm, id, rate) => {
          try {
            if (!pcm) {
              log.warn('⚠️ Received empty audio from ElevenLabs', { id });
              return;
            }
            
            const mulaw = base64PCMToBase64Mulaw(pcm, rate || 16000);
            if (!mulaw) {
              log.warn('⚠️ Failed to convert audio - returned null', { id, rate, pcmLength: pcm.length });
              return;
            }
            
            const buf = Buffer.from(mulaw, 'base64');
            if (buf.length === 0) {
              log.warn('⚠️ Mulaw buffer is empty after decode', { id });
              return;
            }
            
            // Slice into standard 20ms chunks (160 bytes at 8kHz)
            let chunkCount = 0;
            for (let i = 0; i < buf.length; i += 160) {
              this.queue.push(buf.slice(i, i + 160));
              chunkCount++;
            }
            log.info(`✓ Audio enqueued (${chunkCount} chunks)`, { 
              id, 
              rate, 
              pcmLength: pcm.length,
              bufLength: buf.length,
              queueLength: this.queue.length 
            });
          } catch (err) {
            log.error('❌ Audio processing error', { err: err.message, id, rate, stack: err.stack });
          }
        });

        this.el.on('close', () => {
          const drainedSeconds = (Date.now() - this.drainStartTime) / 1000;
          const packetsTotal = this.totalPackets || 0;
          log.warn('🔴 ElevenLabs connection CLOSED', { 
            reason: 'el-closed',
            drainedFor: `${drainedSeconds.toFixed(2)}s`,
            packetsStreamed: packetsTotal,
            queueRemaining: this.queue.length
          });
          this.stop('el-closed');
        });
        this._startDrainLoop();
      });
    } catch (err) {
      log.error('Start Error', { err: err.message });
      this.stop('start-error');
    }
  }

  _startDrainLoop() {
    let lastLogTime = 0;
    
    // 20ms pacing loop to send audio in smooth 80ms packets
    this.timer = setInterval(() => {
      try {
        if (this.isStopped) return;

        // JITTER BUFFER LOGIC:
        // Wait for initial prefill before starting playback (prevents first-word chop)
        if (!this.isDraining && this.queue.length >= this.prefillNeeded) {
          this.isDraining = true;
          this.drainStartTime = Date.now();
          log.info('🟢 Draining started', { 
            queueLength: this.queue.length,
            streamSid: this.sid
          });
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
            // Duration = audio length in bytes / (8000 samples/sec) * 1000 ms
            // At 8kHz mulaw, 1 byte = 1 sample
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
              this.totalPackets++;
              
              // Log every 50 packets or every 10 seconds for debugging
              const now = Date.now();
              if (this.totalPackets % 50 === 0 || (now - lastLogTime) > 10000) {
                log.info('📊 Audio streaming active', {
                  packetsStreamed: this.totalPackets,
                  queueLength: this.queue.length,
                  timestampMs: this.ts,
                  chunkSize: combined.length
                });
                lastLogTime = now;
              }
            } else {
              log.error('❌ WebSocket not open, cannot send audio', { 
                wsState: this.ws.readyState,
                packetsStreamed: this.totalPackets,
                queueLength: this.queue.length
              });
            }
          }
        }
      } catch (err) {
        log.error('❌ Drain loop error', { 
          err: err.message, 
          stack: err.stack,
          packetsStreamed: this.totalPackets,
          queueLength: this.queue.length
        });
      }
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
          try {
            const pcm = mulawToLinear16(Buffer.from(msg.media.payload, 'base64'));
            session.el.sendAudio(pcm.toString('base64'));
          } catch (audioErr) {
            log.error('Audio conversion error', { err: audioErr.message });
          }
        } else if (msg.event === 'stop') session.stop('telephony-stop');
      } catch (e) {
        log.error('Message parsing error', { err: e.message });
      }
    });
    ws.on('close', () => session.stop('ws-closed'));
  });
  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({}) };
