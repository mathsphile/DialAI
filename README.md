# 🎙️ DialAI — General Purpose Voice AI Assistant

> **Dial a number. Speak naturally. Get answers on ANY topic.**
> A voice-first interface to the world's most powerful AI.

---

## 🌟 Overview

DialAI is a **telephony-based AI assistant** that brings the power of Large Language Models (LLMs) to any phone. By combining global telephony infrastructure with **ElevenLabs'** Conversational AI (powered by **Gemini 1.5**), DialAI provides a seamless, real-time voice interface to human knowledge.

The AI persona is **"Nova"** — an intelligent, friendly, and efficient assistant ready to help with any query.

---

## 🚀 Key Features

- 🔓 **Unlimited Knowledge**: Powered by Gemini 1.5, Nova can answer questions on any subject—science, technology, history, daily tasks, or creative brainstorming.
- 🗣️ **Multilingual Support**: Automatically detects and responds in the caller's language (English, Spanish, Hindi, and many more supported by ElevenLabs).
- 📶 **Telephony Integrated**: Works over standard phone lines using Exotel (or easily adaptable to other providers).
- ⚡ **Ultra-Low Latency**: Optimized audio pipeline for near-instant, natural conversations.
- 🛠️ **Fully Customizable**: Simple configuration to adjust the AI's personality, knowledge base, and safety guardrails.

---

## 📦 Quick Start

### 1. Installation
```bash
git clone <your-repo-url> dialai
cd dialai
npm install
```

### 2. Environment Setup
Copy the environment template and add your API keys:
```bash
cp .env.example .env
# Edit .env with your ELEVENLABS and Telephony credentials
```

### 3. Deploy the AI Agent
Initialize your "Nova" assistant in ElevenLabs:
```bash
npm run setup-agent -- --write
```

### 4. Start Development
```bash
npm run dev
```

---

## 📞 Telephony Configuration

DialAI is currently configured for **Exotel**, but its modular design allows for integration with any telephony provider that supports WebSocket media streams.

**Exotel Setup:**
1.  **Incoming Endpoint**: `https://your-domain.com/exotel/incoming`
2.  **Status Callback**: `https://your-domain.com/exotel/status`

---

## 📂 Architecture

- **`src/server.js`**: Core application entry point.
- **`src/config/agentConfig.js`**: Central configuration for the AI persona and model.
- **`src/services/audioStreamBridge.js`**: Handles real-time audio conversion and streaming.
- **`src/services/callHandler.js`**: Manages call states and telephony-specific logic.
- **`scripts/setupAgent.js`**: Automates agent creation and updates.

---

## ☁️ Deployment

### Railway (Recommended)
DialAI is optimized for cloud platforms like **Railway** that support persistent WebSocket connections.
1.  Push your code to GitHub.
2.  Connect your repository to Railway.
3.  Add your environment variables to the dashboard.
4.  Deploy and get a public `https` URL instantly.

---

## ⚖️ Safety & Ethics

- **Privacy First**: Phone numbers are masked in logs. No audio data is stored on the server by default.
- **Safety Guardrails**: Built-in instructions to handle sensitive topics (medical, financial, emergency) responsibly.

---

## 🤝 Powering DialAI

- **ElevenLabs**: Leading-edge Conversational AI and TTS.
- **Google Gemini**: State-of-the-art LLM reasoning.
- **Exotel**: Robust global telephony services.

---
*DialAI — Bringing the power of AI to every phone call.*
