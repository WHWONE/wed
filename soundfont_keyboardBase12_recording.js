// ------------------------------------------------------------
// 🎹 SoundFont Keyboard with WAV Recording (Chrome Version)
// ------------------------------------------------------------

// Basic AudioContext setup
const AudioContextFunc = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContextFunc();

// Global references
let piano = null;
let recNode = null;
let recBuffersL = [];
let recBuffersR = [];
let recLength = 0;
let sampleRate = audioCtx.sampleRate;

// DOM elements
const status = document.getElementById("status");
const startAudioRecBtn = document.getElementById("startAudioRec");
const stopAudioRecBtn = document.getElementById("stopAudioRec");

// ===== SoundFont Load =====
Soundfont.instrument(audioCtx, 'acoustic_grand_piano', { format: 'mp3', soundfont: 'FluidR3_GM' })
  .then(instrument => {
    piano = instrument;
    status.textContent = "✅ Piano SoundFont loaded!";
    startAudioRecBtn.disabled = false;
    stopAudioRecBtn.disabled = true;


    // Ensure we hear piano output normally
    try {
      if (piano.output && piano.output.connect) {
        piano.output.connect(audioCtx.destination);
        console.log("🔊 Piano connected to speakers");
      }
    } catch (e) {
      console.error("Piano connection error:", e);
    }
  })
  .catch(err => {
    status.textContent = "❌ Error loading SoundFont";
    console.error(err);
  });

// ===== Recording Setup =====
audioCtx.audioWorklet.addModule('recorder-worklet.js').catch(err => {
  console.error('AudioWorklet load failed:', err);
  status.textContent = "❌ Recorder init failed.";
});

// ===== Helper Functions =====
function interleave(left, right) {
  const length = left.length + right.length;
  const result = new Float32Array(length);
  let index = 0, inputIndex = 0;
  while (index < length) {
    result[index++] = left[inputIndex];
    result[index++] = right[inputIndex];
    inputIndex++;
  }
  return result;
}

function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function encodeWAV(samples, sampleRate, numChannels) {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  floatTo16BitPCM(view, 44, samples);
  return buffer;
}

// ------------------------------------------------------------
// 🎙 START RECORDING
// ------------------------------------------------------------
function startAudioRecording() {
  if (!piano) return;

  if (!recNode) {
    try {
      recNode = new AudioWorkletNode(audioCtx, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 2
      });
      console.log("🧩 Recorder node created");
    } catch (e) {
      console.error('Failed to create recorder node:', e);
      status.textContent = "❌ Recorder init failed.";
      return;
    }
  }

  // === Step 3: Ensure audio is routed correctly to recorder and speakers ===
  try {
    if (piano.output && piano.output.connect) {
      piano.output.connect(audioCtx.destination);
      piano.output.connect(recNode);
      console.log("✅ Piano output now connected to recorder node!");
    }
  } catch (e) {
    console.error("Audio routing error during recording:", e);
  }

  // Optional debug — show incoming audio chunks
  recNode.port.onmessage = (e) => {
    const { ch0, ch1 } = e.data || {};
    if (ch0 && ch1) {
      recBuffersL.push(ch0);
      recBuffersR.push(ch1);
      recLength += ch0.length;
      console.log("🎚 Received audio chunk:", ch0.length);
    }
  };

  // Clear buffers
  recBuffersL = [];
  recBuffersR = [];
  recLength = 0;

  recNode.port.postMessage({ command: 'start' });
  startAudioRecBtn.disabled = true;
  stopAudioRecBtn.disabled = false;
  status.textContent = "🎙 Recording audio…";
}

// ------------------------------------------------------------
// 🛑 STOP RECORDING
// ------------------------------------------------------------
function stopAudioRecording() {
  if (!recNode) return;

  try {
    recNode.port.postMessage({ command: 'stop' });
  } catch (e) {
    console.error("Recorder stop error:", e);
  }

  // Merge buffers and create WAV
  function mergeBuffers(buffers, totalLength) {
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < buffers.length; i++) {
      result.set(buffers[i], offset);
      offset += buffers[i].length;
    }
    return result;
  }

  const left = mergeBuffers(recBuffersL, recLength);
  const right = mergeBuffers(recBuffersR, recLength);
  const interleaved = interleave(left, right);
  const wavBuffer = encodeWAV(interleaved, sampleRate, 2);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `recording_${ts}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);

  startAudioRecBtn.disabled = false;
  stopAudioRecBtn.disabled = true;
  status.textContent = "💾 Audio recording saved.";
}

// ------------------------------------------------------------
// 🎹 Simple Note Playback (Keyboard Example)
// ------------------------------------------------------------
function playNote(note, duration = 1) {
  if (piano) piano.play(note, audioCtx.currentTime, { duration });
}

// Example: hook up keys if your HTML has them
document.querySelectorAll(".key").forEach(key => {
  key.addEventListener("mousedown", e => {
    const note = e.target.dataset.note;
    playNote(note);
  });
});

// ------------------------------------------------------------
// 🎛 Button bindings
// ------------------------------------------------------------
startAudioRecBtn.addEventListener("click", startAudioRecording);
stopAudioRecBtn.addEventListener("click", stopAudioRecording);
