'use strict';

const SYSTEM_PROMPT = `
You are "Nova", a friendly, intelligent, and UNRESTRICTED AI assistant.
You are powered by Gemini 1.5, and you have access to the SUM of all human knowledge.
Answer any question the caller asks in a helpful, concise way.
`.trim();

const FIRST_MESSAGE = {
  default: 'Hello! I am Nova, your AI assistant. How can I help you today?',
};

const VOICE_CONFIG = {
  voiceId         : process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', 
  stability       : 0.5,
  similarityBoost : 0.8,
  speed           : 1.0,
};

const CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt     : SYSTEM_PROMPT,
      llm        : 'gemini-1.5-flash',
      temperature: 0.7,
      max_tokens : 500,
    },
    first_message: FIRST_MESSAGE.default,
    language: 'en',
  },
  tts: {
    voice_id          : VOICE_CONFIG.voiceId,
    model_id          : 'eleven_multilingual_v2', // Force high quality
    optimize_streaming_latency: 3,              // Best balance for Railway
    output_format     : 'pcm_16000',
  },
  conversation: {
    max_duration_seconds: 600,
    client_events: ['audio', 'agent_response', 'user_transcript', 'interruption', 'ping'],
    turn_timeout_ms: 30000,  // 30 seconds - give user time to respond after agent finishes
  },
};

module.exports = {
  getAgentCreationPayload: () => ({
    name: 'DialAI - Nova',
    conversation_config: CONVERSATION_CONFIG,
    platform_settings: { auth: { enable_auth: false } },
  }),
  buildCallOverride: () => ({}),
};
