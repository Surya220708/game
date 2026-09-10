// ---------------------------------------------------------------------------
// Procedural texture factory.
//
// The project ships with no image assets, so every surface in the game is
// synthesised at boot: albedo + normal + roughness maps are computed from
// tiling value-noise fields, and the sky is baked into an equirectangular
// environment map for physically based reflections.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mulberry32, clamp01, lerp } from './Utils.js';

let TEX_SIZE = 256;
let ANISO = 4;

/** Set once the renderer exists so we can use its capabilities. */
export function configureTextures({ size, anisotropy }) {
  if (size) TEX_SIZE = size;
  if (anisotropy) ANISO = anisotropy;
}

// --------------------------------------------------------------- noise ------

/** Seamless tiling value noise on a `period x period` lattice. */
function makeNoise(period, rng) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (x, y) => {
    const xi = ((x % period) + period) % period;
    const yi = ((y % period) + period) % period;
    return g[yi * period + xi];
  };
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
}

/** Fractal brownian motion over tiling noise. u,v in [0,1) -> ~[0,1]. */
function fbm(seed, octaves = 5, basePeriod = 4) {
  const rng = mulberry32(seed);
  const layers = [];
  for (let o = 0; o < octaves; o++) {
    const p = basePeriod << o;
    layers.push({ p, a: Math.pow(0.5, o), n: makeNoise(p, rng) });
  }
  let weight = 0;
  for (const l of layers) weight += l.a;
  return (u, v, freq = 1, stretch = 1) => {
    let s = 0;
    for (const l of layers) {
      const p = l.p * freq;
      s += l.a * l.n(u * p * stretch, v * p / stretch);
    }
    return s / weight;
  };
}

/** Ridged variant: turns noise into thin filament-like bands (cracks, veins). */
const ridged = (fn) => (u, v, f = 1, s = 1) => Math.abs(fn(u, v, f, s) * 2 - 1);

// --------------------------------------------------------- surface build ----

const OUT = new Float32Array(5);

/**
 * Runs `fn(u, v, out)` for every texel. `out` carries [r, g, b, height, rough]
 * with colour components in 0..1 and height in 0..1.
 */
function buildSurface(size, fn) {
  const img = new ImageData(size, size);
  const px = img.data;
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      OUT[0] = OUT[1] = OUT[2] = 0.5;
      OUT[3] = 0.5;
      OUT[4] = 0.8;
      fn(u, v, OUT);
      const i = y * size + x;
      const o = i << 2;
      px[o] = clamp01(OUT[0]) * 255;
      px[o + 1] = clamp01(OUT[1]) * 255;
      px[o + 2] = clamp01(OUT[2]) * 255;
      px[o + 3] = 255;
      height[i] = OUT[3];
    }
  }
  return { img, height, size };
}

function albedoCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

function grayscaleCanvas(size, fn) {
  const img = new ImageData(size, size);
  const px = img.data;
  for (let i = 0; i < size * size; i++) {
    const g = clamp01(fn(i % size, (i / size) | 0)) * 255;
    const o = i << 2;
    px[o] = px[o + 1] = px[o + 2] = g;
    px[o + 3] = 255;
  }
  return albedoCanvas(img);
}

/** Sobel-ish normal map derived from the height field (wraps seamlessly). */
function normalCanvas(height, size, strength = 2.4) {
  const img = new ImageData(size, size);
  const px = img.data;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * size + x) << 2;
      px[o] = ((dx / len) * 0.5 + 0.5) * 255;
      px[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      px[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      px[o + 3] = 255;
    }
  }
  return albedoCanvas(img);
}

function toTexture(canvas, { srgb = false, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = ANISO;
  t.needsUpdate = true;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ------------------------------------------------------- surface recipes ----
// Every recipe is a pure function of (u, v) so it tiles perfectly.

const RECIPES = {
  // Dirt/gravel ground of the outpost.
  dirt: {
    seed: 11,
    rough: 0.95,
    metal: 0.0,
    normalScale: 1.1,
    env: 0.35,
    paint(n1, n2, n3, r1, r2) {
      return (u, v, out) => {
        const big = n1(u, v, 0.5);
        const grain = n2(u, v, 3.2);
        const fine = n3(u, v, 9);
        const crack = r1(u, v, 1.4);
        let l = 0.30 + (big - 0.5) * 0.26 + (grain - 0.5) * 0.18 + (fine - 0.5) * 0.10;
        let dark = 0;
        if (crack < 0.045) dark = 1 - crack / 0.045;
        // pebbles
        const peb = n3(u * 0.97 + 0.31, v * 0.97, 26);
        if (peb > 0.79) l += (peb - 0.79) * 1.3;
        if (peb < 0.16) l -= (0.16 - peb) * 1.1;
        l -= dark * 0.22;
        const tint = 0.34 + (big - 0.5) * 0.3;
        out[0] = l * 0.94 + tint * 0.22;
        out[1] = l * 0.82 + tint * 0.16;
        out[2] = l * 0.62 + tint * 0.08;
        out[3] = 1 - (grain * 0.55 + fine * 0.45) * 0.55;
        out[4] = 0.985;
      };
    },
  },

  // Dry sand around the perimeter.
  sand: {
    seed: 23,
    rough: 0.92,
    metal: 0,
    normalScale: 0.85,
    env: 0.3,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const dune = n1(u, v, 0.7, 2.4);
        const grain = n2(u, v, 7);
        const fine = n3(u, v, 22);
        const l = 0.52 + (dune - 0.5) * 0.18 + (grain - 0.5) * 0.10 + (fine - 0.5) * 0.07;
        const peb = n3(u * 0.8 + 0.4, v * 0.8, 30);
        const spec = peb > 0.84 ? (peb - 0.84) * 1.5 : 0;
        out[0] = l * 1.02 + spec * 0.2;
        out[1] = l * 0.86 + spec * 0.18;
        out[2] = l * 0.58 + spec * 0.14;
        out[3] = 0.55 - (fine - 0.5) * 0.6 - (grain - 0.5) * 0.4;
        out[4] = 0.9;
      };
    },
  },

  // Board-formed concrete: blotchy, cracked, with fine aggregate.
  concrete: {
    seed: 37,
    rough: 0.88,
    metal: 0,
    normalScale: 1.35,
    env: 0.45,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const blotch = n1(u, v, 0.8);
        const agg = n2(u, v, 6);
        const fine = n3(u, v, 24);
        const crack = r1(u, v, 1.1, 1.6);
        let l = 0.44 + (blotch - 0.5) * 0.24 + (agg - 0.5) * 0.10 + (fine - 0.5) * 0.07;
        let h = 0.5 + (agg - 0.5) * 0.7 + (fine - 0.5) * 0.3;
        if (crack < 0.035) {
          const d = 1 - crack / 0.035;
          l -= d * 0.3;
          h -= d * 0.75;
        }
        const stain = Math.max(0, n1(u, v, 2.6) - 0.55) * 0.6;
        l -= stain * 0.14;
        // cold gray with a hint of warm dust
        out[0] = l * 1.0 + 0.02;
        out[1] = l * 0.99 + 0.015;
        out[2] = l * 0.95 + 0.01;
        out[3] = h;
        out[4] = 0.9 - stain * 0.15;
      };
    },
  },

  // Concrete block wall with clear mortar joints.
  bricks: {
    seed: 41,
    rough: 0.9,
    metal: 0,
    normalScale: 1.6,
    env: 0.4,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const rows = 10;
        const fy = v * rows;
        const row = Math.floor(fy);
        const shift = row % 2 ? 0.5 : 0;
        const fx = u * 5 + shift;
        const col = Math.floor(fx);
        const bx = fx - col;
        const by = fy - row;
        const mortar = Math.min(bx, 1 - bx, by, 1 - by) < 0.055 ? 1 : 0;
        const grain = n2(u, v, 8) * 0.6 + n3(u, v, 20) * 0.4;
        const varB = (Math.sin(col * 12.9898 + row * 78.233) * 43758.5453) % 1;
        const base = 0.42 + Math.abs(varB) * 0.1;
        if (mortar) {
          const m = 0.52 + (grain - 0.5) * 0.16;
          out[0] = m * 0.96;
          out[1] = m * 0.94;
          out[2] = m * 0.88;
          out[3] = 0.32 + grain * 0.1;
          out[4] = 0.94;
          return;
        }
        const l = base + (grain - 0.5) * 0.2;
        const wear = Math.max(0, n1(u, v, 1.6) - 0.6) * 0.4;
        out[0] = l * 1.02 - wear * 0.05;
        out[1] = l * 0.92 + 0.01;
        out[2] = l * 0.8 + 0.01;
        out[3] = 0.75 + (grain - 0.5) * 0.35;
        out[4] = 0.92;
      };
    },
  },

  // Painted, weathered steel plate.
  metal: {
    seed: 53,
    rough: 0.55,
    metal: 0.85,
    normalScale: 0.8,
    env: 1.0,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const blotch = n1(u, v, 1.2);
        const scratch = r1(u, v, 2.2, 3.2); // stretched -> scratch-like
        const fine = n3(u, v, 18);
        let l = 0.34 + (blotch - 0.5) * 0.14 + (fine - 0.5) * 0.06;
        let rough = 0.5 + (fine - 0.5) * 0.3;
        let metal = 0.8;
        if (scratch < 0.05) {
          const d = 1 - scratch / 0.05;
          l += d * 0.28;
          rough -= d * 0.35;
          metal = 1.0;
        }
        const rustPatch = n2(u, v, 1.8);
        if (rustPatch > 0.7) {
          const d = (rustPatch - 0.7) / 0.3;
          out[0] = lerp(l * 0.9, 0.34, d);
          out[1] = lerp(l * 0.92, 0.17, d);
          out[2] = lerp(l * 0.95, 0.08, d);
          out[3] = 0.5 + (fine - 0.5) * 0.8 - d * 0.2;
          out[4] = lerp(rough, 0.95, d);
          return;
        }
        out[0] = l * 0.92;
        out[1] = l * 0.94;
        out[2] = l * 0.98;
        out[3] = 0.5 + (fine - 0.5) * 0.4 - (scratch < 0.05 ? 0.3 : 0);
        out[4] = rough;
      };
    },
  },

  // Rusted corrugated roofing / sandbag revetment sheeting.
  corrugated: {
    seed: 61,
    rough: 0.75,
    metal: 0.6,
    normalScale: 1.5,
    env: 0.8,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const rib = Math.sin(u * Math.PI * 2 * 7);
        const rust = n1(u, v, 1.6);
        const fine = n3(u, v, 14);
        const streaks = n2(u * 0.6, v * 3.2, 3);
        let rustAmt = clamp01((rust - 0.35) * 1.5 + (streaks - 0.6) * 0.8);
        const shade = 0.72 + rib * 0.28;
        const base = 0.36 * shade;
        out[0] = lerp(base * 0.95, 0.36 * shade + 0.1, rustAmt);
        out[1] = lerp(base * 0.97, 0.19 * shade, rustAmt);
        out[2] = lerp(base * 1.02, 0.1 * shade, rustAmt);
        out[3] = 0.5 + rib * 0.5 * 0.55 + (fine - 0.5) * 0.25;
        out[4] = lerp(0.5, 0.95, rustAmt);
      };
    },
  },

  // Hessian sandbags: coarse weave, khaki, dust settled on top.
  sandbag: {
    seed: 71,
    rough: 0.97,
    metal: 0,
    normalScale: 1.9,
    env: 0.25,
    paint(n1, n2, n3) {
      return (u, v, out) => {
        const weaveU = Math.sin(u * Math.PI * 2 * 26);
        const weaveV = Math.sin(v * Math.PI * 2 * 26);
        const weave = (weaveU * weaveV) * 0.5 + 0.5;
        const clump = n2(u, v, 3.4);
        const grain = n3(u, v, 16);
        const l = 0.36 + (clump - 0.5) * 0.2 + (grain - 0.5) * 0.12 + (weave - 0.5) * 0.14;
        out[0] = l * 1.16;
        out[1] = l * 1.03;
        out[2] = l * 0.7;
        out[3] = 0.45 + (weave - 0.5) * 0.5 + (clump - 0.5) * 0.4;
        out[4] = 0.98;
      };
    },
  },

  // Timber planks for crates and barricades.
  wood: {
    seed: 83,
    rough: 0.85,
    metal: 0,
    normalScale: 1.05,
    env: 0.35,
    paint(n1, n2, n3) {
      return (u, v, out) => {
        const planks = 4;
        const pv = v * planks;
        const plank = Math.floor(pv);
        const local = pv - plank;
        const rnd = Math.abs((Math.sin(plank * 91.7) * 4745.3) % 1);
        const grain = n1(u * 1.4, v * 0.22, 2.2, 1);
        const fine = n3(u, v, 20);
        let l = 0.34 + rnd * 0.12 + (grain - 0.5) * 0.2 + (fine - 0.5) * 0.06;
        let h = 0.6 + (fine - 0.5) * 0.3;
        // dark seams between planks
        const edge = Math.min(local, 1 - local);
        if (edge < 0.035) {
          const d = 1 - edge / 0.035;
          l -= d * 0.3;
          h -= d * 0.9;
        }
        // knots
        const knot = n2(u, v, 5.5);
        if (knot > 0.87) l -= (knot - 0.87) * 1.4;
        out[0] = l * 1.22;
        out[1] = l * 0.86;
        out[2] = l * 0.55;
        out[3] = h;
        out[4] = 0.88;
      };
    },
  },

  // Asphalt / oiled gravel hardstanding.
  asphalt: {
    seed: 97,
    rough: 0.86,
    metal: 0.05,
    normalScale: 1.0,
    env: 0.4,
    paint(n1, n2, n3, r1) {
      return (u, v, out) => {
        const gravel = n2(u, v, 12) * 0.6 + n3(u, v, 30) * 0.4;
        const patch = n1(u, v, 1.1);
        const crack = r1(u, v, 2.0);
        let l = 0.17 + (patch - 0.5) * 0.09 + (gravel - 0.5) * 0.14;
        if (crack < 0.03) l -= (1 - crack / 0.03) * 0.09;
        out[0] = l * 0.98;
        out[1] = l * 0.99;
        out[2] = l * 1.03;
        out[3] = 0.5 + (gravel - 0.5) * 0.9;
        out[4] = 0.82 - (gravel - 0.5) * 0.2;
      };
    },
  },

  // Multi-terrain camouflage cloth (uniforms, tarps, netting).
  camo: {
    seed: 101,
    rough: 0.94,
    metal: 0,
    normalScale: 0.7,
    env: 0.3,
    paint(n1, n2, n3) {
      return (u, v, out) => {
        const a = n1(u, v, 1.4);
        const b = n2(u, v, 2.6);
        const weave = n3(u, v, 26);
        let r = 0.20, g = 0.22, bl = 0.15;
        if (a > 0.58) {
          r = 0.30; g = 0.27; bl = 0.17; // tan
        } else if (b > 0.6) {
          r = 0.13; g = 0.16; bl = 0.10; // dark green
        } else if (b < 0.34 && a < 0.5) {
          r = 0.24; g = 0.18; bl = 0.12; // brown
        }
        const shade = 0.85 + (weave - 0.5) * 0.3;
        out[0] = r * shade;
        out[1] = g * shade;
        out[2] = bl * shade;
        out[3] = 0.5 + (weave - 0.5) * 0.5;
        out[4] = 0.95;
      };
    },
  },

  // Painted composite / plastic (crates, fuel drums, weapon furniture).
  plastic: {
    seed: 109,
    rough: 0.42,
    metal: 0.1,
    normalScale: 0.35,
    env: 0.9,
    paint(n1, n2) {
      return (u, v, out) => {
        const n = n2(u, v, 20);
        const dirt = Math.max(0, n1(u, v, 3) - 0.6) * 0.3;
        const l = 0.22 + (n - 0.5) * 0.03;
        out[0] = l * 1.1;
        out[1] = l * 1.12;
        out[2] = l * 1.15;
        out[3] = 0.5 + (n - 0.5) * 0.3;
        out[4] = 0.4 + dirt;
      };
    },
  },

  // Steel grid walkway / grating.
  grating: {
    seed: 113,
    rough: 0.6,
    metal: 0.9,
    normalScale: 1.3,
    env: 1.0,
    paint(n1, n2, n3) {
      return (u, v, out) => {
        const bar = Math.min(
          Math.abs(((u * 8) % 1) - 0.5),
          Math.abs(((v * 8) % 1) - 0.5)
        ) < 0.13 ? 1 : 0;
        const base = bar ? 0.42 : 0.10;
        const n = n3(u, v, 24);
        const rust = Math.max(0, n2(u, v, 2.2) - 0.55) * 1.4;
        const l = base + (n - 0.5) * 0.08;
        out[0] = lerp(l * 0.96, l * 0.9 + 0.12, rust);
        out[1] = lerp(l * 0.98, l * 0.5, rust);
        out[2] = lerp(l * 1.0, l * 0.3, rust);
        out[3] = bar ? 0.55 + (n - 0.5) * 0.3 : -0.2;
        out[4] = lerp(0.5, 0.92, rust);
      };
    },
  },
};

// ------------------------------------------------------------ materials -----

const materialCache = new Map();
const textureCache = new Map();

function buildMaterial(name) {
  const def = RECIPES[name];
  if (!def) throw new Error(`unknown material: ${name}`);

  // Detail maps are generated at a lower resolution than large-area surfaces.
  const size = TEX_SIZE;
  const n1 = fbm(def.seed, 5, 4);
  const n2 = fbm(def.seed + 1, 4, 8);
  const n3 = fbm(def.seed + 2, 3, 16);
  const r1 = ridged(fbm(def.seed + 3, 4, 6));

  const { img, height } = buildSurface(size, def.paint(n1, n2, n3, r1));
  const map = toTexture(albedoCanvas(img), { srgb: true });
  const normalMap = toTexture(normalCanvas(height, size, 2.6), { srgb: false });
  // Roughness is packed from the height field's complementary detail.
  const roughCanvas = grayscaleCanvas(size, (x, y) => {
    const h = height[y * size + x];
    return 0.55 + (h - 0.5) * 0.5;
  });
  const roughnessMap = toTexture(roughCanvas);

  textureCache.set(`${name}:map`, map);
  textureCache.set(`${name}:normal`, normalMap);

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap,
    normalScale: new THREE.Vector2(def.normalScale, def.normalScale),
    roughness: def.rough,
    metalness: def.metal,
    envMapIntensity: def.env ?? 0.6,
    dithering: true,
  });
  mat.userData.surface = name;
  return mat;
}

/** Cached surface materials, created on first request. */
export function getMaterial(name) {
  let mat = materialCache.get(name);
  if (!mat) {
    mat = buildMaterial(name);
    materialCache.set(name, mat);
  }
  return mat;
}

export const MATERIAL_NAMES = Object.keys(RECIPES);

/** Clone a material with a colour tint (crates, drums, signage...). */
export function tintedMaterial(name, color, opts = {}) {
  const base = getMaterial(name);
  const m = base.clone();
  m.color = new THREE.Color(color);
  if (opts.roughness !== undefined) m.roughness = opts.roughness;
  if (opts.metalness !== undefined) m.metalness = opts.metalness;
  if (opts.emissive) {
    m.emissive = new THREE.Color(opts.emissive);
    m.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  return m;
}

// ------------------------------------------------------------- sprites ------

function radialCanvas(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function glowTexture(size = 64) {
  const key = `glow:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const t = toTexture(
    radialCanvas(size, [
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,240,200,0.75)'],
      [0.6, 'rgba(255,180,90,0.18)'],
      [1, 'rgba(255,140,40,0)'],
    ]),
    { srgb: true, repeat: false }
  );
  textureCache.set(key, t);
  return t;
}

export function smokeTexture(size = 96) {
  const key = `smoke:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const n = fbm(7, 4, 6);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const puff = n(u, v, 1);
      const a = clamp01((1 - d) * 1.5) * (0.45 + puff * 0.75);
      const o = (y * size + x) << 2;
      const g = 150 + puff * 70;
      img.data[o] = g;
      img.data[o + 1] = g * 0.98;
      img.data[o + 2] = g * 0.94;
      img.data[o + 3] = clamp01(a) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(c, { srgb: true, repeat: false });
  textureCache.set(key, t);
  return t;
}

export function sparkTexture(size = 32) {
  const key = `spark:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const t = toTexture(
    radialCanvas(size, [
      [0, 'rgba(255,255,235,1)'],
      [0.3, 'rgba(255,220,140,0.8)'],
      [1, 'rgba(255,150,40,0)'],
    ]),
    { srgb: true, repeat: false }
  );
  textureCache.set(key, t);
  return t;
}

export function flashTexture(size = 128) {
  const key = `flash:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.translate(size / 2, size / 2);
  // core
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.22);
  core.addColorStop(0, 'rgba(255,255,240,1)');
  core.addColorStop(0.4, 'rgba(255,226,150,0.85)');
  core.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // radiating spikes
  const spikes = 7;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + 0.3;
    const len = size * (0.5 - Math.random() * 0.14);
    const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    g.addColorStop(0, 'rgba(255,240,200,0.9)');
    g.addColorStop(0.5, 'rgba(255,190,90,0.35)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = size * (0.045 + Math.random() * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  const t = toTexture(c, { srgb: true, repeat: false });
  textureCache.set(key, t);
  return t;
}

/** Bullet impact decal with soft alpha edges. */
export function bulletHoleTexture(size = 64) {
  const key = `bulletHole:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const n = fbm(19, 3, 8);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const jag = n(u, v, 1.4) * 0.22;
      const hole = clamp01((0.30 + jag - d) * 6);
      const dust = clamp01((0.78 + jag - d) * 2.6);
      const o = (y * size + x) << 2;
      const shade = 26 + n(u, v, 3) * 34;
      // dark hole over dusty ring
      img.data[o] = lerp(120, shade, hole);
      img.data[o + 1] = lerp(116, shade, hole);
      img.data[o + 2] = lerp(110, shade, hole);
      img.data[o + 3] = clamp01(hole * 0.95 + dust * 0.42) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(c, { srgb: true, repeat: false });
  textureCache.set(key, t);
  return t;
}

export function bloodTexture(size = 64) {
  const key = `blood:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(90,8,8,0.92)';
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.6) * size * 0.42;
    const rad = size * (0.05 + Math.random() * 0.16);
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.34);
  g.addColorStop(0, 'rgba(70,4,4,0.95)');
  g.addColorStop(1, 'rgba(70,4,4,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.34, 0, Math.PI * 2);
  ctx.fill();
  const t = toTexture(c, { srgb: true, repeat: false });
  textureCache.set(key, t);
  return t;
}

export function scorchTexture(size = 128) {
  const key = `scorch:${size}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const n = fbm(29, 4, 5);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const rad = n(u, v, 1.2) * 0.35;
      const a = clamp01((0.9 + rad - d) * 2.2);
      const soot = n(u, v, 3);
      const o = (y * size + x) << 2;
      img.data[o] = 12 + soot * 22;
      img.data[o + 1] = 10 + soot * 20;
      img.data[o + 2] = 10 + soot * 20;
      img.data[o + 3] = a * (0.55 + soot * 0.4) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(c, { srgb: true, repeat: false });
  textureCache.set(key, t);
  return t;
}

// ------------------------------------------------------ environment map -----

/**
 * Bakes a sunset sky into an equirectangular canvas so materials get real
 * reflections and the world has a believable horizon.
 */
export function skyCanvas(w = 1024, h = 512, seed = 5) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const n = fbm(seed, 5, 3);
  const img = ctx.createImageData(w, h);
  const sunDir = { az: 0.62, el: 0.16 }; // matches the directional light
  for (let y = 0; y < h; y++) {
    const v = y / h;
    // 0 at top (zenith) -> 1 at bottom (nadir); horizon at 0.5
    const el = (0.5 - v) * Math.PI;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const az = (u - 0.5) * Math.PI * 2;
      const cloud = n(u * 1.0, v * 1.6, 1.3);
      let r, g, b;
      if (el > 0) {
        // sky dome
        const t = clamp01(el / (Math.PI * 0.5));
        const horizonMix = 1 - Math.pow(t, 0.55);
        // base gradient: deep blue up top -> warm haze on the horizon
        r = lerp(0.16, 0.86, Math.pow(horizonMix, 2.1));
        g = lerp(0.24, 0.58, Math.pow(horizonMix, 1.7));
        b = lerp(0.38, 0.42, Math.pow(horizonMix, 1.2));
        // sun glow
        const dAz = Math.abs(((az - sunDir.az + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const dEl = el - sunDir.el;
        const dist = Math.hypot(dAz * 0.85, dEl);
        const glow = Math.exp(-dist * dist * 3.4);
        const disk = Math.exp(-dist * dist * 340);
        r += glow * 0.95 + disk * 3.2;
        g += glow * 0.62 + disk * 3.0;
        b += glow * 0.3 + disk * 2.4;
        // clouds
        const band = Math.exp(-Math.pow((el - 0.22) * 3.1, 2));
        const cAmt = clamp01((cloud - 0.46) * 2.4) * band * 0.9;
        const lit = clamp01(1 - dist * 0.5);
        r = lerp(r, lerp(0.42, 1.0, lit), cAmt * 0.8);
        g = lerp(g, lerp(0.36, 0.82, lit), cAmt * 0.8);
        b = lerp(b, lerp(0.36, 0.66, lit), cAmt * 0.8);
      } else {
        // ground hemisphere of the environment: dark, dusty
        const t = clamp01(-el / (Math.PI * 0.5));
        const haze = 1 - t;
        r = lerp(0.055, 0.30, Math.pow(haze, 3));
        g = lerp(0.05, 0.25, Math.pow(haze, 3));
        b = lerp(0.045, 0.19, Math.pow(haze, 3));
        const dust = (n(u * 2, v * 2, 1) - 0.5) * 0.05;
        r += dust;
        g += dust;
        b += dust;
      }
      const o = (y * w + x) << 2;
      img.data[o] = clamp01(r) * 255;
      img.data[o + 1] = clamp01(g) * 255;
      img.data[o + 2] = clamp01(b) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function skyTexture() {
  if (textureCache.has('sky')) return textureCache.get('sky');
  const t = new THREE.CanvasTexture(skyCanvas());
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  textureCache.set('sky', t);
  return t;
}

/** Average colour of the horizon band — used for fog so it blends exactly. */
export function horizonColor() {
  return new THREE.Color(0x6b6152);
}

export function disposeTextures() {
  textureCache.forEach((t) => t.dispose && t.dispose());
  textureCache.clear();
  materialCache.forEach((m) => {
    ['map', 'normalMap', 'roughnessMap'].forEach((k) => m[k] && m[k].dispose());
    m.dispose();
  });
  materialCache.clear();
}

// ---------------------------------------------------------- fence + grass ---

/** Chain-link mesh with alpha cut-out, used for the perimeter wire. */
export function fenceCanvas(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(196,200,196,0.95)';
  ctx.lineWidth = Math.max(1.4, size / 44);
  const step = size / 4;
  for (let i = -4; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + size, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step, size);
    ctx.lineTo(i * step + size, 0);
    ctx.stroke();
  }
  // rust and dust build-up
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] > 0) {
      const k = 0.6 + Math.random() * 0.5;
      img.data[i] = 150 * k;
      img.data[i + 1] = 146 * k;
      img.data[i + 2] = 140 * k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function fenceMaterial() {
  if (textureCache.has('fenceMat')) return textureCache.get('fenceMat');
  const tex = toTexture(fenceCanvas(128), { srgb: true });
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    roughness: 0.62,
    metalness: 0.75,
    envMapIntensity: 0.9,
  });
  textureCache.set('fenceMat', mat);
  return mat;
}

/** Crossed quads of dry scrub grass. */
export function grassTexture(size = 64) {
  if (textureCache.has('grass')) return textureCache.get('grass');
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {
    const x0 = size * (0.12 + Math.random() * 0.76);
    const h = size * (0.42 + Math.random() * 0.55);
    const bend = (Math.random() - 0.5) * size * 0.3;
    const g = ctx.createLinearGradient(0, size, 0, size - h);
    const tone = 0.55 + Math.random() * 0.45;
    g.addColorStop(0, `rgba(${74 * tone | 0},${70 * tone | 0},${34 * tone | 0},0.95)`);
    g.addColorStop(1, `rgba(${150 * tone | 0},${140 * tone | 0},${78 * tone | 0},0.85)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = size / 40;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, size);
    ctx.quadraticCurveTo(x0 + bend * 0.4, size - h * 0.55, x0 + bend, size - h);
    ctx.stroke();
  }
  const t = toTexture(c, { srgb: true, repeat: false });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  textureCache.set('grass', t);
  return t;
}
