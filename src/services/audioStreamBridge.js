"use strict";

const WebSocket = require("ws");
const { logger, runWithCallContext } = require("../utils/logger");
const {
  mulawToLinear16,
  base64PCMToBase64Mulaw,
} = require("../utils/audioConverter");
const { createSession } = require("./elevenLabsAgentService");

const log = logger.forModule("audioStreamBridge");

class BridgeSession {
  constructor(ws) {
    this.ws = ws;
    this.sid = null;
    this.el = null;
    this.queue = [];
    this.timer = null;
    this.ts = 0;
    this.drainStartTime = 0;
    this.totalPackets = 0;
  }

  async start(data) {
    try {
      this.sid = data.streamSid || data.stream_sid || "unknown";
      log.info("Media Stream Started", { sid: this.sid });

      await runWithCallContext({ callSid: this.sid }, async () => {
        this.el = await createSession({ callSid: this.sid });
        log.info("Nova Ready");

        // CRITICAL: Track if we receive ANY audio events
        let audioEventCount = 0;

        this.el.on("audio", (pcm, id, rate) => {
          audioEventCount++;
          log.info(`📥 AUDIO EVENT #${audioEventCount}`, {
            eventId: id,
            sampleRate: rate,
            pcmBase64Length: pcm ? pcm.length : 0,
            pcmIsNull: !pcm,
            pcmIsEmpty: pcm && pcm.length === 0,
          });

          try {
            if (!pcm) {
              log.error("🚨 CRITICAL: Audio data is NULL", { id });
              return;
            }

            if (pcm.length === 0) {
              log.error("🚨 CRITICAL: Audio data is EMPTY STRING", { id });
              return;
            }

            log.info(`🔄 Converting PCM (${pcm.length} chars)`, { id, rate });

            const mulaw = base64PCMToBase64Mulaw(pcm, rate || 16000);
            if (!mulaw) {
              log.error("🚨 CRITICAL: Conversion returned null/empty", {
                id,
                rate,
                pcmLength: pcm.length,
              });
              return;
            }

            const buf = Buffer.from(mulaw, "base64");
            log.info(`✅ Mulaw converted: ${buf.length} bytes`, { id });

            if (buf.length === 0) {
              log.error("🚨 CRITICAL: Mulaw buffer is empty after decode", {
                id,
              });
              return;
            }

            // Slice into standard 20ms chunks (160 bytes at 8kHz)
            let chunkCount = 0;
            for (let i = 0; i < buf.length; i += 160) {
              this.queue.push(buf.slice(i, i + 160));
              chunkCount++;
            }
            log.info(
              `✓ Audio enqueued: ${chunkCount} chunks (${buf.length} bytes → queue now ${this.queue.length} items)`,
              {
                id,
                rate,
              },
            );
          } catch (err) {
            log.error("🚨 CRITICAL: Audio processing error", {
              err: err.message,
              id,
              rate,
              stack: err.stack,
            });
          }
        });

        this.el.on("close", () => {
          const drainedSeconds = (Date.now() - this.drainStartTime) / 1000;
          const packetsTotal = this.totalPackets || 0;
          log.warn("🔴 ElevenLabs connection CLOSED", {
            reason: "el-closed",
            drainedFor: `${drainedSeconds.toFixed(2)}s`,
            packetsStreamed: packetsTotal,
            queueRemaining: this.queue.length,
          });
          this.stop("el-closed");
        });
        this._startDrainLoop();
      });
    } catch (err) {
      log.error("Start Error", { err: err.message });
      this.stop("start-error");
    }
  }

  _startDrainLoop() {
    let drainLoopRuns = 0;

    // 20ms pacing loop to send audio in smooth 20ms packets (160 bytes of 8kHz mu-law)
    this.timer = setInterval(() => {
      drainLoopRuns++;

      try {
        if (this.isStopped) return;

        // Log status occasionally
        if (drainLoopRuns % 50 === 0) {
          log.info("📊 Drain loop status", {
            queueLength: this.queue.length,
            packetsStreamed: this.totalPackets,
            wsOpen: this.ws.readyState === WebSocket.OPEN,
          });
        }

        // Send audio as soon as we have chunks
        if (this.queue.length > 0) {
          // Mark first audio as started
          if (this.totalPackets === 0) {
            log.info("🟢 Audio streaming STARTED (first packet)", {
              queueLength: this.queue.length,
            });
          }

          // Send one 20ms chunk (160 bytes)
          const chunk = this.queue.shift();

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(
              JSON.stringify({
                event: "media",
                streamSid: this.sid,
                media: {
                  payload: chunk.toString("base64"),
                  timestamp: String(this.ts),
                },
              }),
            );
            this.ts += 20; // Each chunk is 20ms (160 bytes at 8kHz)
            this.totalPackets++;

            // Log every 50 packets for debugging
            if (this.totalPackets % 50 === 0) {
              log.info("📊 Audio packets sent", {
                packetsStreamed: this.totalPackets,
                queueLength: this.queue.length,
                timestampMs: this.ts,
                chunkSize: chunk.length,
              });
            }
          } else {
            if (this.totalPackets > 0) {
              log.error("🚨 WebSocket closed during streaming", {
                wsState: this.ws ? this.ws.readyState : "undefined",
                packetsStreamed: this.totalPackets,
                queueRemaining: this.queue.length,
              });
            }
          }
        }
      } catch (err) {
        log.error("🚨 Drain loop error", {
          err: err.message,
          packetsStreamed: this.totalPackets,
          queueLength: this.queue.length,
        });
      }
    }, 20); // Run every 20ms to match the 20ms chunks
  }

  stop(reason) {
    this.isStopped = true;
    clearInterval(this.timer);
    if (this.el) {
      this.el.close();
      this.el = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    log.info("Stream Stopped", { reason });
  }
}

function createBridge(httpServer) {
  const wss = new WebSocket.Server({
    server: httpServer,
    path: "/media-stream",
  });
  wss.on("connection", (ws) => {
    log.info("EXOTEL CONNECTED");
    const session = new BridgeSession(ws);
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === "start") await session.start(msg.start);
        else if (msg.event === "media" && session.el) {
          try {
            const pcm = mulawToLinear16(
              Buffer.from(msg.media.payload, "base64"),
            );
            session.el.sendAudio(pcm.toString("base64"));
          } catch (audioErr) {
            log.error("Audio conversion error", { err: audioErr.message });
          }
        } else if (msg.event === "stop") session.stop("telephony-stop");
      } catch (e) {
        log.error("Message parsing error", { err: e.message });
      }
    });
    ws.on("close", () => session.stop("ws-closed"));
  });
  return wss;
}

module.exports = { createBridge, getBridgeStats: () => ({}) };
