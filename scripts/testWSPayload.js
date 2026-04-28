const WebSocket = require("ws");
require('dotenv').config();

const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.ELEVENLABS_AGENT_ID}`;
const ws = new WebSocket(url, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });

const override = {
  agent: {
    prompt: {
      prompt: "Test prompt"
    },
    first_message: "Hello",
    language: "hi"
  },
  tts: {
    voice_id: "EXAVITQu4vr4xnSDxMaL"
  }
};

ws.on("open", () => {
  const initPayload = { type: "conversation_initiation_client_data", conversation_config_override: override };
  console.log("Sending payload:", JSON.stringify(initPayload));
  ws.send(JSON.stringify(initPayload));
});

ws.on("message", (data) => {
  console.log("Received:", data.toString());
});

ws.on("close", (code, reason) => {
  console.log("Closed:", code, reason.toString());
});
ws.on("error", (err) => console.error("Error:", err));
