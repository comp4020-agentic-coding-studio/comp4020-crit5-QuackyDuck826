// Procedural, synth-only sound design (no audio assets) — every effect and
// the whole music bed is generated at runtime with the Web Audio API, kept
// entirely out of game.ts/render.ts so game logic and drawing stay pure.
// main.ts is the only caller: it unlocks audio on the first user gesture and
// calls into this module when state transitions happen.

// A simple, four-chord loop (i–VI–III–VII in A minor) held as soft sine
// pads — plain and pleasant rather than busy, per feedback that the old
// arpeggio/bitcrush bed sounded broken.
const CHORDS = [
  [220.0, 261.63, 329.63], // A minor
  [174.61, 220.0, 261.63], // F major
  [261.63, 329.63, 392.0], // C major
  [196.0, 246.94, 293.66], // G major
];
const MUSIC_CHORD_BASE_DURATION = 3.2; // seconds per chord at the start of a run
const MUSIC_CHORD_MIN_DURATION = 1.8; // seconds per chord once fully ramped up
const MUSIC_RAMP_SECONDS = 90; // how long it takes to reach the fastest tempo
const SCHEDULE_AHEAD = 0.3; // seconds of lookahead per tick

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface AudioEngine {
  unlock(): void;
  directionChange(direction: 1 | -1): void;
  nearMiss(): void;
  closeCall(): void;
  death(): void;
  obstacleBorn(): void;
  obstacleDied(): void;
  tickMusic(runElapsed: number): void;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let musicBus: GainNode;
  let sfxBus: GainNode;
  let delayIn: DelayNode;
  let nextChordTime = 0;
  let chordIndex = 0;

  function ensureCtx(): AudioContext {
    if (ctx) return ctx;
    ctx = new AudioContext();

    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);

    // A gentle, fixed lowpass keeps the chord pads warm and soft — no
    // resonance sweeps or distortion, just a plain, clean bed.
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = "lowpass";
    musicFilter.frequency.value = 1400;
    musicFilter.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.55;
    musicBus.connect(musicFilter);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);

    // A shared feedback delay is the one "spacey" effect every sound is
    // routed through a little, so the whole mix feels like it's echoing
    // across open space rather than each sound feeling dry/isolated.
    delayIn = ctx.createDelay(1);
    delayIn.delayTime.value = 0.28;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.25;
    delayIn.connect(feedback);
    feedback.connect(delayIn);
    delayIn.connect(delayWet);
    delayWet.connect(master);

    return ctx;
  }

  function sendToDelay(node: AudioNode) {
    node.connect(delayIn);
  }

  function playTone(
    bus: GainNode,
    opts: {
      freqFrom: number;
      freqTo?: number;
      duration: number;
      peakGain: number;
      type?: OscillatorType;
      delaySend?: number;
    },
  ) {
    const audio = ensureCtx();
    const t0 = audio.currentTime;
    const osc = audio.createOscillator();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(opts.freqFrom, t0);
    if (opts.freqTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t0 + opts.duration);
    }

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(opts.peakGain, t0 + Math.min(0.015, opts.duration * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);

    osc.connect(gain);
    gain.connect(bus);
    if (opts.delaySend) {
      const send = audio.createGain();
      send.gain.value = opts.delaySend;
      gain.connect(send);
      sendToDelay(send);
    }

    osc.start(t0);
    osc.stop(t0 + opts.duration + 0.02);
  }

  function noiseBurst(bus: GainNode, duration: number, peakGain: number) {
    const audio = ensureCtx();
    const t0 = audio.currentTime;
    const sampleCount = Math.floor(audio.sampleRate * duration);
    const buffer = audio.createBuffer(1, sampleCount, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;

    const source = audio.createBufferSource();
    source.buffer = buffer;

    const filter = audio.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(900, t0);
    filter.frequency.exponentialRampToValueAtTime(120, t0 + duration);

    const gain = audio.createGain();
    gain.gain.setValueAtTime(peakGain, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);

    source.start(t0);
    source.stop(t0 + duration + 0.02);
  }

  function playChord(t0: number, duration: number) {
    const audio = ensureCtx();
    const chord = CHORDS[chordIndex % CHORDS.length];
    chordIndex++;

    const attack = Math.min(0.6, duration * 0.25);
    const release = Math.min(0.9, duration * 0.35);

    for (const freq of chord) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = audio.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.07, t0 + attack);
      gain.gain.setValueAtTime(0.07, t0 + duration - release);
      gain.gain.linearRampToValueAtTime(0, t0 + duration);

      osc.connect(gain);
      gain.connect(musicBus);

      const send = audio.createGain();
      send.gain.value = 0.18;
      gain.connect(send);
      sendToDelay(send);

      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
    }
  }

  return {
    unlock() {
      const audio = ensureCtx();
      if (audio.state === "suspended") audio.resume();
      if (nextChordTime === 0) nextChordTime = audio.currentTime + 0.15;
    },

    directionChange(direction) {
      playTone(sfxBus, {
        freqFrom: direction === 1 ? 500 : 900,
        freqTo: direction === 1 ? 900 : 500,
        duration: 0.14,
        peakGain: 0.16,
        type: "triangle",
        delaySend: 0.2,
      });
    },

    nearMiss() {
      playTone(sfxBus, {
        freqFrom: 700,
        freqTo: 1050,
        duration: 0.16,
        peakGain: 0.2,
        type: "sine",
        delaySend: 0.3,
      });
      playTone(sfxBus, {
        freqFrom: 1400,
        freqTo: 2000,
        duration: 0.12,
        peakGain: 0.08,
        type: "sine",
        delaySend: 0.2,
      });
    },

    closeCall() {
      playTone(sfxBus, { freqFrom: 600, duration: 0.1, peakGain: 0.18, type: "triangle", delaySend: 0.25 });
      playTone(sfxBus, { freqFrom: 750, duration: 0.14, peakGain: 0.16, type: "triangle", delaySend: 0.25 });
    },

    death() {
      playTone(sfxBus, {
        freqFrom: 320,
        freqTo: 55,
        duration: 0.6,
        peakGain: 0.3,
        type: "sawtooth",
        delaySend: 0.3,
      });
      playTone(sfxBus, {
        freqFrom: 300,
        freqTo: 50,
        duration: 0.6,
        peakGain: 0.22,
        type: "square",
        delaySend: 0.3,
      });
      noiseBurst(sfxBus, 0.35, 0.22);
    },

    obstacleBorn() {
      playTone(sfxBus, { freqFrom: 900, duration: 0.05, peakGain: 0.05, type: "sine" });
    },

    obstacleDied() {
      playTone(sfxBus, { freqFrom: 500, freqTo: 350, duration: 0.06, peakGain: 0.045, type: "sine" });
    },

    tickMusic(runElapsed) {
      if (!ctx || nextChordTime === 0) return;
      const rampT = Math.min(1, Math.max(0, runElapsed / MUSIC_RAMP_SECONDS));
      const duration = lerp(MUSIC_CHORD_BASE_DURATION, MUSIC_CHORD_MIN_DURATION, rampT);

      while (nextChordTime < ctx.currentTime + SCHEDULE_AHEAD) {
        playChord(nextChordTime, duration);
        nextChordTime += duration;
      }
    },
  };
}
