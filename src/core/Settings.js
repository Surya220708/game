// ---------------------------------------------------------------------------
// Settings: defaults, persistence, and quality presets.
// ---------------------------------------------------------------------------

const KEY = 'blackout.settings.v1';

export const QUALITY_PRESETS = {
  low: {
    label: 'LOW',
    pixelRatio: 1,
    shadowMap: 512,
    shadows: true,
    aniso: 1,
    bloom: false,
    bloomStrength: 0.0,
    textureSize: 128,
    maxEnemies: 7,
    particles: 0.45,
    decals: 20,
    tracerFx: true,
    fog: true,
    aoIntensity: 0,
    grass: false,
    softShadows: false,
  },
  medium: {
    label: 'MEDIUM',
    pixelRatio: 1,
    shadowMap: 1024,
    shadows: true,
    aniso: 2,
    bloom: true,
    bloomStrength: 0.45,
    textureSize: 160,
    maxEnemies: 10,
    particles: 0.7,
    decals: 34,
    tracerFx: true,
    fog: true,
    aoIntensity: 0.35,
    grass: false,
    softShadows: false,
  },
  high: {
    label: 'HIGH',
    pixelRatio: 1.25,
    shadowMap: 2048,
    shadows: true,
    aniso: 4,
    bloom: true,
    bloomStrength: 0.62,
    textureSize: 256,
    maxEnemies: 14,
    particles: 1,
    decals: 48,
    tracerFx: true,
    fog: true,
    aoIntensity: 0.55,
    grass: true,
    softShadows: true,
  },
  ultra: {
    label: 'ULTRA',
    pixelRatio: 1.5,
    shadowMap: 4096,
    shadows: true,
    aniso: 8,
    bloom: true,
    bloomStrength: 0.72,
    textureSize: 256,
    maxEnemies: 18,
    particles: 1.4,
    decals: 64,
    tracerFx: true,
    fog: true,
    aoIntensity: 0.7,
    grass: true,
    softShadows: true,
  },
};

export function detectDefaultQuality() {
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 4;
  const touch = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 500;
  if (touch && (small || cores <= 4)) return 'low';
  if (touch) return 'medium';
  if (cores >= 8 && mem >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

export function isTouchDevice() {
  if (matchMedia('(pointer: coarse)').matches) return true;
  if (navigator.maxTouchPoints > 1) return true;
  return 'ontouchstart' in window && matchMedia('(hover: none)').matches;
}

const DEFAULTS = {
  sensitivity: 1,
  adsSensitivity: 0.7,
  fov: 80,
  volume: 0.75,
  quality: null, // resolved on boot
  renderScale: 1,
  invertY: false,
  aimAssist: true,
  forceTouch: null, // null = auto-detect
  effects: true,
  showFps: false,
};

class SettingsStore {
  constructor() {
    this.data = { ...DEFAULTS };
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) {
      /* storage disabled — run with defaults */
    }
    if (!this.data.quality) this.data.quality = detectDefaultQuality();
    if (this.data.forceTouch === null) this.data.forceTouch = isTouchDevice();
    // Keep sanitisers so a corrupted store can never break the renderer.
    this.data.sensitivity = clampNum(this.data.sensitivity, 0.1, 3, 1);
    this.data.adsSensitivity = clampNum(this.data.adsSensitivity, 0.2, 1.5, 0.7);
    this.data.fov = clampNum(this.data.fov, 65, 110, 80);
    this.data.volume = clampNum(this.data.volume, 0, 1, 0.75);
    this.data.renderScale = clampNum(this.data.renderScale, 0.5, 1.5, 1);
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      /* ignore */
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    this.listeners.forEach((fn) => fn(key, value, this.data));
  }

  watch(fn) {
    this.listeners.add(fn);
  }

  get preset() {
    return QUALITY_PRESETS[this.data.quality] || QUALITY_PRESETS.medium;
  }

  reset() {
    const q = this.data.quality;
    Object.assign(this.data, DEFAULTS, { quality: q, forceTouch: isTouchDevice() });
    this.save();
    this.listeners.forEach((fn) => fn('*', null, this.data));
  }
}

function clampNum(v, a, b, d) {
  v = Number(v);
  if (!isFinite(v)) return d;
  return Math.min(b, Math.max(a, v));
}

export const settings = new SettingsStore();
