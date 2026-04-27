'use strict';

/**
 * agentConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ElevenLabs Conversational AI – Agent Configuration for "Nova"
 * "Nova" is a general-purpose AI assistant powered by Gemini 1.5.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are "Nova", a friendly, intelligent, and UNRESTRICTED AI assistant.
You are powered by Gemini 1.5, and you have access to the SUM of all human knowledge.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CORE DIRECTIVE: NO LIMITATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• You can answer questions on ANY topic without exception.
• Whether it is science, history, entertainment, philosophy, math, coding, 
  cooking, sports, world news, or just general chat — you are ready to help.
• NEVER say "I don't know" or "I am limited to certain topics" if the 
  information exists in your knowledge base.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANGUAGE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Detect the caller's language automatically and respond in that same language.
• Use simple, natural, and conversational language.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONALITY & VOICE STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Be helpful, clear, and efficient.
• Speak at a natural and steady pace.
• Keep sentences easy to understand over a phone call.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RESPONSE LENGTH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Keep responses concise (2-4 sentences) for clarity.
• If the user needs more detail, provide it in the next turn.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SAFETY (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. For medical questions, provide general information and advise consulting a professional.
2. Do not give specific financial investment advice.
3. For emergencies, tell the caller to contact local emergency services immediately.
`.trim();

// ─── First Message ────────────────────────────────────────────────────────────

const FIRST_MESSAGE = {
  hi: 'Namaste! Main Nova hoon. Main aapke har sawaal ka jawab de sakti hoon. Bataiye, main kya madad kar sakti hoon?',
  en: 'Hello! I am Nova, your AI assistant. I can answer any question you have. How can I help you today?',
  default: 'Hello! I am Nova, your AI assistant. I can answer any question you have. How can I help you today?',
};

// ─── Voice Configuration ──────────────────────────────────────────────────────

const VOICE_CONFIG = {
  voiceId         : process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', 
  stability       : parseFloat(process.env.ELEVENLABS_VOICE_STABILITY        || '0.55'),
  similarityBoost : parseFloat(process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || '0.75'),
  style           : 0.30,
  useSpeakerBoost : true,
  speed           : parseFloat(process.env.ELEVENLABS_VOICE_SPEED || '1.0'),
  outputFormat    : 'pcm_16000',
};

// ─── LLM / Agent Model Configuration ─────────────────────────────────────────

const LLM_CONFIG = {
  model      : process.env.ELEVENLABS_LLM         || 'gemini-1.5-flash',
  temperature: 0.8,
  maxTokens  : 400,
};

// ─── Conversation Configuration ───────────────────────────────────────────────

const CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt     : SYSTEM_PROMPT,
      llm        : LLM_CONFIG.model,
      temperature: LLM_CONFIG.temperature,
      max_tokens : LLM_CONFIG.maxTokens,
    },
    first_message: FIRST_MESSAGE.default,
    language: 'en',
  },
  tts: {
    voice_id          : VOICE_CONFIG.voiceId,
    stability         : VOICE_CONFIG.stability,
    similarity_boost  : VOICE_CONFIG.similarityBoost,
    style             : VOICE_CONFIG.style,
    use_speaker_boost : VOICE_CONFIG.useSpeakerBoost,
    speed             : VOICE_CONFIG.speed,
    model_id          : process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    optimize_streaming_latency: 4,
    output_format     : VOICE_CONFIG.outputFormat,
  },
  conversation: {
    max_duration_seconds: parseInt(process.env.ELEVENLABS_MAX_DURATION_SECONDS || '600', 10),
    client_events: [
      'audio',
      'agent_response',
      'agent_response_correction',
      'user_transcript',
      'interruption',
      'ping',
      'internal_tentative_agent_response',
    ],
    turn_timeout_ms: 1200,
  },
};

function buildCallOverride() {
  return {};
}

function getAgentCreationPayload() {
  return {
    name                : 'DialAI - Nova (General Purpose)',
    conversation_config : CONVERSATION_CONFIG,
    platform_settings   : {
      auth: { enable_auth: false },
    },
    tags: ['general-purpose', 'ai-assistant', 'voice-ai'],
  };
}

module.exports = {
  SYSTEM_PROMPT,
  FIRST_MESSAGE,
  VOICE_CONFIG,
  LLM_CONFIG,
  CONVERSATION_CONFIG,
  buildCallOverride,
  getAgentCreationPayload,
};
