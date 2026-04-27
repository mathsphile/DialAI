"use strict";

/**
 * server.js – DialAI Bharat Entry Point
 * ─────────────────────────────────────────────────────────────────────────────
 * Bootstraps the Express HTTP server and the Twilio Media Streams WebSocket
 * server that form the backbone of the DialAI Bharat voice helpline.
 *
 * Start order
 * ───────────
 *  1. Load .env configuration
 *  2. Validate critical environment variables
 *  3. Initialise Express with security / logging middleware
 *  4. Mount REST routes  (/health, /twiml)
 *  5. Start HTTP server
 *  6. Attach WebSocket bridge on /media-stream
 *  7. Ensure ElevenLabs agent exists (creates it if ELEVENLABS_AGENT_ID is unset)
 *  8. Register graceful-shutdown hooks
 *
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
const { router: twilioRouter } = require("./routes/twilioWebhook");
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
const PROVIDER = (process.env.TELEPHONY_PROVIDER || "twilio").toLowerCase();
const IS_EXOTEL = PROVIDER === "exotel";

// ─── Environment validation ────────────────────────────────────────────────────

/**
 * Validate required environment variables on startup.
 * Logs warnings for missing optional vars and throws for critical ones.
 */
function validateEnv() {
  const REQUIRED = IS_EXOTEL
    ? ["ELEVENLABS_API_KEY", "EXOTEL_SID", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN"]
    : ["ELEVENLABS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];

  const RECOMMENDED = IS_EXOTEL
    ? [
        "SERVER_URL",
        "EXOTEL_CALLER_ID",
        "ELEVENLABS_AGENT_ID",
        "ELEVENLABS_VOICE_ID",
      ]
    : [
        "SERVER_URL",
        "TWILIO_PHONE_NUMBER",
        "ELEVENLABS_AGENT_ID",
        "ELEVENLABS_VOICE_ID",
      ];

  const missing = REQUIRED.filter((k) => !process.env[k]);
  const absent = RECOMMENDED.filter((k) => !process.env[k]);

  if (missing.length > 0) {
    log.error(
      "Missing REQUIRED environment variables – server cannot start safely",
      { missing },
    );
    if (IS_PROD) {
      throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
    log.warn(
      "Running in development mode with missing required vars. Some features will not work.",
    );
  }

  if (absent.length > 0) {
    log.warn("Missing RECOMMENDED environment variables", { absent });
  }

  if (
    !process.env.SERVER_URL ||
    process.env.SERVER_URL.includes("your-ngrok")
  ) {
    log.warn(
      "⚠️  SERVER_URL is not set or still uses the placeholder value.\n" +
        "   Twilio cannot reach this server for Media Streams.\n" +
        "   Run:  npx ngrok http 3000\n" +
        "   Then set SERVER_URL=https://<your-ngrok-id>.ngrok-free.app in .env",
    );
  }

  log.info("Environment validated", {
    NODE_ENV,
    PORT,
    SERVER_URL,
    provider: PROVIDER,
  });
}

// ─── Express application ───────────────────────────────────────────────────────

function createApp() {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────────
  app.use(
    helmet({
      // Allow the Twilio status callback to POST without CORS issues
      crossOriginResourcePolicy: { policy: "cross-origin" },
      // No need for content-security-policy on API-only server
      contentSecurityPolicy: false,
    }),
  );

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Only allow Twilio's IP ranges in production; open in development
  app.use(
    cors({
      origin: IS_PROD
        ? /\.twilio\.com$/ // Twilio callback origin
        : "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "X-Twilio-Signature", "X-Health-Secret"],
    }),
  );

  // ── Body parsers ────────────────────────────────────────────────────────────
  // Twilio sends application/x-www-form-urlencoded POST bodies
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  // JSON body parser for health / admin endpoints
  app.use(express.json({ limit: "512kb" }));

  // ── HTTP request logging ────────────────────────────────────────────────────
  const morganFormat = IS_PROD
    ? ":remote-addr :method :url :status :res[content-length] - :response-time ms"
    : "dev";

  app.use(
    morgan(morganFormat, {
      stream: {
        write: (msg) => log.http(msg.trim()),
      },
      // Skip health checks from access log to reduce noise
      skip: (req) => req.path === "/health" && req.method === "GET",
    }),
  );

  // ── Request ID injection ────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    req.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────

  // Liveness + detailed health checks
  app.use("/health", healthRouter);

  // Telephony webhook endpoints – mount based on TELEPHONY_PROVIDER
  if (IS_EXOTEL) {
    app.use("/exotel", exotelRouter);
    log.info("Exotel webhook routes mounted at /exotel");
  } else {
    app.use("/twiml", twilioRouter);
    log.info("Twilio webhook routes mounted at /twiml");
  }

  // Root route – basic info (useful during ngrok testing)
  app.get("/", (_req, res) => {
    res.json({
      service: "DialAI Bharat",
      description: "Voice AI Helpline for Rural India",
      version: process.env.npm_package_version || "1.0.0",
      status: "running",
      languages: ["Hindi (हिन्दी)", "Bengali (বাংলা)", "English"],
      endpoints: IS_EXOTEL
        ? {
            health: `${SERVER_URL}/health`,
            health_detailed: `${SERVER_URL}/health/detailed`,
            exotel_incoming: `${SERVER_URL}/exotel/incoming`,
            exotel_status: `${SERVER_URL}/exotel/status`,
            exotel_fallback: `${SERVER_URL}/exotel/fallback`,
            media_stream_ws:
              SERVER_URL.replace(/^https?:\/\//, "wss://") + "/media-stream",
          }
        : {
            health: `${SERVER_URL}/health`,
            health_detailed: `${SERVER_URL}/health/detailed`,
            twiml_incoming: `${SERVER_URL}/twiml/incoming`,
            twiml_status: `${SERVER_URL}/twiml/status`,
            media_stream_ws:
              SERVER_URL.replace(/^https?:\/\//, "wss://") + "/media-stream",
          },
      docs: "See README.md for setup instructions",
    });
  });

  // ── 404 handler ─────────────────────────────────────────────────────────────
  app.use((req, res) => {
    log.warn("404 Not Found", { path: req.path, method: req.method });
    res.status(404).json({
      error: "not_found",
      message: `Route ${req.method} ${req.path} does not exist`,
      hint: "See GET / for available endpoints",
    });
  });

  // ── Global error handler ────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const isKnown = status < 500;

    if (isKnown) {
      log.warn("Request error", {
        status,
        message: err.message,
        path: req.path,
      });
    } else {
      log.error("Unhandled server error", {
        status,
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      });
    }

    res.status(status).json({
      error: err.code || "internal_error",
      message:
        IS_PROD && status >= 500
          ? "An internal error occurred. Please try again."
          : err.message,
      requestId: req.requestId,
    });
  });

  return app;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Register SIGTERM / SIGINT handlers for clean shutdown.
 * Allows in-flight calls to drain before the process exits.
 *
 * @param {import('http').Server}    httpServer
 * @param {import('ws').Server}      wss
 */
function setupGracefulShutdown(httpServer, wss) {
  const SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds

  async function shutdown(signal) {
    log.info(`${signal} received – initiating graceful shutdown …`);

    // 1. Stop accepting new HTTP connections
    httpServer.close((err) => {
      if (err) {
        log.warn("HTTP server close error (may have no open connections)", {
          err: err.message,
        });
      } else {
        log.info("HTTP server closed.");
      }
    });

    // 2. Close all WebSocket connections
    if (wss) {
      wss.clients.forEach((ws) => {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          /* ignore */
        }
      });
      wss.close(() => log.info("WebSocket server closed."));
    }

    // 3. Force exit after timeout if connections won't drain
    const forceExit = setTimeout(() => {
      log.warn("Graceful shutdown timed out – forcing exit.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    forceExit.unref(); // Don't prevent process from exiting normally

    log.info("Graceful shutdown complete.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ─── Banner ────────────────────────────────────────────────────────────────────

function printBanner() {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║           🇮🇳  DialAI Bharat – Voice AI Helpline            ║",
    "║         Empowering Rural India through Voice & AI            ║",
    "╠══════════════════════════════════════════════════════════════╣",
    `║  Environment : ${NODE_ENV.padEnd(44)}║`,
    `║  Port        : ${String(PORT).padEnd(44)}║`,
    `║  Server URL  : ${SERVER_URL.slice(0, 44).padEnd(44)}║`,
    "║                                                              ║",
    "║  Languages   : Hindi (हिन्दी) · Bengali (বাংলা) · English  ║",
    "║                                                              ║",
    `║  Endpoints                                                   ║`,
    `║    Health    : ${SERVER_URL}/health`.slice(0, 64).padEnd(64) + "║",
    `║    Incoming  : ${SERVER_URL}/${IS_EXOTEL ? "exotel" : "twiml"}/incoming`
      .slice(0, 64)
      .padEnd(64) + "║",
    `║    WS Bridge : ${SERVER_URL.replace(/^https?:\/\//, "wss://")}/media-stream`
      .slice(0, 64)
      .padEnd(64) + "║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
  ];
  lines.forEach((l) => log.info(l));
}

// ─── Main bootstrap ────────────────────────────────────────────────────────────

async function main() {
  try {
    // 1. Validate environment
    validateEnv();

    // 2. Build Express app
    const app = createApp();
    const httpServer = http.createServer(app);

    // 3. Attach WebSocket bridge for Twilio Media Streams
    const wss = createBridge(httpServer, { path: "/media-stream" });

    // 4. Register the bridge's live stats with the health endpoint
    registerStatsProvider(getBridgeStats);

    // 5. Start HTTP server
    await new Promise((resolve, reject) => {
      httpServer.listen(PORT, "0.0.0.0", (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    printBanner();

    // 6. Ensure ElevenLabs "Saathi" agent exists
    //    (Creates it via API if ELEVENLABS_AGENT_ID is not set in .env)
    if (process.env.ELEVENLABS_API_KEY) {
      try {
        const agentId = await ensureAgent();
        log.info(`✅  ElevenLabs agent ready: ${agentId}`);
        log.info(
          "   Add ELEVENLABS_AGENT_ID=" +
            agentId +
            " to .env to skip this step on next start.",
        );
      } catch (err) {
        log.error("Failed to initialise ElevenLabs agent", {
          err: err.message,
        });
        log.warn(
          "Server will continue but calls may fail until the agent is configured.",
        );
      }
    } else {
      log.warn("ELEVENLABS_API_KEY not set – skipping agent initialisation.");
    }

    // 7. Graceful shutdown
    setupGracefulShutdown(httpServer, wss);

    log.info("✅  DialAI Bharat server is ready to accept calls.");
    const dialNumber = IS_EXOTEL
      ? process.env.EXOTEL_CALLER_ID || "<your Exophone>"
      : process.env.TWILIO_PHONE_NUMBER || "<your Twilio number>";
    log.info(`   Dial ${dialNumber} to test.`);

    if (!IS_PROD) {
      log.info("");
      log.info(
        "📡  Dev tip: Run  npx ngrok http 3000  then set SERVER_URL in .env",
      );
      if (IS_EXOTEL) {
        log.info("🔧  Configure Exotel Voicebot Applet URL to:");
        log.info(`     Voicebot URL  : ${SERVER_URL}/exotel/incoming`);
        log.info("     Mode          : HTTPS resolver that returns a WSS URL");
        log.info(`     Passthru URL  : ${SERVER_URL}/exotel/status`);
        log.info("     Place the Passthru applet after Voicebot to capture Stream[Status]");
        log.info(
          "📋  Exotel dashboard: App Bazaar → Voicebot Applet → URL, then Passthru Applet after it",
        );
      } else {
        log.info("🔧  Then configure your Twilio number webhook to:");
        log.info(`     ${SERVER_URL}/twiml/incoming`);
      }
    }
  } catch (err) {
    log.error("Fatal error during server startup", {
      message: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// ─── Run ───────────────────────────────────────────────────────────────────────

main();
