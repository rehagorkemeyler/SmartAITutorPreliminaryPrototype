import { textbookContext } from './textbook_context.js';

// ─── DOM Elements ───────────────────────────────────────────────────────────
const setupOverlay = document.getElementById('setup-overlay');
const appContainer = document.getElementById('app-container');
const apiKeyInput = document.getElementById('api-key-input');
const startBtn = document.getElementById('start-btn');
const setupError = document.getElementById('setup-error');
const orb = document.getElementById('orb');
const aiTranscript = document.getElementById('ai-transcript');
const studentTranscript = document.getElementById('student-transcript');
const resetKeyBtn = document.getElementById('reset-key-btn');

// ─── Constants ──────────────────────────────────────────────────────────────
const MODEL_ID = "models/gemini-3.1-flash-live-preview";
const WS_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MIC_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;

// ─── Application State ─────────────────────────────────────────────────────
let ws = null;
let audioContext = null;
let audioWorkletNode = null;
let microphoneStream = null;
let speechRecognition = null;
let isSessionActive = false;
let isAiSpeaking = false;
let nextPlayTime = 0;
let currentAiText = "";
// Track all scheduled audio sources so we can flush them on barge-in
let scheduledSources = [];

// ─── 1. PWA Service Worker ─────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

// ─── 2. API Key Management & Boot ──────────────────────────────────────────
function init() {
  const savedKey = localStorage.getItem('gemini_api_key');
  if (savedKey) apiKeyInput.value = savedKey;
}

resetKeyBtn.addEventListener('click', (e) => {
  e.preventDefault();
  localStorage.removeItem('gemini_api_key');
  location.reload();
});

startBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setupError.textContent = "Please enter an API Key.";
    return;
  }

  localStorage.setItem('gemini_api_key', key);
  setupError.textContent = "";

  try {
    startBtn.disabled = true;
    startBtn.textContent = "Connecting...";

    // Acquire microphone with hardware echo cancellation
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Boot the Web Audio pipeline at 16 kHz for capture
    audioContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    await audioContext.audioWorklet.addModule('audio-processor.js');

    // Swap screens
    setupOverlay.classList.add('hidden');
    appContainer.classList.remove('hidden');

    // Go live
    startSession(key);
  } catch (err) {
    console.error("Setup error:", err);
    setupError.textContent = "Error: " + err.message;
    startBtn.disabled = false;
    startBtn.textContent = "Start Session";
  }
});

init();

// ─── 3. WebSocket Session ──────────────────────────────────────────────────
function startSession(apiKey) {
  isSessionActive = true;
  const cleanApiKey = apiKey.trim();
  const url = `${WS_ENDPOINT}?key=${cleanApiKey}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("[WS] Connected");
    aiTranscript.textContent = "Connected. Say hello!";

    // Single setup frame — strict snake_case
    // Uses the OFFICIAL transcription keys from the Gemini Live API docs:
    //   output_audio_transcription: {}  → tutor's speech as text
    //   input_audio_transcription: {}   → student's speech as text
    const setupMessage = {
      setup: {
        model: MODEL_ID,
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
        },
        output_audio_transcription: {},
        input_audio_transcription: {}
      }
    };

    ws.send(JSON.stringify(setupMessage));
    console.log("[WS] Setup payload sent (with transcription flags)");

    // Start mic capture and browser STT fallback
    startAudioCapture();
    startSpeechRecognition();
  };

  ws.onmessage = async (event) => {
    try {
      const rawText = (event.data instanceof Blob)
        ? await event.data.text()
        : event.data;
      const msg = JSON.parse(rawText);
      handleIncomingMessage(msg);
    } catch (err) {
      console.error("[WS] Parse error:", err);
    }
  };

  ws.onerror = (err) => {
    console.error("[WS] Error:", err);
    aiTranscript.textContent = "Connection error.";
  };

  ws.onclose = (event) => {
    console.log("[WS] Closed:", event.code, event.reason);
    aiTranscript.textContent = `Session ended (Code: ${event.code}).`;
    isSessionActive = false;
    if (speechRecognition) speechRecognition.stop();
  };
}

// ─── 4. Continuous Microphone Capture ──────────────────────────────────────
// Streams raw 16 kHz Int16 PCM to Gemini CONTINUOUSLY.
// No gating — the server-side VAD handles barge-in natively.
function startAudioCapture() {
  const source = audioContext.createMediaStreamSource(microphoneStream);
  audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-pcm-processor');

  audioWorkletNode.port.onmessage = (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const pcmBuffer = event.data;
      const base64Data = arrayBufferToBase64(pcmBuffer);

      ws.send(JSON.stringify({
        realtime_input: {
          audio: {
            data: base64Data,
            mime_type: "audio/pcm;rate=16000"
          }
        }
      }));
    }
  };

  source.connect(audioWorkletNode);
  // Do NOT connect to destination — prevents mic-through-speakers
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// ─── 5. Incoming Message Handler ───────────────────────────────────────────
function handleIncomingMessage(msg) {
  const sc = msg.serverContent || msg.server_content;
  if (!sc) return;

  // ── A. BARGE-IN: Server signals that generation was interrupted ──
  if (sc.interrupted) {
    console.log("[Barge-In] Server interrupted — flushing audio queue");
    flushAudioQueue();
    return;
  }

  // ── B. OUTPUT TRANSCRIPTION: Tutor's speech as text ──
  const outputTranscription = sc.outputTranscription || sc.output_transcription;
  if (outputTranscription && outputTranscription.text) {
    console.log("[Tutor Text]", outputTranscription.text);
    appendAiTranscript(outputTranscription.text);
  }

  // ── C. INPUT TRANSCRIPTION: Student's speech as text (from Gemini) ──
  const inputTranscription = sc.inputTranscription || sc.input_transcription;
  if (inputTranscription && inputTranscription.text) {
    console.log("[Student Text]", inputTranscription.text);
    studentTranscript.textContent = inputTranscription.text;
  }

  // ── D. MODEL TURN: Audio (and possibly text) parts ──
  const modelTurn = sc.modelTurn || sc.model_turn;
  if (modelTurn && modelTurn.parts) {
    for (const part of modelTurn.parts) {
      // Text from model turn (fallback transcription)
      if (part.text) {
        appendAiTranscript(part.text);
      }

      // Audio from model turn
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        playAudioData(inlineData.data, PLAYBACK_SAMPLE_RATE);
      }
    }
  }

  // ── E. TURN COMPLETE signal ──
  if (sc.turnComplete || sc.turn_complete) {
    console.log("[Turn] Complete");
  }
}

// ─── 6. Audio Playback Queue ───────────────────────────────────────────────
function playAudioData(base64String, sampleRate) {
  const binaryString = window.atob(base64String);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Int16 PCM → Float32
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const audioBuffer = audioContext.createBuffer(1, float32.length, sampleRate);
  audioBuffer.getChannelData(0).set(float32);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  // Gapless scheduling
  if (nextPlayTime < audioContext.currentTime) {
    nextPlayTime = audioContext.currentTime;
  }

  source.start(nextPlayTime);
  scheduledSources.push(source);

  // Orb: speaking ON
  if (!isAiSpeaking) {
    setOrbSpeaking(true);
  }

  nextPlayTime += audioBuffer.duration;

  // Orb: speaking OFF when queue drains
  const timeUntilEndMs = (nextPlayTime - audioContext.currentTime) * 1000;
  setTimeout(() => {
    if (audioContext.currentTime >= nextPlayTime - 0.05) {
      setOrbSpeaking(false);
    }
  }, timeUntilEndMs + 50);

  // Clean up finished sources from the tracking array
  source.onended = () => {
    scheduledSources = scheduledSources.filter(s => s !== source);
  };
}

// Flush ALL scheduled audio immediately (called on barge-in)
function flushAudioQueue() {
  for (const source of scheduledSources) {
    try { source.stop(); } catch (_) { } // May already be finished
  }
  scheduledSources = [];
  nextPlayTime = 0;
  setOrbSpeaking(false);
  // Clear tutor text for the new response
  currentAiText = "";
  aiTranscript.textContent = "...";
}

function setOrbSpeaking(speaking) {
  isAiSpeaking = speaking;
  orb.classList.toggle('speaking', speaking);
  orb.classList.toggle('idle', !speaking);

  // Echo protection: abort/restart browser STT based on AI speaking state
  if (speechRecognition && isSessionActive) {
    if (speaking) {
      try { speechRecognition.abort(); } catch (_) { }
    }
    // When speaking stops, the .onend handler auto-restarts STT
  }
}

// ─── 7. UI Transcript ──────────────────────────────────────────────────────
function appendAiTranscript(text) {
  currentAiText += text;
  aiTranscript.textContent = currentAiText;
}

// ─── 8. Echo-Protected Speech Recognition (Browser Fallback) ───────────────
// Uses webkitSpeechRecognition for the student's live transcription.
// This serves as a FALLBACK — if Gemini's native input_audio_transcription
// is working, both will display (Gemini's version will be more accurate).
// Echo protection: STT is aborted while AI speaks, auto-restarts when silent.
function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("SpeechRecognition API not available.");
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  // Don't hardcode lang — let browser auto-detect for bilingual support
  // The browser will use its default language, typically from the OS settings

  let finalTranscript = '';

  speechRecognition.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript = transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    studentTranscript.textContent = interimTranscript || finalTranscript;

    // Clear old tutor text when student begins speaking
    if (interimTranscript.length > 0 && currentAiText !== "") {
      currentAiText = "";
      aiTranscript.textContent = "...";
    }
  };

  speechRecognition.onerror = (event) => {
    if (event.error !== 'aborted') {
      console.warn("[STT] Error:", event.error);
    }
  };

  speechRecognition.onend = () => {
    if (!isSessionActive) return;

    // If AI is speaking, poll until she stops, then restart
    if (isAiSpeaking) {
      pollForSpeechRestart();
    } else {
      try { speechRecognition.start(); } catch (_) { }
    }
  };

  speechRecognition.start();
}

function pollForSpeechRestart() {
  if (!isSessionActive) return;
  if (!isAiSpeaking) {
    try { speechRecognition.start(); } catch (_) { }
  } else {
    setTimeout(pollForSpeechRestart, 200);
  }
}
