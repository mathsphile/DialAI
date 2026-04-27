"use strict";

/**
 * languageDetector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight, zero-dependency language detector for DialAI Bharat.
 *
 * Supported languages
 * ───────────────────
 *  • hi  – Hindi        (Devanagari script + Latin transliteration)
 *  • bn  – Bengali      (Bengali / Assamese script + Latin transliteration)
 *  • en  – English      (Latin script fallback)
 *
 * Detection strategy (applied in order, first match wins)
 * ────────────────────────────────────────────────────────
 *  1. Unicode script analysis  – Devanagari / Bengali character ratio
 *  2. Stopword matching        – High-frequency words per language
 *  3. Transliteration hints    – Common Romanised Hindi / Bengali words
 *  4. Fallback                 – Configurable default (default: 'hi')
 *
 * All methods are pure functions with no I/O or async operations so they can
 * be called inline on each user transcript without latency overhead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Unicode script ranges ─────────────────────────────────────────────────────

/** Devanagari block: U+0900 – U+097F  (Hindi, Sanskrit, Marathi, Nepali …) */
const RE_DEVANAGARI = /[\u0900-\u097F]/g;

/** Bengali block: U+0980 – U+09FF  (Bengali, Assamese) */
const RE_BENGALI = /[\u0980-\u09FF]/g;

/** Generic Latin (ASCII + extended Latin) – used to measure Latin ratio */
const RE_LATIN = /[A-Za-z\u00C0-\u024F]/g;

// ── Script detection threshold ────────────────────────────────────────────────

/**
 * Minimum ratio of script-specific characters to total characters for a
 * confident script-based detection.
 * Lowered from the default 0.2 because PSTN speech often gets partially
 * mis-transcribed, producing mixed-script text.
 */
const SCRIPT_THRESHOLD = parseFloat(
  process.env.LANG_DETECTION_THRESHOLD || "0.12",
);

// ── Stopword lists ────────────────────────────────────────────────────────────
// Curated high-frequency function words that are unambiguous per language.
// Listed in rough frequency order (most common first).

/**
 * Devanagari Hindi stopwords (native script).
 * Sorted by corpus frequency in conversational / rural Hindi.
 */
const HINDI_STOPWORDS_DEVANAGARI = new Set([
  "है",
  "हैं",
  "का",
  "की",
  "के",
  "में",
  "को",
  "से",
  "और",
  "पर",
  "यह",
  "वह",
  "हम",
  "आप",
  "मैं",
  "तुम",
  "वो",
  "जो",
  "कि",
  "पर",
  "था",
  "थी",
  "थे",
  "हो",
  "हों",
  "ने",
  "भी",
  "तो",
  "ही",
  "नहीं",
  "क्या",
  "कब",
  "कहाँ",
  "कैसे",
  "कितना",
  "क्यों",
  "कौन",
  "कोई",
  "अब",
  "यहाँ",
  "वहाँ",
  "बहुत",
  "अच्छा",
  "ठीक",
  "हाँ",
  "नहीं",
  "मुझे",
  "हमें",
  "उन्हें",
  "उसे",
  "इसे",
  "सब",
  "जब",
  "तब",
  "फिर",
  "लेकिन",
  "मगर",
  "या",
  "अगर",
  "तो",
  "चाहिए",
  "होगा",
  "बारिश",
  "मौसम",
  "फसल",
  "खेत",
  "किसान",
  "कल",
  "आज",
]);

/**
 * Bengali stopwords (native script).
 */
const BENGALI_STOPWORDS_NATIVE = new Set([
  "আমি",
  "তুমি",
  "সে",
  "আমরা",
  "তোমরা",
  "তারা",
  "এটি",
  "এটা",
  "ওটা",
  "কি",
  "কী",
  "কে",
  "কোথায়",
  "কেন",
  "কখন",
  "কীভাবে",
  "আছে",
  "আছেন",
  "আছি",
  "ছিল",
  "ছিলাম",
  "হবে",
  "হয়",
  "হচ্ছে",
  "এবং",
  "বা",
  "কিন্তু",
  "যদি",
  "তাহলে",
  "না",
  "হ্যাঁ",
  "এখানে",
  "সেখানে",
  "এখন",
  "তখন",
  "আবার",
  "আর",
  "এই",
  "সেই",
  "ভালো",
  "খারাপ",
  "আজ",
  "কাল",
  "বৃষ্টি",
  "আবহাওয়া",
  "চাষ",
  "কৃষক",
  "বাজার",
  "দাম",
]);

// ── Latin transliteration dictionaries ───────────────────────────────────────
// Words that are unambiguously associated with a language when typed in
// Latin script (Romanised Hindi / Bengali, common in WhatsApp / SMS culture).

/**
 * Romanised Hindi words.
 * Includes common rural-context vocabulary (farming, weather, health, govt).
 */
const HINDI_LATIN_WORDS = new Set([
  // Grammar & discourse markers
  "hai",
  "hain",
  "hoga",
  "hogi",
  "honge",
  "tha",
  "thi",
  "the",
  "kya",
  "kab",
  "kahan",
  "kaisa",
  "kaise",
  "kitna",
  "kitne",
  "kyun",
  "kaun",
  "koi",
  "aur",
  "lekin",
  "magar",
  "ya",
  "agar",
  "toh",
  "to",
  "bhi",
  "hi",
  "nahi",
  "nahin",
  "haan",
  "ji",
  "acha",
  "theek",
  "mujhe",
  "humein",
  "unhe",
  "use",
  "isse",
  "main",
  "aap",
  "hum",
  "tum",
  "woh",
  "vo",
  "yeh",
  "ye",
  "jo",
  "jab",
  "tab",
  "ab",
  "yahan",
  "wahan",
  "phir",
  "fir",
  "sab",
  "bahut",
  "thoda",
  // Farmer / rural context
  "barish",
  "baarish",
  "mausam",
  "fasal",
  "khet",
  "kisan",
  "khad",
  "beej",
  "sinchai",
  "pani",
  "kal",
  "aaj",
  "kal",
  "subah",
  "shaam",
  "mandi",
  "bhav",
  "rate",
  "dhan",
  "gehu",
  "gehun",
  "chawal",
  // Health context
  "bukhar",
  "bukhaar",
  "zukam",
  "khasi",
  "pet",
  "dard",
  "dawai",
  "doctor",
  "aspatal",
  "hospital",
  "upchar",
  // Government schemes
  "kisan",
  "pradhan",
  "yojana",
  "sarkar",
  "sarkari",
  "suvidha",
  // Common verbs (colloquial)
  "bata",
  "batao",
  "bataiye",
  "dekho",
  "suno",
  "samjho",
  "dijiye",
  "chahiye",
  "milega",
  "milegi",
  "karo",
  "karna",
  // NOTE: "to" intentionally excluded — it's too ambiguous with English
]);

/**
 * Romanised Bengali words.
 */
const BENGALI_LATIN_WORDS = new Set([
  // Grammar & discourse markers
  "ami",
  "tumi",
  "apni",
  "se",
  "amra",
  "tomra",
  "tara",
  "ki",
  "keno",
  "kothay",
  "kobe",
  "kivabe",
  "kemon",
  "ache",
  "achen",
  "achhi",
  "chilo",
  "hobe",
  "hoy",
  "hochhe",
  "ebong",
  "o",
  "kintu",
  "jodi",
  "tahle",
  "na",
  "hya",
  "ekhane",
  "sekhane",
  "ekhon",
  "tokhon",
  "abar",
  "ar",
  "ei",
  "sei",
  "bhalo",
  "kharap",
  // Farmer / rural context
  "bristi",
  "brishti",
  "abohaoa",
  "chas",
  "krishok",
  "bazar",
  "dam",
  "dhaan",
  "gom",
  "chal",
  "jol",
  // Health context
  "jor",
  "sardi",
  "kashi",
  "pett",
  "byatha",
  "oshudh",
  "daktar",
  // Common verbs
  "bolo",
  "dekho",
  "suno",
  "bojho",
  "dao",
  "nao",
  "jabo",
  "asbo",
  "korbo",
  "jani",
  "janina",
  "bolun",
  "dekhun",
]);

// ── English indicators ────────────────────────────────────────────────────────
// English doesn't need a large stopword list because it is the fallback.
// We only use these to boost confidence when other signals are ambiguous.

const ENGLISH_STOPWORDS = new Set([
  "the",
  "is",
  "are",
  "was",
  "were",
  "what",
  "when",
  "where",
  "why",
  "how",
  "who",
  "which",
  "this",
  "that",
  "these",
  "those",
  "can",
  "will",
  "would",
  "could",
  "should",
  "have",
  "has",
  "had",
  "tell",
  "me",
  "about",
  "please",
  "help",
  "need",
  "want",
  "know",
  "give",
  "show",
  "explain",
  "describe",
  "today",
  "tomorrow",
  "weather",
  "farmer",
  "crop",
  "price",
  "market",
  "health",
  "fever",
  "doctor",
  "scheme",
  "government",
  "student",
  "study",
  "learn",
  // Common English function words that don't appear in other language lists
  "to",
  "do",
  "my",
  "for",
  "at",
  "in",
  "on",
  "of",
  "with",
  "and",
  "not",
  "no",
  "yes",
  "if",
  "or",
  "but",
  "so",
  "an",
  "a",
  "treat",
  "stomach",
  "pain",
  "home",
  "remedy",
  "symptoms",
  "how",
  "should",
  "does",
  "get",
  "make",
  "take",
  "use",
  "good",
  "bad",
  "best",
  "more",
  "some",
  "any",
  "much",
  "many",
  "information",
  "details",
  "find",
  "check",
  "apply",
  "register",
]);

// ── Language metadata ─────────────────────────────────────────────────────────

const LANGUAGE_META = {
  hi: {
    code: "hi",
    name: "Hindi",
    nativeName: "हिन्दी",
    script: "Devanagari",
    greeting: "नमस्ते",
    rtl: false,
  },
  bn: {
    code: "bn",
    name: "Bengali",
    nativeName: "বাংলা",
    script: "Bengali",
    greeting: "নমস্কার",
    rtl: false,
  },
  en: {
    code: "en",
    name: "English",
    nativeName: "English",
    script: "Latin",
    greeting: "Hello",
    rtl: false,
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Count occurrences of a regex pattern in a string.
 * @param {string} text
 * @param {RegExp} re  Must have the `g` flag set.
 * @returns {number}
 */
function countMatches(text, re) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/**
 * Count how many words from `text` appear in a given Set.
 * Comparison is case-insensitive for Latin words, exact for native scripts.
 *
 * @param {string[]} words     Tokenised words from the transcript
 * @param {Set<string>} wordSet
 * @param {boolean} [lowercase=false]  Lower-case words before lookup
 * @returns {number}
 */
function countStopwordHits(words, wordSet, lowercase = false) {
  let count = 0;
  for (const w of words) {
    const lookup = lowercase ? w.toLowerCase() : w;
    if (wordSet.has(lookup)) count++;
  }
  return count;
}

/**
 * Tokenise text into words, stripping punctuation.
 * Preserves Devanagari, Bengali and Latin characters; drops everything else.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  if (!text) return [];
  // Match sequences of Devanagari, Bengali, Latin, or digits
  return text.match(/[\u0900-\u097F\u0980-\u09FF\w]+/g) || [];
}

// ── Core detection function ───────────────────────────────────────────────────

/**
 * Detect the language of the given transcript text.
 *
 * @param {string}  text            Raw transcript from STT / user input
 * @param {object}  [options]
 * @param {string}  [options.fallback='hi']   Default language code when detection is uncertain
 * @param {boolean} [options.verbose=false]   Return detailed scoring breakdown
 *
 * @returns {string}                          Language code ('hi' | 'bn' | 'en')
 *   When options.verbose is true, returns:
 * @returns {{ lang: string, confidence: number, scores: object, method: string }}
 */
function detectLanguage(text, { fallback, verbose = false } = {}) {
  const DEFAULT_LANG = fallback || process.env.DEFAULT_LANGUAGE || "hi";

  if (!text || typeof text !== "string") {
    return verbose
      ? {
          lang: DEFAULT_LANG,
          confidence: 0,
          scores: {},
          method: "fallback-empty",
        }
      : DEFAULT_LANG;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return verbose
      ? {
          lang: DEFAULT_LANG,
          confidence: 0,
          scores: {},
          method: "fallback-empty",
        }
      : DEFAULT_LANG;
  }

  const totalChars = trimmed.length;

  // ── Step 1: Unicode script analysis ──────────────────────────────────────
  const devanagariCount = countMatches(trimmed, RE_DEVANAGARI);
  const bengaliCount = countMatches(trimmed, RE_BENGALI);

  const devanagariRatio = devanagariCount / totalChars;
  const bengaliRatio = bengaliCount / totalChars;

  if (devanagariRatio >= SCRIPT_THRESHOLD) {
    const result = {
      lang: "hi",
      confidence: Math.min(1, devanagariRatio * 2),
      scores: { devanagariRatio, bengaliRatio },
      method: "unicode-script",
    };
    return verbose ? result : result.lang;
  }

  if (bengaliRatio >= SCRIPT_THRESHOLD) {
    const result = {
      lang: "bn",
      confidence: Math.min(1, bengaliRatio * 2),
      scores: { devanagariRatio, bengaliRatio },
      method: "unicode-script",
    };
    return verbose ? result : result.lang;
  }

  // ── Step 2: Stopword matching (native script) ─────────────────────────────
  const words = tokenise(trimmed);

  const hindiNativeHits = countStopwordHits(words, HINDI_STOPWORDS_DEVANAGARI);
  const bengaliNativeHits = countStopwordHits(words, BENGALI_STOPWORDS_NATIVE);

  if (hindiNativeHits > 0 || bengaliNativeHits > 0) {
    if (hindiNativeHits > bengaliNativeHits) {
      const result = {
        lang: "hi",
        confidence: Math.min(1, (hindiNativeHits / words.length) * 3),
        scores: { hindiNativeHits, bengaliNativeHits },
        method: "native-stopword",
      };
      return verbose ? result : result.lang;
    }
    if (bengaliNativeHits > hindiNativeHits) {
      const result = {
        lang: "bn",
        confidence: Math.min(1, (bengaliNativeHits / words.length) * 3),
        scores: { hindiNativeHits, bengaliNativeHits },
        method: "native-stopword",
      };
      return verbose ? result : result.lang;
    }
  }

  // ── Step 3: Latin transliteration matching ────────────────────────────────
  const lowerWords = words.map((w) => w.toLowerCase());

  const hindiLatinHits = countStopwordHits(lowerWords, HINDI_LATIN_WORDS, true);
  const bengaliLatinHits = countStopwordHits(
    lowerWords,
    BENGALI_LATIN_WORDS,
    true,
  );
  const englishHits = countStopwordHits(lowerWords, ENGLISH_STOPWORDS, true);

  const scores = { hindiLatinHits, bengaliLatinHits, englishHits };

  const maxLatin = Math.max(hindiLatinHits, bengaliLatinHits, englishHits);

  if (maxLatin > 0) {
    if (hindiLatinHits === maxLatin && hindiLatinHits > bengaliLatinHits) {
      const result = {
        lang: "hi",
        confidence: Math.min(1, (hindiLatinHits / words.length) * 2),
        scores,
        method: "latin-transliteration",
      };
      return verbose ? result : result.lang;
    }

    if (bengaliLatinHits === maxLatin && bengaliLatinHits > hindiLatinHits) {
      const result = {
        lang: "bn",
        confidence: Math.min(1, (bengaliLatinHits / words.length) * 2),
        scores,
        method: "latin-transliteration",
      };
      return verbose ? result : result.lang;
    }

    if (
      englishHits === maxLatin &&
      englishHits > hindiLatinHits &&
      englishHits > bengaliLatinHits
    ) {
      const result = {
        lang: "en",
        confidence: Math.min(1, (englishHits / words.length) * 2),
        scores,
        method: "english-stopword",
      };
      return verbose ? result : result.lang;
    }
  }

  // ── Step 4: Fallback ──────────────────────────────────────────────────────
  const result = {
    lang: DEFAULT_LANG,
    confidence: 0.1,
    scores,
    method: "fallback-default",
  };
  return verbose ? result : result.lang;
}

// ── Language metadata helpers ─────────────────────────────────────────────────

/**
 * Get full metadata for a language code.
 *
 * @param {string} langCode  'hi' | 'bn' | 'en'
 * @returns {object}
 */
function getLanguageMeta(langCode) {
  return LANGUAGE_META[langCode] || LANGUAGE_META.en;
}

/**
 * Get the human-readable name of a language.
 *
 * @param {string} langCode
 * @returns {string}  e.g. 'Hindi', 'Bengali', 'English'
 */
function getLanguageName(langCode) {
  return getLanguageMeta(langCode).name;
}

/**
 * Get the native-language name (for display in the language itself).
 *
 * @param {string} langCode
 * @returns {string}  e.g. 'हिन्दी', 'বাংলা', 'English'
 */
function getNativeName(langCode) {
  return getLanguageMeta(langCode).nativeName;
}

/**
 * Get a greeting string in the target language.
 *
 * @param {string} langCode
 * @returns {string}
 */
function getGreeting(langCode) {
  return getLanguageMeta(langCode).greeting;
}

/**
 * Return the list of all supported language codes.
 *
 * @returns {string[]}
 */
function getSupportedLanguages() {
  return Object.keys(LANGUAGE_META);
}

/**
 * Validate that a language code is supported.
 *
 * @param {string} langCode
 * @returns {boolean}
 */
function isSupported(langCode) {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_META, langCode);
}

// ── Prompt-language instruction builder ──────────────────────────────────────

/**
 * Build a concise instruction string that can be prepended to the ElevenLabs
 * system prompt or conversation override to lock the agent to a specific
 * language.  Used when we have high confidence from our own detector.
 *
 * @param {string} langCode
 * @returns {string}
 */
function buildLanguageInstruction(langCode) {
  const instructions = {
    hi: "The user is speaking Hindi. You MUST respond ONLY in Hindi (Devanagari or simple Roman Hindi). Do not switch to English.",
    bn: "The user is speaking Bengali. You MUST respond ONLY in Bengali. Do not switch to English.",
    en: "The user is speaking English. Respond in clear, simple English with short sentences.",
  };
  return instructions[langCode] || instructions.en;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  detectLanguage,
  getLanguageMeta,
  getLanguageName,
  getNativeName,
  getGreeting,
  getSupportedLanguages,
  isSupported,
  buildLanguageInstruction,

  // Exposed internals (useful for testing / debugging)
  tokenise,
  HINDI_STOPWORDS_DEVANAGARI,
  BENGALI_STOPWORDS_NATIVE,
  HINDI_LATIN_WORDS,
  BENGALI_LATIN_WORDS,
  SCRIPT_THRESHOLD,
  LANGUAGE_META,
};
