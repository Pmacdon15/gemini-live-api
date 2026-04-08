
const MODEL_NAME = "gemini-3.1-flash-live-preview";
const GOOGLE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

const server = Bun.serve({
  port: 3001,
  fetch(req, server) {
    if (server.upgrade(req)) {
      return;
    }
    return new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      console.log("Webpage client connected");

      // Connect to Google Gemini API
      const googleWs = new WebSocket(GOOGLE_WS_URL);
      ws.data = { googleWs };

      googleWs.onopen = () => {
        console.log("Connected to Google Gemini API");

        // 1. Send the initial setup configuration
        const setupMessage = {
          setup: {
            model: `models/${MODEL_NAME}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Aoede", // Softer, more melodic voice
                  },
                },
              },
            },
            systemInstruction: {
              parts: [
                {
                  text: "You are a helpful, kind assistant. You can see through the user's camera. Keep your responses very brief and concise—just a few words at a time. Use a gentle, soft tone.",
                },
              ],
            },
          },
        };
        googleWs.send(JSON.stringify(setupMessage));
        console.log("Setup configuration sent to Google");
      };

      googleWs.onmessage = (event) => {
        // Relay messages from Google back to the webpage
        ws.send(event.data);
      };

      googleWs.onclose = (event) => {
        console.log(`Google connection closed: ${event.code} ${event.reason}`);
        ws.close();
      };

      googleWs.onerror = (error) => {
        console.error("Google WebSocket Error:", error);
      };
    },
    message(ws, message) {
      // Relay messages from the webpage to Google
      if (ws.data.googleWs && ws.data.googleWs.readyState === WebSocket.OPEN) {
        ws.data.googleWs.send(message);
      }
    },
    close(ws) {
      console.log("Webpage client disconnected");
      if (ws.data.googleWs) {
        ws.data.googleWs.close();
      }
    },
  },
});

console.log(`Relay server running at ws://localhost:${server.port}`);
console.log(`Relay is active on 96.51.136.132:3001 (ensure port is open)`);
