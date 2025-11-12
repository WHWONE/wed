class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.command) {
        if (e.data.command === 'start') this.isRecording = true;
        if (e.data.command === 'stop')  this.isRecording = false;
      }
    };
  }
  process(inputs) {
    if (!this.isRecording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0] || new Float32Array(128);
    const ch1 = input[1] || ch0;
    const b0 = new Float32Array(ch0.length); b0.set(ch0);
    const b1 = new Float32Array(ch1.length); b1.set(ch1);
    this.port.postMessage({ ch0: b0, ch1: b1 }, [b0.buffer, b1.buffer]);
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
