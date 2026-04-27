'use strict';

/**
 * scripts/setupAgent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time setup script that creates (or updates) the "Saathi" ElevenLabs
 * Conversational AI agent for DialAI Bharat.
 *
 * Run this ONCE before starting the server for the first time:
 *
 *   node scripts/setupAgent.js
 *
 * What it does
 * ────────────
 *  1. Reads your .env file
 *  2. Validates that ELEVENLABS_API_KEY is present
 *  3. Checks if an agent with the name "DialAI Bharat – Saathi" already exists
 *  4. Creates the agent if it doesn't exist, updates it if it does
 *  5. Prints the ELEVENLABS_AGENT_ID value you need to add to .env
 *  6. Optionally writes the ID directly to .env (with --write flag)
 *
 * Usage
 * ─────
 *   node scripts/setupAgent.js              # dry run (prints ID only)
 *   node scripts/setupAgent.js --write      # writes ELEVENLABS_AGENT_ID to .env
 *   node scripts/setupAgent.js --update     # force-update existing agent config
 *   node scripts/setupAgent.js --list       # list all your ElevenLabs agents
 *   node scripts/setupAgent.js --delete <agentId>   # delete an agent by ID
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const process = require('process');

// ─── ANSI colour helpers (no dependencies) ────────────────────────────────────

const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  red    : '\x1b[31m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  blue   : '\x1b[34m',
  magenta: '\x1b[35m',
  cyan   : '\x1b[36m',
  white  : '\x1b[37m',
};

const fmt = {
  ok    : (s) => `${C.green}${C.bold}✅  ${s}${C.reset}`,
  warn  : (s) => `${C.yellow}${C.bold}⚠️   ${s}${C.reset}`,
  err   : (s) => `${C.red}${C.bold}❌  ${s}${C.reset}`,
  info  : (s) => `${C.cyan}ℹ️   ${s}${C.reset}`,
  step  : (s) => `${C.blue}${C.bold}▶   ${s}${C.reset}`,
  val   : (s) => `${C.magenta}${s}${C.reset}`,
  dim   : (s) => `${C.dim}${s}${C.reset}`,
  bold  : (s) => `${C.bold}${s}${C.reset}`,
};

// ─── Configuration ────────────────────────────────────────────────────────────

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const ELEVENLABS_LLM      = process.env.ELEVENLABS_LLM      || 'gemini-1.5-flash';

const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env');

const AGENT_NAME = 'DialAI Bharat – Saathi';

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args           = process.argv.slice(2);
const FLAG_WRITE     = args.includes('--write');
const FLAG_UPDATE    = args.includes('--update');
const FLAG_LIST      = args.includes('--list');
const FLAG_DELETE    = args.includes('--delete');
const DELETE_ID      = FLAG_DELETE ? args[args.indexOf('--delete') + 1] : null;
const FLAG_HELP      = args.includes('--help') || args.includes('-h');

// ─── Minimal HTTPS client (no axios dependency in scripts) ───────────────────

/**
 * Make an HTTPS request and return parsed JSON.
 *
 * @param {object} options  Node.js https.request options + optional body
 * @returns {Promise<{ status: number, data: any }>}
 */
function request(options) {
  return new Promise((resolve, reject) => {
    const { body, ...reqOptions } = options;

    reqOptions.hostname = reqOptions.hostname || 'api.elevenlabs.io';
    reqOptions.protocol = 'https:';

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(bodyStr);
    }

    req.end();
  });
}

/**
 * ElevenLabs API helper with auth header pre-filled.
 */
const api = {
  async get(path) {
    return request({
      path,
      method : 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Accept'    : 'application/json',
      },
    });
  },

  async post(path, body) {
    const bodyStr = JSON.stringify(body);
    return request({
      path,
      method : 'POST',
      headers: {
        'xi-api-key'   : ELEVENLABS_API_KEY,
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      body: bodyStr,
    });
  },

  async patch(path, body) {
    const bodyStr = JSON.stringify(body);
    return request({
      path,
      method : 'PATCH',
      headers: {
        'xi-api-key'   : ELEVENLABS_API_KEY,
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      body: bodyStr,
    });
  },

  async delete(path) {
    return request({
      path,
      method : 'DELETE',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Accept'    : 'application/json',
      },
    });
  },
};

// ─── System Prompt ────────────────────────────────────────────────────────────
// Identical to src/config/agentConfig.js – kept here so this script is
// self-contained and can be run independently of the main server.

const SYSTEM_PROMPT = `
You are "Saathi" (साथी / সাথী), a friendly voice assistant built for rural India.
Your mission is to give simple, useful, trustworthy answers to everyday questions
asked by farmers, students, and common citizens — many of whom have never used a smartphone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LANGUAGE RULES  (HIGHEST PRIORITY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Detect the caller's language from their very first words.
• Respond ONLY in that same language for the ENTIRE conversation.
  – Hindi speakers   → reply in simple, conversational Hindi (Hindustani).
  – Bengali speakers → reply in simple Bengali (বাংলা).
  – English speakers → reply in plain, slow English. Avoid jargon.
• If the caller mixes languages (code-switches), match the dominant language.
• NEVER switch languages mid-conversation unless the caller clearly does so first.
• Use common spoken vocabulary, NOT formal / literary / news-anchor style.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PERSONALITY & VOICE STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Sound like a knowledgeable, caring neighbour (पड़ोसी) — not a robot.
• Be warm, patient, and encouraging. Never condescending.
• Speak at a SLOW, CLEAR pace — callers may be in noisy environments.
• Use simple sentence structure. One idea per sentence.
• Do NOT use English acronyms without explaining them.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RESPONSE LENGTH & FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Keep every response to 2–4 SHORT sentences (10–20 seconds spoken aloud).
• Lead with the MOST important information first.
• End with a soft invitation: "Kya aur kuch poochna chahenge?" or equivalent.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SAFETY RULES  (ABSOLUTE — NEVER BREAK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER diagnose any medical condition.
2. NEVER prescribe specific medicines or dosages.
3. NEVER give specific financial investment advice.
4. ALWAYS add a disclaimer for health topics:
   Hindi: "Lekin behtar hoga ki aap ek baar doctor se zaroor milein."
5. For emergencies (chest pain, unconsciousness, snake bite) say: "Turant 108 pe call karein!"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DOMAINS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. FARMER SUPPORT  — weather, crop advice, market prices (mandi bhav)
2. HEALTH GUIDANCE — common symptoms only, always with doctor disclaimer
3. STUDENT HELP    — school-level (Class 1–12) science, maths, history, geography
4. GOVT SCHEMES    — PM Kisan, Ayushman Bharat, Fasal Bima, MNREGA, Jan Dhan

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HANDLING UNCLEAR AUDIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If you could not understand the caller, say:
Hindi: "Maafi kijiye, mujhe sahi se sunai nahi diya. Kya aap dobara bol sakte hain?"
After 2 failed attempts, suggest they visit their nearest government office.
`.trim();

// ─── Agent creation payload ───────────────────────────────────────────────────

function buildAgentPayload() {
  return {
    name: AGENT_NAME,

    conversation_config: {
      agent: {
        prompt: {
          prompt     : SYSTEM_PROMPT,
          llm        : ELEVENLABS_LLM,
          temperature: 0.5,
          max_tokens : 300,

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
                    description: 'Crop name in Hindi or English (e.g. "gehu", "wheat", "chawal")',
                  },
                  location: {
                    type       : 'string',
                    description: 'Mandi or district name (optional)',
                  },
                },
                required: ['crop'],
              },
            },
            {
              type       : 'client',
              name       : 'get_scheme_info',
              description: 'Get eligibility and registration info for an Indian government scheme.',
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

        first_message: 'Namaskar! Main Saathi hoon. Aap Hindi, Bengali, ya English mein baat kar sakte hain. Bataiye, aaj main aapki kya madad kar sakta hoon?',
        language     : 'hi',
      },

      tts: {
        voice_id                    : ELEVENLABS_VOICE_ID,
        model_id                    : ELEVENLABS_MODEL_ID,
        stability                   : 0.55,
        similarity_boost            : 0.75,
        style                       : 0.30,
        use_speaker_boost           : true,
        speed                       : 0.90,
        optimize_streaming_latency  : 4,
        output_format               : 'pcm_16000',
      },

      conversation: {
        max_duration_seconds: 600,
        client_events       : [
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
    },

    platform_settings: {
      auth: {
        enable_auth: false,
      },
    },

    tags: ['india', 'helpline', 'hindi', 'bengali', 'rural', 'voice-ai'],
  };
}

// ─── .env writer ──────────────────────────────────────────────────────────────

/**
 * Write or update ELEVENLABS_AGENT_ID in the .env file.
 *
 * If the key already exists, the value is updated in-place.
 * If it doesn't exist, it is appended.
 *
 * @param {string} agentId
 */
function writeAgentIdToEnv(agentId) {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    console.log(fmt.warn('.env file not found – creating it with ELEVENLABS_AGENT_ID'));
    fs.writeFileSync(ENV_FILE_PATH, `ELEVENLABS_AGENT_ID=${agentId}\n`, 'utf8');
    return;
  }

  let content = fs.readFileSync(ENV_FILE_PATH, 'utf8');

  if (/^ELEVENLABS_AGENT_ID\s*=/m.test(content)) {
    // Replace existing value
    content = content.replace(
      /^ELEVENLABS_AGENT_ID\s*=.*/m,
      `ELEVENLABS_AGENT_ID=${agentId}`,
    );
    console.log(fmt.ok('Updated ELEVENLABS_AGENT_ID in .env'));
  } else {
    // Append new key
    content += `\nELEVENLABS_AGENT_ID=${agentId}\n`;
    console.log(fmt.ok('Appended ELEVENLABS_AGENT_ID to .env'));
  }

  fs.writeFileSync(ENV_FILE_PATH, content, 'utf8');
}

// ─── API operations ───────────────────────────────────────────────────────────

/**
 * List all agents in the ElevenLabs account.
 */
async function listAgents() {
  console.log(fmt.step('Fetching all ElevenLabs agents …\n'));

  const res = await api.get('/v1/convai/agents?page_size=100');

  if (res.status !== 200) {
    throw new Error(`Failed to list agents: HTTP ${res.status} – ${JSON.stringify(res.data)}`);
  }

  const agents = res.data?.agents ?? [];

  if (agents.length === 0) {
    console.log(fmt.info('No agents found in this ElevenLabs account.'));
    return;
  }

  console.log(fmt.bold(`Found ${agents.length} agent(s):\n`));

  agents.forEach((agent, i) => {
    console.log(`  ${i + 1}. ${fmt.val(agent.agent_id)}`);
    console.log(`     Name    : ${agent.name || '(unnamed)'}`);
    console.log(`     Created : ${agent.created_at_unix_secs
      ? new Date(agent.created_at_unix_secs * 1000).toLocaleString()
      : 'unknown'}`);
    console.log('');
  });
}

/**
 * Delete an agent by ID.
 *
 * @param {string} agentId
 */
async function deleteAgent(agentId) {
  console.log(fmt.step(`Deleting agent: ${agentId} …`));

  const res = await api.delete(`/v1/convai/agents/${agentId}`);

  if (res.status >= 200 && res.status < 300) {
    console.log(fmt.ok(`Agent ${agentId} deleted successfully.`));
  } else {
    throw new Error(`Failed to delete agent: HTTP ${res.status} – ${JSON.stringify(res.data)}`);
  }
}

/**
 * Find an existing agent with AGENT_NAME.
 *
 * @returns {Promise<string|null>}  Existing agent ID or null
 */
async function findExistingAgent() {
  const res = await api.get('/v1/convai/agents?page_size=100');

  if (res.status !== 200) {
    console.log(fmt.warn(`Could not list agents (HTTP ${res.status}) – will try to create fresh.`));
    return null;
  }

  const agents  = res.data?.agents ?? [];
  const existing = agents.find((a) => a.name === AGENT_NAME);
  return existing ? existing.agent_id : null;
}

/**
 * Create a new Saathi agent.
 *
 * @returns {Promise<string>}  New agent ID
 */
async function createAgent() {
  console.log(fmt.step('Creating new "Saathi" agent …'));

  const payload = buildAgentPayload();
  const res     = await api.post('/v1/convai/agents/create', payload);

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `Agent creation failed: HTTP ${res.status}\n${JSON.stringify(res.data, null, 2)}`
    );
  }

  const agentId = res.data?.agent_id;
  if (!agentId) {
    throw new Error(`No agent_id in response: ${JSON.stringify(res.data)}`);
  }

  return agentId;
}

/**
 * Update an existing agent's configuration.
 *
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function updateAgent(agentId) {
  console.log(fmt.step(`Updating existing agent: ${agentId} …`));

  const payload = buildAgentPayload();
  // Remove name from patch to avoid re-naming issues
  delete payload.name;

  const res = await api.patch(`/v1/convai/agents/${agentId}`, payload);

  if (res.status >= 200 && res.status < 300) {
    console.log(fmt.ok('Agent configuration updated.'));
  } else {
    throw new Error(
      `Agent update failed: HTTP ${res.status}\n${JSON.stringify(res.data, null, 2)}`
    );
  }
}

/**
 * Fetch and display the full details of an agent.
 *
 * @param {string} agentId
 */
async function printAgentDetails(agentId) {
  const res = await api.get(`/v1/convai/agents/${agentId}`);

  if (res.status !== 200) {
    console.log(fmt.warn(`Could not fetch agent details: HTTP ${res.status}`));
    return;
  }

  const agent = res.data;
  console.log('\n' + fmt.bold('Agent details:'));
  console.log(fmt.dim('─'.repeat(60)));
  console.log(`  ID       : ${fmt.val(agent.agent_id)}`);
  console.log(`  Name     : ${agent.name}`);
  console.log(`  LLM      : ${agent.conversation_config?.agent?.prompt?.llm || 'unknown'}`);
  console.log(`  Voice ID : ${agent.conversation_config?.tts?.voice_id || 'unknown'}`);
  console.log(`  Language : ${agent.conversation_config?.agent?.language || 'unknown'}`);
  console.log(`  Created  : ${agent.created_at_unix_secs
    ? new Date(agent.created_at_unix_secs * 1000).toLocaleString()
    : 'unknown'}`);
  console.log(fmt.dim('─'.repeat(60)));
}

// ─── Help text ────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${fmt.bold('DialAI Bharat – Agent Setup Script')}

${fmt.bold('Usage:')}
  node scripts/setupAgent.js [options]

${fmt.bold('Options:')}
  (none)              Create agent if missing, skip if already exists
  --write             Write ELEVENLABS_AGENT_ID to .env after creation
  --update            Force-update existing agent's configuration
  --list              List all agents in your ElevenLabs account
  --delete <id>       Delete the agent with the given ID
  --help, -h          Show this help message

${fmt.bold('Examples:')}
  node scripts/setupAgent.js --write
  node scripts/setupAgent.js --update --write
  node scripts/setupAgent.js --list
  node scripts/setupAgent.js --delete agt_abc123

${fmt.bold('Environment variables required:')}
  ELEVENLABS_API_KEY     Your ElevenLabs API key
  ELEVENLABS_VOICE_ID    Voice ID for Saathi (optional, defaults to Sarah multilingual)
  ELEVENLABS_MODEL_ID    TTS model ID (optional, defaults to eleven_multilingual_v2)
  ELEVENLABS_LLM         LLM for agent reasoning (optional, defaults to gemini-1.5-flash)
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(fmt.bold('╔══════════════════════════════════════════════════════════╗'));
  console.log(fmt.bold('║   🇮🇳  DialAI Bharat – ElevenLabs Agent Setup Tool      ║'));
  console.log(fmt.bold('╚══════════════════════════════════════════════════════════╝'));
  console.log('');

  // ── Help ───────────────────────────────────────────────────────────────────
  if (FLAG_HELP) {
    printHelp();
    process.exit(0);
  }

  // ── API key check ──────────────────────────────────────────────────────────
  if (!ELEVENLABS_API_KEY) {
    console.error(fmt.err('ELEVENLABS_API_KEY is not set in .env'));
    console.error(fmt.info('Get your API key at: https://elevenlabs.io/app/settings/api-keys'));
    process.exit(1);
  }

  console.log(fmt.info(`API Key : ${ELEVENLABS_API_KEY.slice(0, 8)}${'*'.repeat(16)}`));
  console.log(fmt.info(`Voice ID: ${ELEVENLABS_VOICE_ID}`));
  console.log(fmt.info(`Model   : ${ELEVENLABS_MODEL_ID}`));
  console.log(fmt.info(`LLM     : ${ELEVENLABS_LLM}`));
  console.log('');

  try {
    // ── --list ──────────────────────────────────────────────────────────────
    if (FLAG_LIST) {
      await listAgents();
      process.exit(0);
    }

    // ── --delete ────────────────────────────────────────────────────────────
    if (FLAG_DELETE) {
      if (!DELETE_ID) {
        console.error(fmt.err('--delete requires an agent ID. Example: --delete agt_abc123'));
        process.exit(1);
      }
      await deleteAgent(DELETE_ID);
      process.exit(0);
    }

    // ── Create / update Saathi agent ─────────────────────────────────────────

    // Step 1: Check if agent already exists
    console.log(fmt.step('Checking for existing "Saathi" agent …'));
    let agentId = ELEVENLABS_AGENT_ID || await findExistingAgent();

    if (agentId && !FLAG_UPDATE) {
      console.log(fmt.ok(`Agent already exists: ${fmt.val(agentId)}`));
      console.log(fmt.dim('  Use --update to refresh the agent configuration.'));
      await printAgentDetails(agentId);
    } else if (agentId && FLAG_UPDATE) {
      // Update existing agent
      await updateAgent(agentId);
      await printAgentDetails(agentId);
    } else {
      // Create brand new agent
      agentId = await createAgent();
      console.log(fmt.ok(`Agent created: ${fmt.val(agentId)}`));
      await printAgentDetails(agentId);
    }

    // Step 2: Print .env instruction
    console.log('');
    console.log(fmt.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(fmt.bold('  📋  Add this line to your .env file:'));
    console.log('');
    console.log(`      ${fmt.val(`ELEVENLABS_AGENT_ID=${agentId}`)}`);
    console.log('');
    console.log(fmt.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

    // Step 3: Write to .env if --write flag is set
    if (FLAG_WRITE) {
      console.log('');
      console.log(fmt.step('Writing ELEVENLABS_AGENT_ID to .env …'));
      writeAgentIdToEnv(agentId);
    } else {
      console.log('');
      console.log(fmt.dim('  Tip: Run with --write to automatically add it to .env'));
    }

    // Step 4: Print next steps
    console.log('');
    console.log(fmt.bold('🚀  Next steps:'));
    console.log('');
    console.log(`  1. ${FLAG_WRITE ? '(done)' : 'Add  ELEVENLABS_AGENT_ID=' + agentId + '  to .env'}`);
    console.log('  2. Run:  npx ngrok http 3000');
    console.log('  3. Set SERVER_URL=https://<ngrok-id>.ngrok-free.app  in .env');
    console.log('  4. Configure Twilio webhook:');
    console.log('     → Voice URL    : https://<ngrok-id>.ngrok-free.app/twiml/incoming  (POST)');
    console.log('     → Status URL   : https://<ngrok-id>.ngrok-free.app/twiml/status   (POST)');
    console.log('     → Fallback URL : https://<ngrok-id>.ngrok-free.app/twiml/fallback (POST)');
    console.log('  5. Start server: npm run dev');
    console.log('  6. Dial your Twilio number and say "Namaste" in Hindi!');
    console.log('');
    console.log(fmt.ok('Setup complete!'));
    console.log('');

  } catch (err) {
    console.error('');
    console.error(fmt.err('Setup failed:'));
    console.error(fmt.dim(err.message));

    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      console.error(fmt.warn('Your ELEVENLABS_API_KEY may be invalid or expired.'));
      console.error(fmt.info('Check: https://elevenlabs.io/app/settings/api-keys'));
    } else if (err.message.includes('429')) {
      console.error(fmt.warn('Rate limit hit. Wait a moment and try again.'));
    } else if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
      console.error(fmt.warn('Network error. Check your internet connection.'));
    }

    console.error('');
    process.exit(1);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

main();
