# 🇮🇳 DialAI Bharat — Voice AI Helpline for Rural India

> **Dial a number. Speak in Hindi or Bengali. Get real answers.**
> No smartphone. No app. No internet. Just a phone call.

---

## Table of Contents

1. [What is DialAI Bharat?](#what-is-dialai-bharat)
2. [System Architecture](#system-architecture)
3. [Prerequisites](#prerequisites)
4. [Quick Start (5 minutes)](#quick-start)
5. [Full Setup Guide](#full-setup-guide)
   - [Step 1 — Clone & Install](#step-1--clone--install)
   - [Step 2 — ElevenLabs Setup](#step-2--elevenlabs-setup)
   - [Step 3 — Twilio Setup](#step-3--twilio-setup)
   - [Step 4 — Configure Environment](#step-4--configure-environment)
   - [Step 5 — Create the Saathi Agent](#step-5--create-the-saathi-agent)
   - [Step 6 — Start the Server](#step-6--start-the-server)
   - [Step 7 — Expose with ngrok](#step-7--expose-with-ngrok)
   - [Step 8 — Configure Twilio Webhooks](#step-8--configure-twilio-webhooks)
   - [Step 9 — Make Your First Call](#step-9--make-your-first-call)
6. [Exotel Setup (India-First Alternative)](#exotel-setup-india-first-alternative)
7. [Domain Capabilities](#domain-capabilities)
8. [Language Support](#language-support)
9. [Audio Pipeline Deep Dive](#audio-pipeline-deep-dive)
10. [API Reference](#api-reference)
11. [Testing](#testing)
12. [Production Deployment](#production-deployment)
13. [Troubleshooting](#troubleshooting)
14. [Environment Variables Reference](#environment-variables-reference)
15. [Security & Compliance](#security--compliance)
16. [Cost Estimates (India)](#cost-estimates-india)
17. [Roadmap](#roadmap)

---

## What is DialAI Bharat?

DialAI Bharat is a **phone-call-based AI helpline** built specifically for rural Indian users who may not own a smartphone or have internet access.

A farmer in Bihar, a student in rural West Bengal, or a homemaker in UP can dial a regular phone number and speak naturally in **Hindi or Bengali** to get:

- 🌾 **Farmer support** — weather forecasts, crop advice, mandi prices
- 🏥 **Health guidance** — safe home remedies, when to see a doctor (NO diagnosis)
- 📚 **Student help** — school-level explanations in simple language
- 🏛️ **Government schemes** — PM Kisan, Ayushman Bharat, MNREGA, Fasal Bima

**The AI persona is "Saathi" (साथी / সাথী)** — Hindi/Bengali for "friend" — a warm, patient voice that speaks slowly and clearly, designed for first-time callers in noisy rural environments.

---

## System Architecture

```
Caller (any phone)
      │
      │  PSTN / Mobile Network
      ▼
┌─────────────┐
│   Twilio    │  ← or Exotel (India)
│  (Telephony)│
└──────┬──────┘
       │  Twilio Media Streams (WebSocket)
       │  Audio: μ-law 8 kHz → PCM 16 kHz
       ▼
┌─────────────────────────────────────────────────┐
│          DialAI Bharat Bridge Server            │
│                 (Node.js)                       │
│                                                 │
│  ┌─────────────────┐  ┌──────────────────────┐ │
│  │  callHandler    │  │  languageDetector    │ │
│  │  (TwiML + state)│  │  (hi / bn / en)      │ │
│  └─────────────────┘  └──────────────────────┘ │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │         audioStreamBridge               │   │
│  │  Twilio WS ◄──────────────► ElevenLabs │   │
│  │  μ-law 8kHz  ↕ convert  PCM 16kHz      │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  ┌───────────────┐  ┌──────────────────────┐   │
│  │  cache.js     │  │  Tool Handlers       │   │
│  │  (in-memory)  │  │  • get_weather        │   │
│  └───────────────┘  │  • get_mandi_price   │   │
│                     │  • get_scheme_info   │   │
│                     └──────────────────────┘   │
└─────────────────────────────────────────────────┘
       │  WebSocket (wss://)
       │  Audio: PCM 16 kHz (bidirectional)
       ▼
┌─────────────────────────────┐
│    ElevenLabs ConvAI        │
│    Agent: "Saathi"          │
│    STT → LLM → TTS          │
│    Model: gemini-1.5-flash  │
│    Voice: Multilingual v2   │
└─────────────────────────────┘
       │  Tool calls
       ▼
┌──────────────────────────────┐
│  External APIs               │
│  • Open-Meteo (weather)      │
│  • Agmarknet (mandi prices)  │
│  • Built-in scheme database  │
└──────────────────────────────┘
```

**Real-time latency target: < 3 seconds end-to-end**

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | v18.0.0 or higher (`node --version`) |
| npm | v9+ (comes with Node 18) |
| ElevenLabs account | [elevenlabs.io](https://elevenlabs.io) — free tier works for testing |
| Twilio account | [twilio.com](https://twilio.com) — trial account works |
| ngrok | [ngrok.com](https://ngrok.com) — free tier is fine |
| Git | For cloning |

> **India users:** If you want a true Indian DID (+91 number), use **Exotel** instead of Twilio.
> See the [Exotel Setup](#exotel-setup-india-first-alternative) section.

---

## Quick Start

```bash
# 1. Install dependencies
cd dialai-bharat
npm install

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your API keys (see Step 4 below)

# 3. Create the Saathi ElevenLabs agent
node scripts/setupAgent.js --write

# 4. Start the server
npm run dev

# 5. In a new terminal, expose with ngrok
npx ngrok http 3000

# 6. Update SERVER_URL in .env with your ngrok URL
# 7. Configure Twilio webhook (see Step 8)
# 8. Call your Twilio number and say "Namaste"!
```

---

## Full Setup Guide

### Step 1 — Clone & Install

```bash
# If you haven't already
git clone <your-repo-url> dialai-bharat
cd dialai-bharat

# Install all dependencies
npm install

# Verify Node version (must be 18+)
node --version
```

---

### Step 2 — ElevenLabs Setup

#### 2.1 Create an account

1. Go to [elevenlabs.io](https://elevenlabs.io)
2. Sign up (free tier available)
3. Verify your email

#### 2.2 Get your API key

1. Go to **Settings → API Keys**
   - Direct link: [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
2. Click **"Create API Key"**
3. Name it `dialai-bharat`
4. Copy the key — you'll need it in Step 4

#### 2.3 Choose a multilingual voice

The agent needs a voice that supports **Hindi, Bengali, and English**.
ElevenLabs `eleven_multilingual_v2` model supports all three.

Recommended Voice IDs (copy one):

| Voice | Voice ID | Best For |
|-------|----------|----------|
| Sarah (female, multilingual) | `EXAVITQu4vr4xnSDxMaL` | Default — warm, clear |
| Aria (female, multilingual)  | `9BWtsMINqrJLrRacOk9x` | Slightly warmer tone  |
| Roger (male, multilingual)   | `CwhRBWXzGAHq8TQ4Fs17` | Male voice option     |

> **Tip:** You can browse voices at [elevenlabs.io/app/voice-library](https://elevenlabs.io/app/voice-library)
> Filter by language "Hindi" to find community-created Hindi voices.

#### 2.4 (Optional) Upgrade plan for production

The free tier has ~10,000 characters/month which is enough for development.
For production serving real callers, consider the **Starter** or **Creator** plan.

---

### Step 3 — Twilio Setup

#### 3.1 Create a Twilio account

1. Go to [twilio.com](https://twilio.com)
2. Sign up and verify your phone number
3. Complete phone number verification (required for free trial)

#### 3.2 Get your credentials

From the [Twilio Console](https://console.twilio.com):

1. Copy your **Account SID** (starts with `AC`)
2. Copy your **Auth Token** (click the eye icon to reveal)

#### 3.3 Buy a phone number

> **Free trial:** Twilio gives you a free US/UK number on trial.
> For a real Indian number (+91), you need a paid account + Exotel.

1. Go to **Phone Numbers → Manage → Buy a Number**
2. Select country: **India** (if you have a paid account) or **US** (trial)
3. Filter by **Voice** capability
4. Buy the number (India DIDs: ~₹300–500/month)

For trial accounts, you get a US number like `+1 (XXX) XXX-XXXX`.
Indian users can still call it internationally, or use ngrok for local testing.

#### 3.4 Note your phone number

Copy the full E.164 format number, e.g. `+14155552671` or `+918XXXXXXXXX`

---

### Step 4 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` in your editor and fill in these values:

```bash
# ── Server ──────────────────────────────────────────────
PORT=3000
NODE_ENV=development
SERVER_URL=https://YOUR-NGROK-ID.ngrok-free.app   # fill after Step 7

# ── ElevenLabs ──────────────────────────────────────────
ELEVENLABS_API_KEY=sk_your_api_key_here
ELEVENLABS_AGENT_ID=                              # fill after Step 5
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL        # Sarah multilingual
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_LLM=gemini-1.5-flash
ELEVENLABS_VOICE_SPEED=0.90                       # slower for rural users

# ── Twilio ───────────────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+14155552671                  # your Twilio number

# ── Language ─────────────────────────────────────────────
DEFAULT_LANGUAGE=hi                               # Hindi default
```

**Critical:** Do NOT commit `.env` to version control. It is in `.gitignore` by default.

---

### Step 5 — Create the Saathi Agent

This one-time script creates the "Saathi" AI agent in your ElevenLabs account
and writes the agent ID to your `.env` file automatically.

```bash
node scripts/setupAgent.js --write
```

**Expected output:**

```
╔══════════════════════════════════════════════════════════╗
║   🇮🇳  DialAI Bharat – ElevenLabs Agent Setup Tool      ║
╚══════════════════════════════════════════════════════════╝

ℹ️   API Key : sk_123456**************
ℹ️   Voice ID: EXAVITQu4vr4xnSDxMaL
ℹ️   Model   : eleven_multilingual_v2
ℹ️   LLM     : gemini-1.5-flash

▶   Checking for existing "Saathi" agent …
▶   Creating new "Saathi" agent …
✅  Agent created: agt_abc123xyz

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📋  Add this line to your .env file:

      ELEVENLABS_AGENT_ID=agt_abc123xyz

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  Updated ELEVENLABS_AGENT_ID in .env
✅  Setup complete!
```

**Other useful commands:**

```bash
# List all your ElevenLabs agents
node scripts/setupAgent.js --list

# Update agent config after changing agentConfig.js
node scripts/setupAgent.js --update --write

# Delete an agent
node scripts/setupAgent.js --delete agt_abc123
```

---

### Step 6 — Start the Server

#### Development mode (with auto-restart)

```bash
npm run dev
```

#### Production mode

```bash
npm start
```

**Expected startup output:**

```
╔══════════════════════════════════════════════════════════════╗
║           🇮🇳  DialAI Bharat – Voice AI Helpline            ║
║         Empowering Rural India through Voice & AI            ║
╠══════════════════════════════════════════════════════════════╣
║  Environment : development                                   ║
║  Port        : 3000                                          ║
║  Server URL  : http://localhost:3000                         ║
║                                                              ║
║  Languages   : Hindi (हिन्दी) · Bengali (বাংলা) · English  ║
║                                                              ║
║  Endpoints                                                   ║
║    Health    : http://localhost:3000/health                  ║
║    Incoming  : http://localhost:3000/twiml/incoming          ║
║    WS Bridge : ws://localhost:3000/media-stream              ║
╚══════════════════════════════════════════════════════════════╝

✅  ElevenLabs agent ready: agt_abc123xyz
✅  DialAI Bharat server is ready to accept calls.
```

Verify the server is running:

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","service":"dialai-bharat",...}
```

---

### Step 7 — Expose with ngrok

Twilio needs a **public HTTPS URL** to send webhooks to your local server.
ngrok creates a secure tunnel to `localhost:3000`.

#### 7.1 Install ngrok

```bash
# Option A: npm
npm install -g ngrok

# Option B: Homebrew (macOS)
brew install ngrok

# Option C: Download from ngrok.com
# https://ngrok.com/download
```

#### 7.2 Authenticate ngrok (one-time)

```bash
# Get your authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

#### 7.3 Start the tunnel

```bash
npx ngrok http 3000
```

**ngrok output:**

```
Session Status                online
Account                       your@email.com (Plan: Free)
Version                       3.x.x
Region                        India (in)    ← choose India for lowest latency
Forwarding                    https://abc123def456.ngrok-free.app → http://localhost:3000

Connections                   ttl     opn     rt1     rt5     p50     p90
                              0       0       0.00    0.00    0.00    0.00
```

#### 7.4 Update SERVER_URL in .env

Copy the `https://` forwarding URL and add it to `.env`:

```bash
SERVER_URL=https://abc123def456.ngrok-free.app
```

**Restart the server** after updating:

```bash
# Ctrl+C to stop, then:
npm run dev
```

> **Pro tip:** ngrok free tier gives a new URL every time you restart.
> Use a paid ngrok plan or a fixed domain for production.

---

### Step 8 — Configure Twilio Webhooks

This tells Twilio where to send calls when someone dials your helpline number.

#### 8.1 Open the Twilio Console

Go to: **Phone Numbers → Manage → Active Numbers**

Click on your helpline number.

#### 8.2 Set Voice Configuration

Under **"Voice & Fax"** section:

| Field | Value |
|-------|-------|
| **A CALL COMES IN** | Webhook |
| **URL** | `https://YOUR-NGROK-ID.ngrok-free.app/twiml/incoming` |
| **HTTP Method** | `HTTP POST` |
| **CALL STATUS CHANGES** | `https://YOUR-NGROK-ID.ngrok-free.app/twiml/status` |
| **FALLBACK URL** | `https://YOUR-NGROK-ID.ngrok-free.app/twiml/fallback` |

Click **Save Configuration**.

#### 8.3 Verify webhook connectivity

```bash
# Test the TwiML endpoint directly
curl -X POST https://YOUR-NGROK-ID.ngrok-free.app/twiml/test
# Should return valid TwiML XML
```

---

### Step 9 — Make Your First Call

📞 **Dial your Twilio phone number.**

You should hear Saathi say:
> *"Namaskar! Main Saathi hoon. Aap Hindi, Bengali, ya English mein baat kar sakte hain. Bataiye, aaj main aapki kya madad kar sakta hoon?"*

**Try these test phrases:**

| Language | Say This | Expected Response |
|----------|----------|-------------------|
| Hindi | "Kal barish hoga kya?" | Tomorrow's weather forecast |
| Hindi | "Gehu ka mandi bhav kya hai?" | Wheat price info |
| Hindi | "PM Kisan yojana kya hai?" | Scheme explanation |
| Bengali | "Aj bristi hobe ki?" | Tomorrow's weather in Bengali |
| English | "Tell me about Ayushman Bharat" | Scheme info in English |
| Hindi | "Bukhar mein kya karna chahiye?" | Safe health advice + disclaimer |
| English | "What is photosynthesis?" | Simple school-level explanation |

---

## Exotel Setup (India-First Alternative)

Exotel provides true **Indian phone numbers (+91)** and is designed for the Indian telecom ecosystem. It's the best choice for a production India helpline.

### Why Exotel over Twilio for India?

| Feature | Twilio | Exotel |
|---------|--------|--------|
| Indian DIDs (+91) | Paid, limited | Native, wide selection |
| India pricing | International rates | ₹0.25–0.50/min |
| Indian regulatory compliance | Partial | Full (TRAI compliant) |
| Call quality in India | Variable | Optimised |
| Support in India | Global | IST hours |
| BSNL/MTNL compatibility | Limited | Full |

### Exotel Setup Steps

#### 1. Create Exotel account

Go to [my.exotel.com](https://my.exotel.com) → Sign up → Complete KYC

KYC requires:
- Business PAN
- GST number (if applicable)
- Director Aadhaar

#### 2. Buy a virtual number (Exophone)

1. Dashboard → **Buy Number**
2. Select your state/region
3. Choose a landline (0XX) or mobile (7XX, 8XX, 9XX) number
4. Activate for Voice

#### 3. Get API credentials

Dashboard → **Settings → API**:
- **Account SID** (your Exotel SID)
- **API Key**
- **API Token**
- **Subdomain** (usually `api.exotel.com`)

#### 4. Configure .env for Exotel

```bash
TELEPHONY_PROVIDER=exotel

EXOTEL_SID=your_exotel_sid
EXOTEL_API_KEY=your_api_key
EXOTEL_API_TOKEN=your_api_token
EXOTEL_SUBDOMAIN=api.exotel.com
EXOTEL_CALLER_ID=0XXXXXXXXXX
```

#### 5. Exotel webhook format

Exotel uses a slightly different payload format than Twilio. 
The core bridge logic is identical — only the webhook parsing differs.

Configure in Exotel dashboard:
- **Passthru URL:** `https://your-server.com/twiml/incoming`
- **Status Callback:** `https://your-server.com/twiml/status`

> **Note:** Exotel does not use Twilio Media Streams protocol natively.
> For Exotel, you would use their **Exotel Voice API** with WebRTC/SIP bridging.
> Contact Exotel enterprise sales for Media Streaming support.

---

## Domain Capabilities

### 🌾 Domain 1: Farmer Support

**Weather Queries:**
- Real-time forecasts via Open-Meteo API (free, no API key required)
- Auto-geocodes city/district names to coordinates
- Provides today + tomorrow forecast
- WMO weather code mapped to simple Hindi/Bengali phrases
- Falls back gracefully when API is unreachable

**Sample exchange (Hindi):**
```
User: "Patna mein kal barish hogi?"
Saathi: "Patna mein kal halki barish ho sakti hai. Adhiktam taapman 32 degree rahega.
         Apni fasal ki suraksha ke liye taiyar rahein. Kya aur kuch jaanna chahenge?"
```

**Mandi Price Queries:**
- Supports: wheat (gehu), rice (chawal/dhan), maize, mustard (sarso),
  soybean, arhar dal, chickpea (chana), onion (pyaaz), tomato, potato
- Handles alternate Hindi/Bengali names automatically
- Shows min/max/modal prices with MSP reference
- Directs to e-NAM portal for live prices
- **Production:** Replace mock data with [data.gov.in Agmarknet API](https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070)

**Crop Advice:**
- General sowing/harvesting guidance
- Common pest prevention tips
- Irrigation basics
- Always directs to local Block Agriculture Officer for expert advice

---

### 🏥 Domain 2: Health Guidance

**⚠️ SAFETY FIRST — These are hard-coded, unchangeable rules:**

1. **NEVER diagnoses** any condition
2. **NEVER prescribes** specific medicines
3. **ALWAYS adds** doctor consultation disclaimer
4. **Emergency redirect** to 108 for: chest pain, unconsciousness, high fever in children, snake bite, breathing difficulty

**Handles safely:**
- Fever (mild), cold, cough, sore throat
- Stomach upset, indigestion
- Headache (tension type)
- Minor cuts and wounds
- Heat exhaustion (basic)

**Sample exchange (Hindi):**
```
User: "Mujhe bukhaar hai, kya karoon?"
Saathi: "Bukhaar ke liye zyada paani piyein aur aaram karein.
         Agar bukhaar 100 degree se zyada ho toh paracetamol le sakte hain.
         Lekin behtar hoga ki aap ek baar doctor se zaroor milein.
         Kya aur kuch poochna chahenge?"
```

---

### 📚 Domain 3: Student Help

**Covers Class 1–12 topics:**
- **Science:** Photosynthesis, gravity, Newton's laws, chemical formulas, cells
- **Maths:** Explained verbally with local examples (fields, crops, money)
- **History:** Indian freedom movement, ancient civilizations
- **Geography:** Rivers, states, climate zones of India
- **Civics:** Constitution, Panchayati Raj, fundamental rights

**Rural-context examples used by Saathi:**
- Measuring crops in bigha/hectare for maths
- Village well for explaining water cycle
- Rice growing for photosynthesis
- Local market for economics concepts

---

### 🏛️ Domain 4: Government Schemes

**Built-in knowledge base (always available, no API needed):**

| Scheme | Key Facts |
|--------|-----------|
| **PM Kisan** | ₹6,000/year, pmkisan.gov.in, helpline: 155261 |
| **Ayushman Bharat (PMJAY)** | ₹5 lakh health insurance, helpline: 14555 |
| **PM Fasal Bima** | Crop insurance, pmfby.gov.in |
| **MNREGA** | 100 days employment guarantee |
| **PM Jan Dhan** | Zero-balance account, RuPay card |
| **DAY-NRLM** | Women SHG support |

**Response format (always):**
1. What is it? (1 sentence)
2. Who can get it? (1 sentence)
3. How to apply / where to go?
4. Key helpline number

---

## Language Support

### Detection Strategy

Language is detected using a 4-layer approach:

```
Layer 1: Unicode script analysis
  → Devanagari chars (ह, म, प…) → Hindi
  → Bengali chars (আ, ক, ম…) → Bengali
  → If ratio > 12% → confident detection

Layer 2: Native script stopwords
  → High-frequency function words per language
  → Works even for partially mis-transcribed text

Layer 3: Latin transliteration
  → "kal barish hoga" → Hindi
  → "ami tumi ache" → Bengali
  → "what is the weather" → English

Layer 4: Fallback
  → Configurable via DEFAULT_LANGUAGE (default: 'hi')
```

### Language Statistics

| Language | Detection Method | Accuracy |
|----------|-----------------|----------|
| Hindi (Devanagari) | Unicode script | ~99% |
| Bengali (native script) | Unicode script | ~99% |
| Romanised Hindi | Transliteration dict | ~85% |
| Romanised Bengali | Transliteration dict | ~80% |
| English | Stopword matching | ~90% |

### Adding More Languages

To add **Marathi**, **Tamil**, or other languages:

1. Add Unicode range in `languageDetector.js`:
   ```javascript
   // Marathi uses the same Devanagari block as Hindi
   // Tamil: U+0B80–U+0BFF
   const RE_TAMIL = /[\u0B80-\u0BFF]/g;
   ```

2. Add stopword list for the new language

3. Update `LANGUAGE_META` with metadata

4. Add first message in `agentConfig.js → FIRST_MESSAGE`

5. Update `ELEVENLABS_LLM` to a model that supports the language

---

## Audio Pipeline Deep Dive

### The Problem

Twilio's PSTN network uses **G.711 μ-law codec at 8 kHz** — the 60-year-old standard
used by telephone networks worldwide. ElevenLabs expects **16-bit PCM at 16 kHz**.

### The Solution

```
Twilio                    Bridge Server               ElevenLabs
  │                            │                           │
  │── μ-law 8kHz (base64) ──►  │                           │
  │                            │  1. Decode base64         │
  │                            │  2. MULAW → Linear PCM    │
  │                            │  3. Upsample 8k→16kHz     │
  │                            │     (linear interpolation)│
  │                            │  4. Normalize volume       │
  │                            │  5. VAD (drop silence)    │
  │                            │── PCM 16kHz (base64) ──►  │
  │                            │                           │
  │                            │◄─ PCM 16kHz (base64) ───  │
  │                            │                           │
  │                            │  1. Decode base64         │
  │                            │  2. Downsample 16k→8kHz   │
  │                            │     (average pairs)       │
  │                            │  3. PCM → MULAW encoding  │
  │                            │  4. Encode base64         │
  │◄─ μ-law 8kHz (base64) ───  │                           │
```

### Audio Optimisations

| Feature | Purpose |
|---------|---------|
| **Linear interpolation** upsampling | Prevents aliasing, smoother quality than sample duplication |
| **Average pairs** downsampling | Low-pass filter prevents aliasing on PSTN's 4kHz Nyquist limit |
| **Volume normalisation** | Boosts quiet callers (rural mobiles, feature phones) to STT-friendly levels |
| **VAD (Voice Activity Detection)** | Stops sending silence frames to ElevenLabs, saves bandwidth/cost |
| **Audio buffering** (100ms chunks) | Smooth streaming, avoids tiny fragmented packets |
| **Outbound drain timer** (20ms intervals) | Correct real-time playback pace to Twilio |
| **Comfort noise injection** | Prevents dead air between AI utterances |

### Twilio Media Streams Protocol

Each Twilio media event contains:

```json
{
  "event": "media",
  "sequenceNumber": "5",
  "media": {
    "track": "inbound",
    "chunk": "5",
    "timestamp": "100",
    "payload": "//7//v/+..."
  }
}
```

`payload` is base64-encoded μ-law PCM (160 bytes = 20ms at 8 kHz per chunk).

To send audio back to the caller:

```json
{
  "event": "media",
  "streamSid": "MZxxxxx",
  "media": {
    "payload": "//7//v/+..."
  }
}
```

---

## API Reference

### REST Endpoints

#### `GET /health`
Liveness probe. Returns 200 while server is alive.

```json
{
  "status": "ok",
  "service": "dialai-bharat",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime_s": 3600
}
```

#### `GET /health/detailed`
Full system status. Protected by `HEALTH_SECRET` env var.

```bash
curl -H "X-Health-Secret: your-secret" https://your-server.com/health/detailed
```

#### `GET /health/metrics`
Prometheus-format metrics for monitoring.

#### `POST /twiml/incoming`
Primary Twilio webhook. Called when a call arrives. Returns TwiML.

**Request:** Twilio POST body (application/x-www-form-urlencoded)
**Response:** TwiML XML with `<Connect><Stream>` directive

#### `POST /twiml/status`
Call status callback. Returns 204 No Content.

#### `POST /twiml/fallback`
Called by Twilio if `/twiml/incoming` fails. Returns apology TwiML.

#### `GET /twiml/test`
Dev-mode only. Returns sample TwiML for webhook testing.

### WebSocket Endpoint

#### `ws://your-server.com/media-stream`
Twilio Media Streams WebSocket. Not for direct use — Twilio connects automatically.

---

## Testing

### Run All Tests

```bash
npm run test:call
```

### Run by Domain

```bash
# Farmer support scenarios
npm run test:call -- --domain farmer

# Health guidance
npm run test:call -- --domain health

# Student help
npm run test:call -- --domain student

# Government schemes
npm run test:call -- --domain govt

# Audio conversion
npm run test:call -- --domain audio

# Language detection
npm run test:call -- --domain lang

# Cache layer
npm run test:call -- --domain cache
```

### Run by Language

```bash
npm run test:call -- --lang hi   # Hindi scenarios only
npm run test:call -- --lang bn   # Bengali scenarios only
npm run test:call -- --lang en   # English scenarios only
```

### Skip Live API Calls

```bash
npm run test:call -- --no-api    # uses mock data for weather
```

### Verbose Output

```bash
npm run test:call -- --verbose   # shows full JSON tool responses
```

### Expected Test Output

```
═══════════════════════════════════════════════════
   DialAI Bharat – Test Scenarios Runner
═══════════════════════════════════════════════════

🌐 Language Detection
────────────────────────────────────────────────────

  [lang-01] Detect pure Devanagari (Hindi)
  ✔ Devanagari: "आज का मौसम कैसा रहेगा?…"
  ✔ Devanagari: "मेरी फसल के लिए क्या करूं?…"
  ✔ Devanagari: "बुखार में क्या खाना चाहिए?…"
  ✔ Devanagari: "पीएम किसान योजना क्या है?…"

🌾 Farmer Support
────────────────────────────────────────────────────

  [farmer-01] Hindi: "Kal barish hoga?" – weather tool
  ✔ Tool returned a result
  ✔ will_rain is boolean
  ✔ temp_max_c is a number

...

═══════════════════════════════════════════════════
   Test Summary
═══════════════════════════════════════════════════
  Total    : 55
  Passed   : 55
  Failed   : 0
  Time     : 2341 ms

✔ All 55 tests passed! DialAI Bharat is ready.
```

### Manual Call Testing Script

```bash
# Use Twilio CLI to make a test call to your own number
npm install -g twilio-cli
twilio login

# Place a call from your Twilio number to your personal number
twilio api:core:calls:create \
  --from "+14155552671" \
  --to "+919XXXXXXXXX" \
  --url "https://YOUR-NGROK.ngrok-free.app/twiml/incoming"
```

### ngrok Inspector

Open [http://127.0.0.1:4040](http://127.0.0.1:4040) while ngrok is running to inspect:
- All webhook requests from Twilio
- Request/response bodies
- Replay failed requests without making a new call

---

## Production Deployment

### Option A: Railway (Easiest)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment variables
railway variables set ELEVENLABS_API_KEY=...
railway variables set TWILIO_ACCOUNT_SID=...
# ... (all variables from .env)
```

Railway provides a permanent `https://` URL — no ngrok needed.

### Option B: AWS EC2 (India Region)

Recommended region: **ap-south-1** (Mumbai) for lowest latency to Indian callers.

```bash
# 1. Launch EC2 instance (Ubuntu 22.04, t3.medium recommended)

# 2. SSH in and set up
sudo apt update && sudo apt install -y nodejs npm nginx certbot

# 3. Clone the repo
git clone <your-repo-url> /opt/dialai-bharat
cd /opt/dialai-bharat
npm install

# 4. Create systemd service
sudo nano /etc/systemd/system/dialai-bharat.service
```

```ini
[Unit]
Description=DialAI Bharat Voice Helpline
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/dialai-bharat
EnvironmentFile=/opt/dialai-bharat/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=dialai-bharat

[Install]
WantedBy=multi-user.target
```

```bash
# 5. Start the service
sudo systemctl enable dialai-bharat
sudo systemctl start dialai-bharat

# 6. Set up nginx reverse proxy with SSL
sudo certbot --nginx -d your-domain.com
```

**nginx config:**

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket specific
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Option C: Google Cloud Run

```bash
# Build Docker image
docker build -t dialai-bharat .

# Push to Artifact Registry
docker tag dialai-bharat asia-south1-docker.pkg.dev/PROJECT/dialai/dialai-bharat
docker push asia-south1-docker.pkg.dev/PROJECT/dialai/dialai-bharat

# Deploy to Cloud Run (Mumbai region)
gcloud run deploy dialai-bharat \
  --image asia-south1-docker.pkg.dev/PROJECT/dialai/dialai-bharat \
  --region asia-south1 \
  --allow-unauthenticated \
  --port 3000 \
  --memory 512Mi \
  --concurrency 50
```

### Production Checklist

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Set `TWILIO_VALIDATE_WEBHOOK=true` for security
- [ ] Set a strong `HEALTH_SECRET` value
- [ ] Use a permanent domain (not ngrok) in `SERVER_URL`
- [ ] Set up log aggregation (CloudWatch, Datadog, etc.)
- [ ] Configure `MAX_CONCURRENT_CALLS` based on your ElevenLabs plan limits
- [ ] Set up uptime monitoring on `/health`
- [ ] Enable call recording consent TwiML if recording calls
- [ ] Test with real Indian phone numbers on all target networks (Jio, Airtel, Vi, BSNL)

---

## Troubleshooting

### Problem: No sound / silence on call

**Check 1:** Verify `SERVER_URL` in `.env` is correct and matches your ngrok URL.

**Check 2:** Check server logs for WebSocket connection errors.

```bash
# Watch live logs
npm run dev 2>&1 | grep -E "ERROR|WARN|stream|bridge"
```

**Check 3:** Verify the ngrok inspector at http://127.0.0.1:4040 shows Twilio hitting `/twiml/incoming` with a 200 response.

**Check 4:** Make sure the WebSocket path is `wss://` (secure) — Twilio requires this.

---

### Problem: AI responds in wrong language

**Check 1:** The `DEFAULT_LANGUAGE` in `.env` — should be `hi` for Hindi.

**Check 2:** Check the transcript in server logs to see what the STT produced.

**Check 3:** The ElevenLabs agent's `language` setting — it should be `hi` (set by `setupAgent.js`).

---

### Problem: "Agent not found" error on startup

```bash
# Re-run agent setup
node scripts/setupAgent.js --write

# Verify the ID was written
grep ELEVENLABS_AGENT_ID .env
```

---

### Problem: Audio is choppy / distorted

**Cause 1:** Network latency. Check your server's ping to `api.elevenlabs.io`.

```bash
ping api.elevenlabs.io
# Should be < 100ms from India. Use Mumbai AWS region for best results.
```

**Cause 2:** `AUDIO_FLUSH_INTERVAL_MS` is too low. Try `200` instead of `100`.

**Cause 3:** Volume normalisation may be over-amplifying. Try disabling it temporarily by setting `targetRMS` lower in `audioConverter.js`.

---

### Problem: Twilio webhook returns 403

**Cause:** `TWILIO_VALIDATE_WEBHOOK=true` is set but signature doesn't match.

**Fix for development:**

```bash
TWILIO_VALIDATE_WEBHOOK=false
```

**Fix for production:** Make sure `SERVER_URL` exactly matches the URL Twilio uses to call you. Include or exclude trailing slashes consistently.

---

### Problem: "ELEVENLABS_API_KEY not set" error

```bash
# Check if .env exists
ls -la .env

# Check the key is set
grep ELEVENLABS_API_KEY .env

# Make sure dotenv is loading (should be first line of server.js)
# require('dotenv').config()
```

---

### Problem: ElevenLabs connection times out

**Check 1:** API key is valid:

```bash
curl -H "xi-api-key: YOUR_KEY" https://api.elevenlabs.io/v1/user
# Should return your account info
```

**Check 2:** Agent ID is valid:

```bash
node scripts/setupAgent.js --list
```

**Check 3:** Firewall or proxy blocking outbound WebSocket connections on port 443.

---

### Problem: Call drops after ~60 seconds

This is often a Twilio timeout for Media Streams. Make sure the `<Connect><Stream>` TwiML is configured correctly and the server is actively sending/receiving WebSocket messages.

Check the server logs for ping/pong activity with ElevenLabs — the connection requires a heartbeat.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `SERVER_URL` | **Yes** | — | Public HTTPS URL (ngrok or domain) |
| `ELEVENLABS_API_KEY` | **Yes** | — | ElevenLabs API key |
| `ELEVENLABS_AGENT_ID` | No | auto-created | Agent ID (created by setupAgent.js) |
| `ELEVENLABS_VOICE_ID` | No | `EXAVITQu4vr4xnSDxMaL` | Voice ID for Saathi |
| `ELEVENLABS_MODEL_ID` | No | `eleven_multilingual_v2` | TTS model |
| `ELEVENLABS_LLM` | No | `gemini-1.5-flash` | LLM for agent reasoning |
| `ELEVENLABS_VOICE_SPEED` | No | `0.90` | Speaking speed (0.5–1.5) |
| `ELEVENLABS_VOICE_STABILITY` | No | `0.55` | Voice stability (0–1) |
| `ELEVENLABS_MAX_DURATION_SECONDS` | No | `600` | Max call duration |
| `TWILIO_ACCOUNT_SID` | **Yes** | — | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | **Yes** | — | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | No | — | Your Twilio number (E.164) |
| `TWILIO_VALIDATE_WEBHOOK` | No | `false` | Validate Twilio signatures |
| `TELEPHONY_PROVIDER` | No | `twilio` | `twilio` or `exotel` |
| `AUDIO_FLUSH_INTERVAL_MS` | No | `100` | Audio buffer flush interval |
| `DEFAULT_LANGUAGE` | No | `hi` | Fallback language code |
| `CACHE_TTL_SECONDS` | No | `300` | Cache entry lifetime |
| `CACHE_MAX_KEYS` | No | `500` | Max cached responses |
| `MAX_CONCURRENT_CALLS` | No | `50` | Max simultaneous calls |
| `MAX_WS_PER_IP` | No | `5` | Max WebSocket connections per IP |
| `LOG_LEVEL` | No | `info` | `error\|warn\|info\|debug` |
| `LOG_TO_FILE` | No | `true` | Write logs to `./logs/` |
| `HEALTH_SECRET` | No | — | Secret for `/health/detailed` |

---

## Security & Compliance

### Data Privacy (PDPB / India)

- **No call recordings** enabled by default
- Phone numbers are **masked** in all logs (`+91 98****4567`)
- Transcripts are stored only in-memory for the duration of the call
- No personally identifiable information (PII) is written to disk
- Cache keys use normalised transcript hashes, not raw phone numbers

### Safety Guardrails

The Saathi agent has **non-negotiable safety rules**:
1. Cannot diagnose medical conditions
2. Cannot prescribe medications
3. Cannot give specific financial investment advice
4. Always directs users to qualified professionals for serious issues
5. Always provides 108 emergency number for medical emergencies

### Twilio Webhook Security

In production, always enable signature validation:

```bash
TWILIO_VALIDATE_WEBHOOK=true
```

This ensures only genuine Twilio requests reach your server.

### Rate Limiting

Built-in protections:
- `MAX_CONCURRENT_CALLS=50` — global limit
- `MAX_WS_PER_IP=5` — per-IP WebSocket limit
- Twilio Auth Token signature validation

---

## Cost Estimates (India)

### Per Call (estimated)

| Component | Cost per minute |
|-----------|----------------|
| Twilio India DID (inbound) | ~$0.0085 (~₹0.70) |
| ElevenLabs ConvAI (per character generated) | Varies by plan |
| Open-Meteo weather API | **Free** |
| AWS EC2 t3.medium (amortised) | ~$0.002 (~₹0.17) |
| **Total** | ~₹1.50–3.00 per minute |

### Monthly Estimates

| Scale | Calls/day | Cost/month |
|-------|-----------|------------|
| Pilot | 100 | ₹4,500–9,000 |
| Small district | 1,000 | ₹45,000–90,000 |
| State-wide | 10,000 | ₹4.5L–9L |

> **Cost optimisation tips:**
> - Use **Exotel** for 30–50% lower telephony costs in India
> - Enable **response caching** (CACHE_TTL_SECONDS=300) to reduce ElevenLabs API calls
> - Set `MAX_DURATION_SECONDS=300` (5 min) for routine queries

---

## Roadmap

### v1.1 (Next)
- [ ] Live Agmarknet API integration for real mandi prices
- [ ] IMD (India Meteorological Department) weather API
- [ ] WhatsApp fallback for smartphone users (same phone number)

### v1.2
- [ ] Marathi language support (Maharashtra farmers)
- [ ] Tamil language support (South India)
- [ ] Punjabi language support (Punjab/Haryana farmers)

### v1.3
- [ ] IVR menu for category selection (press 1 for farming, 2 for health...)
- [ ] SMS follow-up with key information after call
- [ ] Call recording with consent + quality review dashboard

### v2.0
- [ ] Aadhaar-linked personalisation (with consent)
- [ ] PM Kisan status check integration
- [ ] Pradhan Mantri Grameen Digital Saksharta Abhiyan integration
- [ ] Offline-capable edge deployment for areas with poor connectivity

---

## Contributing

We welcome contributions that make DialAI Bharat more useful for rural India.

**Priority areas:**
1. Regional language support (Marathi, Tamil, Punjabi, Gujarati, Odia)
2. Real API integrations (Agmarknet, IMD, PM Kisan status)
3. Audio quality improvements for feature phones
4. Accessibility improvements for elderly callers

---

## License

MIT License — See `LICENSE` file.

---

## Acknowledgements

Built with:
- [ElevenLabs Conversational AI](https://elevenlabs.io/docs/conversational-ai) — Voice AI engine
- [Twilio](https://twilio.com) — Telephony & Media Streams
- [Open-Meteo](https://open-meteo.com) — Free weather API
- [Government of India Open Data](https://data.gov.in) — Scheme & price data

---

*DialAI Bharat — because every Indian deserves access to information, in their own language, on any phone.*

🙏 **Jai Hind**