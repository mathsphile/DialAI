'use strict';

/**
 * DialAI Bharat – In-Memory Response Cache
 *
 * Caches AI responses keyed on a normalised transcript hash so that
 * repeated identical (or near-identical) queries skip the ElevenLabs
 * round-trip and return instantly.
 *
 * Features
 * ────────
 * • TTL-based expiry (configurable per entry or global default)
 * • LRU-style eviction when maxKeys is reached
 * • Hit / miss / eviction statistics
 * • Language-aware keys  (same question in Hindi ≠ same question in English)
 * • Automatic periodic cleanup of stale entries
 */

const NodeCache = require('node-cache');

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TTL   = parseInt(process.env.CACHE_TTL_SECONDS  || '300', 10);  // 5 min
const MAX_KEYS      = parseInt(process.env.CACHE_MAX_KEYS     || '500', 10);
const CHECK_PERIOD  = 60; // seconds between internal expiry sweeps

// ─── Singleton Cache Instance ─────────────────────────────────────────────────

const store = new NodeCache({
  stdTTL       : DEFAULT_TTL,
  checkperiod  : CHECK_PERIOD,
  useClones    : false,          // store references – responses are read-only strings
  maxKeys      : MAX_KEYS,
  deleteOnExpire: true,
});

// ─── Stats Counters ───────────────────────────────────────────────────────────

const stats = {
  hits      : 0,
  misses    : 0,
  sets      : 0,
  evictions : 0,
  expirations: 0,
};

store.on('expired', (_key, _val) => { stats.expirations++; });
store.on('del',     (_key, _val) => { stats.evictions++;   });

// ─── Key Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalise a user transcript so minor variations map to the same cache key.
 *
 * Rules applied (in order):
 *  1. Lower-case (ASCII range only – preserves Devanagari / Bengali casing)
 *  2. Collapse whitespace
 *  3. Strip leading/trailing punctuation
 *  4. Prefix with language code
 *
 * @param {string} transcript  Raw user speech transcript
 * @param {string} langCode    'hi' | 'bn' | 'en'
 * @returns {string} Cache key
 */
function buildKey(transcript, langCode = 'en') {
  if (!transcript || typeof transcript !== 'string') return null;

  const normalised = transcript
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[।,.!?;:'"()\[\]-]+|[।,.!?;:'"()\[\]-]+$/g, '');

  if (!normalised) return null;

  return `${langCode}::${normalised}`;
}

/**
 * Simple non-cryptographic hash for long transcripts to keep key sizes small.
 * Uses djb2 algorithm – fast and good enough for cache keys.
 *
 * @param {string} str
 * @returns {string} 8-character hex string
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash >>>= 0; // keep unsigned 32-bit
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Build final cache key.  For transcripts longer than 120 chars the key is
 * hashed to avoid bloating memory with giant keys.
 *
 * @param {string} transcript
 * @param {string} langCode
 * @returns {string|null}
 */
function getCacheKey(transcript, langCode) {
  const base = buildKey(transcript, langCode);
  if (!base) return null;
  return base.length > 120 ? `${langCode}::hash::${hashString(base)}` : base;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Retrieve a cached response.
 *
 * @param {string} transcript  User speech transcript
 * @param {string} langCode    Language code
 * @returns {{ text: string, audioBase64: string|null, cachedAt: number }|null}
 */
function get(transcript, langCode = 'en') {
  const key = getCacheKey(transcript, langCode);
  if (!key) return null;

  const entry = store.get(key);
  if (entry === undefined) {
    stats.misses++;
    return null;
  }

  stats.hits++;
  return entry;
}

/**
 * Store a response in the cache.
 *
 * @param {string} transcript   User speech transcript (cache key source)
 * @param {string} langCode     Language code
 * @param {object} responseData Object to cache, e.g. { text, audioBase64 }
 * @param {number} [ttl]        Custom TTL in seconds (overrides global default)
 * @returns {boolean} True if the entry was stored successfully
 */
function set(transcript, langCode = 'en', responseData, ttl = DEFAULT_TTL) {
  const key = getCacheKey(transcript, langCode);
  if (!key) return false;

  // Enforce max-key limit with a simple LRU eviction:
  // remove the oldest key if we are at capacity before inserting.
  if (store.keys().length >= MAX_KEYS) {
    const oldest = store.keys()[0];
    if (oldest) store.del(oldest);
  }

  const entry = {
    ...responseData,
    cachedAt  : Date.now(),
    langCode,
    transcript: transcript.slice(0, 200), // store truncated copy for debugging
  };

  const success = store.set(key, entry, ttl);
  if (success) stats.sets++;
  return success;
}

/**
 * Explicitly remove a cached entry (e.g. after a known-bad response).
 *
 * @param {string} transcript
 * @param {string} langCode
 * @returns {number} Number of deleted entries (0 or 1)
 */
function del(transcript, langCode = 'en') {
  const key = getCacheKey(transcript, langCode);
  if (!key) return 0;
  return store.del(key);
}

/**
 * Flush the entire cache (useful on agent config change / redeploy).
 */
function flush() {
  store.flushAll();
}

/**
 * Return current cache statistics.
 *
 * @returns {object}
 */
function getStats() {
  const nodeStats = store.getStats();
  return {
    hits           : stats.hits,
    misses         : stats.misses,
    sets           : stats.sets,
    evictions      : stats.evictions,
    expirations    : stats.expirations,
    hitRate        : stats.hits + stats.misses > 0
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) + '%'
      : 'n/a',
    currentKeys    : nodeStats.keys,
    maxKeys        : MAX_KEYS,
    defaultTtlSecs : DEFAULT_TTL,
  };
}

/**
 * Check whether a key exists without bumping hit/miss counters.
 *
 * @param {string} transcript
 * @param {string} langCode
 * @returns {boolean}
 */
function has(transcript, langCode = 'en') {
  const key = getCacheKey(transcript, langCode);
  if (!key) return false;
  return store.has(key);
}

/**
 * Return all currently cached keys (useful for debugging / admin endpoints).
 *
 * @returns {string[]}
 */
function listKeys() {
  return store.keys();
}

// ─── Module Export ────────────────────────────────────────────────────────────

module.exports = {
  get,
  set,
  del,
  flush,
  has,
  getStats,
  listKeys,
  getCacheKey,   // exported for unit-testing
};
