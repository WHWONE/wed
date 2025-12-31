/* ========================================================================== *
 * soundfont_keyboardBase12.js (Refactor: single-file, module-style)
 * DROP-IN REPLACEMENT
 *
 * MAPPING GUIDE (sections + public methods)
 *
 * 1) App State (single mutable object)
 *    - state.audio: { ctx, instrument, isReady }
 *    - state.transport: { loopTimerId, loopMode, isLooping }
 *    - state.theory: { NOTES, NOTE_TO_SEMITONE, MODE_INTERVALS, lowNote, highNote }
 *    - state.rhythm: { bpm, dynamicIntensity, timingVariationMs, humanize, restProbability, durationWeights }
 *    - state.phrase: { phraseLengthBeats, phraseBeats, phrasePendingEnd, BAR_BEATS, beatInBar, cadenceQueue,
 *                      probContinue, probReverse, probRepeat, intervalWeights, motif memory fields... }
 *    - state.pattern: { patterns, activeSlot, isRecording, recordStartCtxTime, recordBpm, timers }
 *    - state.ui: { el, keyEls, config }
 *    - state.debug: false (optional; off by default)
 *
 * 2) DOMCache / UIBinder
 *    - DOMCache.cache()
 *    - UIBinder.init(controller)
 *    - UIBinder.buildKeyboard(controller)
 *    - UIBinder.highlightKey(note)
 *    - UIBinder.setStatus(text)
 *    - UIBinder.setLoopButtonsEnabled(isLooping)
 *    - UIBinder.updatePatternInfo()
 *
 * 3) AudioEngine
 *    - AudioEngine.init()
 *    - AudioEngine.loadInstrument()
 *    - AudioEngine.playNote(note, vel, durSec, offsetSec)
 *    - AudioEngine.playChord(notes, vel, durSec)
 *
 * 4) TheoryEngine (helpers; no DOM writes)
 *    - noteToMidi(note)
 *    - midiToNearestAllowedNote(midi, allowedNotes)
 *    - getScaleNotes(root, mode)
 *    - filterNotesInRange(notes)
 *    - pickClosestTonicMidi(allowed, root, referenceMidi)
 *    - degreeMidiNear(allowedMidis, targetPc, referenceMidi)
 *
 * 5) RhythmEngine (no timers)
 *    - durationToBeats(name)
 *    - pickWeightedDurationBeats(weights)
 *    - beatsToMs(beats, bpm)
 *    - beatsToSec(beats, bpm)
 *
 * 6) PhraseEngine (Generator; returns declarative events only)
 *    - PhraseEngine.nextEvent(state, beatsThisEvent) -> { kind, beats, note?/notes?, meta?/reason? }
 *    - PhraseEngine.resetForLoopStart(state)
 *
 * 7) PatternEngine (record + playback; playback uses timers but stoppable)
 *    - PatternEngine.startRecording(state)
 *    - PatternEngine.stopRecording(state)
 *    - PatternEngine.clearPattern(state)
 *    - PatternEngine.playPattern(state, hooks)
 *    - PatternEngine.recordEvent(state, evt)
 *    - PatternEngine.stopPlayback(state)
 *
 * 8) TransportEngine (owns loop timer)
 *    - TransportEngine.startLoop(state, onTick)
 *    - TransportEngine.stopLoop(state)
 *    - TransportEngine.restartLoop(state, onTick)
 *
 * 9) AppController (single orchestration point)
 *    - controller.init()
 *    - controller.playManualNote(note)
 *    - controller.playRandomOnce()
 *    - controller.playChordOnce()
 *    - controller.startNoteLoop()
 *    - controller.startChordLoop()
 *    - controller.stopAll()
 *    - controller.stopLoopOnly()
 *    - controller.onTick(beats, durationSec)
 *    - controller.startRecording/stopRecording/playPattern/clearPattern
 *    - controller setters for UI
 *
 * SMOKE TEST CHECKLIST is at the bottom of this file.
 * ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  /* ==============================
   * 1) CENTRALIZED APP STATE
   * ============================== */
  const AudioContextFunc = window.AudioContext || window.webkitAudioContext;

  const state = {
    debug: false,

    audio: {
      ctx: new AudioContextFunc(),
      instrument: null,
      isReady: false,
      soundfontName: "acoustic_grand_piano",
      soundfontSet: "FluidR3_GM",
      soundfontFormat: "mp3",
      soundfontGain: 0.8
    },

    transport: {
      loopTimerId: null,
      loopMode: "none", // "note" | "chord" | "none"
      isLooping: false
    },

    theory: {
      NOTES: [
        "C3","C#3","D3","D#3","E3","F3","F#3","G3","G#3","A3","A#3","B3",
        "C4","C#4","D4","D#4","E4","F4","F#4","G4","G#4","A4","A#4","B4",
        "C5","C#5","D5","D#5","E5","F5","F#5","G5","G#5","A5","A#5","B5","C6"
      ],
      NOTE_TO_SEMITONE: {
        "C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,
        "F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11
      },
      MODE_INTERVALS: {
        ionian:[0,2,4,5,7,9,11], dorian:[0,2,3,5,7,9,10],
        phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11],
        mixolydian:[0,2,4,5,7,9,10], aeolian:[0,2,3,5,7,8,10],
        locrian:[0,1,3,5,6,8,10], pent_major:[0,2,4,7,9],
        pent_minor:[0,3,5,7,10], chromatic:[0,1,2,3,4,5,6,7,8,9,10,11]
      },
      lowNote: "C4",
      highNote: "C5"
    },

    rhythm: {
      bpm: 90,
      dynamicIntensity: 0.7,
      timingVariationMs: 30,
      humanize: true,
      restProbability: 20,
      durationWeights: {
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
      }
    },

    phrase: {
      // directional
      lastNoteIndex: null,
      lastDirection: 0,
      probContinue: 60,
      probReverse: 25,
      probRepeat: 15,

      // phrase timing
      phraseLengthBeats: 16,
      phraseBeats: 0,
      phrasePendingEnd: false,
      BAR_BEATS: 4,
      beatInBar: 0,

      phraseRestProb: 20,
      phraseResolveProb: 60,

      cadenceQueue: [],

      // interval mixer weights (defaults match HTML)
      intervalWeights: {0:15,1:30,2:30,3:20,4:0,5:10,7:8,9:4,12:2},

      // motif memory
      lastPhraseMemory: null,      // { key, mode, tonicMidi, intervals[], rhythms[] }
      currentPhraseCapture: [],    // [{interval, beats}]
      phraseReplayQueue: []        // [{interval, beats}]
    },

    pattern: {
      patterns: { A: [], B: [], C: [], D: [] },
      activeSlot: "A",
      isRecording: false,
      recordStartCtxTime: 0,
      recordBpm: 90,
      timers: []
    },

    ui: {
      el: {},
      keyEls: new Map(),
      config: { whiteKeyWidth: 60 }
    }
  };

  /* ==============================
   * 2) DOMCache / UIBinder
   * ============================== */
  const DOMCache = (() => {
    function cache() {
      const $ = (id) => document.getElementById(id);
      state.ui.el = {
        status: $("status"),
        playRandom: $("playRandom"),
        playChord: $("playChord"),
        playChordLoop: $("playChordLoop"),
        startLoop: $("startLoop"),
        stopLoop: $("stopLoop"),

        keySelect: $("keySelect"),
        modeSelect: $("modeSelect"),
        whiteKeys: $("whiteKeys"),
        blackKeys: $("blackKeys"),

        tempoSlider: $("tempoSlider"),
        tempoValue: $("tempoValue"),
        velocitySlider: $("velocitySlider"),
        velocityValue: $("velocityValue"),
        humanizeToggle: $("humanizeToggle"),
        timingSlider: $("timingSlider"),
        timingValue: $("timingValue"),
        restSlider: $("restSlider"),
        restValue: $("restValue"),

        startRecord: $("startRecord"),
        stopRecord: $("stopRecord"),
        playPattern: $("playPattern"),
        clearPattern: $("clearPattern"),
        patternInfo: $("patternInfo"),
        patternButtons: document.querySelectorAll(".patternSlot"),

        lowNoteSelect: $("lowNoteSelect"),
        highNoteSelect: $("highNoteSelect"),

        // Melody / Phrase numeric inputs
        numPhraseLen: $("numPhraseLen"),
        numPhraseRest: $("numPhraseRest"),
        numPhraseResolve: $("numPhraseResolve"),
        numProbContinue: $("numProbContinue"),
        numProbReverse: $("numProbReverse"),
        numProbRepeat: $("numProbRepeat"),

        // interval mixer sliders + labels
        w0: $("w0"), v0: $("v0"),
        w2: $("w2"), v2: $("v2"),
        w3: $("w3"), v3: $("v3"),
        w5: $("w5"), v5: $("v5"),
        w7: $("w7"), v7: $("v7"),
        w9: $("w9"), v9: $("v9"),

        // duration sliders + labels
        durWhole: $("durWhole"), valWhole: $("valWhole"),
        durHalf: $("durHalf"), valHalf: $("valHalf"),
        durDottedHalf: $("durDottedHalf"), valDottedHalf: $("valDottedHalf"),
        durQuarter: $("durQuarter"), valQuarter: $("valQuarter"),
        durDottedQuarter: $("durDottedQuarter"), valDottedQuarter: $("valDottedQuarter"),
        durQuarterTriplet: $("durQuarterTriplet"), valQuarterTriplet: $("valQuarterTriplet"),
        durEighth: $("durEighth"), valEighth: $("valEighth"),
        durDottedEighth: $("durDottedEighth"), valDottedEighth: $("valDottedEighth"),
        durEighthTriplet: $("durEighthTriplet"), valEighthTriplet: $("valEighthTriplet"),
        durSixteenth: $("durSixteenth"), valSixteenth: $("valSixteenth"),
        durDottedSixteenth: $("durDottedSixteenth"), valDottedSixteenth: $("valDottedSixteenth"),
        durSixteenthTriplet: $("durSixteenthTriplet"), valSixteenthTriplet: $("valSixteenthTriplet")
      };
    }
    return { cache };
  })();

  const UIBinder = (() => {
    function setStatus(text) {
      if (state.ui.el.status) state.ui.el.status.textContent = text;
    }

    function setLoopButtonsEnabled(isLooping) {
      const el = state.ui.el;
      if (el.playRandom) el.playRandom.disabled = isLooping;
      if (el.playChord) el.playChord.disabled = isLooping;
      if (el.playChordLoop) el.playChordLoop.disabled = isLooping;
      if (el.startLoop) el.startLoop.disabled = isLooping;
      if (el.stopLoop) el.stopLoop.disabled = !isLooping;
    }

    function updatePatternInfo() {
      const el = state.ui.el;
      if (!el.patternInfo) return;
      const len = state.pattern.patterns[state.pattern.activeSlot].length;
      el.patternInfo.textContent =
        `Active Pattern: ${state.pattern.activeSlot} | ${len ? len + " events." : "No events recorded."}`;
    }

    function highlightKey(note) {
      const el = state.ui.keyEls.get(note);
      if (!el) return;
      el.classList.add("active");
      setTimeout(() => el.classList.remove("active"), 250);
    }

    function buildKeyboard(controller) {
      const el = state.ui.el;
      if (!el.whiteKeys || !el.blackKeys) return;

      const NOTES = state.theory.NOTES;
      const whiteKeyWidth = state.ui.config.whiteKeyWidth;

      el.whiteKeys.innerHTML = "";
      el.blackKeys.innerHTML = "";
      state.ui.keyEls.clear();

      const whiteIndexByNote = {};
      let wIndex = 0;

      for (const n of NOTES) {
        if (!n.includes("#")) {
          const k = document.createElement("div");
          k.classList.add("white");
          k.dataset.note = n;
          k.addEventListener("click", () => controller.playManualNote(n));
          el.whiteKeys.appendChild(k);

          state.ui.keyEls.set(n, k);
          whiteIndexByNote[n] = wIndex++;
        }
      }

      function naturalToLeftOfSharp(sharpNote) {
        const m = sharpNote.match(/^([A-G])#(\d)$/);
        if (!m) return null;
        const map = { C: "C", D: "D", F: "F", G: "G", A: "A" };
        return map[m[1]] ? map[m[1]] + m[2] : null;
      }

      const offsetWithinPair = Math.round(whiteKeyWidth * 0.66);
      for (const n of NOTES) {
        if (n.includes("#")) {
          const leftNat = naturalToLeftOfSharp(n);
          const wIdx = leftNat ? whiteIndexByNote[leftNat] : undefined;
          if (wIdx === undefined) continue;

          const k = document.createElement("div");
          k.classList.add("black");
          k.dataset.note = n;
          k.style.left = (wIdx * whiteKeyWidth + offsetWithinPair) + "px";
          k.addEventListener("click", () => controller.playManualNote(n));
          el.blackKeys.appendChild(k);

          state.ui.keyEls.set(n, k);
        }
      }
    }

    function init(controller) {
      const el = state.ui.el;

      // Prime state from current UI values
      if (el.tempoSlider) state.rhythm.bpm = parseInt(el.tempoSlider.value, 10);
      if (el.velocitySlider) state.rhythm.dynamicIntensity = parseFloat(el.velocitySlider.value);
      if (el.timingSlider) state.rhythm.timingVariationMs = parseInt(el.timingSlider.value, 10);
      if (el.humanizeToggle) state.rhythm.humanize = !!el.humanizeToggle.checked;
      if (el.restSlider) state.rhythm.restProbability = parseInt(el.restSlider.value, 10);

      if (el.tempoValue) el.tempoValue.textContent = String(state.rhythm.bpm);
      if (el.velocityValue) el.velocityValue.textContent = Math.round(state.rhythm.dynamicIntensity * 100) + "%";
      if (el.timingValue) el.timingValue.textContent = `${state.rhythm.timingVariationMs} ms`;
      if (el.restValue) el.restValue.textContent = `${state.rhythm.restProbability}%`;

      // Populate range selects
      const NOTES = state.theory.NOTES;
      if (el.lowNoteSelect && el.highNoteSelect) {
        el.lowNoteSelect.innerHTML = "";
        el.highNoteSelect.innerHTML = "";
        for (const note of NOTES) {
          const o1 = document.createElement("option");
          o1.value = note; o1.textContent = note;
          el.lowNoteSelect.appendChild(o1);
          const o2 = document.createElement("option");
          o2.value = note; o2.textContent = note;
          el.highNoteSelect.appendChild(o2);
        }
        el.lowNoteSelect.value = state.theory.lowNote;
        el.highNoteSelect.value = state.theory.highNote;
      }

      buildKeyboard(controller);

      // Buttons: start disabled until audio ready (preserve UX)
      if (el.playRandom) el.playRandom.disabled = true;
      if (el.playChord) el.playChord.disabled = true;
      if (el.playChordLoop) el.playChordLoop.disabled = true;
      if (el.playPattern) el.playPattern.disabled = true;
      if (el.stopLoop) el.stopLoop.disabled = true;

      setLoopButtonsEnabled(false);
      updatePatternInfo();

      // --- Listeners must call controller only ---

      // One-shots
      if (el.playRandom) el.playRandom.addEventListener("click", () => controller.playRandomOnce());
      if (el.playChord) el.playChord.addEventListener("click", () => controller.playChordOnce());

      // Loop controls
      if (el.startLoop) el.startLoop.addEventListener("click", () => controller.startNoteLoop());
      if (el.playChordLoop) el.playChordLoop.addEventListener("click", () => controller.startChordLoop());
      if (el.stopLoop) el.stopLoop.addEventListener("click", () => controller.stopAll());

      // Tempo/dynamics/humanize/rest/timing
      if (el.tempoSlider) el.tempoSlider.addEventListener("input", (e) => {
        const bpm = parseInt(e.target.value, 10);
        if (el.tempoValue) el.tempoValue.textContent = String(bpm);
        controller.setBpm(bpm);
      });

      if (el.velocitySlider) el.velocitySlider.addEventListener("input", (e) => {
        const v = parseFloat(e.target.value);
        if (el.velocityValue) el.velocityValue.textContent = Math.round(v * 100) + "%";
        controller.setDynamicIntensity(v);
      });

      if (el.humanizeToggle) el.humanizeToggle.addEventListener("input", (e) => {
        controller.setHumanize(!!e.target.checked);
      });

      if (el.restSlider) el.restSlider.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        if (el.restValue) el.restValue.textContent = `${v}%`;
        controller.setGlobalRestProbability(v);
      });

      if (el.timingSlider) el.timingSlider.addEventListener("input", (e) => {
        const ms = parseInt(e.target.value, 10);
        if (el.timingValue) el.timingValue.textContent = `${ms} ms`;
        controller.setTimingVariationMs(ms);
      });

      // Range
      if (el.lowNoteSelect) el.lowNoteSelect.addEventListener("change", () => controller.setLowNote(el.lowNoteSelect.value));
      if (el.highNoteSelect) el.highNoteSelect.addEventListener("change", () => controller.setHighNote(el.highNoteSelect.value));

      // Pattern controls
      if (el.startRecord) el.startRecord.addEventListener("click", () => controller.startRecording());
      if (el.stopRecord) el.stopRecord.addEventListener("click", () => controller.stopRecording());
      if (el.playPattern) el.playPattern.addEventListener("click", () => controller.playPattern());
      if (el.clearPattern) el.clearPattern.addEventListener("click", () => controller.clearPattern());

      if (el.patternButtons && el.patternButtons.length) {
        el.patternButtons.forEach((btn) => btn.addEventListener("click", () => controller.setActivePatternSlot(btn.dataset.slot)));
      }

      // Melody/Phrase numeric inputs
      if (el.numPhraseLen) {
        el.numPhraseLen.addEventListener("input", (e) => controller.setPhraseLengthBeats(parseFloat(e.target.value)));
        el.numPhraseRest.addEventListener("input", (e) => controller.setPhraseRestProb(parseInt(e.target.value, 10)));
        el.numPhraseResolve.addEventListener("input", (e) => controller.setPhraseResolveProb(parseInt(e.target.value, 10)));
        el.numProbContinue.addEventListener("input", (e) => controller.setProbContinue(parseInt(e.target.value, 10)));
        el.numProbReverse.addEventListener("input", (e) => controller.setProbReverse(parseInt(e.target.value, 10)));
        el.numProbRepeat.addEventListener("input", (e) => controller.setProbRepeat(parseInt(e.target.value, 10)));
        console.log("🎛 Melody / Phrase number inputs initialized.");
      } else {
        console.log("⚠️ Melody / Phrase inputs not found (skipping UI link).");
      }

      // Interval mixer sliders -> state.phrase.intervalWeights (preserve original mapping)
      const intervalIds = ["0","2","3","5","7","9"];
      intervalIds.forEach((id) => {
        const s = el["w" + id];
        const lbl = el["v" + id];
        if (!s || !lbl) return;
        s.addEventListener("input", (e) => {
          const val = parseInt(e.target.value, 10);
          lbl.textContent = `${val}%`;
          const k = parseInt(id, 10);
          if (k === 9) {
            state.phrase.intervalWeights[9] = val;
            state.phrase.intervalWeights[12] = Math.max(1, Math.round(val / 2));
          } else if (k === 2) {
            state.phrase.intervalWeights[1] = val;
            state.phrase.intervalWeights[2] = val;
          } else {
            state.phrase.intervalWeights[k] = val;
          }
        });
      });

      // Duration sliders -> state.rhythm.durationWeights
      const durationMap = [
        ["whole","durWhole","valWhole"],
        ["half","durHalf","valHalf"],
        ["dotted_half","durDottedHalf","valDottedHalf"],
        ["quarter","durQuarter","valQuarter"],
        ["dotted_quarter","durDottedQuarter","valDottedQuarter"],
        ["quarter_triplet","durQuarterTriplet","valQuarterTriplet"],
        ["eighth","durEighth","valEighth"],
        ["dotted_eighth","durDottedEighth","valDottedEighth"],
        ["eighth_triplet","durEighthTriplet","valEighthTriplet"],
        ["sixteenth","durSixteenth","valSixteenth"],
        ["dotted_sixteenth","durDottedSixteenth","valDottedSixteenth"],
        ["sixteenth_triplet","durSixteenthTriplet","valSixteenthTriplet"]
      ];
      durationMap.forEach(([name, sId, lId]) => {
        const s = el[sId];
        const lbl = el[lId];
        if (!s || !lbl) return;
        s.addEventListener("input", (e) => {
          const v = parseInt(e.target.value, 10);
          state.rhythm.durationWeights[name] = v;
          lbl.textContent = `${v}%`;
        });
      });
    }

    return {
      init,
      buildKeyboard,
      highlightKey,
      setStatus,
      setLoopButtonsEnabled,
      updatePatternInfo
    };
  })();

  /* ==============================
   * 3) AudioEngine
   * ============================== */
  const AudioEngine = (() => {
    function init() {
      return loadInstrument();
    }

    function loadInstrument() {
      const { ctx } = state.audio;
      return Soundfont.instrument(ctx, state.audio.soundfontName, {
        soundfont: state.audio.soundfontSet,
        format: state.audio.soundfontFormat,
        gain: state.audio.soundfontGain
      }).then((inst) => {
        state.audio.instrument = inst;
        state.audio.isReady = true;
      });
    }

    function _calcGain(vel) {
      const minV = 0.5 * state.rhythm.dynamicIntensity;
      const maxV = state.rhythm.dynamicIntensity;
      const varied = Math.random() * (maxV - minV) + minV;
      return vel * varied;
    }

    function playNote(note, vel = 0.7, durationSec = 1.0, offsetSec = 0) {
      if (!state.audio.instrument) return null;
      const gain = _calcGain(vel);
      state.audio.instrument.play(note, state.audio.ctx.currentTime + offsetSec, {
        duration: durationSec,
        gain
      });
      UIBinder.highlightKey(note);
      return gain;
    }

    function playChord(notes, vel = 0.7, durationSec = 1.2) {
      if (!state.audio.instrument) return null;

      const humanize = state.rhythm.humanize;
      const timingVariation = state.rhythm.timingVariationMs;

      notes.forEach((n, j) => {
        let offset = 0;
        if (humanize && timingVariation > 0) {
          const rangeSec = timingVariation / 1000;
          offset = (Math.random() - 0.5) * (2 * rangeSec);
        }
        const gain = _calcGain(vel);
        state.audio.instrument.play(n, state.audio.ctx.currentTime + offset, {
          duration: durationSec + j * 0.05,
          gain
        });
        UIBinder.highlightKey(n);
      });

      return state.rhythm.dynamicIntensity;
    }

    return { init, loadInstrument, playNote, playChord };
  })();

  /* ==============================
   * 4) TheoryEngine
   * ============================== */
  const TheoryEngine = (() => {
    function noteToMidi(note) {
      const m = note.match(/^([A-G])(#?)(\d)$/);
      if (!m) return null;
      const letter = m[1];
      const sharp = m[2] === "#" ? "#" : "";
      const oct = parseInt(m[3], 10);
      const semi = state.theory.NOTE_TO_SEMITONE[letter + sharp];
      if (semi === undefined) return null;
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
        if (d < bestDist) { bestDist = d; best = n; }
      }
      return best;
    }

    function getAllowedMidis(allowed) {
      return allowed.map((n) => ({ n, m: noteToMidi(n) })).filter((x) => x.m !== null);
    }

    function getRangeMidMidi() {
      const lo = noteToMidi(state.theory.lowNote);
      const hi = noteToMidi(state.theory.highNote);
      if (lo === null || hi === null) return 60;
      return Math.round((lo + hi) / 2);
    }

    function getScaleNotes(root, mode) {
      const NOTES = state.theory.NOTES;
      const NOTE_TO_SEMITONE = state.theory.NOTE_TO_SEMITONE;
      const MODE_INTERVALS = state.theory.MODE_INTERVALS;

      root = root.replace("♯", "#").replace("♭", "b").split("/")[0].trim();
      if (!(root in NOTE_TO_SEMITONE)) root = "C";
      const rootOffset = NOTE_TO_SEMITONE[root];
      const intervals = MODE_INTERVALS[mode] || MODE_INTERVALS.ionian;

      return NOTES.filter((n) => {
        const base = n.replace(/[0-9]/g, "");
        const semi = NOTE_TO_SEMITONE[base];
        const rel = (semi - rootOffset + 12) % 12;
        return intervals.includes(rel);
      });
    }

    function filterNotesInRange(notes) {
      const NOTES = state.theory.NOTES;
      const lowIndex = NOTES.indexOf(state.theory.lowNote);
      const highIndex = NOTES.indexOf(state.theory.highNote);
      return notes.filter((n) => {
        const idx = NOTES.indexOf(n);
        return idx >= lowIndex && idx <= highIndex;
      });
    }

    function pickClosestTonicMidi(allowed, root, referenceMidi) {
      const candidates = allowed
        .map((n) => ({ n, m: noteToMidi(n) }))
        .filter((x) => x.m !== null && x.n.startsWith(root));

      if (!candidates.length) {
        const nearest = midiToNearestAllowedNote(referenceMidi, allowed);
        return nearest ? noteToMidi(nearest) : null;
      }

      let best = candidates[0];
      let bestDist = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c.m - referenceMidi);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      return best.m;
    }

    function degreeMidiNear(allowedMidis, targetPc, referenceMidi) {
      let best = null;
      let bestDist = Infinity;
      for (const { m } of allowedMidis) {
        if ((m % 12) !== targetPc) continue;
        const d = Math.abs(m - referenceMidi);
        if (d < bestDist) { bestDist = d; best = m; }
      }
      return best;
    }

    return {
      noteToMidi,
      midiToNearestAllowedNote,
      getAllowedMidis,
      getRangeMidMidi,
      getScaleNotes,
      filterNotesInRange,
      pickClosestTonicMidi,
      degreeMidiNear
    };
  })();

  /* ==============================
   * 5) RhythmEngine
   * ============================== */
  const RhythmEngine = (() => {
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
      return map[name] ?? 1;
    }

    function pickWeightedDurationBeats(weights) {
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      if (!total) return 1;
      const r = Math.random() * total;
      let cum = 0;
      for (const [name, w] of Object.entries(weights)) {
        cum += w;
        if (r < cum) return durationToBeats(name);
      }
      return 1;
    }

    function beatsToMs(beats, bpm) { return (60000 / bpm) * beats; }
    function beatsToSec(beats, bpm) { return (60 / bpm) * beats; }

    return { durationToBeats, pickWeightedDurationBeats, beatsToMs, beatsToSec };
  })();

  /* ==============================
   * 6) PhraseEngine (Generator)
   * ============================== */
  const PhraseEngine = (() => {
    function resetForLoopStart(s) {
      s.phrase.lastNoteIndex = null;
      s.phrase.lastDirection = 0;
      s.phrase.phraseBeats = 0;
      s.phrase.phrasePendingEnd = false;
      s.phrase.beatInBar = 0;
      s.phrase.cadenceQueue = [];
      s.phrase.phraseReplayQueue = [];
      s.phrase.currentPhraseCapture = [];
    }

    function _shouldGlobalRest(s) {
      return Math.random() * 100 < s.rhythm.restProbability;
    }

    function _weightedRandomInterval(weights) {
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      if (!total) return 2;
      const r = Math.random() * total;
      let cum = 0;
      for (const [interval, w] of Object.entries(weights)) {
        cum += w;
        if (r < cum) return parseInt(interval, 10);
      }
      return 2;
    }

    function _pickDirection(s) {
      const r = Math.random() * 100;

      if (r < s.phrase.probContinue) {
        if (s.phrase.lastDirection === 0) return Math.random() < 0.5 ? 1 : -1;
        return s.phrase.lastDirection;
      }

      if (r < s.phrase.probContinue + s.phrase.probReverse) {
        if (s.phrase.lastDirection === 0) return Math.random() < 0.5 ? 1 : -1;
        return -s.phrase.lastDirection;
      }

      const rr = Math.random();
      if (rr < 0.15) return 0;
      return rr < 0.575 ? 1 : -1;
    }

    function _chooseCadenceType() {
      const r = Math.random() * 100;
      if (r < 20) return "tonic";
      if (r < 70) return "authentic";
      if (r < 90) return "plagal";
      return "half";
    }

    function _scheduleCadence(s, allowed, root) {
      const allowedMidis = TheoryEngine.getAllowedMidis(allowed);
      const refMidi =
        (s.phrase.lastNoteIndex !== null && allowed[s.phrase.lastNoteIndex])
          ? TheoryEngine.noteToMidi(allowed[s.phrase.lastNoteIndex])
          : TheoryEngine.getRangeMidMidi();

      const tonicMidi = TheoryEngine.pickClosestTonicMidi(allowed, root, refMidi);
      if (tonicMidi === null) return;

      const tonicPc = tonicMidi % 12;
      const dominantPc = (tonicPc + 7) % 12;
      const subdominantPc = (tonicPc + 5) % 12;

      const type = _chooseCadenceType();
      s.phrase.cadenceQueue = [];

      if (type === "tonic") {
        s.phrase.cadenceQueue.push({ midi: tonicMidi, label: "I" });
        return;
      }

      if (type === "half") {
        const vMidi = TheoryEngine.degreeMidiNear(allowedMidis, dominantPc, refMidi) ?? tonicMidi;
        s.phrase.cadenceQueue.push({ midi: vMidi, label: "V" });
        return;
      }

      if (type === "plagal") {
        const ivMidi = TheoryEngine.degreeMidiNear(allowedMidis, subdominantPc, refMidi) ?? tonicMidi;
        s.phrase.cadenceQueue.push({ midi: ivMidi, label: "IV" });
        s.phrase.cadenceQueue.push({ midi: tonicMidi, label: "I" });
        return;
      }

      const vMidi = TheoryEngine.degreeMidiNear(allowedMidis, dominantPc, refMidi) ?? tonicMidi;
      s.phrase.cadenceQueue.push({ midi: vMidi, label: "V" });
      s.phrase.cadenceQueue.push({ midi: tonicMidi, label: "I" });
    }

    function _commitPhraseMemory(s, allowed, root) {
      if (!s.phrase.currentPhraseCapture.length) return;

      const refMidi = TheoryEngine.getRangeMidMidi();
      const tonicMidi = TheoryEngine.pickClosestTonicMidi(allowed, root, refMidi);
      if (tonicMidi === null) return;

      s.phrase.lastPhraseMemory = {
        key: root,
        mode: s.ui.el.modeSelect ? s.ui.el.modeSelect.value : "ionian",
        tonicMidi,
        intervals: s.phrase.currentPhraseCapture.map((x) => x.interval),
        rhythms: s.phrase.currentPhraseCapture.map((x) => x.beats)
      };
    }

    function _maybeStartPhraseReplay(s) {
      if (!s.phrase.lastPhraseMemory) return false;
      if (Math.random() * 100 >= s.phrase.probRepeat) return false;

      s.phrase.phraseReplayQueue = s.phrase.lastPhraseMemory.intervals.map((interval, i) => ({
        interval,
        beats: s.phrase.lastPhraseMemory.rhythms[i] ?? 1
      }));
      return s.phrase.phraseReplayQueue.length > 0;
    }

    function _advanceBeatCounters(s, beats) {
      s.phrase.beatInBar = (s.phrase.beatInBar + beats) % s.phrase.BAR_BEATS;
    }

    function _captureInterval(s, note, beatsThisEvent, allowed, root) {
      const refMidi = TheoryEngine.getRangeMidMidi();
      const tonicMidi = TheoryEngine.pickClosestTonicMidi(allowed, root, refMidi);
      if (tonicMidi === null) return;
      const mm = TheoryEngine.noteToMidi(note);
      if (mm === null) return;
      s.phrase.currentPhraseCapture.push({ interval: mm - tonicMidi, beats: beatsThisEvent });
    }

    function _nextNoteEvent(s, allowed, root, beatsThisEvent) {
      const isDownbeat = (s.phrase.beatInBar === 0);

      // Cadence queue has priority
      if (s.phrase.cadenceQueue.length) {
        const step = s.phrase.cadenceQueue.shift();
        const note = TheoryEngine.midiToNearestAllowedNote(step.midi, allowed);

        s.phrase.phraseBeats += beatsThisEvent;
        if (s.phrase.phraseBeats >= s.phrase.phraseLengthBeats) s.phrase.phrasePendingEnd = true;
        _advanceBeatCounters(s, beatsThisEvent);

        if (note) {
          _captureInterval(s, note, beatsThisEvent, allowed, root);
          s.phrase.lastNoteIndex = allowed.indexOf(note);
          return { kind: "note", note, beats: beatsThisEvent, meta: { reason: "cadence", label: step.label } };
        }
        return { kind: "rest", beats: beatsThisEvent, reason: "cadence-no-note" };
      }

      // Phrase end only on downbeat
      if (s.phrase.phrasePendingEnd && isDownbeat) {
        const doResolve = (Math.random() * 100 < s.phrase.phraseResolveProb);
        if (doResolve) {
          _scheduleCadence(s, allowed, root);
          if (!s.phrase.cadenceQueue.length) {
            const refMidi =
              (s.phrase.lastNoteIndex !== null && allowed[s.phrase.lastNoteIndex])
                ? TheoryEngine.noteToMidi(allowed[s.phrase.lastNoteIndex])
                : TheoryEngine.getRangeMidMidi();
            const tonicMidi = TheoryEngine.pickClosestTonicMidi(allowed, root, refMidi);
            if (tonicMidi !== null) s.phrase.cadenceQueue.push({ midi: tonicMidi, label: "I" });
          }
        }

        _commitPhraseMemory(s, allowed, root);

        // reset phrase counters for the new phrase
        s.phrase.phrasePendingEnd = false;
        s.phrase.phraseBeats = 0;
        s.phrase.currentPhraseCapture = [];

        const doPhraseRest = (Math.random() * 100 < s.phrase.phraseRestProb);
        const didReplay = _maybeStartPhraseReplay(s);

        if (doPhraseRest) {
          _advanceBeatCounters(s, beatsThisEvent);
          return { kind: "rest", beats: beatsThisEvent, reason: didReplay ? "phrase-rest-next-replay" : "phrase-rest" };
        }

        // If cadence scheduled, start immediately on this downbeat
        if (s.phrase.cadenceQueue.length) {
          return _nextNoteEvent(s, allowed, root, beatsThisEvent);
        }
      }

      // Phrase replay (motif)
      if (s.phrase.phraseReplayQueue.length) {
        const step = s.phrase.phraseReplayQueue.shift();
        const refMidi =
          (s.phrase.lastNoteIndex !== null && allowed[s.phrase.lastNoteIndex])
            ? TheoryEngine.noteToMidi(allowed[s.phrase.lastNoteIndex])
            : TheoryEngine.getRangeMidMidi();

        const tonicMidi = TheoryEngine.pickClosestTonicMidi(allowed, root, refMidi) ?? refMidi;
        const targetMidi = tonicMidi + step.interval;
        const note = TheoryEngine.midiToNearestAllowedNote(targetMidi, allowed);

        s.phrase.phraseBeats += beatsThisEvent;
        if (s.phrase.phraseBeats >= s.phrase.phraseLengthBeats) s.phrase.phrasePendingEnd = true;
        _advanceBeatCounters(s, beatsThisEvent);

        if (note) {
          _captureInterval(s, note, beatsThisEvent, allowed, root);
          s.phrase.lastNoteIndex = allowed.indexOf(note);
          return { kind: "note", note, beats: beatsThisEvent, meta: { reason: "phrase-replay" } };
        }
        return { kind: "rest", beats: beatsThisEvent, reason: "phrase-replay-no-note" };
      }

      // Global rest (inside phrase), but don't block phrase end downbeats
      if (!s.phrase.phrasePendingEnd && _shouldGlobalRest(s)) {
        s.phrase.phraseBeats += beatsThisEvent;
        if (s.phrase.phraseBeats >= s.phrase.phraseLengthBeats) s.phrase.phrasePendingEnd = true;
        _advanceBeatCounters(s, beatsThisEvent);
        return { kind: "rest", beats: beatsThisEvent, reason: "global" };
      }

      // Normal note generation
      let nextNote = null;

      if (s.phrase.lastNoteIndex === null) {
        nextNote = allowed[Math.floor(Math.random() * allowed.length)];
        s.phrase.lastNoteIndex = allowed.indexOf(nextNote);
        s.phrase.lastDirection = 1;
      } else {
        const interval = _weightedRandomInterval(s.phrase.intervalWeights);
        const dir = _pickDirection(s);
        const step = Math.max(0, Math.round(interval / 2));
        let newIndex = s.phrase.lastNoteIndex + dir * step;
        newIndex = Math.max(0, Math.min(newIndex, allowed.length - 1));
        nextNote = allowed[newIndex];
        s.phrase.lastDirection = dir;
        s.phrase.lastNoteIndex = newIndex;
      }

      if (nextNote) _captureInterval(s, nextNote, beatsThisEvent, allowed, root);

      s.phrase.phraseBeats += beatsThisEvent;
      if (s.phrase.phraseBeats >= s.phrase.phraseLengthBeats) s.phrase.phrasePendingEnd = true;
      _advanceBeatCounters(s, beatsThisEvent);

      return nextNote
        ? { kind: "note", note: nextNote, beats: beatsThisEvent, meta: { reason: "normal" } }
        : { kind: "rest", beats: beatsThisEvent, reason: "no-note" };
    }

    function _nextChordEvent(s, beatsThisEvent) {
      const el = s.ui.el;
      const root = el.keySelect ? el.keySelect.value : "C";
      const mode = el.modeSelect ? el.modeSelect.value : "ionian";
      let allowed = TheoryEngine.getScaleNotes(root, mode);
      allowed = TheoryEngine.filterNotesInRange(allowed);
      if (allowed.length < 5) return { kind: "rest", beats: beatsThisEvent, reason: "chord-insufficient-notes" };

      const i = Math.floor(Math.random() * (allowed.length - 4));
      const chord = [allowed[i], allowed[i + 2], allowed[i + 4]].filter(Boolean);
      return { kind: "chord", notes: chord, beats: beatsThisEvent, meta: { reason: "chord-loop" } };
    }

    function nextEvent(s, beatsThisEvent) {
      if (s.transport.loopMode === "chord") return _nextChordEvent(s, beatsThisEvent);

      const el = s.ui.el;
      const root = el.keySelect ? el.keySelect.value : "C";
      const mode = el.modeSelect ? el.modeSelect.value : "ionian";
      let allowed = TheoryEngine.getScaleNotes(root, mode);
      allowed = TheoryEngine.filterNotesInRange(allowed);
      if (!allowed.length) return { kind: "rest", beats: beatsThisEvent, reason: "no-allowed-notes" };

      return _nextNoteEvent(s, allowed, root, beatsThisEvent);
    }

    return { nextEvent, resetForLoopStart };
  })();

  /* ==============================
   * 7) PatternEngine
   * ============================== */
  const PatternEngine = (() => {
    function _clearTimers(s) {
      s.pattern.timers.forEach((id) => clearTimeout(id));
      s.pattern.timers = [];
    }

    function stopPlayback(s) {
      _clearTimers(s);
    }

    function recordEvent(s, evt) {
      if (!s.pattern.isRecording) return;
      const t = s.audio.ctx.currentTime - s.pattern.recordStartCtxTime;
      s.pattern.patterns[s.pattern.activeSlot].push({ ...evt, time: t });
      UIBinder.updatePatternInfo();
    }

    function startRecording(s) {
      stopPlayback(s);
      s.pattern.patterns[s.pattern.activeSlot] = [];
      s.pattern.isRecording = true;
      s.pattern.recordStartCtxTime = s.audio.ctx.currentTime;
      s.pattern.recordBpm = s.rhythm.bpm;

      const el = s.ui.el;
      if (el.startRecord) el.startRecord.disabled = true;
      if (el.stopRecord) el.stopRecord.disabled = false;
      if (el.playPattern) el.playPattern.disabled = true;

      UIBinder.setStatus(`⏺ Recording Pattern ${s.pattern.activeSlot}…`);
      UIBinder.updatePatternInfo();
    }

    function stopRecording(s) {
      if (!s.pattern.isRecording) return;
      s.pattern.isRecording = false;

      const el = s.ui.el;
      if (el.startRecord) el.startRecord.disabled = false;
      if (el.stopRecord) el.stopRecord.disabled = true;

      const len = s.pattern.patterns[s.pattern.activeSlot].length;
      if (el.playPattern) el.playPattern.disabled = (len === 0);

      if (!len) {
        if (el.patternInfo) el.patternInfo.textContent = `Active Pattern: ${s.pattern.activeSlot} | No events recorded.`;
        UIBinder.setStatus("⏹ Recording stopped (empty).");
      } else {
        const dur = s.pattern.patterns[s.pattern.activeSlot][len - 1].time.toFixed(2);
        if (el.patternInfo) {
          el.patternInfo.textContent = `Active Pattern: ${s.pattern.activeSlot} | ${len} events (${dur}s @ ${s.pattern.recordBpm} BPM).`;
        }
        UIBinder.setStatus("✅ Pattern recorded.");
      }
    }

    function clearPattern(s) {
      s.pattern.patterns[s.pattern.activeSlot] = [];
      stopPlayback(s);

      const el = s.ui.el;
      // preserve original odd behavior (Play Pattern stays enabled)
      if (el.playPattern) el.playPattern.disabled = false;
      if (el.patternInfo) el.patternInfo.textContent = `Active Pattern: ${s.pattern.activeSlot} | Cleared.`;
      UIBinder.setStatus(`🗑 Cleared Pattern ${s.pattern.activeSlot}.`);
    }

    function playPattern(s, hooks) {
      const pattern = s.pattern.patterns[s.pattern.activeSlot];
      if (!pattern.length) {
        UIBinder.setStatus(`Pattern ${s.pattern.activeSlot} is empty.`);
        return;
      }

      // Controller policy: pattern playback takes over; stop loop
      hooks.stopLoopOnly();

      stopPlayback(s);

      const scale = s.pattern.recordBpm > 0 ? (s.pattern.recordBpm / s.rhythm.bpm) : 1;
      UIBinder.setStatus(`▶️ Playing Pattern ${s.pattern.activeSlot}…`);

      pattern.forEach((evt) => {
        const delayMs = evt.time * scale * 1000;
        const id = setTimeout(() => hooks.playFromPattern(evt), delayMs);
        s.pattern.timers.push(id);
      });

      const totalMs = pattern[pattern.length - 1].time * scale * 1000;
      const endId = setTimeout(() => {
        UIBinder.setStatus(`⏹ Pattern ${s.pattern.activeSlot} playback done.`);
      }, totalMs + 120);
      s.pattern.timers.push(endId);
    }

    return {
      startRecording,
      stopRecording,
      clearPattern,
      playPattern,
      recordEvent,
      stopPlayback
    };
  })();

  /* ==============================
   * 8) TransportEngine (loop timer owner)
   * ============================== */
  const TransportEngine = (() => {
    function _scheduleNext(s, onTick) {
      const beatsThisEvent = RhythmEngine.pickWeightedDurationBeats(s.rhythm.durationWeights);
      const delayMs = RhythmEngine.beatsToMs(beatsThisEvent, s.rhythm.bpm);
      const durationSec = RhythmEngine.beatsToSec(beatsThisEvent, s.rhythm.bpm) * 0.92;

      onTick(beatsThisEvent, durationSec);

      s.transport.loopTimerId = setTimeout(() => _scheduleNext(s, onTick), delayMs);
    }

    function startLoop(s, onTick) {
      if (s.transport.loopTimerId) return;
      s.transport.isLooping = true;
      _scheduleNext(s, onTick);
    }

    function stopLoop(s) {
      if (s.transport.loopTimerId) {
        clearTimeout(s.transport.loopTimerId);
        s.transport.loopTimerId = null;
      }
      s.transport.isLooping = false;
      s.transport.loopMode = "none";
    }

    function restartLoop(s, onTick) {
      if (!s.transport.loopTimerId) return;
      const mode = s.transport.loopMode;
      stopLoop(s);
      s.transport.loopMode = mode;
      s.transport.isLooping = true;
      _scheduleNext(s, onTick);
    }

    return { startLoop, stopLoop, restartLoop };
  })();

  /* ==============================
   * 9) AppController (single orchestrator)
   * ============================== */
  const AppController = (() => {
    const debugLog = (...args) => { if (state.debug) console.log(...args); };

    function _ensureAudioReady() {
      if (!state.audio.isReady) {
        UIBinder.setStatus("⏳ Loading SoundFont…");
        return false;
      }
      return true;
    }

    function _playEvent(evt, durationSecOverride = null) {
      if (!_ensureAudioReady()) return;

      if (evt.kind === "rest") {
        const r = evt.reason || "";
        if (r === "global") UIBinder.setStatus("🤫 Rest (global)");
        else if (r === "phrase-rest") UIBinder.setStatus("🤫 Phrase rest");
        else if (r === "phrase-rest-next-replay") UIBinder.setStatus("🤫 Phrase rest (next phrase will replay motif)");
        else if (r === "phrase-replay-no-note") UIBinder.setStatus("🔁 Phrase replay (no valid note)");
        else UIBinder.setStatus("🤫 Rest");
        return;
      }

      if (evt.kind === "note") {
        const beats = evt.beats ?? 1;
        const durationSec = durationSecOverride ?? (RhythmEngine.beatsToSec(beats, state.rhythm.bpm) * 0.92);
        const gainUsed = AudioEngine.playNote(evt.note, 0.75, durationSec, 0);

        if (evt.meta?.reason === "cadence") {
          UIBinder.setStatus(`🎵 Cadence: ${evt.meta.label} → ${evt.note}`);
          state.phrase.lastDirection = 0;
        } else if (evt.meta?.reason === "phrase-replay") {
          UIBinder.setStatus(`🔁 Phrase replay: ${evt.note}`);
        } else {
          UIBinder.setStatus(`🎵 Note: ${evt.note}`);
        }

        if (gainUsed !== null) {
          PatternEngine.recordEvent(state, { type: "note", note: evt.note, velocity: gainUsed, duration: durationSec });
        }
        return;
      }

      if (evt.kind === "chord") {
        const beats = evt.beats ?? 2;
        const durationSec = durationSecOverride ?? (RhythmEngine.beatsToSec(beats, state.rhythm.bpm) * 0.95);
        const velUsed = AudioEngine.playChord(evt.notes || [], 0.7, durationSec);

        UIBinder.setStatus(`🎶 Chord: ${(evt.notes || []).join(", ")}`);

        if (velUsed !== null) {
          PatternEngine.recordEvent(state, { type: "chord", notes: evt.notes || [], velocity: velUsed, duration: durationSec });
        }
      }
    }

    function onTick(beatsThisEvent, durationSec) {
      // duration selected exactly once per tick (TransportEngine), passed here
      const evt = PhraseEngine.nextEvent(state, beatsThisEvent);
      debugLog("tick", { beatsThisEvent, durationSec, evt });
      if (evt.kind === "note" || evt.kind === "chord") _playEvent(evt, durationSec);
      else _playEvent(evt, null);
    }

    function stopLoopOnly() {
      TransportEngine.stopLoop(state);
      UIBinder.setLoopButtonsEnabled(false);
    }

    function stopAll() {
      // stop authority: loop + pattern playback timers
      TransportEngine.stopLoop(state);
      PatternEngine.stopPlayback(state);

      UIBinder.setLoopButtonsEnabled(false);

      // restore one-shots availability
      const el = state.ui.el;
      if (el.playRandom) el.playRandom.disabled = false;
      if (el.playChord) el.playChord.disabled = false;
      if (el.playChordLoop) el.playChordLoop.disabled = false;
      if (el.startLoop) el.startLoop.disabled = false;
      if (el.stopLoop) el.stopLoop.disabled = true;

      UIBinder.setStatus("⏹ Stopped loop playback.");
      state.transport.loopMode = "none";
      state.transport.isLooping = false;
    }

    function playRandomOnce() {
      if (!_ensureAudioReady()) return;
      const beats = 1;
      const sec = RhythmEngine.beatsToSec(beats, state.rhythm.bpm) * 0.95;

      const prevMode = state.transport.loopMode;
      state.transport.loopMode = "note";
      const evt = PhraseEngine.nextEvent(state, beats);
      state.transport.loopMode = prevMode;

      if (evt.kind === "note") _playEvent(evt, sec);
      else _playEvent(evt, null);
    }

    function playChordOnce() {
      if (!_ensureAudioReady()) return;
      const beats = 2;
      const sec = RhythmEngine.beatsToSec(beats, state.rhythm.bpm) * 0.95;

      const prevMode = state.transport.loopMode;
      state.transport.loopMode = "chord";
      const evt = PhraseEngine.nextEvent(state, beats);
      state.transport.loopMode = prevMode;

      if (evt.kind === "chord") _playEvent(evt, sec);
      else _playEvent(evt, null);
    }

    function playManualNote(note) {
      if (!_ensureAudioReady()) return;
      const gainUsed = AudioEngine.playNote(note, 0.8, 1.0, 0);
      if (gainUsed !== null) {
        PatternEngine.recordEvent(state, { type: "note", note, velocity: gainUsed, duration: 1.0 });
      }
    }

    function startNoteLoop() {
      if (state.transport.loopTimerId) return;
      PatternEngine.stopPlayback(state);

      state.transport.loopMode = "note";
      PhraseEngine.resetForLoopStart(state);

      UIBinder.setLoopButtonsEnabled(true);
      UIBinder.setStatus("🎵 Note loop running...");

      TransportEngine.startLoop(state, onTick);
    }

    function startChordLoop() {
      if (state.transport.loopTimerId) return;
      PatternEngine.stopPlayback(state);

      state.transport.loopMode = "chord";
      PhraseEngine.resetForLoopStart(state);

      UIBinder.setLoopButtonsEnabled(true);
      UIBinder.setStatus("🎶 Chord loop running...");

      TransportEngine.startLoop(state, onTick);
    }

    // Pattern controls
    function startRecording() { PatternEngine.startRecording(state); }
    function stopRecording() { PatternEngine.stopRecording(state); }
    function clearPattern() { PatternEngine.clearPattern(state); }

    function playPattern() {
      PatternEngine.playPattern(state, {
        stopLoopOnly,
        playFromPattern: (evt) => {
          if (!_ensureAudioReady()) return;
          if (evt.type === "note") {
            AudioEngine.playNote(evt.note, 0.7, evt.duration ?? 1.0, 0);
          } else if (evt.type === "chord") {
            AudioEngine.playChord(evt.notes || [], 0.7, evt.duration ?? 1.0);
          }
        }
      });
    }

    function setActivePatternSlot(slot) {
      // stop recording + playback when switching slot (preserve safety)
      PatternEngine.stopRecording(state);
      PatternEngine.stopPlayback(state);

      const btns = state.ui.el.patternButtons;
      if (btns && btns.length) {
        btns.forEach((b) => b.classList.remove("active"));
        const match = Array.from(btns).find((b) => b.dataset.slot === slot);
        if (match) match.classList.add("active");
      }

      state.pattern.activeSlot = slot;
      UIBinder.updatePatternInfo();

      // update playPattern enabled state like original: enable if any events exist
      const len = state.pattern.patterns[slot].length;
      if (state.ui.el.playPattern) state.ui.el.playPattern.disabled = (len === 0);
    }

    // Setters (UI -> controller only)
    function setBpm(bpm) {
      state.rhythm.bpm = bpm;

      // Correctness requirement: loop timing stable and restart on BPM change
      if (state.transport.loopTimerId) {
        const mode = state.transport.loopMode;
        TransportEngine.stopLoop(state);
        state.transport.loopMode = mode;
        PhraseEngine.resetForLoopStart(state);
        TransportEngine.startLoop(state, onTick);
      }
    }

    function setDynamicIntensity(x) { state.rhythm.dynamicIntensity = x; }
    function setTimingVariationMs(ms) { state.rhythm.timingVariationMs = ms; }
    function setHumanize(flag) { state.rhythm.humanize = flag; }
    function setGlobalRestProbability(pct) { state.rhythm.restProbability = pct; }
    function setLowNote(note) { state.theory.lowNote = note; }
    function setHighNote(note) { state.theory.highNote = note; }

    function setPhraseLengthBeats(v) { state.phrase.phraseLengthBeats = Number.isFinite(v) ? v : 16; }
    function setPhraseRestProb(v) { state.phrase.phraseRestProb = v; }
    function setPhraseResolveProb(v) { state.phrase.phraseResolveProb = v; }
    function setProbContinue(v) { state.phrase.probContinue = v; }
    function setProbReverse(v) { state.phrase.probReverse = v; }
    function setProbRepeat(v) { state.phrase.probRepeat = v; }

    function init() {
      DOMCache.cache();
      UIBinder.init(publicApi);

      AudioEngine.init()
        .then(() => {
          UIBinder.setStatus("✅ Piano SoundFont loaded!");

          // enable buttons
          const el = state.ui.el;
          if (el.playRandom) el.playRandom.disabled = false;
          if (el.playChord) el.playChord.disabled = false;
          if (el.playChordLoop) el.playChordLoop.disabled = false;

          // allow play pattern button even if empty (but original UX is ambiguous; keep enabled now that loaded)
          if (el.playPattern) el.playPattern.disabled = false;
        })
        .catch((err) => {
          console.error(err);
          UIBinder.setStatus("❌ Error loading SoundFont.");
        });
    }

    const publicApi = {
      init,

      // manual
      playManualNote,
      playRandomOnce,
      playChordOnce,

      // loop
      startNoteLoop,
      startChordLoop,
      stopAll,
      stopLoopOnly,

      // pattern
      startRecording,
      stopRecording,
      playPattern,
      clearPattern,
      setActivePatternSlot,

      // setters
      setBpm,
      setDynamicIntensity,
      setTimingVariationMs,
      setHumanize,
      setGlobalRestProbability,
      setLowNote,
      setHighNote,

      setPhraseLengthBeats,
      setPhraseRestProb,
      setPhraseResolveProb,
      setProbContinue,
      setProbReverse,
      setProbRepeat
    };

    return publicApi;
  })();

  // Boot
  AppController.init();

  /* ====================================================================== *
   * SMOKE TEST CHECKLIST (run in this order)
   *
   * A) Boot / Load
   * - Load the page fresh.
   * - Expect: status shows SoundFont loaded (or similar ready message).
   * - Expect: Play buttons enabled.
   * - Open DevTools console.
   * - Expect: no errors on load.
   *
   * B) Basic playback (manual triggers)
   * - Click a few white/black keys.
   *   Expect: each key plays a note and highlights.
   * - Click Play Random (single shot).
   *   Expect: one note plays (or rest if global rest is allowed), and status updates.
   * - Click Play Chord (single shot).
   *   Expect: chord sounds, status updates.
   *
   * C) Loop timing and stop authority
   * - Click Note Loop.
   *   Expect: notes/rests begin at steady tempo.
   * - Click Stop.
   *   Expect: loop stops immediately (within one tick); no continuing notes scheduled.
   * - Click Note Loop again.
   *   Expect: loop restarts cleanly (no double-timer “speed up” effect).
   *
   * D) BPM change / restart behavior
   * - Start loop, then change BPM slider while looping.
   *   Expect: timing changes promptly and smoothly (restart ok).
   *   Expect: no console errors.
   * - Stop.
   *   Expect: stop still works (no stuck timers).
   *
   * E) Duration coherence (no double selection)
   * - Set 100% quarter, 0% others. Start note loop.
   *   Expect: evenly spaced quarter-note timing.
   * - Switch to 100% eighth (or sixteenth). Start loop.
   *   Expect: clearly faster tick rate.
   * - Confirm: note duration feels tied to tick length (not mismatched overlap).
   *
   * F) Phrase boundary integrity
   * - Set Phrase Length to 4 beats. Start loop.
   *   Expect: phrase endings align to downbeat (barline), not mid-bar.
   *   Expect: resolve/cadence events happen on downbeat boundary.
   *
   * G) Rest logic separation
   * - Set global rest high (~70%), phrase rest high (~70%).
   *   Expect: global rests inside phrases; phrase rests at boundaries.
   * - Set global rest 0%, phrase rest high.
   *   Expect: phrases play normally but pause between phrases.
   *
   * H) Phrase repetition (memory)
   * - Set Repeat% high (~80%).
   *   Expect: audible repetition of prior phrase contour/motif.
   * - Stop, restart.
   *   Expect: no crash; repetition remains consistent.
   *
   * I) Pattern recording / playback
   * - Click Record, play a few notes (keyboard or Play One Note), then Stop Rec.
   *   Expect: pattern info event count > 0.
   * - Click Play Pattern.
   *   Expect: recorded sequence plays back with roughly correct timing.
   * - Click Stop.
   *   Expect: stops pattern playback too (no runaway timers).
   * - Click Clear.
   *   Expect: slot clears.
   *
   * J) Mode switching safety
   * - While a pattern is playing, start a note loop.
   *   Expect: pattern playback stops cleanly and loop takes over.
   * - Start chord loop, stop, start note loop.
   *   Expect: no timer stacking, no “double speed”.
   *
   * K) Final stability check
   * - Start loop → change BPM → stop → record pattern → play → stop → start loop again.
   *   Expect: all works, no console errors.
   *
   * If this fails, where to look
   * - Double speed: two timers active; ensure TransportEngine.stopLoop clears loopTimerId before restart.
   * - Pattern won’t stop: PatternEngine.stopPlayback not called by controller stopAll().
   * - UI sliders inert: listeners must call controller setters (only).
   * - Notes play but no record: controller must call PatternEngine.recordEvent on actual playback.
   * - Phrase ends mid-bar: phrase end logic must only trigger on downbeat.
   * ====================================================================== */
});
