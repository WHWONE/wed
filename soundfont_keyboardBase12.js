document.addEventListener("DOMContentLoaded", () => {
  const AudioContextFunc = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextFunc();
  let piano = null;

  // ===== Loop State =====
  let loopTimer = null;
  let isChordLoop = false;
  let lastNoteIndex = null;

  // ===== Pattern Bank State =====
  const patterns = { A: [], B: [], C: [], D: [] };
  let activeSlot = "A";
  let isRecording = false;
  let recordStartTime = 0;
  let recordBpm = 90;
  let patternTimers = [];

  // ===== UI Elements =====
  const status = document.getElementById("status");
  const playRandom = document.getElementById("playRandom");
  const playChordBtn = document.getElementById("playChord");
  const playChordLoopBtn = document.getElementById("playChordLoop");
  const keySelect = document.getElementById("keySelect");
  const modeSelect = document.getElementById("modeSelect");
  const whiteKeysContainer = document.getElementById("whiteKeys");
  const blackKeysContainer = document.getElementById("blackKeys");

  const tempoSlider = document.getElementById("tempoSlider");
  const tempoValue = document.getElementById("tempoValue");
  const velocitySlider = document.getElementById("velocitySlider");
  const velocityValue = document.getElementById("velocityValue");
  const humanizeToggle = document.getElementById("humanizeToggle");
  // ===== Timing Variation Slider =====
const timingSlider = document.getElementById("timingSlider");
const timingValue = document.getElementById("timingValue");
let timingVariation = parseInt(timingSlider.value);

timingSlider.addEventListener("input", e => {
  timingVariation = parseInt(e.target.value);
  timingValue.textContent = `${timingVariation} ms`;
});
  

// ===== Random Rest Controls =====
const restSlider = document.getElementById("restSlider");
const restValue = document.getElementById("restValue");
let restProbability = parseInt(restSlider.value);

restSlider.addEventListener("input", e => {
  restProbability = parseInt(e.target.value);
  restValue.textContent = restProbability + "%";
});

// Helper that decides if the current beat should be a rest
function shouldRest() {
  return Math.random() * 100 < restProbability;
}


  const startRecordBtn = document.getElementById("startRecord");
  const stopRecordBtn = document.getElementById("stopRecord");
  const playPatternBtn = document.getElementById("playPattern");
  const clearPatternBtn = document.getElementById("clearPattern");
  const patternInfo = document.getElementById("patternInfo");
  const patternButtons = document.querySelectorAll(".patternSlot");

  // Interval mixer sliders
  const sliderIDs = ["0", "2", "3", "5", "7", "9"];
  const sliders = {};
  sliderIDs.forEach(id => {
    sliders[id] = {
      slider: document.getElementById("w" + id),
      label: document.getElementById("v" + id)
    };
  });

  // ===== Tempo & Dynamics State =====
  let bpm = parseInt(tempoSlider.value);
  let dynamicIntensity = parseFloat(velocitySlider.value);

  tempoSlider.addEventListener("input", e => {
    bpm = parseInt(e.target.value);
    tempoValue.textContent = bpm;
    if (loopTimer) restartLoop();
  });

  velocitySlider.addEventListener("input", e => {
    dynamicIntensity = parseFloat(e.target.value);
    velocityValue.textContent = Math.round(dynamicIntensity * 100) + "%";
  });

  // ===== Pattern Slot Switching =====
  patternButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      // stop any pattern playback & recording before switching
      stopRecording();
      clearPatternPlayback();

      patternButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeSlot = btn.dataset.slot;

      const len = patterns[activeSlot].length;
      patternInfo.textContent =
        `Active Pattern: ${activeSlot} | ${len ? len + " events." : "No events recorded."}`;
    });
  });

  // ===== Note & Mode Definitions =====
const NOTES = [
  // C3 octave
  "C3","C#3","D3","D#3","E3","F3","F#3",
  "G3","G#3","A3","A#3","B3",
  // C4 octave
  "C4","C#4","D4","D#4","E4","F4","F#4",
  "G4","G#4","A4","A#4","B4",
  // C5 octave
  "C5","C#5","D5","D#5","E5","F5","F#5",
  "G5","G#5","A5","A#5","B5",
  // up to C6
  "C6"
];
// ===== Note Range Controls =====
// Allow user to limit playback between two notes (e.g. C4–F4)
let lowNote = "C4";
let highNote = "C5";

const lowNoteSelect = document.getElementById("lowNoteSelect");
const highNoteSelect = document.getElementById("highNoteSelect");

// Populate dropdowns using the existing NOTES array
NOTES.forEach(note => {
  const optLow = document.createElement("option");
  optLow.value = note;
  optLow.textContent = note;
  lowNoteSelect.appendChild(optLow);

  const optHigh = document.createElement("option");
  optHigh.value = note;
  optHigh.textContent = note;
  highNoteSelect.appendChild(optHigh);
});

// Set initial values
lowNoteSelect.value = lowNote;
highNoteSelect.value = highNote;

// Update variables on change
lowNoteSelect.addEventListener("change", () => {
  lowNote = lowNoteSelect.value;
});
highNoteSelect.addEventListener("change", () => {
  highNote = highNoteSelect.value;
});

// Helper function to filter allowed notes within range
function filterNotesInRange(allowed) {
  const lowIndex = NOTES.indexOf(lowNote);
  const highIndex = NOTES.indexOf(highNote);
  return allowed.filter(n => {
    const idx = NOTES.indexOf(n);
    return idx >= lowIndex && idx <= highIndex;
  });
}



  const NOTE_TO_SEMITONE = {
    "C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,
    "F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11
  };

  const MODE_INTERVALS = {
    ionian:      [0,2,4,5,7,9,11],
    dorian:      [0,2,3,5,7,9,10],
    phrygian:    [0,1,3,5,7,8,10],
    lydian:      [0,2,4,6,7,9,11],
    mixolydian:  [0,2,4,5,7,9,10],
    aeolian:     [0,2,3,5,7,8,10],
    locrian:     [0,1,3,5,6,8,10],
    pent_major:  [0,2,4,7,9],
    pent_minor:  [0,3,5,7,10],
    chromatic:   [0,1,2,3,4,5,6,7,8,9,10,11]
  };

  // ===== Interval Weight System =====
  let intervalWeights = {
    0:15,  // same note
    1:0,   // mapped with 2
    2:30,  // 2nds
    3:20,  // 3rds
    4:0,
    5:10,  // 4ths
    7:8,   // 5ths
    9:4,   // 6ths
    12:2   // octaves
  };

  sliderIDs.forEach(id => {
    sliders[id].slider.addEventListener("input", e => {
      const val = parseInt(e.target.value);
      sliders[id].label.textContent = val + "%";
      const key = parseInt(id);

      if (key === 9) {
        intervalWeights[9] = val;
        intervalWeights[12] = Math.max(1, Math.round(val / 2));
      } else if (key === 2) {
        intervalWeights[1] = val;
        intervalWeights[2] = val;
      } else {
        intervalWeights[key] = val;
      }
    });
  });

  function weightedRandomInterval(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (!total) return 2;
    const r = Math.random() * total;
    let cum = 0;
    for (const [interval, weight] of Object.entries(weights)) {
      cum += weight;
      if (r < cum) return parseInt(interval);
    }
    return 2;
  }

// ===== Build Keyboard (auto layout; works for any range like C3–C5) =====
// IMPORTANT: .white width in CSS is 60px; keep whiteKeyWidth in sync with CSS.
const whiteKeyWidth = 60;

// Clean slate
whiteKeysContainer.innerHTML = "";
blackKeysContainer.innerHTML = "";

// 1) Build white keys in visual order and remember their x-positions (by index)
const whiteIndexByNote = {}; // e.g., { "C3":0, "D3":1, ... }
let wIndex = 0;
NOTES.forEach(n => {
  if (!n.includes("#")) {
    const k = document.createElement("div");
    k.classList.add("white");
    k.dataset.note = n;
    whiteKeysContainer.appendChild(k);
    whiteIndexByNote[n] = wIndex++;
  }
});

// 2) Build black keys positioned relative to their preceding white key
// Map a sharp to the natural note on its left (on a piano)
// C# -> C, D# -> D, F# -> F, G# -> G, A# -> A
function naturalToLeftOfSharp(sharpNote) {
  const m = sharpNote.match(/^([A-G])#(\d)$/);
  if (!m) return null;
  const letter = m[1], oct = m[2];
  const map = { C: "C", D: "D", F: "F", G: "G", A: "A" };
  const nat = map[letter];
  return nat ? nat + oct : null;
}

// Place black key ~2/3 across its left white key (looks realistic)
const offsetWithinPair = Math.round(whiteKeyWidth * 0.66);

NOTES.forEach(n => {
  if (n.includes("#")) {
    const leftNat = naturalToLeftOfSharp(n);
    const wIdx = leftNat ? whiteIndexByNote[leftNat] : undefined;
    if (wIdx === undefined) return; // if outside visual range, skip
    const leftPx = (wIdx * whiteKeyWidth) + offsetWithinPair;

    const k = document.createElement("div");
    k.classList.add("black");
    k.dataset.note = n;
    k.style.left = leftPx + "px";
    blackKeysContainer.appendChild(k);
  }
});

  function highlightKey(note) {
    const k = document.querySelector(`[data-note="${note}"]`);
    if (k) {
      k.classList.add("active");
      setTimeout(() => k.classList.remove("active"), 250);
    }
  }

  // ===== Scale / Mode =====
  function getScaleNotes(root) {
    root = root.replace("♯", "#").replace("♭", "b").split("/")[0].trim();
    if (!(root in NOTE_TO_SEMITONE)) root = "C";
    const rootOffset = NOTE_TO_SEMITONE[root];
    const mode = modeSelect.value;
    const intervals = MODE_INTERVALS[mode] || MODE_INTERVALS.ionian;

    return NOTES.filter(n => {
      const base = n.replace(/[0-9]/g, "");
      const semi = NOTE_TO_SEMITONE[base];
      const rel = (semi - rootOffset + 12) % 12;
      return intervals.includes(rel);
    });
  }

  // ===== Pattern Recording =====
  function recordEvent(evt) {
    if (!isRecording) return;
    const t = audioCtx.currentTime - recordStartTime;
    patterns[activeSlot].push({ ...evt, time: t });
    patternInfo.textContent =
      `Active Pattern: ${activeSlot} | ${patterns[activeSlot].length} events.`;
  }

  function clearPatternPlayback() {
    patternTimers.forEach(id => clearTimeout(id));
    patternTimers = [];
  }

  function startRecording() {
    clearPatternPlayback();
    patterns[activeSlot] = [];
    isRecording = true;
    recordStartTime = audioCtx.currentTime;
    recordBpm = bpm;

    startRecordBtn.disabled = true;
    stopRecordBtn.disabled = false;
    playPatternBtn.disabled = true;

    status.textContent = `⏺ Recording Pattern ${activeSlot}…`;
    patternInfo.textContent = `Active Pattern: ${activeSlot} | Recording…`;
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    startRecordBtn.disabled = false;
    stopRecordBtn.disabled = true;
    playPatternBtn.disabled = patterns[activeSlot].length === 0;

    const len = patterns[activeSlot].length;
    if (!len) {
      patternInfo.textContent = `Active Pattern: ${activeSlot} | No events recorded.`;
      status.textContent = "⏹ Recording stopped (empty).";
    } else {
      const dur = patterns[activeSlot][len - 1].time.toFixed(2);
      patternInfo.textContent =
        `Active Pattern: ${activeSlot} | ${len} events (${dur}s @ ${recordBpm} BPM).`;
      status.textContent = "✅ Pattern recorded.";
    }
  }

  function clearPattern() {
    patterns[activeSlot] = [];
    clearPatternPlayback();
    playPatternBtn.disabled = false;
    patternInfo.textContent =
      `Active Pattern: ${activeSlot} | Cleared.`;
    status.textContent = `🗑 Cleared Pattern ${activeSlot}.`;
  }

  function playPattern() {
    const pattern = patterns[activeSlot];
    if (!pattern.length) {
      status.textContent = `Pattern ${activeSlot} is empty.`;
      return;
    }

    stopLoopInternal();
    clearPatternPlayback();

    const scale = recordBpm > 0 ? recordBpm / bpm : 1;
    status.textContent = `▶️ Playing Pattern ${activeSlot}…`;

    pattern.forEach(evt => {
      const delay = evt.time * scale * 1000;
      const id = setTimeout(() => {
        if (evt.type === "note") {
          playNote(evt.note, evt.velocity ?? 0.7);
        } else if (evt.type === "chord") {
          (evt.notes || []).forEach(n => playNote(n, evt.velocity ?? 0.7));
        }
      }, delay);
      patternTimers.push(id);
    });

    const totalDur = pattern[pattern.length - 1].time * scale * 1000;
    const endId = setTimeout(() => {
      status.textContent = `⏹ Pattern ${activeSlot} playback done.`;
    }, totalDur + 120);
    patternTimers.push(endId);
  }

  startRecordBtn.addEventListener("click", startRecording);
  stopRecordBtn.addEventListener("click", stopRecording);
  playPatternBtn.addEventListener("click", playPattern);
  clearPatternBtn.addEventListener("click", clearPattern);

  // ===== Core Play Functions =====
// ===== Play Note with Dynamic Range =====
function playNote(note, vel = 0.7) {
  if (!piano) return;

  // Compute randomized intensity between 50% and 100% of slider value
  const minV = 0.5 * dynamicIntensity;
  const maxV = dynamicIntensity;
  const variedIntensity = Math.random() * (maxV - minV) + minV;

  // Combine with incoming velocity if applicable
  const gain = vel * variedIntensity;

  piano.play(note, audioCtx.currentTime, { duration: 1.2, gain });
  highlightKey(note);

  recordEvent({
    type: "note",
    note,
    velocity: gain,
    duration: 1.2
  });
}


function playChord() {
  if (!piano) return;
  const root = keySelect.value;
  let allowed = getScaleNotes(root);
  allowed = filterNotesInRange(allowed);
  if (allowed.length < 3) return;

  const i = Math.floor(Math.random() * (allowed.length - 2));
  const chord = [allowed[i], allowed[i + 2], allowed[i + 4]].filter(Boolean);

  chord.forEach((n, j) => {
    // 🎚 Apply dynamic intensity range (50–100%)
    const minV = 0.5 * dynamicIntensity;
    const maxV = dynamicIntensity;
    const variedIntensity = Math.random() * (maxV - minV) + minV;

    // ⏱ Optional humanized timing offset (±30 ms) controlled by toggle
let offset = 0;
if (humanizeToggle.checked && timingVariation > 0) {
  // Convert ms to seconds, ±range
  const rangeSec = timingVariation / 1000;
  offset = (Math.random() - 0.5) * (2 * rangeSec);
}


    piano.play(n, audioCtx.currentTime + offset, {
      duration: 1.5 + j * 0.1,
      gain: variedIntensity
    });

    highlightKey(n);
  });

  status.textContent = `🎶 Chord: ${chord.join(", ")}`;

  recordEvent({
    type: "chord",
    notes: chord,
    velocity: dynamicIntensity
  });
}
  // ===== SoundFont Load =====
  Soundfont.instrument(audioCtx, "acoustic_grand_piano", {
    soundfont: "FluidR3_GM",
    format: "mp3",
    gain: 0.8
  }).then(inst => {
    piano = inst;
    status.textContent = "✅ Piano SoundFont loaded!";
    playRandom.disabled = false;
    playChordBtn.disabled = false;
    playChordLoopBtn.disabled = false;
    playPatternBtn.disabled = false;
  }).catch(err => {
    console.error(err);
    status.textContent = "❌ Error loading SoundFont.";
  });

  // ===== Keyboard Clicks =====
  document.querySelectorAll(".white, .black").forEach(k => {
    k.addEventListener("click", () => {
      const note = k.dataset.note;
      playNote(note, 0.8);
    });
  });

  // ===== Random Note in Key (interval-weighted) =====
  playRandom.addEventListener("click", () => {
    playRandomNoteInKey();
  });

  function playRandomNoteInKey() {
    const root = keySelect.value;
let allowed = getScaleNotes(root);
allowed = filterNotesInRange(allowed);
    if (!allowed.length) return;
  // Possibly skip this note entirely (rest)
  if (shouldRest()) {
    status.textContent = "🤫 Rest (no note played)";
    return;
  }

    let next;
    if (lastNoteIndex === null) {
      next = allowed[Math.floor(Math.random() * allowed.length)];
      lastNoteIndex = allowed.indexOf(next);
    } else {
      const interval = weightedRandomInterval(intervalWeights);
      if (interval === 0) {
        next = allowed[lastNoteIndex];
      } else {
        const dir = Math.random() < 0.5 ? -1 : 1;
        let newIndex = lastNoteIndex + dir * Math.round(interval / 2);
        newIndex = Math.max(0, Math.min(newIndex, allowed.length - 1));
        next = allowed[newIndex];
        lastNoteIndex = newIndex;
      }
    }

    const baseVel = 0.7 + (Math.random() * 0.3 - 0.15);
    const jitter = humanizeToggle.checked ? (Math.random() - 0.5) * 0.06 : 0;
    const when = audioCtx.currentTime + Math.max(0, jitter);
    const gain = baseVel * dynamicIntensity;

    if (!piano) return;
    piano.play(next, when, { duration: 1.2, gain });
    highlightKey(next);

    recordEvent({
      type: "note",
      note: next,
      velocity: gain,
      duration: 1.2
    });

    status.textContent = `🎵 Note: ${next}`;
  }

  // ===== Loop Functions =====
  function playRandomChordInKey() {
    playChord();
  }

  function scheduleLoop(fn) {
    const beat = 60000 / bpm;
    fn();
    loopTimer = setTimeout(() => scheduleLoop(fn), beat);
  }

  function startLoop(chord = false) {
    if (loopTimer) return;
    clearPatternPlayback(); // avoid overlap
    isChordLoop = chord;
    lastNoteIndex = null;

    playRandom.disabled = true;
    playChordBtn.disabled = true;
    playChordLoopBtn.disabled = true;
    document.getElementById("startLoop").disabled = true;
    document.getElementById("stopLoop").disabled = false;

    status.textContent = chord
      ? "🎶 Chord loop running..."
      : "🎵 Note loop running...";

    const fn = chord ? playRandomChordInKey : playRandomNoteInKey;
    scheduleLoop(fn);
  }

  function stopLoopInternal() {
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    isChordLoop = false;
  }

  function restartLoop() {
    if (!loopTimer) return;
    const wasChord = isChordLoop;
    stopLoopInternal();
    startLoop(wasChord);
  }

  function stopLoop() {
    stopLoopInternal();
    playRandom.disabled = false;
    playChordBtn.disabled = false;
    playChordLoopBtn.disabled = false;
    document.getElementById("startLoop").disabled = false;
    document.getElementById("stopLoop").disabled = true;
    status.textContent = "⏹ Stopped loop playback.";
  }

  document.getElementById("startLoop").addEventListener("click", () => startLoop(false));
  playChordLoopBtn.addEventListener("click", () => startLoop(true));
  document.getElementById("stopLoop").addEventListener("click", stopLoop);
});
