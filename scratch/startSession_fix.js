// 2. Main Session Logic
function startSession(apiKey) {
  isSessionActive = true;
  
  const cleanApiKey = apiKey.trim(); 
  
  // Use v1alpha to see if it provides better response behavior, but strip experimental flags for stability
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${cleanApiKey}`;
  ws = new WebSocket(url);
  
  ws.onopen = () => {
    console.log("WebSocket connected");
    aiTranscript.textContent = "Connected. Say hello!";
    
    const setupMessage = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generation_config: {
          response_modalities: ["AUDIO"],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: "Aoede" }
            }
          }
        },
        system_instruction: {
          parts: [{ text: textbookContext }]
        }
      }
    };
    
    ws.send(JSON.stringify(setupMessage));
    startAudioCapture();
  };

  ws.onmessage = async (event) => {
    try {
      let data;
      if (event.data instanceof Blob) {
        const text = await event.data.text();
        data = JSON.parse(text);
      } else {
        data = JSON.parse(event.data);
      }
      handleIncomingMessage(data);
    } catch (err) {
      console.error("Error parsing message:", err);
    }
  };

  ws.onclose = (event) => {
    console.log("WebSocket closed:", event.code, event.reason);
    aiTranscript.textContent = `Session ended (Code: ${event.code}, Reason: ${event.reason || 'None provided'}).`;
    isSessionActive = false;
    if (speechRecognition) speechRecognition.stop();
  };
}
