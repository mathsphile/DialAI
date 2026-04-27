'use strict';

require('dotenv').config();

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const process = require('process');

// Import the actual configuration from the src directory
const { getAgentCreationPayload } = require('../src/config/agentConfig');

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

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || '';
const ENV_FILE_PATH = path.resolve(__dirname, '..', '.env');

const args           = process.argv.slice(2);
const FLAG_WRITE     = args.includes('--write');
const FLAG_UPDATE    = args.includes('--update');
const FLAG_LIST      = args.includes('--list');

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
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
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

const api = {
  async get(path) {
    return request({ path, method : 'GET', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'application/json' } });
  },
  async post(path, body) {
    const bodyStr = JSON.stringify(body);
    return request({ path, method : 'POST', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, body: bodyStr });
  },
  async patch(path, body) {
    const bodyStr = JSON.stringify(body);
    return request({ path, method : 'PATCH', headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, body: bodyStr });
  }
};

async function main() {
  console.log('\n' + fmt.bold('╔══════════════════════════════════════════════════════════╗'));
  console.log(fmt.bold('║   🇮🇳  DialAI – ElevenLabs Agent Setup Tool      ║'));
  console.log(fmt.bold('╚══════════════════════════════════════════════════════════╝\n'));

  if (!ELEVENLABS_API_KEY) {
    console.error(fmt.err('ELEVENLABS_API_KEY is not set in .env'));
    process.exit(1);
  }

  try {
    if (FLAG_LIST) {
      const res = await api.get('/v1/convai/agents?page_size=100');
      console.log(fmt.bold('Agents:'), res.data.agents);
      process.exit(0);
    }

    const payload = getAgentCreationPayload();
    let agentId = ELEVENLABS_AGENT_ID;

    if (agentId && FLAG_UPDATE) {
      console.log(fmt.step(`Updating agent ${agentId} with UNRESTRICTED knowledge ...`));
      const updatePayload = { ...payload.conversation_config };
      const res = await api.patch(`/v1/convai/agents/${agentId}`, { conversation_config: updatePayload });
      
      if (res.status >= 200 && res.status < 300) {
        console.log(fmt.ok('SUCCESS: Agent is now fully open to all topics!'));
      } else {
        console.error(fmt.err('Update failed'), res.data);
      }
    } else {
      console.log(fmt.step('Creating a new UNRESTRICTED agent ...'));
      const res = await api.post('/v1/convai/agents/create', payload);
      agentId = res.data.agent_id;
      console.log(fmt.ok(`Created new open agent: ${agentId}`));
      if (FLAG_WRITE) {
         let content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
         content = content.replace(/^ELEVENLABS_AGENT_ID\s*=.*/m, `ELEVENLABS_AGENT_ID=${agentId}`);
         fs.writeFileSync(ENV_FILE_PATH, content, 'utf8');
         console.log(fmt.ok('Updated .env with new Agent ID'));
      }
    }

    console.log('\n' + fmt.bold('🚀 DONE: The agent is now powered by Gemini 1.5 with FULL KNOWLEDGE.'));
    console.log(fmt.info('Restart your server and ask it anything!'));

  } catch (err) {
    console.error(fmt.err('Error:'), err.message);
  }
}

main();
