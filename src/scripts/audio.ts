// Procedural, synth-only sound design (no audio assets) — every effect and
// the whole music bed is generated at runtime with the Web Audio API, kept
// entirely out of game.ts/render.ts so game logic and drawing stay pure.
// main.ts is the only caller: it unlocks audio on the first user gesture and
// calls into this module when state transitions happen.

const ARPEGGIO_SCALE = [220.0, 261.63, 293.66, 329.63, 392.0]; // A minor pentatonic
const ARPEGGIO_PATTERN = [0, 2, 1, 3, 2, 4, 3, 1];
const MUSIC_BASE_INTERVAL = 0.85; // seconds between notes at the start of a run
const MUSIC_MIN_INTERVAL = 0.32; // seconds between notes once fully ramped up
const MUSIC_RAMP_SECONDS = 90; // how long it takes to reach the fastest tempo
const SCHEDULE_AHEAD = 0.2; // seconds of lookahead per tick

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
  let nextNoteTime = 0;
  let patternIndex = 0;
  let droneStarted = false;

  function ensureCtx(): AudioContext {
    if (ctx) return ctx;
    ctx = new AudioContext();

    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.4;
    musicBus.connect(master);

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

  function startDrone() {
    if (droneStarted) return;
    droneStarted = true;
    const audio = ensureCtx();

    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 400;
    filter.connect(musicBus);

    const lfo = audio.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = audio.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    for (const detune of [-4, 4]) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 55;
      osc.detune.value = detune;
      const gain = audio.createGain();
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
    }
  }

  function playArpeggioNote(interval: number) {
    const step = ARPEGGIO_PATTERN[patternIndex % ARPEGGIO_PATTERN.length];
    patternIndex++;
    const freq = ARPEGGIO_SCALE[step];
    const audio = ensureCtx();
    const t0 = nextNoteTime;

    const osc = audio.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const filter = audio.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + interval * 0.85);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(musicBus);

    const send = audio.createGain();
    send.gain.value = 0.3;
    gain.connect(send);
    sendToDelay(send);

    osc.start(t0);
    osc.stop(t0 + interval);
  }

  return {
    unlock() {
      const audio = ensureCtx();
      if (audio.state === "suspended") audio.resume();
      startDrone();
      if (nextNoteTime === 0) nextNoteTime = audio.currentTime + 0.1;
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
      if (!ctx || nextNoteTime === 0) return;
      const rampT = Math.min(1, Math.max(0, runElapsed / MUSIC_RAMP_SECONDS));
      const interval = MUSIC_BASE_INTERVAL + (MUSIC_MIN_INTERVAL - MUSIC_BASE_INTERVAL) * rampT;
      while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        playArpeggioNote(interval);
        nextNoteTime += interval;
      }
    },
  };
}
