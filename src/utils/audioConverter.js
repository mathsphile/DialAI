'use strict';

/**
 * audioConverter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all audio format conversions for DialAI Bharat.
 *
 * Pipeline:
 *   Twilio  ──► mulaw 8 kHz  ──► PCM 16-bit 16 kHz ──► ElevenLabs
 *   Twilio  ◄── mulaw 8 kHz  ◄── PCM 16-bit 16 kHz ◄── ElevenLabs
 *
 * μ-law (G.711) is the standard codec used by Twilio Media Streams (PSTN).
 * ElevenLabs Conversational AI expects / returns signed 16-bit PCM at 16 kHz.
 *
 * References:
 *   • ITU-T G.711 – Pulse code modulation (PCM) of voice frequencies
 *   • https://www.twilio.com/docs/voice/twiml/stream
 *   • https://elevenlabs.io/docs/conversational-ai/api-reference
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants ────────────────────────────────────────────────────────────────

const MULAW_BIAS   = 0x84;   // 132 – added before encoding to handle 0 properly
const MULAW_CLIP   = 32635;  // Maximum linear value before clipping
const MULAW_SILENCE = 0xFF;  // μ-law byte for silence (decoded → 0)

// Pre-computed μ-law → linear PCM decode table (256 entries, values ±32767)
const MULAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    // Invert all bits
    let sample = ~i & 0xFF;
    const sign     = sample & 0x80;
    const exponent = (sample >> 4) & 0x07;
    const mantissa = sample & 0x0F;

    // Reconstruct linear value
    let linear = ((mantissa << 3) + MULAW_BIAS) << exponent;
    linear -= MULAW_BIAS;

    table[i] = sign ? -linear : linear;
  }
  return table;
})();

// ── Core codec functions ──────────────────────────────────────────────────────

/**
 * Decode a single μ-law byte to a signed 16-bit PCM sample.
 * Uses the pre-computed lookup table for O(1) performance.
 *
 * @param {number} mulawByte  0–255
 * @returns {number} Signed 16-bit integer (−32768 … 32767)
 */
function mulawByteToLinear(mulawByte) {
  return MULAW_DECODE_TABLE[mulawByte & 0xFF];
}

/**
 * Encode a signed 16-bit PCM sample to a μ-law byte.
 * Implements the ITU-T G.711 μ-law compander.
 *
 * @param {number} sample  Signed 16-bit integer (−32768 … 32767)
 * @returns {number} μ-law byte (0–255)
 */
function linearToMulawByte(sample) {
  // Clamp to 16-bit range
  sample = Math.max(-32768, Math.min(32767, Math.round(sample)));

  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign   = 0x80;
  }

  // Clip
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;

  sample += MULAW_BIAS;

  // Determine exponent (segment)
  let exponent = 7;
  let expMask  = 0x4000;
  while (exponent > 0 && (sample & expMask) === 0) {
    exponent--;
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulawByte;
}

// ── Buffer-level converters ───────────────────────────────────────────────────

/**
 * Convert a Buffer of μ-law bytes (8 kHz, mono) to a Buffer of signed
 * 16-bit little-endian PCM samples (16 kHz, mono).
 *
 * Upsampling strategy: linear interpolation between consecutive samples.
 * This gives smoother audio than naive sample duplication and avoids
 * high-frequency aliasing artefacts on the PSTN speech band (< 4 kHz).
 *
 * @param {Buffer} mulawBuf  Raw μ-law bytes from Twilio
 * @returns {Buffer}         16-bit LE PCM at 16 kHz ready for ElevenLabs
 */
function mulawToLinear16(mulawBuf) {
  const inputLen  = mulawBuf.length;          // samples at 8 kHz
  const outputLen = inputLen * 2;             // samples at 16 kHz (2× upsample)
  const outBuf    = Buffer.allocUnsafe(outputLen * 2); // 2 bytes / sample

  for (let i = 0; i < inputLen; i++) {
    const current = mulawByteToLinear(mulawBuf[i]);
    // For interpolation we look one sample ahead; at the last sample we hold
    const next    = i + 1 < inputLen
      ? mulawByteToLinear(mulawBuf[i + 1])
      : current;

    // Original sample position in output stream
    outBuf.writeInt16LE(current, i * 4);

    // Interpolated half-way sample
    const interpolated = Math.round((current + next) / 2);
    outBuf.writeInt16LE(interpolated, i * 4 + 2);
  }

  return outBuf;
}

/**
 * Convert a Buffer of signed 16-bit little-endian PCM (16 kHz, mono) to
 * a Buffer of μ-law bytes (8 kHz, mono) suitable for Twilio playback.
 *
 * Downsampling strategy: average consecutive pairs of samples before encoding.
 * Simple averaging acts as a one-pole low-pass filter, suppressing aliasing
 * from content above 4 kHz (the PSTN Nyquist limit).
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM at 16 kHz from ElevenLabs
 * @returns {Buffer}       μ-law bytes at 8 kHz for Twilio
 */
function linear16ToMulaw(pcmBuf) {
  // Ensure we work on an even number of 16-bit samples
  const inputSamples  = Math.floor(pcmBuf.length / 2);
  const outputSamples = Math.ceil(inputSamples / 2);  // 2:1 downsample
  const outBuf        = Buffer.allocUnsafe(outputSamples);

  for (let i = 0; i < outputSamples; i++) {
    const idx0 = i * 4;            // byte offset of first sample of pair
    const idx1 = idx0 + 2;        // byte offset of second sample of pair

    const s0 = idx0 + 1 < pcmBuf.length ? pcmBuf.readInt16LE(idx0) : 0;
    const s1 = idx1 + 1 < pcmBuf.length ? pcmBuf.readInt16LE(idx1) : s0;

    // Average the pair before encoding (anti-alias)
    const averaged = Math.round((s0 + s1) / 2);
    outBuf[i] = linearToMulawByte(averaged);
  }

  return outBuf;
}

/**
 * Convert a Buffer of signed 16-bit little-endian PCM (24 kHz, mono) to
 * μ-law bytes (8 kHz, mono).
 *
 * ElevenLabs may return audio at 24 kHz depending on agent config.
 * Downsampling ratio: 3:1.  We average every triple of samples.
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM at 24 kHz
 * @returns {Buffer}       μ-law bytes at 8 kHz for Twilio
 */
function linear24kToMulaw(pcmBuf) {
  const inputSamples  = Math.floor(pcmBuf.length / 2);
  const outputSamples = Math.ceil(inputSamples / 3);
  const outBuf        = Buffer.allocUnsafe(outputSamples);

  for (let i = 0; i < outputSamples; i++) {
    let sum   = 0;
    let count = 0;

    for (let j = 0; j < 3; j++) {
      const byteOffset = (i * 3 + j) * 2;
      if (byteOffset + 1 < pcmBuf.length) {
        sum += pcmBuf.readInt16LE(byteOffset);
        count++;
      }
    }

    const averaged = count > 0 ? Math.round(sum / count) : 0;
    outBuf[i] = linearToMulawByte(averaged);
  }

  return outBuf;
}

/**
 * Convert signed 16-bit little-endian PCM from 8 kHz mono to 16 kHz mono
 * using linear interpolation.
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM at 8 kHz
 * @returns {Buffer}       16-bit LE PCM at 16 kHz
 */
function linear8kToLinear16(pcmBuf) {
  const inputSamples = Math.floor(pcmBuf.length / 2);
  const outputBuf = Buffer.allocUnsafe(inputSamples * 4);

  for (let i = 0; i < inputSamples; i++) {
    const current = pcmBuf.readInt16LE(i * 2);
    const next = i + 1 < inputSamples
      ? pcmBuf.readInt16LE((i + 1) * 2)
      : current;

    outputBuf.writeInt16LE(current, i * 4);
    outputBuf.writeInt16LE(Math.round((current + next) / 2), i * 4 + 2);
  }

  return outputBuf;
}

/**
 * Convert signed 16-bit little-endian PCM from 16 kHz mono to 8 kHz mono.
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM at 16 kHz
 * @returns {Buffer}       16-bit LE PCM at 8 kHz
 */
function linear16kToLinear8k(pcmBuf) {
  const inputSamples = Math.floor(pcmBuf.length / 2);
  const outputSamples = Math.ceil(inputSamples / 2);
  const outputBuf = Buffer.allocUnsafe(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const idx0 = i * 4;
    const idx1 = idx0 + 2;

    const s0 = idx0 + 1 < pcmBuf.length ? pcmBuf.readInt16LE(idx0) : 0;
    const s1 = idx1 + 1 < pcmBuf.length ? pcmBuf.readInt16LE(idx1) : s0;
    outputBuf.writeInt16LE(Math.round((s0 + s1) / 2), i * 2);
  }

  return outputBuf;
}

/**
 * Convert signed 16-bit little-endian PCM from 24 kHz mono to 16 kHz mono.
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM at 24 kHz
 * @returns {Buffer}       16-bit LE PCM at 16 kHz
 */
function linear24kToLinear16(pcmBuf) {
  const inputSamples = Math.floor(pcmBuf.length / 2);
  const outputSamples = Math.floor((inputSamples * 2) / 3);
  const outputBuf = Buffer.allocUnsafe(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sourceIndex = Math.min(
      inputSamples - 1,
      Math.round((i * 3) / 2),
    );
    outputBuf.writeInt16LE(pcmBuf.readInt16LE(sourceIndex * 2), i * 2);
  }

  return outputBuf;
}

// ── Base-64 convenience wrappers ──────────────────────────────────────────────

/**
 * Convert a base-64–encoded μ-law payload (from Twilio) to a base-64–encoded
 * PCM 16 kHz payload ready to send to ElevenLabs.
 *
 * @param {string} base64Mulaw  Base-64 string from Twilio media event
 * @returns {string}            Base-64 string for ElevenLabs audio chunk
 */
function base64MulawToBase64PCM16k(base64Mulaw) {
  if (!base64Mulaw || base64Mulaw.length === 0) return '';
  const mulawBuf = Buffer.from(base64Mulaw, 'base64');
  const pcmBuf   = mulawToLinear16(mulawBuf);
  return pcmBuf.toString('base64');
}

/**
 * Convert a base-64–encoded PCM 16 kHz payload (from ElevenLabs) to a
 * base-64–encoded μ-law payload ready for Twilio.
 *
 * Auto-detects 24 kHz output based on buffer size heuristics when the
 * explicit `sampleRate` parameter is provided.
 *
 * @param {string} base64PCM     Base-64 PCM string from ElevenLabs
 * @param {number} [sampleRate=16000]  Sample rate of the incoming PCM
 * @returns {string}             Base-64 μ-law string for Twilio media event
 */
function base64PCMToBase64Mulaw(base64PCM, sampleRate = 16000) {
  if (!base64PCM || base64PCM.length === 0) return '';
  const pcmBuf  = Buffer.from(base64PCM, 'base64');
  const mulawBuf = sampleRate === 24000
    ? linear24kToMulaw(pcmBuf)
    : linear16ToMulaw(pcmBuf);
  return mulawBuf.toString('base64');
}

function base64PCM8kToBase64PCM16k(base64PCM) {
  if (!base64PCM || base64PCM.length === 0) return '';
  const pcmBuf = Buffer.from(base64PCM, 'base64');
  return linear8kToLinear16(pcmBuf).toString('base64');
}

function base64PCM24kToBase64PCM16k(base64PCM) {
  if (!base64PCM || base64PCM.length === 0) return '';
  const pcmBuf = Buffer.from(base64PCM, 'base64');
  return linear24kToLinear16(pcmBuf).toString('base64');
}

function base64PCM16kToBase64PCM8k(base64PCM) {
  if (!base64PCM || base64PCM.length === 0) return '';
  const pcmBuf = Buffer.from(base64PCM, 'base64');
  return linear16kToLinear8k(pcmBuf).toString('base64');
}

// ── Silence generators ────────────────────────────────────────────────────────

/**
 * Generate a Buffer of μ-law silence for `durationMs` milliseconds at 8 kHz.
 * Useful for padding or comfort noise injection.
 *
 * @param {number} durationMs  Duration in milliseconds
 * @returns {Buffer}
 */
function generateMulawSilence(durationMs) {
  const samples = Math.ceil((8000 * durationMs) / 1000);
  return Buffer.alloc(samples, MULAW_SILENCE);
}

/**
 * Generate a Buffer of PCM silence for `durationMs` milliseconds at 16 kHz.
 *
 * @param {number} durationMs  Duration in milliseconds
 * @returns {Buffer}
 */
function generatePCMSilence16k(durationMs) {
  const samples = Math.ceil((16000 * durationMs) / 1000);
  return Buffer.alloc(samples * 2, 0); // 2 bytes / sample, all zeros = silence
}

// ── Audio analysis helpers ────────────────────────────────────────────────────

/**
 * Compute the Root Mean Square (RMS) energy of a PCM 16-bit buffer.
 * Useful for voice-activity detection (VAD) to detect silence / noise.
 *
 * @param {Buffer} pcmBuf  16-bit LE PCM
 * @returns {number}       RMS value (0–32767).  < 200 is typically silence.
 */
function computeRMS(pcmBuf) {
  const samples = Math.floor(pcmBuf.length / 2);
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Determine whether a PCM buffer contains speech (very basic VAD).
 * Threshold tuned for 8 kHz PSTN speech after μ-law decoding.
 *
 * @param {Buffer} pcmBuf        16-bit LE PCM buffer
 * @param {number} [threshold=300]  RMS threshold below which audio is silence
 * @returns {boolean}
 */
function isSpeech(pcmBuf, threshold = 300) {
  return computeRMS(pcmBuf) > threshold;
}

/**
 * Normalise the volume of a PCM 16-bit buffer to a target RMS level.
 * Prevents very quiet audio (common on rural mobile networks) from
 * confusing the ElevenLabs STT engine.
 *
 * @param {Buffer} pcmBuf          16-bit LE PCM
 * @param {number} [targetRMS=3000] Target RMS level
 * @returns {Buffer}               Normalised PCM buffer (new allocation)
 */
function normaliseVolume(pcmBuf, targetRMS = 3000) {
  const currentRMS = computeRMS(pcmBuf);
  if (currentRMS < 10) return pcmBuf; // silence – don't amplify noise

  const gain      = targetRMS / currentRMS;
  const samples   = Math.floor(pcmBuf.length / 2);
  const outBuf    = Buffer.allocUnsafe(pcmBuf.length);

  for (let i = 0; i < samples; i++) {
    const s         = pcmBuf.readInt16LE(i * 2);
    const amplified = Math.max(-32768, Math.min(32767, Math.round(s * gain)));
    outBuf.writeInt16LE(amplified, i * 2);
  }

  return outBuf;
}

// ── Chunking utilities ────────────────────────────────────────────────────────

/**
 * Split a large PCM buffer into fixed-size chunks suitable for streaming.
 * Default chunk size = 20 ms at 16 kHz (640 bytes = 320 samples × 2 bytes).
 *
 * @param {Buffer} pcmBuf            Complete PCM buffer
 * @param {number} [chunkMs=20]      Chunk size in milliseconds
 * @param {number} [sampleRate=16000]
 * @returns {Buffer[]}               Array of PCM chunks
 */
function chunkPCMBuffer(pcmBuf, chunkMs = 20, sampleRate = 16000) {
  const chunkSamples  = Math.ceil((sampleRate * chunkMs) / 1000);
  const chunkBytes    = chunkSamples * 2;
  const chunks        = [];

  for (let offset = 0; offset < pcmBuf.length; offset += chunkBytes) {
    chunks.push(pcmBuf.slice(offset, offset + chunkBytes));
  }

  return chunks;
}

// ── Module exports ────────────────────────────────────────────────────────────

module.exports = {
  // Core codec
  mulawByteToLinear,
  linearToMulawByte,

  // Buffer-level conversion
  mulawToLinear16,
  linear16ToMulaw,
  linear24kToMulaw,
  linear8kToLinear16,
  linear16kToLinear8k,
  linear24kToLinear16,

  // Base-64 convenience wrappers (primary interface for the bridge)
  base64MulawToBase64PCM16k,
  base64PCMToBase64Mulaw,
  base64PCM8kToBase64PCM16k,
  base64PCM24kToBase64PCM16k,
  base64PCM16kToBase64PCM8k,

  // Silence helpers
  generateMulawSilence,
  generatePCMSilence16k,

  // Audio analysis
  computeRMS,
  isSpeech,
  normaliseVolume,

  // Chunking
  chunkPCMBuffer,

  // Constants (re-exported for consumers)
  MULAW_SILENCE,
  MULAW_DECODE_TABLE,
};
