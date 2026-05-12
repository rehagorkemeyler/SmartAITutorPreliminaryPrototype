class AudioPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const channelData = input[0]; // Mono
      
      for (let i = 0; i < channelData.length; i++) {
        // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
        let sample = Math.max(-1, Math.min(1, channelData[i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        this.buffer[this.bufferIndex++] = sample;

        if (this.bufferIndex >= this.bufferSize) {
          // Send back the PCM buffer to the main thread
          // Make a copy since we're transferring it
          const outputBuffer = new Int16Array(this.buffer);
          this.port.postMessage(outputBuffer.buffer, [outputBuffer.buffer]);
          this.bufferIndex = 0;
        }
      }
    }
    return true; // Keep processor alive
  }
}

registerProcessor('audio-pcm-processor', AudioPCMProcessor);
