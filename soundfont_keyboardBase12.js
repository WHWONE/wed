document.addEventListener("DOMContentLoaded", () => {
  const AudioContextFunc = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextFunc();
  let piano = null;

  // ===== Loop State =====
  let loopTimer = null;
  let isChordLoop = false;
  let lastNoteIndex = null;

  // ===== Melodic Direction System =====
  // -1 = down, 0 = same, +1 = up
  let lastDirection = 0;

  // Probability weights (UI controlled)
  let probContinue = 60; // keep same direction
  let probReverse = 25;  // flip direction
  let probRepeat = 15;   // RE-PURPOSED: repeat last PHRASE (motif replay), not "repeat same note"

  // ===== Phrase & Cadence System =====
  // FIX #3: phrase length is BEATS, not "note count"
  let phraseLengthBeats = 16; // default 16 beats (4 bars of 4/4) unless user changes
  let phraseBeats = 0;        // accumulated beats inside current phrase
  let phrasePendingEnd = false;

  // FIX #4: phrase endings on barlines/downbeats
  const BAR_BEATS = 4;        // assume 4/4 for now (structural fix; no new UI)
  let beatInBar = 0;          // [0..BAR_BEATS)
  let barsSinceStart = 0;

  // Between-phrase rest (separate from global rest)
  // FIX #5
  let phraseRestProb = 30;     // chance to rest BETWEEN phrases (on downbeat boundary)
  let phraseResolveProb = 70;  // chance to do a cadence at phrase end

  // Cadence queue: phrase endings may schedule 1–2 notes (e.g. V -> I)
  let cadenceQueue = []; // array of { midi, label }

  // Phrase memory for repetition (motifs)
  // FIX #8: store intervals (relative to tonic) + rhythm (beats per step)
  let lastPhraseMemory = null;        // { key, mode, intervals:[], rhythms:[] }
  let currentPhraseCapture = [];      // capture during phrase: [{interval, beats}]
  let phraseReplayQueue = [];         // expanded replay steps: [{interval, beats}]

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

  // ===== Tempo & Velocity Controls =====
  const tempoSlider = document.getElementById("tempoSlider");
  const tempoValue = document.getElementById("tempoValue");
  const velocitySlider = document.getElementById("velocitySlider");
  const velocityValue = document.getElementById("velocityValue");
  const humanizeToggle = document.getElementById("humanizeToggle");

  const timingSlider = document.getElementById("timingSlider");
  const timingValue = document.getElementById("timingValue");
  let timingVariation = parseInt(timingSlider.value, 10);
  timingSlider.addEventListener("input", e => {
    timingVariation = parseInt(e.target.value, 10);
    timingValue.textContent = `${timingVariation} ms`;
  });

  // ===== Rest Probability (GLOBAL) =====
  const restSlider = document.getElementById("restSlider");
  const restValue = document.getElementById("restValue");
  let restProbability = parseInt(restSlider.value, 10);
  restSlider.addEventListener("input", e => {
    restProbability = parseInt(e.target.value, 10);
    restValue.textContent = restProbability + "%";
  });
  function shouldGlobalRest() {
    return Math.random() * 100 < restProbability;
  }

  // ===== Pattern Buttons =====
  const startRecordBtn = document.getElementById("startRecord");
  const stopRecordBtn = document.getElementById("stopRecord");
  const playPatternBtn = document.getElementById("playPattern");
  const clearPatternBtn = document.getElementById("clearPattern");
  const patternInfo = document.getElementById("patternInfo");
  const patternButtons = document.querySelectorAll(".patternSlot");

  // ===== Interval Mixer Sliders =====
  const sliderIDs = ["0", "2", "3", "5", "7", "9"];
  const sliders = {};
  sliderIDs.forEach(id => {
    sliders[id] = {
      slider: document.getElementById("w" + id),
      label: document.getElementById("v" + id)
    };
  });

  // ===== Tempo & Dynamics =====
  let bpm = parseInt(tempoSlider.value, 10);
  let dynamicIntensity = parseFloat(velocitySlider.value);
  tempoSlider.addEventListener("input", e => {
    bpm = parseInt(e.target.value, 10);
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

  // ===== Note & Mode Data =====
  const NOTES = [
    "C3","C#3","D3","D#3","E3","F3","F#3","G3","G#3","A3","A#3","B3",
    "C4","C#4","D4","D#4","E4","F4","F#4","G4","G#4","A4","A#4","B4",
    "C5","C#5","D5","D#5","E5","F5","F#5","G5","G#5","A5","A#5","B5","C6"
  ];
  let lowNote = "C4";
  let highNote = "C5";
  const lowNoteSelect = document.getElementById("lowNoteSelect");
  const highNoteSelect = document.getElementById("highNoteSelect");

  NOTES.forEach(note => {
    const optL = document.createElement("option");
    optL.value = note;
    optL.textContent = note;
    lowNoteSelect.appendChild(optL);
    const optH = document.createElement("option");
    optH.value = note;
    optH.textContent = note;
    highNoteSelect.appendChild(optH);
  });
  lowNoteSelect.value = lowNote;
  highNoteSelect.value = highNote;
  lowNoteSelect.addEventListener("change", () => lowNote = lowNoteSelect.value);
  highNoteSelect.addEventListener("change", () => highNote = highNoteSelect.value);

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
    ionian:[0,2,4,5,7,9,11], dorian:[0,2,3,5,7,9,10],
    phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11],
    mixolydian:[0,2,4,5,7,9,10], aeolian:[0,2,3,5,7,8,10],
    locrian:[0,1,3,5,6,8,10], pent_major:[0,2,4,7,9],
    pent_minor:[0,3,5,7,10], chromatic:[0,1,2,3,4,5,6,7,8,9,10,11]
  };

  // ===== MIDI helpers =====
  function noteToMidi(note) {
    // e.g. "C#4"
    const m = note.match(/^([A-G])(#?)(\d)$/);
    if (!m) return null;
    const letter = m[1];
    const sharp = m[2] === "#" ? "#" : "";
    const oct = parseInt(m[3], 10);
    const semi = NOTE_TO_SEMITONE[letter + sharp];
    if (semi === undefined) return null;
    // MIDI: C4 = 60; formula: (oct+1)*12 + semi
    return (oct + 1) * 12 + semi;
  }

  function midiToNearestAllowedNote(midi, allowed) {
    if (!allowed || !allowed.length) return null;
    let best = allowed[0];
    let bestDist = Infinity;
    for (const n of allowed) {
      const mm = noteToMidi(n);
      if (mm === null) continue;
      const d = Math.abs(mm - midi);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  function getAllowedMidis(allowed) {
    return allowed.map(n => ({ n, m: noteToMidi(n) })).filter(x => x.m !== null);
  }

  function getRangeMidMidi() {
    const lo = noteToMidi(lowNote);
    const hi = noteToMidi(highNote);
    if (lo === null || hi === null) return 60;
    return Math.round((lo + hi) / 2);
  }

  // ===== Scale Helper =====
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

  // ===== Interval Weights =====
  let intervalWeights = {0:15,1:0,2:30,3:20,4:0,5:10,7:8,9:4,12:2};
  sliderIDs.forEach(id => {
    sliders[id].slider.addEventListener("input", e => {
      const val = parseInt(e.target.value, 10);
      sliders[id].label.textContent = val + "%";
      const key = parseInt(id, 10);
      if (key === 9) { intervalWeights[9] = val; intervalWeights[12] = Math.max(1, Math.round(val / 2)); }
      else if (key === 2) { intervalWeights[1] = val; intervalWeights[2] = val; }
      else { intervalWeights[key] = val; }
    });
  });

  function weightedRandomInterval(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (!total) return 2;
    const r = Math.random() * total;
    let cum = 0;
    for (const [interval, weight] of Object.entries(weights)) {
      cum += weight;
      if (r < cum) return parseInt(interval, 10);
    }
    return 2;
  }

  // ===== Duration Weights =====
  const durationSliders = {
    whole: document.getElementById("durWhole"),
    half: document.getElementById("durHalf"),
    dotted_half: document.getElementById("durDottedHalf"),
    quarter: document.getElementById("durQuarter"),
    dotted_quarter: document.getElementById("durDottedQuarter"),
    quarter_triplet: document.getElementById("durQuarterTriplet"),
    eighth: document.getElementById("durEighth"),
    dotted_eighth: document.getElementById("durDottedEighth"),
    eighth_triplet: document.getElementById("durEighthTriplet"),
    sixteenth: document.getElementById("durSixteenth"),
    dotted_sixteenth: document.getElementById("durDottedSixteenth"),
    sixteenth_triplet: document.getElementById("durSixteenthTriplet")
  };

  const durationLabels = {
    whole: document.getElementById("valWhole"),
    half: document.getElementById("valHalf"),
    dotted_half: document.getElementById("valDottedHalf"),
    quarter: document.getElementById("valQuarter"),
    dotted_quarter: document.getElementById("valDottedQuarter"),
    quarter_triplet: document.getElementById("valQuarterTriplet"),
    eighth: document.getElementById("valEighth"),
    dotted_eighth: document.getElementById("valDottedEighth"),
    eighth_triplet: document.getElementById("valEighthTriplet"),
    sixteenth: document.getElementById("valSixteenth"),
    dotted_sixteenth: document.getElementById("valDottedSixteenth"),
    sixteenth_triplet: document.getElementById("valSixteenthTriplet")
  };

  let durationWeights = {
    whole: 10,
    half: 15,
    dotted_half: 5,
    quarter: 40,
    dotted_quarter: 5,
    quarter_triplet: 5,
    eighth: 20,
    dotted_eighth: 5,
    eighth_triplet: 5,
    sixteenth: 10,
    dotted_sixteenth: 3,
    sixteenth_triplet: 3
  };

  Object.entries(durationSliders).forEach(([name, el]) => {
    el.addEventListener("input", e => {
      const val = parseInt(e.target.value, 10);
      durationWeights[name] = val;
      durationLabels[name].textContent = val + "%";
    });
  });

  function durationToBeats(name) {
    const map = {
      whole: 4,
      half: 2,
      dotted_half: 3,
      quarter: 1,
      dotted_quarter: 1.5,
      quarter_triplet: 2 / 3,
      eighth: 0.5,
      dotted_eighth: 0.75,
      eighth_triplet: 1 / 3,
      sixteenth: 0.25,
      dotted_sixteenth: 0.375,
      sixteenth_triplet: 1 / 6
    };
    return map[name] || 1;
  }

  function pickWeightedDurationBeats() {
    const total = Object.values(durationWeights).reduce((a, b) => a + b, 0);
    const r = Math.random() * total;
    let cum = 0;
    for (const [name, weight] of Object.entries(durationWeights)) {
      cum += weight;
      if (r < cum) return durationToBeats(name);
    }
    return 1;
  }

  // ===== Keyboard Setup =====
  const whiteKeyWidth = 60;
  whiteKeysContainer.innerHTML = "";
  blackKeysContainer.innerHTML = "";
  const whiteIndexByNote = {};
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

  function naturalToLeftOfSharp(sharpNote) {
    const m = sharpNote.match(/^([A-G])#(\d)$/);
    if (!m) return null;
    const map = { C: "C", D: "D", F: "F", G: "G", A: "A" };
    return map[m[1]] ? map[m[1]] + m[2] : null;
  }

  const offsetWithinPair = Math.round(whiteKeyWidth * 0.66);
  NOTES.forEach(n => {
    if (n.includes("#")) {
      const leftNat = naturalToLeftOfSharp(n);
      const wIdx = leftNat ? whiteIndexByNote[leftNat] : undefined;
      if (wIdx === undefined) return;
      const k = document.createElement("div");
      k.classList.add("black");
      k.dataset.note = n;
      k.style.left = (wIdx * whiteKeyWidth + offsetWithinPair) + "px";
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

  // ===== Recording =====
  function recordEvent(evt) {
    if (!isRecording) return;
    const t = audioCtx.currentTime - recordStartTime;
    patterns[activeSlot].push({ ...evt, time: t });
    patternInfo.textContent = `Active Pattern: ${activeSlot} | ${patterns[activeSlot].length} events.`;
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
      patternInfo.textContent = `Active Pattern: ${activeSlot} | ${len} events (${dur}s @ ${recordBpm} BPM).`;
      status.textContent = "✅ Pattern recorded.";
    }
  }

  function clearPattern() {
    patterns[activeSlot] = [];
    clearPatternPlayback();
    playPatternBtn.disabled = false;
    patternInfo.textContent = `Active Pattern: ${activeSlot} | Cleared.`;
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
        if (evt.type === "note") playNote(evt.note, evt.velocity ?? 0.7, evt.duration ?? 1.0);
        else if (evt.type === "chord") (evt.notes || []).forEach(n => playNote(n, evt.velocity ?? 0.7, evt.duration ?? 1.0));
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

  // ===== Play Functions =====
  function playNote(note, vel = 0.7, durationSec = 1.0) {
    if (!piano) return;
    const minV = 0.5 * dynamicIntensity;
    const maxV = dynamicIntensity;
    const variedIntensity = Math.random() * (maxV - minV) + minV;
    const gain = vel * variedIntensity;

    piano.play(note, audioCtx.currentTime, { duration: durationSec, gain });
    highlightKey(note);
    recordEvent({ type: "note", note, velocity: gain, duration: durationSec });
  }

  function playChord(durationSec = 1.2) {
    if (!piano) return;
    const root = keySelect.value;
    let allowed = getScaleNotes(root);
    allowed = filterNotesInRange(allowed);
    if (allowed.length < 3) return;

    const i = Math.floor(Math.random() * (allowed.length - 2));
    const chord = [allowed[i], allowed[i + 2], allowed[i + 4]].filter(Boolean);

    chord.forEach((n, j) => {
      const minV = 0.5 * dynamicIntensity;
      const maxV = dynamicIntensity;
      const variedIntensity = Math.random() * (maxV - minV) + minV;
      let offset = 0;

      if (humanizeToggle.checked && timingVariation > 0) {
        const rangeSec = timingVariation / 1000;
        offset = (Math.random() - 0.5) * (2 * rangeSec);
      }

      piano.play(n, audioCtx.currentTime + offset, { duration: durationSec + j * 0.05, gain: variedIntensity });
      highlightKey(n);
    });

    status.textContent = `🎶 Chord: ${chord.join(", ")}`;
    recordEvent({ type: "chord", notes: chord, velocity: dynamicIntensity, duration: durationSec });
  }

  // ===== SoundFont Load =====
  Soundfont.instrument(audioCtx, "acoustic_grand_piano", {
    soundfont: "FluidR3_GM", format: "mp3", gain: 0.8
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
    k.addEventListener("click", () => playNote(k.dataset.note, 0.8, 1.0));
  });

  // ============================================================
  // FIX #1: Continue % knob is now actually used
  // ============================================================
  function pickNextDirection() {
    const r = Math.random() * 100;

    // Continue: keep same direction (or choose a starting direction if none)
    if (r < probContinue) {
      if (lastDirection === 0) return Math.random() < 0.5 ? 1 : -1;
      return lastDirection;
    }

    // Reverse: flip current direction (or pick one if none)
    if (r < probContinue + probReverse) {
      if (lastDirection === 0) return Math.random() < 0.5 ? 1 : -1;
      return -lastDirection;
    }

    // Otherwise: choose a fresh direction randomly (including "same" sometimes)
    const rr = Math.random();
    if (rr < 0.15) return 0;
    return rr < 0.575 ? 1 : -1;
  }

  // ============================================================
  // FIX #6: resolve tonic without random octave jumps
  // Choose tonic closest to current pitch / last note.
  // ============================================================
  function pickClosestTonicMidi(allowed, root, referenceMidi) {
    // Candidate tonics are notes whose pitch class matches root
    const candidates = allowed
      .map(n => ({ n, m: noteToMidi(n) }))
      .filter(x => x.m !== null && x.n.startsWith(root));

    if (!candidates.length) {
      // fallback to nearest allowed note to reference
      return noteToMidi(midiToNearestAllowedNote(referenceMidi, allowed));
    }

    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c.m - referenceMidi);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best.m;
  }

  // ============================================================
  // FIX #7: cadence types (not only tonic)
  // Cadence types are simple, structural, and mode-safe.
  // - "tonic": I (resolve to tonic)
  // - "authentic": V -> I (dominant-ish to tonic)
  // - "plagal": IV -> I (subdominant-ish to tonic)
  // - "half": -> V (end on dominant-ish)
  // ============================================================
  function chooseCadenceType() {
    // keep deterministic-ish defaults (no new UI)
    const r = Math.random() * 100;
    if (r < 20) return "tonic";
    if (r < 70) return "authentic";
    if (r < 90) return "plagal";
    return "half";
  }

  function degreeMidiNear(allowedMidis, targetPc, referenceMidi) {
    // Find note whose pitch class = targetPc, closest to referenceMidi
    let best = null;
    let bestDist = Infinity;
    for (const { n, m } of allowedMidis) {
      if (m === null) continue;
      if ((m % 12) !== targetPc) continue;
      const d = Math.abs(m - referenceMidi);
      if (d < bestDist) {
        bestDist = d;
        best = { n, m };
      }
    }
    return best ? best.m : null;
  }

  function scheduleCadence(allowed, root) {
    const allowedMidis = getAllowedMidis(allowed);
    const refMidi =
      (lastNoteIndex !== null && allowed[lastNoteIndex]) ? noteToMidi(allowed[lastNoteIndex]) :
      getRangeMidMidi();

    const tonicMidi = pickClosestTonicMidi(allowed, root, refMidi);
    if (tonicMidi === null) return;

    const tonicPc = tonicMidi % 12;
    const dominantPc = (tonicPc + 7) % 12;      // V
    const subdominantPc = (tonicPc + 5) % 12;   // IV

    const type = chooseCadenceType();
    cadenceQueue = [];

    if (type === "tonic") {
      cadenceQueue.push({ midi: tonicMidi, label: "I" });
      return;
    }

    if (type === "half") {
      const vMidi = degreeMidiNear(allowedMidis, dominantPc, refMidi) ?? tonicMidi;
      cadenceQueue.push({ midi: vMidi, label: "V" });
      return;
    }

    if (type === "plagal") {
      const ivMidi = degreeMidiNear(allowedMidis, subdominantPc, refMidi) ?? tonicMidi;
      cadenceQueue.push({ midi: ivMidi, label: "IV" });
      cadenceQueue.push({ midi: tonicMidi, label: "I" });
      return;
    }

    // authentic
    const vMidi = degreeMidiNear(allowedMidis, dominantPc, refMidi) ?? tonicMidi;
    cadenceQueue.push({ midi: vMidi, label: "V" });
    cadenceQueue.push({ midi: tonicMidi, label: "I" });
  }

  // ============================================================
  // FIX #8: phrase memory for actual repetition
  // Store phrase as intervals-from-tonic (in semitones) + rhythm (beats).
  // Replay maps those intervals back onto current allowed notes.
  // ============================================================
  function commitPhraseMemory(allowed, root) {
    if (!currentPhraseCapture.length) return;

    // Use a tonic near mid-range as the memory reference to keep intervals stable
    const refMidi = getRangeMidMidi();
    const tonicMidi = pickClosestTonicMidi(allowed, root, refMidi);
    if (tonicMidi === null) return;

    lastPhraseMemory = {
      key: root,
      mode: modeSelect.value,
      tonicMidi,
      intervals: currentPhraseCapture.map(x => x.interval),
      rhythms: currentPhraseCapture.map(x => x.beats)
    };
  }

  function maybeStartPhraseReplay() {
    // Repeat% now controls phrase replay chance at phrase boundaries
    if (!lastPhraseMemory) return false;
    if (Math.random() * 100 >= probRepeat) return false;

    phraseReplayQueue = lastPhraseMemory.intervals.map((interval, i) => ({
      interval,
      beats: lastPhraseMemory.rhythms[i] ?? 1
    }));
    return phraseReplayQueue.length > 0;
  }

  // ============================================================
  // Random Note Logic (now duration-aware and phrase-aware)
  // FIX #2: duration chosen once in scheduler and passed in here
  // ============================================================
  function playRandomNoteInKey(beatsThisEvent, durationSec) {
    const root = keySelect.value;
    let allowed = filterNotesInRange(getScaleNotes(root));
    if (!allowed.length) return;

    const isDownbeat = (beatInBar === 0);

    // If we have cadence notes queued (phrase ending), play those first
    if (cadenceQueue.length) {
      const step = cadenceQueue.shift();
      const note = midiToNearestAllowedNote(step.midi, allowed);
      if (note) {
        playNote(note, 0.8, durationSec);
        status.textContent = `🎵 Cadence: ${step.label} → ${note}`;
        lastNoteIndex = allowed.indexOf(note);
        lastDirection = 0;

        // capture cadence notes as part of phrase memory (optional but musical)
        const tonicMidiForCapture = pickClosestTonicMidi(allowed, root, step.midi ?? getRangeMidMidi());
        if (tonicMidiForCapture !== null) {
          const interval = (noteToMidi(note) ?? tonicMidiForCapture) - tonicMidiForCapture;
          currentPhraseCapture.push({ interval, beats: beatsThisEvent });
        }
      }

      // cadence notes consume time like any other event
      advanceBeatCounters(beatsThisEvent);
      return;
    }

    // FIX #4: phrase endings aligned to downbeats:
    // When phrasePendingEnd is true, only trigger ending behavior on a downbeat.
    if (phrasePendingEnd && isDownbeat) {
      // Decide phrase resolve/cadence
      const doResolve = (Math.random() * 100 < phraseResolveProb);

      if (doResolve) {
        scheduleCadence(allowed, root);
        // If cadenceQueue is empty (edge case), force tonic
        if (!cadenceQueue.length) {
          const refMidi = (lastNoteIndex !== null && allowed[lastNoteIndex]) ? noteToMidi(allowed[lastNoteIndex]) : getRangeMidMidi();
          const tonicMidi = pickClosestTonicMidi(allowed, root, refMidi);
          if (tonicMidi !== null) cadenceQueue.push({ midi: tonicMidi, label: "I" });
        }
      }

      // Commit phrase memory (what we just captured)
      commitPhraseMemory(allowed, root);

      // Reset phrase state for next phrase
      phrasePendingEnd = false;
      phraseBeats = 0;
      currentPhraseCapture = [];

      // Decide between-phrase rest (distinct from global rests)
      // FIX #5
      const doPhraseRest = (Math.random() * 100 < phraseRestProb);

      // Potentially start phrase replay
      const didReplay = maybeStartPhraseReplay();

      if (doPhraseRest) {
        status.textContent = didReplay
          ? "🤫 Phrase rest (next phrase will replay motif)"
          : "🤫 Phrase rest";
        // Still advance beat counters (time passes), but no sound this tick
        advanceBeatCounters(beatsThisEvent);
        return;
      }

      // If cadenceQueue was scheduled, next call will play it.
      // Fall through to normal note generation for this tick ONLY if no cadenceQueue.
      if (cadenceQueue.length) {
        // We want the cadence to start immediately on this downbeat tick,
        // so handle it now by recursive call (safe because it will hit the cadenceQueue branch).
        playRandomNoteInKey(beatsThisEvent, durationSec);
        return;
      }
    }

    // If replay queue active, use it (motif repetition)
    if (phraseReplayQueue.length) {
      const step = phraseReplayQueue.shift();
      const refMidi =
        (lastNoteIndex !== null && allowed[lastNoteIndex]) ? noteToMidi(allowed[lastNoteIndex]) :
        getRangeMidMidi();

      const tonicMidi = pickClosestTonicMidi(allowed, root, refMidi);
      const targetMidi = (tonicMidi ?? refMidi) + step.interval;

      const note = midiToNearestAllowedNote(targetMidi, allowed);
      if (note) {
        playNote(note, 0.78, durationSec);
        status.textContent = `🔁 Phrase replay: ${note}`;
        lastNoteIndex = allowed.indexOf(note);
      } else {
        status.textContent = "🔁 Phrase replay (no valid note)";
      }

      // Capture replayed notes too (so memory stays consistent if user keeps repeating)
      if (note) {
        const tonicMidi2 = tonicMidi ?? targetMidi;
        const interval2 = (noteToMidi(note) ?? targetMidi) - tonicMidi2;
        currentPhraseCapture.push({ interval: interval2, beats: beatsThisEvent });
      }

      // Global rest should NOT cancel a replay tick (distinct behaviors)
      // (This is part of FIX #5 spirit: keep phrase mechanics separate.)
      phraseBeats += beatsThisEvent;
      if (phraseBeats >= phraseLengthBeats) phrasePendingEnd = true;

      advanceBeatCounters(beatsThisEvent);
      return;
    }

    // ============================================================
    // Normal generation
    // ============================================================

    // Global rest: applies inside phrase, but we avoid skipping phrase-ending downbeats
    // (keeps phrase endings musically coherent)
    if (!phrasePendingEnd && shouldGlobalRest()) {
      status.textContent = "🤫 Rest (global)";
      phraseBeats += beatsThisEvent;
      if (phraseBeats >= phraseLengthBeats) phrasePendingEnd = true;
      advanceBeatCounters(beatsThisEvent);
      return;
    }

    let nextNote = null;

    if (lastNoteIndex === null) {
      nextNote = allowed[Math.floor(Math.random() * allowed.length)];
      lastNoteIndex = allowed.indexOf(nextNote);
      lastDirection = 1;
    } else {
      const interval = weightedRandomInterval(intervalWeights);

      // "repeat same note" is now driven by the interval mixer weight 0 + direction=0 outcomes,
      // not by probRepeat (which is phrase replay).
      const dir = pickNextDirection();

      // Keep your original "interval/2" behavior, but make it more stable:
      const step = Math.max(0, Math.round(interval / 2));
      let newIndex = lastNoteIndex + dir * step;

      // Clamp
      newIndex = Math.max(0, Math.min(newIndex, allowed.length - 1));

      nextNote = allowed[newIndex];
      lastDirection = dir;
      lastNoteIndex = newIndex;
    }

    // Play
    if (nextNote) {
      playNote(nextNote, 0.75, durationSec);
      status.textContent = `🎵 Note: ${nextNote}`;

      // Capture for phrase memory (interval from a stable tonic near mid-range)
      const refMidi = getRangeMidMidi();
      const tonicMidi = pickClosestTonicMidi(allowed, root, refMidi);
      if (tonicMidi !== null) {
        const mm = noteToMidi(nextNote);
        if (mm !== null) {
          currentPhraseCapture.push({ interval: mm - tonicMidi, beats: beatsThisEvent });
        }
      }
    }

    // Phrase beat accounting
    phraseBeats += beatsThisEvent;
    if (phraseBeats >= phraseLengthBeats) {
      // FIX #4: do NOT end immediately; wait until next downbeat
      phrasePendingEnd = true;
    }

    advanceBeatCounters(beatsThisEvent);
  }

  function advanceBeatCounters(beatsThisEvent) {
    // advance beat position within bar
    const prevBeatInBar = beatInBar;
    beatInBar = (beatInBar + beatsThisEvent) % BAR_BEATS;

    // crude bar count tracking (for debug / future use)
    // detect wrap-around
    if (prevBeatInBar > beatInBar || (beatsThisEvent >= BAR_BEATS)) {
      barsSinceStart += 1;
    }
  }

  // ===== Single Note Button (uses a "default" duration) =====
  playRandom.addEventListener("click", () => {
    // use a consistent quarter-note-ish feel for manual single trigger
    const beats = 1;
    const sec = (60 / bpm) * beats * 0.95;
    playRandomNoteInKey(beats, sec);
  });

  playChordBtn.addEventListener("click", () => {
    const beats = 2;
    const sec = (60 / bpm) * beats * 0.95;
    playChord(sec);
  });

  // ============================================================
  // Loop System (Duration-Aware)
  // FIX #2: duration chosen ONCE per tick and passed into generator
  // ============================================================
  function scheduleLoop(fn) {
    const beatsThisEvent = pickWeightedDurationBeats();
    const nextDelayMs = (60000 / bpm) * beatsThisEvent;

    // keep duration slightly shorter than full slot to reduce overlap
    const durationSec = (60 / bpm) * beatsThisEvent * 0.92;

    fn(beatsThisEvent, durationSec);

    loopTimer = setTimeout(() => scheduleLoop(fn), nextDelayMs);
  }

  function startLoop(chord = false) {
    if (loopTimer) return;
    clearPatternPlayback();
    isChordLoop = chord;
    lastNoteIndex = null;

    // reset phrase timing so downbeats are deterministic at loop start
    beatInBar = 0;
    barsSinceStart = 0;
    phraseBeats = 0;
    phrasePendingEnd = false;
    cadenceQueue = [];
    phraseReplayQueue = [];
    currentPhraseCapture = [];

    playRandom.disabled = true;
    playChordBtn.disabled = true;
    playChordLoopBtn.disabled = true;
    document.getElementById("startLoop").disabled = true;
    document.getElementById("stopLoop").disabled = false;

    status.textContent = chord ? "🎶 Chord loop running..." : "🎵 Note loop running...";

    if (chord) {
      const fn = (beatsThisEvent, durationSec) => playChord(durationSec);
      scheduleLoop(fn);
    } else {
      scheduleLoop(playRandomNoteInKey);
    }
  }

  function stopLoopInternal() {
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
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

  // ===== Melody / Phrase Control Inputs =====
  const numPhraseLen = document.getElementById("numPhraseLen");
  const numPhraseRest = document.getElementById("numPhraseRest");
  const numPhraseResolve = document.getElementById("numPhraseResolve");
  const numProbContinue = document.getElementById("numProbContinue");
  const numProbReverse = document.getElementById("numProbReverse");
  const numProbRepeat = document.getElementById("numProbRepeat");

  if (numPhraseLen) {
    // FIX #3: Phrase Length input is interpreted as BEATS
    numPhraseLen.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      phraseLengthBeats = Number.isFinite(v) ? v : 16;
    });
    numPhraseRest.addEventListener("input", e => phraseRestProb = parseInt(e.target.value, 10));
    numPhraseResolve.addEventListener("input", e => phraseResolveProb = parseInt(e.target.value, 10));

    // FIX #1: Continue% is used in pickNextDirection()
    numProbContinue.addEventListener("input", e => probContinue = parseInt(e.target.value, 10));
    numProbReverse.addEventListener("input", e => probReverse = parseInt(e.target.value, 10));

    // FIX #8: Repeat% now means "repeat last phrase motif"
    numProbRepeat.addEventListener("input", e => probRepeat = parseInt(e.target.value, 10));

    console.log("🎛 Melody / Phrase number inputs initialized.");
  } else {
    console.log("⚠️ Melody / Phrase inputs not found (skipping UI link).");
  }
});
