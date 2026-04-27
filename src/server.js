"use strict";

/**
 * server.js – DialAI Entry Point (Exotel Only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Environment ───────────────────────────────────────────────────────────────
require("dotenv").config();

// ── Core Node modules ─────────────────────────────────────────────────────────
const http = require("http");
const process = require("process");

// ── Third-party ───────────────────────────────────────────────────────────────
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// ── Internal modules ──────────────────────────────────────────────────────────
const { logger } = require("./utils/logger");
const { router: exotelRouter } = require("./routes/exotelWebhook");
const {
  router: healthRouter,
  registerStatsProvider,
} = require("./routes/health");
const {
  createBridge,
  getBridgeStats,
} = require("./services/audioStreamBridge");
const { ensureAgent } = require("./services/elevenLabsAgentService");

const log = logger.forModule("server");

// ─── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const SERVER_URL = (
  process.env.SERVER_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");

// ─── Environment validation ────────────────────────────────────────────────────

function validateEnv() {
  const REQUIRED = ["ELEVENLABS_API_KEY", "EXOTEL_SID", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN"];

  const RECOMMENDED = [
    "SERVER_URL",
    "EXOTEL_CALLER_ID",
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_VOICE_ID",
  ];

  const missing = REQUIRED.filter((k) => !process.env[k]);
  const absent = RECOMMENDED.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    log.error("Missing REQUIRED environment variables", { missing });
    if (IS_PROD) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  if (absent.length > 0) {
    log.warn("Missing RECOMMENDED environment variables", { absent });
  }

  log.info("Environment validated", { NODE_ENV, PORT, SERVER_URL });
}

// ─── Express application ───────────────────────────────────────────────────────

function createApp() {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(express.json({ limit: "512kb" }));

  const morganFormat = IS_PROD ? "combined" : "dev";
  app.use(morgan(morganFormat, { stream: { write: (msg) => log.http(msg.trim()) } }));

  app.use((req, _res, next) => {
    req.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use("/health", healthRouter);
  app.use("/exotel", exotelRouter);

  app.get("/", (_req, res) => {
    res.json({
      service: "DialAI",
      status: "running",
      endpoints: {
        health: `${SERVER_URL}/health`,
        exotel_incoming: `${SERVER_URL}/exotel/incoming`,
        media_stream_ws: SERVER_URL.replace(/^https?:\/\//, "wss://") + "/media-stream",
      }
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err, req, res, _next) => {
    log.error("Server error", { message: err.message, path: req.path });
    res.status(err.status || 500).json({ error: "internal_error", requestId: req.requestId });
  });

  return app;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

function setupGracefulShutdown(httpServer, wss) {
  async function shutdown(signal) {
    log.info(`${signal} received – shutting down …`);
    httpServer.close();
    if (wss) wss.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ─── Main bootstrap ────────────────────────────────────────────────────────────

async function main() {
  try {
    validateEnv();
    const app = createApp();
    const httpServer = http.createServer(app);
    const wss = createBridge(httpServer, { path: "/media-stream" });
    registerStatsProvider(getBridgeStats);

    httpServer.listen(PORT, "0.0.0.0", () => {
      log.info(`✅ Server running on port ${PORT}`);
    });

    if (process.env.ELEVENLABS_API_KEY) {
      const agentId = await ensureAgent();
      log.info(`✅ ElevenLabs agent ready: ${agentId}`);
    }

    setupGracefulShutdown(httpServer, wss);
  } catch (err) {
    log.error("Fatal error", { message: err.message });
    process.exit(1);
  }
}

main();
