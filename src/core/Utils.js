// ---------------------------------------------------------------------------
// Small math / helper toolbox shared by every system.
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const chance = (p) => Math.random() < p;

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Deterministic PRNG so the map and textures look the same every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shortest signed angular difference (radians). */
export function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Critically-ish damped spring used for recoil, sway and camera shake. */
export class Spring {
  constructor(value = 0, stiffness = 220, damping = 24) {
    this.value = value;
    this.target = value;
    this.vel = 0;
    this.k = stiffness;
    this.d = damping;
  }
  update(dt) {
    // Clamp dt so a stall never explodes the integrator.
    const step = Math.min(dt, 1 / 30);
    const a = -this.k * (this.value - this.target) - this.d * this.vel;
    this.vel += a * step;
    this.value += this.vel * step;
    return this.value;
  }
  kick(v) {
    this.vel += v;
  }
  set(v) {
    this.value = this.target = v;
    this.vel = 0;
  }
}

/** Trailing average, used for the FPS readout. */
export class RollingAverage {
  constructor(len = 30) {
    this.buf = new Float32Array(len);
    this.i = 0;
    this.n = 0;
  }
  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k];
    return s / this.n;
  }
}

/** Promise that resolves on the next animation frame (used by the loader). */
export const nextFrame = () =>
  new Promise((res) => requestAnimationFrame(() => res()));

/** Random point in an annulus, used for spawn rings. */
export function ringPoint(cx, cz, rMin, rMax) {
  const a = rand(0, TAU);
  const r = Math.sqrt(rand(rMin * rMin, rMax * rMax));
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, a };
}
