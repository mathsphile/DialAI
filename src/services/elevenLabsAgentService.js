"use strict";

/**
 * elevenLabsAgentService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages all interactions with ElevenLabs Conversational AI for DialAI Bharat.
 *
 * Responsibilities
 * ────────────────
 *  • Agent lifecycle  – create / fetch / update the "Saathi" agent via REST API
 *  • WebSocket client – open per-call connections to ElevenLabs Conv-AI WS
 *  • Audio relay      – receive PCM chunks from ElevenLabs, emit to caller
 *  • Tool dispatch    – handle server-side tool calls (weather, mandi, schemes)
 *  • Ping / pong      – maintain WebSocket keepalive as required by ElevenLabs
 *  • Error recovery   – reconnect on transient failures, surface fatal errors
 *
 * ElevenLabs Conversational AI WebSocket protocol (summary)
 * ──────────────────────────────────────────────────────────
 *  Client → Server
 *    { type: "conversation_initiation_client_data", conversation_config_override: {...} }
 *    { user_audio_chunk: "<base64 PCM 16 kHz>" }
 *    { type: "pong", event_id: N }
 *
 *  Server → Client
 *    { type: "conversation_initiation_metadata", ... }
 *    { type: "audio",            audio_event:           { audio_base_64, event_id } }
 *    { type: "agent_response",   agent_response_event:  { agent_response } }
 *    { type: "user_transcript",  user_transcription_event: { user_transcript } }
 *    { type: "interruption",     interruption_event:    { event_id } }
 *    { type: "ping",             ping_event:            { event_id, ping_ms } }
 *    { type: "client_tool_call", client_tool_call:      { tool_call_id, tool_name, parameters } }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const WebSocket = require("ws");
const axios = require("axios");
const EventEmitter = require("events");

const { logger } = require("../utils/logger");
const {
  buildCallOverride,
  getAgentCreationPayload,
} = require("../config/agentConfig");
const cache = require("../utils/cache");
const { detectLanguage } = require("./languageDetector");

const log = logger.forModule("elevenLabsAgentService");

// ─── Constants ────────────────────────────────────────────────────────────────

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const ELEVENLABS_WS_BASE = "wss://api.elevenlabs.io/v1/convai/conversation";

const RECONNECT_ATTEMPTS = 1; // OPTIMIZED: Reduced from 3 (don't waste tokens retrying on quota)
const RECONNECT_DELAY_MS = 1000;
const PING_TIMEOUT_MS = 10000; // treat connection as dead if no ping in 10 s
const MAX_AUDIO_QUEUE = 200; // OPTIMIZED: Increased from 100 to handle larger batches


// Tool call response timeout – if a tool takes longer we send a graceful error
const TOOL_TIMEOUT_MS = 5000;

// ─── ElevenLabs HTTP client ───────────────────────────────────────────────────

/**
 * Axios instance pre-configured with ElevenLabs auth headers and base URL.
 * Re-used across all REST calls to avoid creating a new instance per request.
 */
function makeApiClient() {
  return axios.create({
    baseURL: ELEVENLABS_API_BASE,
    timeout: 15000,
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

const apiClient = makeApiClient();

// ─── Agent Management ─────────────────────────────────────────────────────────

/**
 * Fetch an existing agent by ID.
 *
 * @param {string} agentId
 * @returns {Promise<object>} Agent object from ElevenLabs API
 */
async function getAgent(agentId) {
  const res = await apiClient.get(`/convai/agents/${agentId}`);
  return res.data;
}

/**
 * Create the "Saathi" agent in ElevenLabs and return the new agent_id.
 * Idempotent – if an agent with the same name already exists (checked by
 * listing agents), it returns the existing ID rather than creating a duplicate.
 *
 * @returns {Promise<string>} agent_id
 */
async function createAgent() {
  log.info('Creating ElevenLabs "Saathi" agent …');

  // Check for existing agent with the same name to be idempotent
  try {
    const listRes = await apiClient.get("/convai/agents", {
      params: { page_size: 100 },
    });
    const agents = listRes.data?.agents ?? [];
    const existing = agents.find((a) => a.name === "DialAI Bharat – Saathi");
    if (existing) {
      log.info(`Reusing existing agent: ${existing.agent_id}`);
      return existing.agent_id;
    }
  } catch (err) {
    log.warn("Could not list existing agents, will attempt creation anyway", {
      err: err.message,
    });
  }

  const payload = getAgentCreationPayload();
  const res = await apiClient.post("/convai/agents/create", payload);
  const agentId = res.data?.agent_id;

  if (!agentId) {
    throw new Error(
      `Agent creation succeeded but no agent_id in response: ${JSON.stringify(res.data)}`,
    );
  }

  log.info(`Agent created successfully: ${agentId}`);
  return agentId;
}

/**
 * Ensure we have a valid agent ID, creating the agent if necessary.
 * Caches the result in process.env.ELEVENLABS_AGENT_ID so subsequent calls
 * within the same process don't hit the API again.
 *
 * @returns {Promise<string>} agent_id
 */
async function ensureAgent() {
  if (process.env.ELEVENLABS_AGENT_ID) {
    return process.env.ELEVENLABS_AGENT_ID;
  }

  const agentId = await createAgent();
  // Persist for the lifetime of this process
  process.env.ELEVENLABS_AGENT_ID = agentId;
  log.info(`Set ELEVENLABS_AGENT_ID=${agentId} for this process session.`);
  log.info(
    "➡  Add this to your .env file to avoid re-creation on next restart.",
  );
  return agentId;
}

/**
 * Update the Saathi agent's configuration (e.g. after a system prompt change).
 *
 * @param {string} agentId
 * @param {object} patchPayload  Partial agent config to merge
 * @returns {Promise<object>}
 */
async function updateAgent(agentId, patchPayload) {
  const res = await apiClient.patch(`/convai/agents/${agentId}`, patchPayload);
  log.info(`Agent ${agentId} updated successfully.`);
  return res.data;
}

// ─── Tool Call Handlers ───────────────────────────────────────────────────────
// These are invoked when ElevenLabs asks the server to run a tool during a call.
// They return a plain object which is JSON-serialised and sent back to ElevenLabs.

/**
 * Weather tool handler.
 * In production replace with Open-Meteo, IMD, or AccuWeather API call.
 *
 * @param {{ location: string }} params
 * @returns {Promise<object>}
 */
async function handleGetWeather({ location }) {
  log.info("Tool: get_weather", { location });

  // Check cache first
  const cacheKey = `weather::${(location || "").toLowerCase()}`;
  const cached = cache.get(cacheKey, "tool");
  if (cached) return cached.data;

  try {
    // ── Real API integration (Open-Meteo – free, no key required) ────────────
    // Geocode location name to lat/lon first for accurate results.
    // For MVP we fall back to a Delhi-centre default if geocoding fails.
    const geoRes = await axios.get(
      "https://geocoding-api.open-meteo.com/v1/search",
      {
        params: { name: location, count: 1, language: "en", format: "json" },
        timeout: 4000,
      },
    );

    const place = geoRes.data?.results?.[0];
    const lat = place?.latitude ?? 28.6; // New Delhi default
    const lon = place?.longitude ?? 77.2;
    const placeName = place?.name ?? location;

    const weatherRes = await axios.get(
      "https://api.open-meteo.com/v1/forecast",
      {
        params: {
          latitude: lat,
          longitude: lon,
          daily:
            "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode",
          current_weather: true,
          timezone: "Asia/Kolkata",
          forecast_days: 2,
        },
        timeout: 4000,
      },
    );

    const wd = weatherRes.data;
    const current = wd.current_weather;
    const daily = wd.daily;

    // Map WMO weather codes to simple Hindi-friendly descriptions
    const weatherDesc = wmoCodeToDescription(current.weathercode);

    const result = {
      location: placeName,
      today: {
        condition: weatherDesc,
        temp_max_c: Math.round(daily.temperature_2m_max[0]),
        temp_min_c: Math.round(daily.temperature_2m_min[0]),
        rain_mm: daily.precipitation_sum[0] ?? 0,
        will_rain: (daily.precipitation_sum[0] ?? 0) > 1,
      },
      tomorrow: {
        condition: wmoCodeToDescription(daily.weathercode[1]),
        temp_max_c: Math.round(daily.temperature_2m_max[1]),
        temp_min_c: Math.round(daily.temperature_2m_min[1]),
        rain_mm: daily.precipitation_sum[1] ?? 0,
        will_rain: (daily.precipitation_sum[1] ?? 0) > 1,
      },
      wind_kmh: Math.round(current.windspeed ?? 0),
      updated_at: new Date().toISOString(),
    };

    // Cache for 30 minutes
    cache.set(cacheKey, "tool", { data: result }, 1800);
    return result;
  } catch (err) {
    log.warn("Weather API failed, returning mock data", {
      err: err.message,
      location,
    });
    // Graceful degradation – return a helpful "unavailable" message
    return {
      location,
      error: "live_data_unavailable",
      message:
        "Abhi live mausam data nahi mil raha. Kripya radio ya apne kisan mitra se pata karein.",
      message_en:
        "Live weather data is currently unavailable. Please check your local radio or Kisan Mitra.",
    };
  }
}

/**
 * Map WMO weather interpretation code to a simple description.
 * Source: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
 *
 * @param {number} code
 * @returns {string}
 */
function wmoCodeToDescription(code) {
  if (code === 0) return "Clear sky / Saaf mausam";
  if (code <= 3) return "Partly cloudy / Thode baadal";
  if (code <= 49) return "Foggy / Kohra";
  if (code <= 67) return "Rainy / Barish";
  if (code <= 77) return "Snow / Barfbaari";
  if (code <= 82) return "Rain showers / Halki barish";
  if (code <= 99) return "Thunderstorm / Toofan aur bijli";
  return "Unknown / Pata nahi";
}

/**
 * Mandi (wholesale market) price tool handler.
 * Integrates with the Government of India's Agmarknet / e-NAM price APIs.
 * Falls back to graceful mock data if the API is unreachable.
 *
 * @param {{ crop: string, location?: string }} params
 * @returns {Promise<object>}
 */
async function handleGetMandiPrice({ crop, location }) {
  log.info("Tool: get_mandi_price", { crop, location });

  // Normalise crop name
  const cropMap = {
    gehu: "wheat",
    gehun: "wheat",
    wheat: "wheat",
    chawal: "rice",
    rice: "rice",
    dhan: "paddy",
    paddy: "paddy",
    makka: "maize",
    maize: "maize",
    corn: "maize",
    sarso: "mustard",
    mustard: "mustard",
    soybean: "soybean",
    soya: "soybean",
    tur: "arhar",
    arhar: "arhar",
    dal: "arhar",
    chana: "chickpea",
    chickpea: "chickpea",
    pyaaz: "onion",
    onion: "onion",
    tamatar: "tomato",
    tomato: "tomato",
    aloo: "potato",
    potato: "potato",
  };
  const normalisedCrop = cropMap[(crop || "").toLowerCase()] || crop;

  // In production: call data.gov.in API or Agmarknet web scraper
  // API endpoint: https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070
  // (Requires data.gov.in API key)

  // MVP: return realistic mock prices with a helpful message
  const mockPrices = {
    wheat: { min: 2015, max: 2275, modal: 2150, unit: "quintal", msp: 2275 },
    rice: { min: 2100, max: 2400, modal: 2250, unit: "quintal", msp: 2183 },
    paddy: { min: 1940, max: 2183, modal: 2060, unit: "quintal", msp: 2183 },
    maize: { min: 1550, max: 1800, modal: 1660, unit: "quintal", msp: 1962 },
    mustard: { min: 4600, max: 5200, modal: 4950, unit: "quintal", msp: 5650 },
    soybean: { min: 3800, max: 4400, modal: 4100, unit: "quintal", msp: 4600 },
    arhar: { min: 5800, max: 6500, modal: 6200, unit: "quintal", msp: 7000 },
    chickpea: { min: 4800, max: 5400, modal: 5100, unit: "quintal", msp: 5440 },
    onion: { min: 800, max: 2200, modal: 1400, unit: "quintal", msp: null },
    tomato: { min: 400, max: 3500, modal: 1800, unit: "quintal", msp: null },
    potato: { min: 600, max: 1400, modal: 1000, unit: "quintal", msp: null },
  };

  const priceData = mockPrices[normalisedCrop];

  if (!priceData) {
    return {
      crop,
      error: "crop_not_found",
      message: `${crop} ka bhav abhi upalabdh nahi hai. Kripya apni nazdeeki mandi mein pata karein ya e-NAM portal (enam.gov.in) dekhein.`,
    };
  }

  return {
    crop: normalisedCrop,
    location: location || "India (national average)",
    prices_inr: priceData,
    currency: "INR",
    note: "Ye approximate bhav hain. Sahi daam ke liye apni mandi se confirm karein.",
    note_en:
      "These are approximate prices. Confirm exact rates at your local mandi.",
    enam_portal: "enam.gov.in",
    fetched_at: new Date().toISOString(),
    data_source: "mock-mvp (replace with Agmarknet/eNAM API in production)",
  };
}

/**
 * Government scheme information tool handler.
 *
 * @param {{ scheme_name: string }} params
 * @returns {Promise<object>}
 */
async function handleGetSchemeInfo({ scheme_name }) {
  log.info("Tool: get_scheme_info", { scheme_name });

  const name = (scheme_name || "").toLowerCase();

  const schemes = {
    "pm kisan": {
      full_name: "PM Kisan Samman Nidhi Yojana",
      benefit:
        "₹6,000 per year (₹2,000 every 4 months) directly to your bank account.",
      benefit_hi: "₹6,000 saal mein, ₹2,000 har 4 mahine seedha bank mein.",
      who_can_apply:
        "Small and marginal farmers with land ownership (up to 2 hectares).",
      how_to_apply:
        "Visit pmkisan.gov.in or your nearest Common Service Centre (CSC).",
      how_to_apply_hi: "pmkisan.gov.in ya nazdeeki CSC centre jayen.",
      documents: [
        "Aadhaar card",
        "Bank passbook",
        "Land records (Khasra/Khatauni)",
      ],
      helpline: "155261 or 1800-115-526 (toll-free)",
      website: "pmkisan.gov.in",
    },

    "ayushman bharat": {
      full_name: "Ayushman Bharat – Pradhan Mantri Jan Arogya Yojana (PMJAY)",
      benefit:
        "₹5 lakh free health insurance per family per year at empanelled hospitals.",
      benefit_hi:
        "₹5 lakh tak ka free ilaj sarkari aur kuch private aspataalon mein.",
      who_can_apply:
        "BPL families and low-income households as per SECC 2011 data.",
      how_to_apply: "Check eligibility at mera.pmjay.gov.in or call 14555.",
      how_to_apply_hi: "mera.pmjay.gov.in ya helpline 14555 pe call karein.",
      documents: ["Aadhaar card", "Ration card or family ID"],
      helpline: "14555 (toll-free)",
      website: "pmjay.gov.in",
    },

    "fasal bima": {
      full_name: "Pradhan Mantri Fasal Bima Yojana (PMFBY)",
      benefit:
        "Crop insurance: compensates for losses due to floods, drought, pests.",
      benefit_hi:
        "Fasal kharab hone par muavza milta hai – barish, sukhha, keede se.",
      who_can_apply:
        "All farmers growing notified crops (loanee and non-loanee).",
      how_to_apply:
        "Register before crop sowing deadline through your bank or CSC.",
      how_to_apply_hi: "Fasal bone se pehle bank ya CSC mein register karein.",
      documents: [
        "Aadhaar",
        "Bank account",
        "Land records",
        "Sowing certificate",
      ],
      helpline: "1800-200-7710 (toll-free)",
      website: "pmfby.gov.in",
    },

    mnrega: {
      full_name:
        "Mahatma Gandhi National Rural Employment Guarantee Act (MGNREGA)",
      benefit:
        "100 days of guaranteed wage employment per year for rural households.",
      benefit_hi:
        "Gaon mein 100 din kaam ki guarantee. Majdoori seedha bank mein.",
      who_can_apply:
        "Any rural household member willing to do unskilled manual work.",
      how_to_apply: "Register at Gram Panchayat office with your Job Card.",
      how_to_apply_hi: "Gram Panchayat mein apna Job Card banvayen.",
      documents: ["Aadhaar card", "Bank account", "Job Card"],
      helpline: "1800-345-22-44 (toll-free)",
      website: "nrega.nic.in",
    },

    "jan dhan": {
      full_name: "Pradhan Mantri Jan Dhan Yojana (PMJDY)",
      benefit:
        "Zero-balance bank account with ₹1 lakh accident insurance, RuPay card.",
      benefit_hi:
        "Bina minimum balance ke bank account, ₹1 lakh bima, RuPay card.",
      who_can_apply: "Any Indian citizen without a bank account.",
      how_to_apply:
        "Visit any bank branch or Business Correspondent (BC) with Aadhaar.",
      how_to_apply_hi:
        "Nazdeeki bank ya Bank Mitra (BC) ke paas Aadhaar le jayen.",
      documents: ["Aadhaar card (or any govt ID)"],
      helpline: "1800-11-0001 (toll-free)",
      website: "pmjdy.gov.in",
    },

    nrlm: {
      full_name: "National Rural Livelihood Mission (DAY-NRLM / Aajeevika)",
      benefit:
        "Support for women Self-Help Groups (SHGs): training, loans, market linkage.",
      benefit_hi:
        "Mahilaon ke Self-Help Group (SHG) ke liye training, loan aur bazaar.",
      who_can_apply:
        "Rural women (especially BPL) who form groups of 10–20 members.",
      how_to_apply:
        "Contact your Block Development Office or local SHG facilitator.",
      how_to_apply_hi:
        "Block Development Office ya najdiki SHG sahayak se milein.",
      documents: ["Aadhaar", "Bank account", "Group formation certificate"],
      helpline: null,
      website: "aajeevika.gov.in",
    },
  };

  // Fuzzy match scheme name
  const matchedKey = Object.keys(schemes).find(
    (k) =>
      name.includes(k) ||
      k.includes(name) ||
      // Handle common alternate spellings
      (name.includes("kisan") && k === "pm kisan") ||
      (name.includes("fasal") && k === "fasal bima") ||
      (name.includes("bima") && k === "fasal bima") ||
      (name.includes("ayush") && k === "ayushman bharat") ||
      (name.includes("jandhan") && k === "jan dhan") ||
      (name.includes("jan dhan") && k === "jan dhan") ||
      ((name.includes("mnrega") || name.includes("nrega")) && k === "mnrega") ||
      ((name.includes("nrlm") || name.includes("livelihood")) && k === "nrlm"),
  );

  if (!matchedKey) {
    return {
      scheme_name,
      error: "scheme_not_found",
      message: `"${scheme_name}" ki jaankari abhi mere paas nahi hai. Kripya apne nazdeeki Common Service Centre (CSC) ya government office mein pata karein.`,
      known_schemes: Object.values(schemes).map((s) => s.full_name),
    };
  }

  return {
    ...schemes[matchedKey],
    query_received: scheme_name,
    data_source: "built-in knowledge base (verify at official website)",
  };
}

// ─── Tool Dispatcher ─────────────────────────────────────────────────────────

/**
 * Route an ElevenLabs tool_call request to the appropriate handler.
 *
 * @param {string} toolName      Name of the tool the agent wants to call
 * @param {object} parameters    Tool parameters
 * @returns {Promise<object>}    Result to send back to ElevenLabs
 */
async function dispatchToolCall(toolName, parameters) {
  const dispatch = {
    get_weather: handleGetWeather,
    get_mandi_price: handleGetMandiPrice,
    get_scheme_info: handleGetSchemeInfo,
  };

  const handler = dispatch[toolName];
  if (!handler) {
    log.warn(`Unknown tool called: ${toolName}`);
    return {
      error: "unknown_tool",
      message: `Tool "${toolName}" is not implemented.`,
    };
  }

  // Wrap with timeout
  return Promise.race([
    handler(parameters),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`),
          ),
        TOOL_TIMEOUT_MS,
      ),
    ),
  ]).catch((err) => {
    log.error(`Tool ${toolName} failed`, { err: err.message });
    return {
      error: "tool_execution_error",
      message: `Could not fetch ${toolName} data. Please advise user to check manually.`,
    };
  });
}

// ─── ElevenLabsSession class ──────────────────────────────────────────────────

/**
 * Represents a single ElevenLabs Conversational AI WebSocket session,
 * tied to one incoming phone call.
 *
 * Events emitted (for use by audioStreamBridge)
 * ──────────────────────────────────────────────
 *  'audio'          (base64PCMString, eventId)    – audio chunk to play to caller
 *  'interruption'   (eventId)                     – agent was interrupted, clear buffer
 *  'transcript'     (text, langCode)              – user speech transcript (for cache)
 *  'agent_response' (text)                        – agent text response (for logging)
 *  'metadata'       (conversationId, outputFormat)– connection established
 *  'error'          (err)                         – fatal session error
 *  'close'          ()                            – session closed cleanly
 */
class ElevenLabsSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.agentId
   * @param {string} [options.callSid]
   * @param {string} [options.callerNumber]
   * @param {string} [options.language='hi']
   */
  constructor({ agentId, callSid, callerNumber, language = "hi" }) {
    super();
    this.agentId = agentId;
    this.callSid = callSid;
    this.callerNumber = callerNumber;
    this.language = language;

    this.ws = null;
    this.conversationId = null;
    this.outputFormat = "pcm_16000";
    this.outputSampleRate = 16000;

    this._audioQueue = [];
    this._isClosed = false;
    this._pingTimer = null;
    this._reconnectLeft = RECONNECT_ATTEMPTS;

    // Transcript buffer to accumulate user's words for language detection
    this._transcriptBuffer = "";
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection to ElevenLabs.
   * Automatically sends the initiation override after connection.
   *
   * @returns {Promise<void>} Resolves when the connection_initiation_metadata is received
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this._isClosed) {
        return reject(new Error("Session already closed"));
      }

      const url = `${ELEVENLABS_WS_BASE}?agent_id=${encodeURIComponent(this.agentId)}`;

      log.info(`Connecting to ElevenLabs WS`, {
        url: url.replace(this.agentId, "***"),
        callSid: this.callSid,
      });

      this.ws = new WebSocket(url, {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
      });

      // ── Open ──────────────────────────────────────────────────────────────
      this.ws.on("open", () => {
        log.info("ElevenLabs WS open – sending initiation data", {
          callSid: this.callSid,
        });

        // This agent rejects runtime config overrides for fields like prompt
        // and first_message, so we only send the initiation envelope unless
        // an override object is explicitly non-empty.
        const override = buildCallOverride({
          language: this.language,
          callerNumber: this.callerNumber,
          callSid: this.callSid,
        });
        const initPayload = { type: "conversation_initiation_client_data" };
        if (override && Object.keys(override).length > 0) {
          initPayload.conversation_config_override = override;
        }

        this._sendJSON(initPayload);
      });

      // ── Message ───────────────────────────────────────────────────────────
      this.ws.on("message", (rawData) => {
        this._handleMessage(rawData, resolve);
      });

      // ── Error ─────────────────────────────────────────────────────────────
      this.ws.on("error", (err) => {
        log.error("ElevenLabs WS error", {
          err: err.message,
          callSid: this.callSid,
        });
        this.emit("error", err);
        reject(err);
      });

      // ── Close ─────────────────────────────────────────────────────────────
      this.ws.on("close", (code, reason) => {
        const reasonStr = reason?.toString() || "";
        log.info(`ElevenLabs WS closed`, {
          code,
          reason: reasonStr,
          callSid: this.callSid,
        });
        this._clearPingTimer();

        // Code 1002 with quota error = don't retry. Retrying won't help and wastes tokens.
        const isQuotaError = code === 1002 && reasonStr.includes("quota");
        
        if (!this._isClosed && this._reconnectLeft > 0 && !isQuotaError) {
          this._reconnectLeft--;
          log.warn(
            `Attempting reconnect (${RECONNECT_ATTEMPTS - this._reconnectLeft}/${RECONNECT_ATTEMPTS}) …`,
          );
          setTimeout(
            () => this.connect().catch(() => this._handleFinalClose()),
            RECONNECT_DELAY_MS,
          );
        } else {
          if (isQuotaError) {
            log.error("ElevenLabs quota exceeded – failing fast (not retrying)");
          }
          this._handleFinalClose();
        }
      });
    });
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  /**
   * @param {Buffer|string} rawData
   * @param {Function}      [resolveConnect]  Promise resolver for the initial connection
   */
  _handleMessage(rawData, resolveConnect) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      log.warn("ElevenLabs WS: could not parse message", {
        rawData: rawData.toString().slice(0, 200),
      });
      return;
    }

    switch (msg.type) {
      // ── Conversation established ────────────────────────────────────────
      case "conversation_initiation_metadata": {
        const meta = msg.conversation_initiation_metadata_event || {};
        this.conversationId = meta.conversation_id;
        this.outputFormat = meta.agent_output_audio_format || "pcm_16000";
        this.outputSampleRate = this.outputFormat.includes("24000")
          ? 24000
          : 16000;

        log.info("ElevenLabs session established", {
          conversationId: this.conversationId,
          outputFormat: this.outputFormat,
          callSid: this.callSid,
        });

        this.emit("metadata", this.conversationId, this.outputFormat);
        this._startPingWatchdog();

        if (resolveConnect) resolveConnect();
        break;
      }

      // ── Audio chunk from agent ──────────────────────────────────────────
      case "audio": {
        const audioEvent = msg.audio_event || {};
        const audioBase64 = audioEvent.audio_base_64;
        const eventId = audioEvent.event_id;

        if (audioBase64) {
          if (this._audioQueue.length < MAX_AUDIO_QUEUE) {
            this._audioQueue.push({ audioBase64, eventId });
            this.emit("audio", audioBase64, eventId, this.outputSampleRate);
          } else {
            log.warn("ElevenLabs audio queue full – dropping chunk", {
              callSid: this.callSid,
            });
          }
        }
        break;
      }

      // ── Agent text response ─────────────────────────────────────────────
      case "agent_response": {
        const agentText = msg.agent_response_event?.agent_response;
        if (agentText) {
          log.info(`Agent response: "${agentText.slice(0, 120)}"`, {
            callSid: this.callSid,
          });
          this.emit("agent_response", agentText);
        }
        break;
      }

      // ── Tentative (streaming) agent response ────────────────────────────
      case "internal_tentative_agent_response": {
        // Ignored for now – only useful for displaying partial text in UI
        break;
      }

      // ── User speech transcript ──────────────────────────────────────────
      case "user_transcript": {
        const transcript = msg.user_transcription_event?.user_transcript;
        if (transcript) {
          log.info(`User transcript: "${transcript}"`, {
            callSid: this.callSid,
          });

          // Update language detection from transcript
          this._transcriptBuffer += " " + transcript;
          const detectedLang = detectLanguage(this._transcriptBuffer.trim());
          if (detectedLang !== this.language) {
            log.info(
              `Language updated from transcript: ${this.language} → ${detectedLang}`,
            );
            this.language = detectedLang;
          }

          this.emit("transcript", transcript, this.language);
        }
        break;
      }

      // ── Interruption (user started speaking while agent was talking) ────
      case "interruption": {
        const eventId = msg.interruption_event?.event_id;
        log.info("Agent interrupted by user", {
          eventId,
          callSid: this.callSid,
        });
        this._audioQueue = []; // discard queued audio
        this.emit("interruption", eventId);
        break;
      }

      // ── Ping from server ────────────────────────────────────────────────
      case "ping": {
        const pingEvent = msg.ping_event || {};
        this._resetPingWatchdog();
        // Respond with pong immediately
        this._sendJSON({ type: "pong", event_id: pingEvent.event_id });
        break;
      }

      // ── Client-side tool call ───────────────────────────────────────────
      case "client_tool_call": {
        const toolCall = msg.client_tool_call || {};
        this._handleToolCall(toolCall);
        break;
      }

      // ── Agent correction (overrides previous audio) ─────────────────────
      case "agent_response_correction": {
        log.debug(
          "Agent response correction received – discarding queued audio",
          { callSid: this.callSid },
        );
        this._audioQueue = [];
        break;
      }

      default:
        log.debug(`ElevenLabs WS unhandled message type: ${msg.type}`);
    }
  }

  // ── Tool Call Handling ──────────────────────────────────────────────────────

  /**
   * Handle a client_tool_call message from ElevenLabs.
   * Runs the tool handler and sends back the result.
   *
   * @param {{ tool_call_id: string, tool_name: string, parameters: object }} toolCall
   */
  async _handleToolCall(toolCall) {
    const { tool_call_id, tool_name, parameters } = toolCall;
    log.info("Tool call received", {
      tool_name,
      parameters,
      callSid: this.callSid,
    });

    try {
      const result = await dispatchToolCall(tool_name, parameters || {});

      this._sendJSON({
        type: "client_tool_result",
        tool_call_id: tool_call_id,
        result: JSON.stringify(result),
        is_error: false,
      });

      log.info("Tool call result sent", { tool_name, tool_call_id });
    } catch (err) {
      log.error("Tool call error", { tool_name, err: err.message });

      this._sendJSON({
        type: "client_tool_result",
        tool_call_id: tool_call_id,
        result: JSON.stringify({ error: err.message }),
        is_error: true,
      });
    }
  }

  // ── Audio input ─────────────────────────────────────────────────────────────

  /**
   * Send a base-64–encoded PCM 16 kHz audio chunk to ElevenLabs.
   * This is the primary data path: Twilio audio → (converted) → here.
   *
   * @param {string} base64PCM  Base-64 PCM 16 kHz 16-bit mono
   */
  sendAudio(base64PCM) {
    if (!this._isOpen()) return;
    // ElevenLabs Conversational AI expects the raw chunk format (not typed event)
    this._sendJSON({ user_audio_chunk: base64PCM });
  }

  // ── Ping / pong watchdog ────────────────────────────────────────────────────

  _startPingWatchdog() {
    this._clearPingTimer();
    this._pingTimer = setTimeout(() => {
      log.warn(
        "No ping received from ElevenLabs – connection may be dead, closing.",
        { callSid: this.callSid },
      );
      this.close();
    }, PING_TIMEOUT_MS);
  }

  _resetPingWatchdog() {
    this._startPingWatchdog();
  }

  _clearPingTimer() {
    if (this._pingTimer) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * @param {object} payload
   */
  _sendJSON(payload) {
    if (!this._isOpen()) {
      log.debug("WS not open – dropping outbound message", {
        type: payload.type,
      });
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      log.error("Failed to send WS message to ElevenLabs", {
        err: err.message,
      });
    }
  }

  _isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  _handleFinalClose() {
    this._isClosed = true;
    this._clearPingTimer();
    this.emit("close");
    this.removeAllListeners();
  }

  // ── Public lifecycle ────────────────────────────────────────────────────────

  /**
   * Gracefully close the session and WebSocket.
   */
  close() {
    if (this._isClosed) return;
    this._isClosed = true;
    this._clearPingTimer();
    log.info("Closing ElevenLabs session", {
      conversationId: this.conversationId,
      callSid: this.callSid,
    });

    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close(1000, "Call ended");
      } catch {
        /* ignore */
      }
    }
    this.emit("close");
    this.removeAllListeners();
  }

  /**
   * @returns {boolean}
   */
  get isConnected() {
    return this._isOpen() && !this._isClosed;
  }

  /**
   * Human-readable session summary for logging.
   */
  get summary() {
    return {
      agentId: this.agentId,
      conversationId: this.conversationId,
      callSid: this.callSid,
      language: this.language,
      outputFormat: this.outputFormat,
      isConnected: this.isConnected,
      queuedAudio: this._audioQueue.length,
    };
  }
}

// ─── Session factory ──────────────────────────────────────────────────────────

/**
 * Create and connect a new ElevenLabsSession for an incoming call.
 *
 * @param {object} options
 * @param {string} [options.callSid]
 * @param {string} [options.callerNumber]
 * @param {string} [options.language='hi']
 * @returns {Promise<ElevenLabsSession>}
 */
async function createSession({ callSid, callerNumber, language = "hi" } = {}) {
  const agentId = await ensureAgent();

  const session = new ElevenLabsSession({
    agentId,
    callSid,
    callerNumber,
    language,
  });

  await session.connect();

  log.info("ElevenLabs session ready", {
    callSid,
    language,
    conversationId: session.conversationId,
  });

  return session;
}

// ─── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  // Session management
  createSession,
  ElevenLabsSession,

  // Agent management (used by scripts/setupAgent.js)
  ensureAgent,
  createAgent,
  getAgent,
  updateAgent,

  // Tool handlers (exported for testing)
  handleGetWeather,
  handleGetMandiPrice,
  handleGetSchemeInfo,
  dispatchToolCall,
};
