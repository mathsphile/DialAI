"use strict";

require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { logger } = require("./utils/logger");
const { router: exotelRouter } = require("./routes/exotelWebhook");
const { router: healthRouter, registerStatsProvider } = require("./routes/health");
const { createBridge, getBridgeStats } = require("./services/audioStreamBridge");
const { ensureAgent } = require("./services/elevenLabsAgentService");

const log = logger.forModule("server");
const PORT = process.env.PORT || 3000;
const SERVER_URL = (process.env.SERVER_URL || "").replace(/\/$/, "");

async function main() {
  try {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors());
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use(morgan("dev"));
    app.use(express.static(path.join(__dirname, "..", "public")));

    app.use("/health", healthRouter);
    app.use("/exotel", exotelRouter);

    const httpServer = http.createServer(app);
    const wss = createBridge(httpServer, { path: "/media-stream" });
    registerStatsProvider(getBridgeStats);

    httpServer.listen(PORT, "0.0.0.0", () => {
      log.info(`🚀 DialAI is LIVE on Railway`);
      log.info(`🔗 URL: ${SERVER_URL}`);
    });

    if (process.env.ELEVENLABS_API_KEY) {
      log.info("Connecting to ElevenLabs...");
      const agentId = await ensureAgent();
      log.info(`✅ Nova Agent Ready: ${agentId}`);
    }

  } catch (err) {
    log.error("❌ FATAL STARTUP ERROR", { message: err.message, stack: err.stack });
    process.exit(1);
  }
}

main();
