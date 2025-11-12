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
  let index = 0, in
