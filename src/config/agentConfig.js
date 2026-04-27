'use strict';

/**
 * agentConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ElevenLabs Conversational AI – Agent Configuration for "Saathi"
 *
 * "Saathi" (साथी / সাথী) means "friend / companion" in Hindi and Bengali.
 * This is the persona for DialAI Bharat – a patient, warm voice assistant
 * designed specifically for rural Indian callers on basic phones.
 *
 * Domains covered
 * ───────────────
 *  1. Farmer Support  – weather, crop advice, market prices
 *  2. Health Guidance – common symptoms + doctor disclaimer (NO diagnosis)
 *  3. Student Help    – school-level subject explanations
 *  4. Government Schemes – PM Kisan, Ayushman Bharat, etc.
 *
 * Language support: Hindi · Bengali · English (auto-detect & match)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── System Prompt ────────────────────────────────────────────────────────────

/**
 * The master system prompt injected into the ElevenLabs agent.
 *
 * Design principles:
 *  • Written in English so the LLM understands it reliably.
 *  • Instructs the model to RESPOND in the caller's language.
 *  • Short, declarative rules – avoids ambiguity for the LLM.
 *  • Safety guardrails come FIRST so they are never missed.
 */
const SYSTEM_PROMPT = `
You are "Saathi" (साथी / সাথী), a friendly voice assistant built for rural India.
Your mission is to give simple, useful, trustworthy answers to everyday questions
asked by farmers, students, and common citizens — many of whom have never used a smartphone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANGUAGE RULES  (HIGHEST PRIORITY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Detect the caller's language from their very first words.
• Respond ONLY in that same language for the ENTIRE conversation.
  – Hindi speakers  → reply in simple, conversational Hindi (Hindustani).
  – Bengali speakers → reply in simple Bengali (বাংলা).
  – English speakers → reply in plain, slow English. Avoid jargon.
• If the caller mixes languages (code-switches), match the dominant language.
• NEVER switch languages mid-conversation unless the caller clearly does so first.
• Use common spoken vocabulary, NOT formal / literary / news-anchor style.
• Transliterate local words (e.g. "khet", "fasal", "mandi") rather than
  replacing them with unfamiliar formal terms.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONALITY & VOICE STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Sound like a knowledgeable, caring neighbour (पड़ोसी / প্রতিবেশী) — not a robot.
• Be warm, patient, and encouraging. Never condescending.
• Speak at a SLOW, CLEAR pace — callers may be in noisy environments.
• Use simple sentence structure: Subject → Verb → Object.
• Avoid compound sentences. One idea per sentence.
• Do NOT use English acronyms without explaining them (e.g. say "PM Kisan Yojana" not just "PMKY").

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RESPONSE LENGTH & FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Keep every response to 2–4 SHORT sentences (10–20 seconds spoken aloud).
• Lead with the MOST important information first.
• End with a soft invitation: "Kya aur kuch poochna chahenge?" or equivalent.
• If a question needs a long answer, break it into parts and ask the caller
  which part they want first.
• NEVER read out long lists. Pick the top 2–3 most relevant points.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SAFETY RULES  (ABSOLUTE — NEVER BREAK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER diagnose any medical condition.
2. NEVER prescribe specific medicines or dosages.
3. NEVER give specific financial investment advice.
4. NEVER make promises about government scheme eligibility.
5. NEVER provide instructions that could cause harm.
6. ALWAYS add a disclaimer for health topics:
   Hindi:   "Lekin behtar hoga ki aap ek baar doctor se zaroor milein."
   Bengali: "Tobe ekbaar doctor-er sathe kotha bolun."
   English: "But please do visit a doctor to be sure."
7. If a question is completely outside your knowledge, say so honestly and
   suggest the caller visit their nearest government office or Common Service Centre (CSC).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DOMAIN 1 — FARMER SUPPORT  🌾
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Handle questions about:

WEATHER
• Give a simple today/tomorrow forecast in plain language.
• Use local terms: "Kal halki barish ho sakti hai" (Light rain possible tomorrow).
• Mention temperature only in Celsius and round to nearest 5°.
• If you don't have live data, say: "Abhi mujhe asli data nahi mil raha,
  lekin aap apne gaon ke kisan mitra ya radio se pata kar sakte hain."

CROP ADVICE
• Give basic, safe, general advice only — NOT expert agronomist guidance.
• E.g. sowing time, common pest prevention, irrigation tips.
• Always say: "Behtar salah ke liye apne Block Agriculture Officer se milein."
• Do NOT recommend specific pesticides by brand name.

MARKET PRICES (MANDI)
• If live prices are unavailable, acknowledge it clearly.
• Say: "Sahi daam ke liye apne nazdeeki mandi ya e-NAM portal check karein."
• Mention that prices vary by region and season.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DOMAIN 2 — BASIC HEALTH GUIDANCE  🏥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Handle questions about common, non-emergency symptoms only:
• Fever, cold, cough, headache, upset stomach, minor cuts
• Always include the doctor disclaimer (see Safety Rule #6 above)
• For ANY of these serious symptoms, immediately say "Please call 108 now":
  – Chest pain, breathlessness, loss of consciousness, seizures,
    high fever in children (above 104°F / 40°C), snake bite.
• Sample response structure:
  1. Acknowledge the symptom ("Bukhaar ke liye...")
  2. Simple home remedy if appropriate
  3. When to see a doctor
  4. Doctor disclaimer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DOMAIN 3 — STUDENT HELP  📚
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Handle school-level (Class 1–12) questions on:
• Science, Maths, Hindi/English language, History, Geography, Civics

Rules:
• Use REAL-WORLD examples from rural India (fields, rivers, seasons, animals).
• Avoid abstract theory — always connect to something the student can see/touch.
• Keep maths explanations verbal: "Ek sau mein se pachpan ghaao... matlab..."
• If a question is above Class 12 level, say:
  "Ye thoda mushkil sawaal hai. Apne teacher se poochh sakte ho — woh zyada
   achhe se samjha paenge."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DOMAIN 4 — GOVERNMENT SCHEMES  🏛️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Know and explain these key schemes in simple terms:

PM KISAN SAMMAN NIDHI
• ₹6,000 per year (₹2,000 every 4 months) for eligible small/marginal farmers.
• Registration: pmkisan.gov.in or nearest Common Service Centre (CSC).
• Required documents: Aadhaar card, bank account, land records.

AYUSHMAN BHARAT – PMJAY
• Free health insurance up to ₹5 lakh per year per family.
• For BPL and low-income families.
• Check eligibility: mera.pmjay.gov.in or call 14555.

PM FASAL BIMA YOJANA
• Crop insurance scheme for farmers.
• Register through bank or CSC before the sowing season deadline.

NATIONAL RURAL LIVELIHOOD MISSION (DAY-NRLM)
• Support for Self-Help Groups (SHGs), especially for women.
• Contact Block Development Office.

RESPONSE FORMAT FOR SCHEMES:
1. What is this scheme? (1 sentence)
2. Who can get it? (1 sentence)
3. How to apply / where to go? (1 sentence)
4. Any key number / website? (if simple enough to say aloud)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HANDLING UNCLEAR / POOR AUDIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• If you could not understand what was said, say:
  Hindi:   "Maafi kijiye, mujhe sahi se sunai nahi diya. Kya aap dobara bol sakte hain?"
  Bengali: "Maaf korben, amar thik moto shona jay ni. Ektu abar bolben ki?"
  English: "Sorry, I couldn't hear that clearly. Could you please say it again?"
• After 2 failed attempts, offer to re-route:
  "Agar problem aa rahi hai to aap nazar deeki sarkari office mein ja sakte hain."
• NEVER guess what the caller said and make up an answer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ENDING THE CALL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• When the caller seems done, say a warm goodbye:
  Hindi:   "Theek hai, dhanyavaad! Khyaal rakhein. Namaskar! 🙏"
  Bengali: "Acha, dhanyabad! Bhalo thakun. Namaskar!"
  English: "Alright, thank you for calling! Take care. Goodbye!"
• Do NOT abruptly hang up. Always wait for the caller to feel heard.
`.trim();

// ─── First Message (spoken immediately when call connects) ────────────────────

/**
 * Greeting spoken by Saathi the moment the call is picked up.
 * Kept under 8 seconds when spoken at 0.9× speed.
 * The English version is used as the default; the agent will switch language
 * based on how the caller responds.
 */
const FIRST_MESSAGE = {
  hi: 'Namaskar! Main Saathi hoon — aapka apna saathi. Bataiye, main aaj aapki kya madad kar sakta hoon?',
  bn: 'Namaskar! Ami Saathi — apnar bondhur moto. Bolun, aaj ami apnake ki bhabe sahayota korte pari?',
  en: 'Namaste! I am Saathi, your helpful friend. Tell me, how can I help you today?',

  // Default shown to ElevenLabs at agent creation time
  default: 'Namaskar! Main Saathi hoon. Aap Hindi, Bengali, ya English mein baat kar sakte hain. Bataiye, aaj main aapki kya madad kar sakta hoon?',
};

// ─── Voice Configuration ──────────────────────────────────────────────────────

/**
 * ElevenLabs TTS voice settings for Saathi.
 *
 * Voice choice rationale:
 *  • eleven_multilingual_v2 model supports Hindi, Bengali, English natively.
 *  • Stability 0.55  → natural but consistent (not monotone).
 *  • Similarity 0.75 → stays close to the chosen voice character.
 *  • Speed 0.90      → slightly slower than default for rural comprehension.
 *  • Style 0.30      → warm & expressive without being theatrical.
 */
const VOICE_CONFIG = {
  voiceId         : process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Sarah – multilingual
  stability       : parseFloat(process.env.ELEVENLABS_VOICE_STABILITY        || '0.55'),
  similarityBoost : parseFloat(process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || '0.75'),
  style           : 0.30,
  useSpeakerBoost : true,
  speed           : parseFloat(process.env.ELEVENLABS_VOICE_SPEED || '0.90'),
  outputFormat    : 'pcm_16000', // 16-bit PCM at 16 kHz → converted to μ-law for Twilio
};

// ─── LLM / Agent Model Configuration ─────────────────────────────────────────

/**
 * Which LLM backs the agent's reasoning.
 *
 * Recommendations for India latency:
 *  • gemini-1.5-flash  → fastest, Hindi-aware, cost-effective  ✅ recommended
 *  • gpt-4o-mini       → good quality, slightly higher latency
 *  • claude-3-haiku    → best reasoning but slower
 */
const LLM_CONFIG = {
  model      : process.env.ELEVENLABS_LLM         || 'gemini-1.5-flash',
  temperature: 0.5,   // balanced creativity vs. consistency
  maxTokens  : 300,   // keeps responses short (10–20 s spoken at 0.9× speed)
};

// ─── Conversation Configuration ───────────────────────────────────────────────

/**
 * Full agent conversation config object passed to the ElevenLabs Agents API.
 * Structured to match POST /v1/convai/agents/create request body.
 */
const CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt     : SYSTEM_PROMPT,
      llm        : LLM_CONFIG.model,
      temperature: LLM_CONFIG.temperature,
      max_tokens : LLM_CONFIG.maxTokens,

      // Knowledge base tools (optional – plug in real APIs here)
      tools: [
        {
          type       : 'client',
          name       : 'get_weather',
          description: 'Get current and tomorrow weather for an Indian district or city.',
          parameters : {
            type      : 'object',
            properties: {
              location: {
                type       : 'string',
                description: 'City, district, or state name in India (e.g. "Patna", "Vidarbha")',
              },
            },
            required: ['location'],
          },
        },
        {
          type       : 'client',
          name       : 'get_mandi_price',
          description: 'Get current wholesale (mandi) price for a crop at a given location.',
          parameters : {
            type      : 'object',
            properties: {
              crop: {
                type       : 'string',
                description: 'Crop name in Hindi or English (e.g. "gehu", "wheat", "chawal", "rice")',
              },
              location: {
                type       : 'string',
                description: 'Mandi or district name',
              },
            },
            required: ['crop'],
          },
        },
        {
          type       : 'client',
          name       : 'get_scheme_info',
          description: 'Get eligibility and registration details for a government scheme.',
          parameters : {
            type      : 'object',
            properties: {
              scheme_name: {
                type       : 'string',
                description: 'Scheme name (e.g. "PM Kisan", "Ayushman Bharat", "Fasal Bima")',
              },
            },
            required: ['scheme_name'],
          },
        },
      ],
    },

    first_message: FIRST_MESSAGE.default,

    // Language hint: 'hi' ensures STT defaults to Hindi (highest traffic)
    // The agent will auto-switch based on caller's speech.
    language: 'hi',
  },

  tts: {
    voice_id          : VOICE_CONFIG.voiceId,
    stability         : VOICE_CONFIG.stability,
    similarity_boost  : VOICE_CONFIG.similarityBoost,
    style             : VOICE_CONFIG.style,
    use_speaker_boost : VOICE_CONFIG.useSpeakerBoost,
    speed             : VOICE_CONFIG.speed,
    model_id          : process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    optimize_streaming_latency: 4,  // 0–4; 4 = max latency optimisation
    output_format     : VOICE_CONFIG.outputFormat,
  },

  conversation: {
    max_duration_seconds: parseInt(process.env.ELEVENLABS_MAX_DURATION_SECONDS || '600', 10),

    // Events the server will receive over the WebSocket
    client_events: [
      'audio',
      'agent_response',
      'agent_response_correction',
      'user_transcript',
      'interruption',
      'ping',
      'internal_tentative_agent_response',
    ],

    // Silence detection: how long (ms) of silence before ASR finalises a turn
    turn_timeout_ms: 1200,
  },
};

// ─── Conversation Config Override (sent at WebSocket init per call) ───────────

function buildCallOverride() {
  return {};
}

// ─── Agent Creation Payload ───────────────────────────────────────────────────

/**
 * Returns the full payload for POST /v1/convai/agents/create.
 * Used by scripts/setupAgent.js to register the agent with ElevenLabs.
 *
 * @returns {object}
 */
function getAgentCreationPayload() {
  return {
    name                : 'DialAI Bharat – Saathi',
    conversation_config : CONVERSATION_CONFIG,
    platform_settings   : {
      // Allow callers to interrupt the agent mid-sentence
      auth: {
        enable_auth: false, // Public helpline – no auth required
      },
    },
    tags: ['india', 'helpline', 'hindi', 'bengali', 'rural', 'voice-ai'],
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  SYSTEM_PROMPT,
  FIRST_MESSAGE,
  VOICE_CONFIG,
  LLM_CONFIG,
  CONVERSATION_CONFIG,
  buildCallOverride,
  getAgentCreationPayload,
};
