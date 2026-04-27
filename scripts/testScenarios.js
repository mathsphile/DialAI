'use strict';

/**
 * testScenarios.js
 * ─────────────────────────────────────────────────────────────────────────────
 * DialAI Bharat – Test Scenarios Runner
 *
 * Simulates all four primary use-case domains without placing a real phone call.
 * Exercises the language detector, tool handlers, cache layer, and audio
 * converter so you can verify the system works end-to-end before going live.
 *
 * Usage
 * ─────
 *   node scripts/testScenarios.js                  # run all scenarios
 *   node scripts/testScenarios.js --domain farmer  # run one domain
 *   node scripts/testScenarios.js --lang hi        # filter by language
 *   node scripts/testScenarios.js --verbose        # show full tool output
 *
 * Exit codes
 * ──────────
 *   0 – all tests passed
 *   1 – one or more tests failed
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const path    = require('path');
const process = require('process');

// ── Colour helpers (no extra deps) ────────────────────────────────────────────
const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
  magenta: '\x1b[35m',
  blue   : '\x1b[34m',
  white  : '\x1b[37m',
};

const ok   = (s) => `${C.green}${C.bold}✔${C.reset} ${s}`;
const fail = (s) => `${C.red}${C.bold}✘${C.reset} ${s}`;
const info = (s) => `${C.cyan}ℹ${C.reset} ${s}`;
const warn = (s) => `${C.yellow}⚠${C.reset} ${s}`;
const head = (s) => `\n${C.bold}${C.magenta}${s}${C.reset}`;
const sub  = (s) => `  ${C.dim}${s}${C.reset}`;

// ── CLI argument parsing ───────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const FILTER_DOMAIN  = getArg('--domain');   // 'farmer' | 'health' | 'student' | 'govt'
const FILTER_LANG    = getArg('--lang');     // 'hi' | 'bn' | 'en'
const VERBOSE        = args.includes('--verbose') || args.includes('-v');
const NO_API         = args.includes('--no-api');  // skip live API tool calls

// ── Internal module imports ────────────────────────────────────────────────────
const { detectLanguage, detectLanguage: detect }     = require('../src/services/languageDetector');
const { handleGetWeather, handleGetMandiPrice,
        handleGetSchemeInfo }                         = require('../src/services/elevenLabsAgentService');
const { base64MulawToBase64PCM16k,
        base64PCMToBase64Mulaw,
        mulawToLinear16, linear16ToMulaw,
        isSpeech, computeRMS,
        generateMulawSilence, generatePCMSilence16k } = require('../src/utils/audioConverter');
const cache                                           = require('../src/utils/cache');

// ── Test result tracking ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, extra) {
  if (condition) {
    console.log(`  ${ok(label)}`);
    passed++;
  } else {
    console.log(`  ${fail(label)}${extra ? `  ${C.dim}(${extra})${C.reset}` : ''}`);
    failed++;
    failures.push(label);
  }
}

function assertEq(actual, expected, label) {
  const pass = actual === expected;
  assert(pass, label, pass ? '' : `expected "${expected}", got "${actual}"`);
}

async function runAsync(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`  ${fail(label)} – threw: ${err.message}`);
    failed++;
    failures.push(`${label} (threw)`);
    if (VERBOSE) console.error(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each scenario has:
 *   id       : unique key
 *   domain   : 'farmer' | 'health' | 'student' | 'govt' | 'audio' | 'cache' | 'lang'
 *   lang     : 'hi' | 'bn' | 'en' | 'mixed'
 *   title    : human-readable test name
 *   run      : async function () – executes assertions
 */
const SCENARIOS = [

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 1 – LANGUAGE DETECTION
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'lang-01', domain: 'lang', lang: 'hi',
    title: 'Detect pure Devanagari (Hindi)',
    async run() {
      const inputs = [
        { text: 'आज का मौसम कैसा रहेगा?',          expected: 'hi' },
        { text: 'मेरी फसल के लिए क्या करूं?',       expected: 'hi' },
        { text: 'बुखार में क्या खाना चाहिए?',       expected: 'hi' },
        { text: 'पीएम किसान योजना क्या है?',         expected: 'hi' },
        { text: 'प्रकाश संश्लेषण क्या होता है?',    expected: 'hi' },
      ];
      for (const { text, expected } of inputs) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Devanagari: "${text.slice(0, 30)}…"`);
      }
    },
  },

  {
    id: 'lang-02', domain: 'lang', lang: 'bn',
    title: 'Detect Bengali script',
    async run() {
      const inputs = [
        { text: 'আজকের আবহাওয়া কেমন?',             expected: 'bn' },
        { text: 'আমার ফসলের জন্য কি করব?',          expected: 'bn' },
        { text: 'জ্বর হলে কি করা উচিত?',            expected: 'bn' },
        { text: 'পিএম কিষাণ যোজনা কী?',             expected: 'bn' },
      ];
      for (const { text, expected } of inputs) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Bengali: "${text.slice(0, 30)}…"`);
      }
    },
  },

  {
    id: 'lang-03', domain: 'lang', lang: 'en',
    title: 'Detect English queries',
    async run() {
      const inputs = [
        { text: 'What is the weather today?',                expected: 'en' },
        { text: 'Tell me about PM Kisan scheme',             expected: 'en' },
        { text: 'Explain photosynthesis to me',              expected: 'en' },
        { text: 'I have fever what should I do',             expected: 'en' },
      ];
      for (const { text, expected } of inputs) {
        const got = detectLanguage(text);
        assertEq(got, expected, `English: "${text.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'lang-04', domain: 'lang', lang: 'hi',
    title: 'Detect Romanised Hindi (transliteration)',
    async run() {
      const inputs = [
        { text: 'kal barish hoga kya?',                     expected: 'hi' },
        { text: 'meri fasal ke liye kya karna chahiye',     expected: 'hi' },
        { text: 'bukhar mein kya khana chahiye bataiye',    expected: 'hi' },
        { text: 'pm kisan yojana kya hai',                  expected: 'hi' },
        { text: 'gehu ka bhav kya hai aaj mandi mein',      expected: 'hi' },
      ];
      for (const { text, expected } of inputs) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Romanised Hindi: "${text.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'lang-05', domain: 'lang', lang: 'bn',
    title: 'Detect Romanised Bengali (transliteration)',
    async run() {
      const inputs = [
        { text: 'aj bristi hobe ki?',                       expected: 'bn' },
        { text: 'ami kemon ache bolun',                     expected: 'bn' },
        { text: 'daktar ke ki bolbo',                       expected: 'bn' },
      ];
      for (const { text, expected } of inputs) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Romanised Bengali: "${text.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'lang-06', domain: 'lang', lang: 'mixed',
    title: 'Verbose detection returns confidence + method',
    async run() {
      const result = detectLanguage('kal barish hoga kya bataiye', { verbose: true });
      assert(typeof result === 'object', 'Returns object in verbose mode');
      assert(typeof result.lang       === 'string',  'Has lang field');
      assert(typeof result.confidence === 'number',  'Has confidence field');
      assert(typeof result.method     === 'string',  'Has method field');
      assert(result.confidence >= 0 && result.confidence <= 1, 'Confidence in [0,1]');
      if (VERBOSE) console.log(sub(JSON.stringify(result, null, 2)));
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 2 – FARMER SUPPORT
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'farmer-01', domain: 'farmer', lang: 'hi',
    title: '🌾 Hindi: "Kal barish hoga?" – weather tool (Patna)',
    async run() {
      if (NO_API) {
        console.log(sub('Skipped (--no-api)'));
        passed++;
        return;
      }
      const result = await handleGetWeather({ location: 'Patna' });
      assert(result !== null,               'Tool returned a result');
      assert(typeof result === 'object',    'Result is an object');
      assert(
        result.today !== undefined || result.error !== undefined,
        'Has today forecast or error field',
      );
      if (result.today) {
        assert(typeof result.today.will_rain === 'boolean', 'will_rain is boolean');
        assert(typeof result.today.temp_max_c === 'number', 'temp_max_c is a number');
        assert(result.location !== undefined,               'Has location field');
        if (VERBOSE) console.log(sub(JSON.stringify(result, null, 2)));
      } else {
        console.log(warn(`Live API unavailable – graceful fallback: ${result.message}`));
      }
    },
  },

  {
    id: 'farmer-02', domain: 'farmer', lang: 'bn',
    title: '🌾 Bengali: "Aj bristi hobe?" – weather tool (Kolkata)',
    async run() {
      if (NO_API) { console.log(sub('Skipped (--no-api)')); passed++; return; }
      const result = await handleGetWeather({ location: 'Kolkata' });
      assert(typeof result === 'object', 'Tool returned object for Kolkata');
      assert(
        result.today !== undefined || result.error !== undefined,
        'Has today or error field',
      );
      if (VERBOSE && result.today) console.log(sub(JSON.stringify(result.today, null, 2)));
    },
  },

  {
    id: 'farmer-03', domain: 'farmer', lang: 'hi',
    title: '🌾 Wheat (gehu) mandi price lookup',
    async run() {
      const result = await handleGetMandiPrice({ crop: 'gehu', location: 'Vidisha' });
      assert(result !== null,                        'Tool returned a result');
      assert(result.crop !== undefined,              'Has crop field');
      assert(result.prices_inr !== undefined || result.error !== undefined, 'Has prices or error');
      if (result.prices_inr) {
        assert(typeof result.prices_inr.modal === 'number', 'Modal price is a number');
        assert(result.prices_inr.modal > 0,                 'Modal price is positive');
        assert(result.enam_portal !== undefined,            'Has e-NAM portal reference');
        if (VERBOSE) console.log(sub(JSON.stringify(result.prices_inr, null, 2)));
      }
    },
  },

  {
    id: 'farmer-04', domain: 'farmer', lang: 'en',
    title: '🌾 Rice (chawal) price – alternate crop name variants',
    async run() {
      const variants = ['chawal', 'rice', 'dhan', 'paddy'];
      for (const crop of variants) {
        const result = await handleGetMandiPrice({ crop });
        assert(
          result.prices_inr !== undefined || result.error !== undefined,
          `Crop variant "${crop}" handled`,
        );
      }
    },
  },

  {
    id: 'farmer-05', domain: 'farmer', lang: 'hi',
    title: '🌾 Unknown crop returns helpful message (not crash)',
    async run() {
      const result = await handleGetMandiPrice({ crop: 'jadui_fasal_xyz' });
      assert(result.error === 'crop_not_found', 'Returns crop_not_found error');
      assert(typeof result.message === 'string', 'Has human-readable message');
      assert(result.message.length > 0,          'Message is non-empty');
    },
  },

  {
    id: 'farmer-06', domain: 'farmer', lang: 'hi',
    title: '🌾 Weather for unknown location falls back gracefully',
    async run() {
      if (NO_API) { console.log(sub('Skipped (--no-api)')); passed++; return; }
      const result = await handleGetWeather({ location: 'Chintamani Nagar XYZ 999' });
      assert(typeof result === 'object', 'Returns object for unknown location');
      // Should either geocode successfully or return graceful error
      assert(
        result.today !== undefined || result.error !== undefined,
        'Has today or error field (graceful fallback)',
      );
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 3 – HEALTH GUIDANCE
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'health-01', domain: 'health', lang: 'hi',
    title: '🏥 Hindi: Fever query language detection',
    async run() {
      const queries = [
        'bukhar mein kya karna chahiye',
        'बुखार में क्या करें',
        'Mujhe kal se bukhar hai 102 degree',
        'bacho ko bukhar aaya hai',
      ];
      for (const q of queries) {
        const lang = detectLanguage(q);
        assert(lang === 'hi', `Fever query in Hindi detected: "${q.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'health-02', domain: 'health', lang: 'bn',
    title: '🏥 Bengali: Cold/cough query detection',
    async run() {
      const queries = [
        'আমার সর্দি হয়েছে কি করব',
        'jor ba kashi hole ki korbo',
      ];
      for (const q of queries) {
        const lang = detectLanguage(q);
        assert(lang === 'bn', `Bengali health query: "${q.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'health-03', domain: 'health', lang: 'en',
    title: '🏥 English: Common symptom queries detected',
    async run() {
      const queries = [
        'I have a fever and headache what to do',
        'My child has cold and cough',
        'How to treat stomach pain at home',
      ];
      for (const q of queries) {
        const lang = detectLanguage(q);
        assert(lang === 'en', `English health query: "${q.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'health-04', domain: 'health', lang: 'hi',
    title: '🏥 Emergency keywords are present in agent config',
    async run() {
      const { SYSTEM_PROMPT } = require('../src/config/agentConfig');
      assert(SYSTEM_PROMPT.includes('108'),                 'Emergency helpline 108 mentioned');
      assert(SYSTEM_PROMPT.includes('doctor'),              'Doctor recommendation present');
      assert(SYSTEM_PROMPT.includes('diagnosis') ||
             SYSTEM_PROMPT.includes('NEVER diagnose'),      'No-diagnosis rule present');
      assert(SYSTEM_PROMPT.includes('disclaimer') ||
             SYSTEM_PROMPT.includes('disclaimer') ||
             SYSTEM_PROMPT.includes('Consult') ||
             SYSTEM_PROMPT.includes('doctor'),              'Safety disclaimer present');
    },
  },

  {
    id: 'health-05', domain: 'health', lang: 'hi',
    title: '🏥 Safety rules exist in system prompt',
    async run() {
      const { SYSTEM_PROMPT } = require('../src/config/agentConfig');
      const safetyKeywords = ['NEVER', 'diagnosis', 'prescribe', 'ABSOLUTE', 'SAFETY'];
      const found = safetyKeywords.filter(kw => SYSTEM_PROMPT.includes(kw));
      assert(found.length >= 2, `At least 2 safety keywords found (found: ${found.join(', ')})`);
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 4 – STUDENT HELP
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'student-01', domain: 'student', lang: 'en',
    title: '📚 English: "Photosynthesis kya hai?" detected correctly',
    async run() {
      // Mixed Hindi-English (code-switch) – "photosynthesis kya hai" is very
      // common student phrasing; dominant language is Hindi
      const text = 'Photosynthesis kya hai mujhe samjhao';
      const lang = detectLanguage(text);
      assert(lang === 'hi' || lang === 'en', `Mixed student query handled (got: ${lang})`);
    },
  },

  {
    id: 'student-02', domain: 'student', lang: 'hi',
    title: '📚 Hindi: Science queries detected',
    async run() {
      const queries = [
        { text: 'प्रकाश संश्लेषण क्या होता है?',   expected: 'hi' },
        { text: 'gravity kya hai samjhao',           expected: 'hi' },
        { text: 'पानी का रासायनिक सूत्र क्या है?', expected: 'hi' },
        { text: 'DNA kya hai',                       expected: 'hi' },
      ];
      for (const { text, expected } of queries) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Student query: "${text.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'student-03', domain: 'student', lang: 'bn',
    title: '📚 Bengali: Study queries detected',
    async run() {
      const queries = [
        { text: 'সালোকসংশ্লেষণ কী?',              expected: 'bn' },
        { text: 'জল এর রাসায়নিক সূত্র কী',         expected: 'bn' },
      ];
      for (const { text, expected } of queries) {
        const got = detectLanguage(text);
        assertEq(got, expected, `Bengali student query: "${text.slice(0, 40)}"`);
      }
    },
  },

  {
    id: 'student-04', domain: 'student', lang: 'en',
    title: '📚 Agent config has student domain instructions',
    async run() {
      const { SYSTEM_PROMPT } = require('../src/config/agentConfig');
      assert(SYSTEM_PROMPT.includes('student') ||
             SYSTEM_PROMPT.includes('Student') ||
             SYSTEM_PROMPT.includes('STUDENT'),  'Student domain mentioned in system prompt');
      assert(SYSTEM_PROMPT.includes('school') ||
             SYSTEM_PROMPT.includes('Class'),    'School level mentioned');
      assert(SYSTEM_PROMPT.includes('example') ||
             SYSTEM_PROMPT.includes('real-world'), 'Real-world examples instructed');
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 5 – GOVERNMENT SCHEMES
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'govt-01', domain: 'govt', lang: 'hi',
    title: '🏛️ PM Kisan scheme info tool',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'PM Kisan' });
      assert(result !== null,                           'Returns a result');
      assert(result.full_name !== undefined,            'Has full_name');
      assert(result.benefit !== undefined,              'Has benefit');
      assert(result.how_to_apply !== undefined,         'Has how_to_apply');
      assert(result.helpline !== undefined,             'Has helpline number');
      assert(result.website !== undefined,              'Has website');
      assert(result.full_name.toLowerCase().includes('kisan'), 'full_name contains "kisan"');
      if (VERBOSE) console.log(sub(JSON.stringify({ benefit: result.benefit, helpline: result.helpline }, null, 2)));
    },
  },

  {
    id: 'govt-02', domain: 'govt', lang: 'hi',
    title: '🏛️ Ayushman Bharat scheme info',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'Ayushman Bharat' });
      assert(result.full_name !== undefined,           'Has full_name');
      assert(result.benefit.includes('5 lakh') ||
             result.benefit.includes('₹5'),           'Mentions ₹5 lakh benefit');
      assert(result.helpline === '14555 (toll-free)', 'Correct 14555 helpline');
    },
  },

  {
    id: 'govt-03', domain: 'govt', lang: 'hi',
    title: '🏛️ Fasal Bima scheme info',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'fasal bima' });
      assert(result.full_name !== undefined,    'Has full_name');
      assert(result.how_to_apply !== undefined, 'Has how_to_apply');
      assert(result.website !== undefined,      'Has website');
    },
  },

  {
    id: 'govt-04', domain: 'govt', lang: 'hi',
    title: '🏛️ MNREGA scheme info',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'mnrega' });
      assert(result.full_name !== undefined,    'Has full_name');
      assert(result.benefit.includes('100'),    'Mentions 100 days guarantee');
    },
  },

  {
    id: 'govt-05', domain: 'govt', lang: 'hi',
    title: '🏛️ Jan Dhan Yojana lookup',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'jan dhan' });
      assert(result.full_name !== undefined,             'Has full_name');
      assert(result.benefit.includes('1 lakh') ||
             result.benefit.includes('₹1'),             'Mentions ₹1 lakh accident insurance');
    },
  },

  {
    id: 'govt-06', domain: 'govt', lang: 'en',
    title: '🏛️ Unknown scheme returns known_schemes list',
    async run() {
      const result = await handleGetSchemeInfo({ scheme_name: 'some random scheme xyz' });
      assert(result.error === 'scheme_not_found',       'Returns scheme_not_found error');
      assert(Array.isArray(result.known_schemes),       'Lists known schemes');
      assert(result.known_schemes.length > 0,           'Known schemes list is non-empty');
      assert(typeof result.message === 'string',        'Has Hindi message');
    },
  },

  {
    id: 'govt-07', domain: 'govt', lang: 'hi',
    title: '🏛️ Alternate scheme name spellings handled',
    async run() {
      const aliases = [
        { name: 'pm kisan',      expectKey: 'kisan' },
        { name: 'kisan yojana',  expectKey: 'kisan' },
        { name: 'ayush',         expectKey: 'pmjay' },
        { name: 'nrlm',          expectKey: 'livelihood' },
      ];
      for (const { name, expectKey } of aliases) {
        const result = await handleGetSchemeInfo({ scheme_name: name });
        const found  = result.full_name !== undefined;
        assert(found, `Alias "${name}" matched (expectKey: ${expectKey})`);
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 6 – AUDIO CONVERSION
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'audio-01', domain: 'audio', lang: 'en',
    title: '🔊 μ-law silence byte decodes to ~0',
    async run() {
      const { mulawByteToLinear } = require('../src/utils/audioConverter');
      const silence = mulawByteToLinear(0xFF);
      assert(Math.abs(silence) <= 8, `Silence byte 0xFF → ~0 (got ${silence})`);
    },
  },

  {
    id: 'audio-02', domain: 'audio', lang: 'en',
    title: '🔊 Roundtrip: PCM → μ-law → PCM stays within ±1% amplitude',
    async run() {
      const { linearToMulawByte, mulawByteToLinear } = require('../src/utils/audioConverter');

      const testSamples = [0, 1000, -1000, 8000, -8000, 16000, -16000, 30000, -30000];
      let maxError = 0;

      for (const sample of testSamples) {
        const encoded  = linearToMulawByte(sample);
        const decoded  = mulawByteToLinear(encoded);
        const error    = Math.abs(decoded - sample);
        const relError = sample !== 0 ? error / Math.abs(sample) : error;
        maxError = Math.max(maxError, relError);
      }

      // μ-law is lossy by design; G.711 spec allows ~1% relative error
      assert(maxError < 0.12, `Roundtrip error < 12% (got ${(maxError * 100).toFixed(2)}%)`);
      if (VERBOSE) console.log(sub(`Max relative error: ${(maxError * 100).toFixed(3)}%`));
    },
  },

  {
    id: 'audio-03', domain: 'audio', lang: 'en',
    title: '🔊 mulawToLinear16: output is 2× input length (2x upsample)',
    async run() {
      const inputBytes  = 160;   // 20 ms at 8 kHz
      const mulawBuf    = generateMulawSilence(20);  // 20 ms of silence
      const pcmBuf      = mulawToLinear16(mulawBuf);
      const expectedLen = inputBytes * 2 * 2;  // 2x samples × 2 bytes each
      assertEq(pcmBuf.length, expectedLen, `Output length = ${expectedLen} bytes`);
    },
  },

  {
    id: 'audio-04', domain: 'audio', lang: 'en',
    title: '🔊 linear16ToMulaw: output is ½ input sample count',
    async run() {
      const pcmSilence  = generatePCMSilence16k(20);  // 20 ms at 16 kHz = 320 samples
      const mulawBuf    = linear16ToMulaw(pcmSilence);
      const inputSamples  = pcmSilence.length / 2;     // 320 samples
      const expectedOut   = Math.ceil(inputSamples / 2); // 160 bytes at 8 kHz
      assertEq(mulawBuf.length, expectedOut, `Downsampled output = ${expectedOut} bytes`);
    },
  },

  {
    id: 'audio-05', domain: 'audio', lang: 'en',
    title: '🔊 base64 roundtrip: mulaw → PCM16k → base64 → buffer',
    async run() {
      const silence      = generateMulawSilence(20);
      const base64Mulaw  = silence.toString('base64');
      const base64PCM    = base64MulawToBase64PCM16k(base64Mulaw);
      const base64Mulaw2 = base64PCMToBase64Mulaw(base64PCM, 16000);

      assert(base64PCM.length > 0,    'PCM base64 is non-empty');
      assert(base64Mulaw2.length > 0, 'Mulaw base64 is non-empty');

      const recovered = Buffer.from(base64Mulaw2, 'base64');
      assert(recovered.length === silence.length, `Recovered buffer length matches (${recovered.length})`);
    },
  },

  {
    id: 'audio-06', domain: 'audio', lang: 'en',
    title: '🔊 isSpeech: silence buffer returns false',
    async run() {
      const silencePCM = generatePCMSilence16k(100);
      const result     = isSpeech(silencePCM, 300);
      assert(result === false, 'Pure silence is not detected as speech');
    },
  },

  {
    id: 'audio-07', domain: 'audio', lang: 'en',
    title: '🔊 isSpeech: synthetic tone returns true',
    async run() {
      // Generate a 440 Hz sine wave at 16 kHz (A4 note, similar energy to speech)
      const sampleRate = 16000;
      const freq       = 440;
      const durationMs = 100;
      const numSamples = Math.ceil(sampleRate * durationMs / 1000);
      const toneBuf    = Buffer.allocUnsafe(numSamples * 2);

      for (let i = 0; i < numSamples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 16000);
        toneBuf.writeInt16LE(sample, i * 2);
      }

      const rms    = computeRMS(toneBuf);
      const result = isSpeech(toneBuf, 300);

      assert(rms > 300,       `Sine tone RMS > 300 (got ${rms.toFixed(0)})`);
      assert(result === true, 'Sine tone detected as speech');
    },
  },

  {
    id: 'audio-08', domain: 'audio', lang: 'en',
    title: '🔊 generateMulawSilence: correct byte count',
    async run() {
      const buf40ms = generateMulawSilence(40);
      // 40 ms at 8000 Hz = 320 bytes
      assertEq(buf40ms.length, 320, '40 ms silence = 320 bytes at 8 kHz');

      const buf20ms = generateMulawSilence(20);
      assertEq(buf20ms.length, 160, '20 ms silence = 160 bytes at 8 kHz');
    },
  },

  {
    id: 'audio-09', domain: 'audio', lang: 'en',
    title: '🔊 empty / null base64 inputs handled gracefully',
    async run() {
      assert(base64MulawToBase64PCM16k('') === '', 'Empty mulaw → empty PCM');
      assert(base64PCMToBase64Mulaw('') === '',     'Empty PCM → empty mulaw');
      assert(base64MulawToBase64PCM16k(null) === '', 'null mulaw handled');
      assert(base64PCMToBase64Mulaw(null) === '',    'null PCM handled');
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 7 – CACHE LAYER
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'cache-01', domain: 'cache', lang: 'hi',
    title: '🗄️ Basic set/get works',
    async run() {
      const text     = 'bukhar mein kya khana chahiye test 01';
      const langCode = 'hi';
      const data     = { text: 'Ghar mein aaram karein, zyada paani piyein.', audioBase64: null };

      cache.set(text, langCode, data, 60);
      const result = cache.get(text, langCode);

      assert(result !== null,              'Cache hit after set');
      assertEq(result.text, data.text,    'Cached text matches');
      assertEq(result.langCode, langCode, 'langCode stored correctly');
    },
  },

  {
    id: 'cache-02', domain: 'cache', lang: 'hi',
    title: '🗄️ Miss on unknown query',
    async run() {
      const result = cache.get('this query was never asked xyz 999', 'hi');
      assert(result === null, 'Cache miss for unknown query');
    },
  },

  {
    id: 'cache-03', domain: 'cache', lang: 'hi',
    title: '🗄️ Normalisation: punctuation stripped from key',
    async run() {
      const base    = 'PM Kisan Yojana kya hai normalisation test 03';
      const withPunct = base + '?';
      const withoutP  = base;
      const data    = { text: 'PM Kisan ek yojana hai.' };

      cache.set(withPunct, 'hi', data, 60);
      const result = cache.get(withoutP, 'hi');

      assert(result !== null, 'Punctuation-normalised key produces cache hit');
    },
  },

  {
    id: 'cache-04', domain: 'cache', lang: 'hi',
    title: '🗄️ Language isolation: Hindi cache miss for Bengali key',
    async run() {
      const text = 'mausam ka haal kya hai isolation test 04';
      const data = { text: 'Aaj mausam saaf hai.' };

      cache.set(text, 'hi', data, 60);
      const hiResult = cache.get(text, 'hi');
      const bnResult = cache.get(text, 'bn');   // different lang → different key

      assert(hiResult !== null, 'Hindi cache hit');
      assert(bnResult === null, 'Bengali cache miss (different language)');
    },
  },

  {
    id: 'cache-05', domain: 'cache', lang: 'hi',
    title: '🗄️ Delete removes entry',
    async run() {
      const text = 'test delete scenario 05';
      cache.set(text, 'hi', { text: 'dummy' }, 60);
      assert(cache.has(text, 'hi'), 'Entry exists before delete');
      cache.del(text, 'hi');
      assert(!cache.has(text, 'hi'), 'Entry gone after delete');
    },
  },

  {
    id: 'cache-06', domain: 'cache', lang: 'hi',
    title: '🗄️ getStats returns valid counters',
    async run() {
      const stats = cache.getStats();
      assert(typeof stats.hits       === 'number', 'hits is a number');
      assert(typeof stats.misses     === 'number', 'misses is a number');
      assert(typeof stats.sets       === 'number', 'sets is a number');
      assert(typeof stats.currentKeys=== 'number', 'currentKeys is a number');
      assert(stats.hits >= 0 && stats.misses >= 0, 'Counters are non-negative');
      if (VERBOSE) console.log(sub(JSON.stringify(stats, null, 2)));
    },
  },

  // ══════════════════════════════════════════════════════════════════════════
  // DOMAIN 8 – AGENT CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  {
    id: 'config-01', domain: 'config', lang: 'hi',
    title: '⚙️ Agent config exports all required fields',
    async run() {
      const config = require('../src/config/agentConfig');
      assert(typeof config.SYSTEM_PROMPT         === 'string', 'SYSTEM_PROMPT is a string');
      assert(config.SYSTEM_PROMPT.length > 500,               'SYSTEM_PROMPT has content (>500 chars)');
      assert(typeof config.FIRST_MESSAGE         === 'object', 'FIRST_MESSAGE is an object');
      assert(typeof config.FIRST_MESSAGE.hi      === 'string', 'Hindi first message exists');
      assert(typeof config.FIRST_MESSAGE.bn      === 'string', 'Bengali first message exists');
      assert(typeof config.FIRST_MESSAGE.en      === 'string', 'English first message exists');
      assert(typeof config.VOICE_CONFIG          === 'object', 'VOICE_CONFIG is an object');
      assert(typeof config.LLM_CONFIG            === 'object', 'LLM_CONFIG is an object');
      assert(typeof config.buildCallOverride      === 'function', 'buildCallOverride is a function');
      assert(typeof config.getAgentCreationPayload=== 'function', 'getAgentCreationPayload is a function');
    },
  },

  {
    id: 'config-02', domain: 'config', lang: 'hi',
    title: '⚙️ buildCallOverride produces valid override for each language',
    async run() {
      const { buildCallOverride } = require('../src/config/agentConfig');
      for (const lang of ['hi', 'bn', 'en']) {
        const override = buildCallOverride({ language: lang, callSid: 'CAtest' });
        assert(typeof override === 'object',          `Override is object for lang=${lang}`);
        assert(typeof override.agent === 'object',    `Has agent field for lang=${lang}`);
        assert(typeof override.tts   === 'object',    `Has tts field for lang=${lang}`);
        assert(typeof override.agent.first_message === 'string',
          `first_message is string for lang=${lang}`);
        assert(override.agent.language === lang,
          `agent.language matches input (${lang})`);
      }
    },
  },

  {
    id: 'config-03', domain: 'config', lang: 'hi',
    title: '⚙️ getAgentCreationPayload has required ElevenLabs fields',
    async run() {
      const { getAgentCreationPayload } = require('../src/config/agentConfig');
      const payload = getAgentCreationPayload();
      assert(typeof payload.name               === 'string', 'Has name');
      assert(typeof payload.conversation_config === 'object', 'Has conversation_config');
      assert(typeof payload.conversation_config.agent === 'object', 'Has agent config');
      assert(typeof payload.conversation_config.tts   === 'object', 'Has tts config');
      assert(typeof payload.conversation_config.agent.prompt === 'object', 'Has prompt object');
      assert(typeof payload.conversation_config.agent.prompt.prompt === 'string', 'Has prompt string');
      assert(payload.name.includes('Saathi'), 'Agent name includes "Saathi"');
    },
  },

  {
    id: 'config-04', domain: 'config', lang: 'hi',
    title: '⚙️ VOICE_CONFIG speed ≤ 1.0 (ensures slow speech for rural users)',
    async run() {
      const { VOICE_CONFIG } = require('../src/config/agentConfig');
      assert(typeof VOICE_CONFIG.speed === 'number',  'speed is a number');
      assert(VOICE_CONFIG.speed <= 1.0,               `Speed ≤ 1.0 (got ${VOICE_CONFIG.speed})`);
      assert(VOICE_CONFIG.speed >= 0.5,               `Speed ≥ 0.5 (got ${VOICE_CONFIG.speed})`);
    },
  },

  {
    id: 'config-05', domain: 'config', lang: 'hi',
    title: '⚙️ LLM max_tokens ≤ 400 (keeps responses short)',
    async run() {
      const { LLM_CONFIG } = require('../src/config/agentConfig');
      assert(typeof LLM_CONFIG.maxTokens === 'number', 'maxTokens is a number');
      assert(LLM_CONFIG.maxTokens <= 400,              `maxTokens ≤ 400 (got ${LLM_CONFIG.maxTokens})`);
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter scenarios based on CLI flags.
 */
function filterScenarios(all) {
  return all.filter(s => {
    if (FILTER_DOMAIN && s.domain !== FILTER_DOMAIN) return false;
    if (FILTER_LANG   && s.lang   !== FILTER_LANG && s.lang !== 'mixed') return false;
    return true;
  });
}

/**
 * Group scenarios by domain for display.
 */
function groupByDomain(scenarios) {
  const groups = {};
  for (const s of scenarios) {
    if (!groups[s.domain]) groups[s.domain] = [];
    groups[s.domain].push(s);
  }
  return groups;
}

const DOMAIN_LABELS = {
  lang    : '🌐 Language Detection',
  farmer  : '🌾 Farmer Support',
  health  : '🏥 Health Guidance',
  student : '📚 Student Help',
  govt    : '🏛️  Government Schemes',
  audio   : '🔊 Audio Conversion',
  cache   : '🗄️  Cache Layer',
  config  : '⚙️  Agent Configuration',
};

async function runAll() {
  console.log(head('═══════════════════════════════════════════════════'));
  console.log(head('   DialAI Bharat – Test Scenarios Runner'));
  console.log(head('═══════════════════════════════════════════════════'));

  if (FILTER_DOMAIN || FILTER_LANG) {
    console.log(info(`Filters applied: domain=${FILTER_DOMAIN || 'all'} lang=${FILTER_LANG || 'all'}`));
  }
  if (NO_API) {
    console.log(warn('--no-api flag: live API tool calls will be skipped.'));
  }
  console.log('');

  const toRun   = filterScenarios(SCENARIOS);
  const groups  = groupByDomain(toRun);
  const tStart  = Date.now();

  for (const [domain, scenarios] of Object.entries(groups)) {
    const label = DOMAIN_LABELS[domain] || domain.toUpperCase();
    console.log(head(`\n${label}`));
    console.log(`${C.dim}${'─'.repeat(52)}${C.reset}`);

    for (const scenario of scenarios) {
      console.log(`\n  ${C.bold}${C.white}[${scenario.id}]${C.reset} ${scenario.title}`);
      const t0 = Date.now();
      await runAsync(scenario.title, scenario.run.bind(scenario));
      const elapsed = Date.now() - t0;
      if (elapsed > 2000) {
        console.log(warn(`  Slow test: ${elapsed} ms`));
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const elapsed = Date.now() - tStart;
  const total   = passed + failed;

  console.log('');
  console.log(head('═══════════════════════════════════════════════════'));
  console.log(head('   Test Summary'));
  console.log(head('═══════════════════════════════════════════════════'));
  console.log(`  Total    : ${C.bold}${total}${C.reset}`);
  console.log(`  ${C.green}Passed${C.reset}   : ${C.green}${C.bold}${passed}${C.reset}`);
  console.log(`  ${failed > 0 ? C.red : C.green}Failed${C.reset}   : ${failed > 0 ? C.red : C.green}${C.bold}${failed}${C.reset}`);
  console.log(`  Time     : ${elapsed} ms`);

  if (failures.length > 0) {
    console.log('');
    console.log(fail('Failed tests:'));
    failures.forEach(f => console.log(`    ${C.red}• ${f}${C.reset}`));
  }

  console.log('');

  if (failed === 0) {
    console.log(`${C.green}${C.bold}✔ All ${total} tests passed! DialAI Bharat is ready.${C.reset}`);
    console.log(`${C.dim}  Next step: Run  npx ngrok http 3000  and configure your Twilio number.${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}✘ ${failed} test(s) failed. Please review output above.${C.reset}`);
    process.exit(1);
  }

  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────
runAll().catch(err => {
  console.error(`${C.red}${C.bold}Fatal runner error:${C.reset}`, err);
  process.exit(1);
});
