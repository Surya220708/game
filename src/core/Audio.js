// ---------------------------------------------------------------------------
// Weapon / world audio, synthesised entirely with the Web Audio API.
// No sample files: every gunshot, footstep and explosion is built from
// noise bursts, filtered sweeps and short tonal transients at runtime.
// ---------------------------------------------------------------------------

import { clamp } from './Utils.js';

const MAX_VOICES = 44;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.75;
    this.voices = 0;
    this.listener = null; // THREE.Camera
    this._v = { x: 0, y: 0, z: 0 };
    this._fwd = { x: 0, y: 0, z: -1 };
    this._right = { x: 1, y: 0, z: 0 };
    this._lastStepAt = 0;
    this._heartTimer = null;
  }

  /** Must be called from a user gesture (click/tap/keydown). */
  init() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (e) {
      return false;
    }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.16;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);

    // A touch of shared "outdoor" reverb so distant shots tail off nicely.
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(1.6, 2.6);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.25;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.3;
    this.verbSend.connect(this.verb);

    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 1;
    this.ambGain.connect(this.master);

    this.noiseBuf = this._noiseBuffer(2.5, 'white');
    this.brownBuf = this._noiseBuffer(6, 'brown');
    this.ready = true;
    this.startAmbience();
    return true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _noiseBuffer(seconds, type) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (type === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // sparse early reflections then a smooth tail
        const env = Math.pow(1 - t, decay);
        d[i] = (Math.random() * 2 - 1) * env * (i < len * 0.02 ? 1.4 : 1);
      }
    }
    return buf;
  }

  updateListener(camera) {
    if (!camera) return;
    this.listener = camera;
    // Read straight from the world matrix (no THREE dependency in this file).
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this._v.x = e[12];
    this._v.y = e[13];
    this._v.z = e[14];
    this._right = { x: e[0], y: e[1], z: e[2] };
    this._fwd = { x: -e[8], y: -e[9], z: -e[10] };
  }

  /** Spatialises a sound relative to the camera: returns {gain, pan, muffling}. */
  _spatial(pos) {
    if (!pos || !this.listener) return { gain: 1, pan: 0, muffle: 1 };
    const dx = pos.x - this._v.x;
    const dy = pos.y - this._v.y;
    const dz = pos.z - this._v.z;
    const dist = Math.hypot(dx, dy, dz) || 0.0001;
    const inv = 1 / dist;
    const pan = clamp(
      (dx * this._right.x + dy * this._right.y + dz * this._right.z) * inv,
      -1,
      1
    );
    const front = (dx * this._fwd.x + dy * this._fwd.y + dz * this._fwd.z) * inv;
    // Slightly quieter behind the player, like a real head shadow.
    const behind = front < 0 ? 0.78 : 1;
    const gain = (1 / (1 + dist * dist * 0.0055)) * behind;
    const muffle = clamp(1 - dist / 90, 0.3, 1);
    return { gain, pan, muffle, dist };
  }

  _budget() {
    if (this.voices > MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
    }, 320);
    return true;
  }

  // -- primitives ------------------------------------------------------------

  /** Filtered noise burst. */
  burst({
    t = 0,
    dur = 0.15,
    vol = 0.5,
    attack = 0.001,
    type = 'lowpass',
    from = 4000,
    to = 200,
    q = 1,
    pan = 0,
    rate = 1,
    buffer = null,
    dest = null,
    send = 0.2,
  } = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = buffer || this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = rate;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(Math.max(40, from), now);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, to), now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(vol, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let node = src;
    node.connect(filt);
    node = filt;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node.connect(p);
      node = p;
    }
    node.connect(g);
    g.connect(dest || this.sfx);
    if (send > 0 && this.verbSend) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.verbSend);
    }
    const offset = Math.random() * (src.buffer.duration - 0.01);
    src.start(now, offset);
    src.stop(now + dur + 0.05);
  }

  /** Tonal transient with pitch sweep. */
  tone({
    t = 0,
    dur = 0.12,
    vol = 0.25,
    attack = 0.002,
    type = 'sine',
    from = 440,
    to = 80,
    pan = 0,
    dest = null,
    send = 0.15,
    delay = 0,
  } = {}) {
    const ctx = this.ctx;
    const now = ctx.currentTime + t + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(vol, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let node = osc;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node.connect(p);
      node = p;
    }
    node.connect(g);
    g.connect(dest || this.sfx);
    if (send > 0 && this.verbSend) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.verbSend);
    }
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  // -- game sounds -----------------------------------------------------------

  /** Player weapon report. `kind` colours the character of the weapon. */
  gunshot(pos, kind = 'rifle', firstPerson = false) {
    if (!this.ready || !this._budget()) return;
    const sp = firstPerson ? { gain: 1, pan: 0, muffle: 1 } : this._spatial(pos);
    if (sp.gain < 0.012) return;
    const v = sp.gain * (firstPerson ? 0.85 : 0.6);
    const m = sp.muffle;
    const cfg = {
      rifle: { body: [230, 55], bodyVol: 0.5, top: 6200, tail: 0.42 },
      smg: { body: [280, 70], bodyVol: 0.42, top: 7000, tail: 0.3 },
      sniper: { body: [190, 42], bodyVol: 0.62, top: 5200, tail: 0.75 },
      pistol: { body: [320, 90], bodyVol: 0.38, top: 6600, tail: 0.26 },
      enemy: { body: [175, 50], bodyVol: 0.4, top: 3200, tail: 0.6 },
    }[kind] || { body: [220, 60], bodyVol: 0.45, top: 6000, tail: 0.4 };

    this.burst({
      dur: 0.13,
      vol: v,
      attack: 0.0008,
      type: 'lowpass',
      from: cfg.top * m,
      to: 300 * m,
      q: 0.9,
      pan: sp.pan,
      send: 0.3,
    });
    this.burst({ dur: 0.035, vol: v * 0.55, attack: 0.0004, type: 'highpass', from: 2600 * m, to: 1500, q: 0.7, pan: sp.pan, send: 0.1 });
    this.burst({ dur: 0.34, vol: v * cfg.tail * 0.35, attack: 0.004, type: 'lowpass', from: 680 * m, to: 170, q: 0.7, pan: sp.pan, send: 0.55, t: 0.02 });
    this.tone({ dur: 0.14, vol: v * cfg.bodyVol, type: 'sine', from: cfg.body[0], to: cfg.body[1], pan: sp.pan });
    // mechanical action cycling
    this.burst({ dur: 0.05, vol: v * 0.12, type: 'bandpass', from: 1900, to: 1200, q: 3, pan: sp.pan, t: 0.055, send: 0 });
  }

  dryFire() {
    if (!this.ready || !this._budget()) return;
    this.burst({ dur: 0.03, vol: 0.2, attack: 0.0005, type: 'bandpass', from: 2800, to: 1800, q: 4, send: 0 });
    this.tone({ dur: 0.03, vol: 0.06, type: 'square', from: 900, to: 500, send: 0 });
  }

  reload(stage) {
    if (!this.ready || !this._budget()) return;
    switch (stage) {
      case 'magout':
        this.burst({ dur: 0.07, vol: 0.16, type: 'bandpass', from: 1100, to: 700, q: 5, send: 0.1 });
        this.tone({ dur: 0.05, vol: 0.05, type: 'triangle', from: 220, to: 140, send: 0 });
        break;
      case 'magin':
        this.burst({ dur: 0.1, vol: 0.24, type: 'bandpass', from: 1500, to: 900, q: 4, send: 0.12 });
        this.tone({ dur: 0.07, vol: 0.09, type: 'square', from: 260, to: 150, send: 0 });
        break;
      case 'bolt':
        this.burst({ dur: 0.07, vol: 0.24, type: 'highpass', from: 2800, to: 1400, q: 1.4, send: 0.14 });
        this.tone({ dur: 0.05, vol: 0.07, type: 'square', from: 420, to: 220, send: 0 });
        break;
      default:
        this.burst({ dur: 0.05, vol: 0.14, type: 'bandpass', from: 1700, to: 1000, q: 4, send: 0 });
    }
  }

  hitmarker(headshot = false) {
    if (!this.ready) return;
    this.tone({ dur: 0.05, vol: 0.13, type: 'sine', from: headshot ? 1900 : 1350, to: headshot ? 1500 : 1100, send: 0 });
    this.burst({ dur: 0.02, vol: 0.1, type: 'highpass', from: 3000, to: 2000, q: 1, send: 0 });
  }

  fleshHit(pos) {
    if (!this.ready || !this._budget()) return;
    const sp = this._spatial(pos);
    if (sp.gain < 0.02) return;
    this.burst({ dur: 0.08, vol: sp.gain * 0.36, type: 'lowpass', from: 900 * sp.muffle, to: 160, q: 1.2, pan: sp.pan, send: 0.08 });
    this.tone({ dur: 0.07, vol: sp.gain * 0.14, type: 'triangle', from: 150, to: 60, pan: sp.pan, send: 0 });
  }

  ricochet(pos) {
    if (!this.ready || !this._budget()) return;
    const sp = this._spatial(pos);
    if (sp.gain < 0.02) return;
    const f = 1800 + Math.random() * 1600;
    this.tone({ dur: 0.16, vol: sp.gain * 0.13, type: 'sine', from: f, to: f * 0.35, pan: sp.pan, send: 0.5 });
    this.burst({ dur: 0.05, vol: sp.gain * 0.12, type: 'bandpass', from: 2400, to: 900, q: 2, pan: sp.pan, send: 0.3 });
  }

  bulletWhiz(pos) {
    if (!this.ready || !this._budget()) return;
    const sp = this._spatial(pos);
    if (sp.gain < 0.05) return;
    const f = 1500 + Math.random() * 900;
    this.tone({ dur: 0.09, vol: sp.gain * 0.17, type: 'sine', from: f, to: f * 0.45, pan: sp.pan, send: 0.4, attack: 0.001 });
  }

  explosion(pos) {
    if (!this.ready || !this._budget()) return;
    const sp = this._spatial(pos);
    const v = Math.max(0.25, sp.gain);
    this.burst({ dur: 0.9, vol: v * 0.95, attack: 0.002, type: 'lowpass', from: 1500 * sp.muffle + 200, to: 50, q: 0.7, pan: sp.pan, send: 0.7 });
    this.tone({ dur: 0.7, vol: v * 0.7, type: 'sine', from: 110, to: 26, pan: sp.pan, send: 0.3 });
    this.tone({ dur: 0.35, vol: v * 0.25, type: 'sawtooth', from: 70, to: 30, pan: sp.pan, send: 0.4 });
    this.burst({ dur: 1.5, vol: v * 0.3, attack: 0.05, type: 'lowpass', from: 320, to: 90, q: 0.6, pan: sp.pan, t: 0.08, send: 0.8 });
    // debris patter
    for (let i = 0; i < 6; i++) {
      this.burst({ dur: 0.05, vol: v * 0.1, type: 'bandpass', from: 1400 + Math.random() * 2200, to: 600, q: 3, pan: sp.pan, t: 0.12 + Math.random() * 0.7, send: 0.4 });
    }
  }

  grenadeBounce(pos) {
    if (!this.ready || !this._budget()) return;
    const sp = this._spatial(pos);
    if (sp.gain < 0.03) return;
    this.tone({ dur: 0.07, vol: sp.gain * 0.12, type: 'triangle', from: 680, to: 240, pan: sp.pan, send: 0.3 });
    this.burst({ dur: 0.05, vol: sp.gain * 0.1, type: 'bandpass', from: 2200, to: 900, q: 2.5, pan: sp.pan, send: 0.3 });
  }

  footstep(surface = 'dirt', volume = 1) {
    if (!this.ready) return;
    const cfg = {
      dirt: [520, 0.5],
      concrete: [1400, 0.42],
      metal: [2300, 0.34],
      sand: [380, 0.55],
      wood: [900, 0.45],
    }[surface] || [600, 0.5];
    const f = cfg[0] * (0.8 + Math.random() * 0.45);
    this.burst({ dur: 0.075, vol: 0.13 * volume * cfg[1] * 2, type: 'bandpass', from: f, to: f * 0.5, q: 1.1, pan: (Math.random() - 0.5) * 0.3, rate: 0.85 + Math.random() * 0.3, send: 0.12 });
  }

  land(force = 1) {
    if (!this.ready) return;
    this.burst({ dur: 0.16, vol: 0.2 * force, type: 'lowpass', from: 700, to: 120, q: 1, send: 0.2 });
    this.tone({ dur: 0.1, vol: 0.12 * force, type: 'triangle', from: 160, to: 60, send: 0.1 });
  }

  playerHurt(severity = 1) {
    if (!this.ready || !this._budget()) return;
    this.burst({ dur: 0.3 * severity, vol: clamp(0.34 * severity, 0.1, 0.6), attack: 0.004, type: 'lowpass', from: 1100, to: 180, q: 1.2, send: 0.25 });
    this.tone({ dur: 0.22, vol: 0.14 * severity, type: 'sawtooth', from: 150, to: 88, send: 0.1 });
    // ringing after heavy hits
    if (severity > 0.75) this.tone({ dur: 1.6, vol: 0.05, attack: 0.02, type: 'sine', from: 3100, to: 2900, send: 0.3 });
  }

  death() {
    if (!this.ready) return;
    this.tone({ dur: 1.4, vol: 0.24, attack: 0.01, type: 'sawtooth', from: 180, to: 42, send: 0.5 });
    this.burst({ dur: 1.6, vol: 0.26, attack: 0.01, type: 'lowpass', from: 900, to: 120, q: 1, send: 0.6 });
  }

  uiClick(high = false) {
    if (!this.ready) return;
    this.tone({ dur: 0.03, vol: 0.055, type: 'square', from: high ? 1500 : 950, to: high ? 1200 : 700, send: 0 });
  }

  waveAlarm() {
    if (!this.ready) return;
    for (let i = 0; i < 2; i++) {
      this.tone({ dur: 0.32, vol: 0.11, attack: 0.02, type: 'square', from: 700, to: 690, delay: i * 0.42, send: 0.3 });
      this.tone({ dur: 0.32, vol: 0.09, attack: 0.02, type: 'square', from: 520, to: 515, delay: i * 0.42 + 0.17, send: 0.3 });
    }
    this.burst({ dur: 0.22, vol: 0.07, type: 'bandpass', from: 1500, to: 900, q: 1.4, send: 0.2 });
  }

  pickup() {
    if (!this.ready) return;
    this.tone({ dur: 0.1, vol: 0.1, type: 'sine', from: 620, to: 1180, send: 0.2 });
    this.tone({ dur: 0.14, vol: 0.07, type: 'triangle', from: 930, to: 1500, delay: 0.07, send: 0.2 });
  }

  /** Heartbeat loop used when the player is critically wounded. */
  setHeartbeat(on, bpm = 96) {
    if (!this.ready) return;
    if (on && !this._heartTimer) {
      const beat = () => {
        this.tone({ dur: 0.16, vol: 0.16, type: 'sine', from: 72, to: 40, send: 0.05, attack: 0.006 });
        this.tone({ dur: 0.12, vol: 0.1, type: 'sine', from: 60, to: 34, delay: 0.17, send: 0.05, attack: 0.006 });
      };
      beat();
      this._heartTimer = setInterval(beat, (60 / bpm) * 1000);
    } else if (!on && this._heartTimer) {
      clearInterval(this._heartTimer);
      this._heartTimer = null;
    }
  }

  /** Layered wind + distant battle ambience. */
  startAmbience() {
    const ctx = this.ctx;
    if (!ctx) return;
    const wind = ctx.createBufferSource();
    wind.buffer = this.brownBuf;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 340;
    windFilter.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.5;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambGain);
    wind.start();

    // slow gust LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 240;
    lfo.connect(lfoGain);
    lfoGain.connect(windFilter.frequency);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.031;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.22;
    lfo2.connect(lfo2Gain);
    lfo2Gain.connect(windGain.gain);
    lfo2.start();

    // distant artillery rumble
    const scheduleRumble = () => {
      if (!this.ready) return;
      const t = 6 + Math.random() * 22;
      setTimeout(() => {
        if (!this.ready) return;
        const pan = Math.random() * 2 - 1;
        this.burst({ dur: 1.4 + Math.random(), vol: 0.05 + Math.random() * 0.05, attack: 0.18, type: 'lowpass', from: 220, to: 70, q: 0.7, pan, send: 0.6 });
        this.tone({ dur: 1.1, vol: 0.03, attack: 0.2, type: 'sine', from: 55, to: 30, pan, send: 0.4 });
        scheduleRumble();
      }, t * 1000);
    };
    scheduleRumble();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}

export const audio = new AudioEngine();
