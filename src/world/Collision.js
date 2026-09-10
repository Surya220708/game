// ---------------------------------------------------------------------------
// Collision + ground querying.
//
// The level is authored from axis-aligned boxes and ramps, which keeps the
// broadphase trivial (a linear scan over ~400 primitive bounds) while still
// supporting multi-level ground, step-up traversal, wall sliding and
// ray-cast hit detection for bullets.
// ---------------------------------------------------------------------------

import { clamp } from '../core/Utils.js';

const EPS = 1e-4;

export class CollisionWorld {
  constructor(terrainHeight = () => 0) {
    this.boxes = []; // solid volumes with an AABB footprint
    this.ramps = []; // sloped surfaces (plus their solid volume underneath)
    this.terrainHeight = terrainHeight;
    this._hits = [];
  }

  clear() {
    this.boxes.length = 0;
    this.ramps.length = 0;
  }

  /**
   * @param {number} cx footprint centre X
   * @param {number} cz footprint centre Z
   * @param {number} w  footprint width (X)
   * @param {number} d  footprint depth (Z)
   * @param {number} y0 bottom height
   * @param {number} h  height above y0
   * @param {string} surface material tag for impacts
   */
  addBox(cx, cz, w, d, y0, h, surface = 'concrete', opts = {}) {
    if (w <= 0 || d <= 0 || h <= 0) return null;
    const box = {
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
      y0,
      y1: y0 + h,
      surface,
      // walls thinner than this are treated as fences: bullets pass, bodies don't
      thin: opts.thin || false,
      tall: h > 1.9,
    };
    this.boxes.push(box);
    return box;
  }

  /** Sloped walkable surface rising along `axis` from y0 to y1. */
  addRamp(cx, cz, w, d, y0, y1, axis = 'z', surface = 'concrete') {
    const ramp = {
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
      y0,
      y1,
      axis,
      surface,
      lo: Math.min(y0, y1),
      hi: Math.max(y0, y1),
    };
    this.ramps.push(ramp);
    return ramp;
  }

  rampHeightAt(ramp, x, z) {
    if (ramp.axis === 'z') {
      const t = clamp((z - ramp.minZ) / (ramp.maxZ - ramp.minZ), 0, 1);
      return ramp.y0 + (ramp.y1 - ramp.y0) * t;
    }
    const t = clamp((x - ramp.minX) / (ramp.maxX - ramp.minX), 0, 1);
    return ramp.y0 + (ramp.y1 - ramp.y0) * t;
  }

  /** Highest walkable surface at (x,z) that is reachable from yRef. */
  groundAt(x, z, yRef = 1e9, stepUp = 0.42) {
    let best = this.terrainHeight(x, z);
    const limit = yRef + stepUp;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.y1 > limit || b.y1 <= best) continue;
      if (x < b.minX - 0.05 || x > b.maxX + 0.05) continue;
      if (z < b.minZ - 0.05 || z > b.maxZ + 0.05) continue;
      best = b.y1;
    }
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      const h = this.rampHeightAt(r, x, z);
      if (h > best && h <= limit) best = h;
    }
    return best;
  }

  /** True if a volume (x,z,r,y0..y1) intersects solid geometry. */
  overlaps(x, z, r, y0, y1) {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.y1 <= y0 || b.y0 >= y1) continue;
      if (x + r < b.minX || x - r > b.maxX) continue;
      if (z + r < b.minZ || z - r > b.maxZ) continue;
      return b;
    }
    return null;
  }

  /**
   * Pushes a capsule (radius r, feet at feetY, height tall) out of walls.
   * Returns the accumulated push vector; resolution runs a few passes so
   * corners settle.
   */
  resolveXZ(pos, r, feetY, tall, stepUp = 0.45, out = { x: 0, z: 0, hit: false }, skipThin = false) {
    out.x = 0;
    out.z = 0;
    out.hit = false;
    const bodyTop = feetY + tall;
    const feetAboveStep = feetY + stepUp;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        // `thin` geometry (perimeter wire, railings) stops sight and bullets
        // but must not wall in the AI, which has no navmesh.
        if (skipThin && b.thin) continue;
        if (b.y1 <= feetAboveStep || b.y0 >= bodyTop) continue;
        const px = pos.x + out.x;
        const pz = pos.z + out.z;
        const cloX = clamp(px, b.minX, b.maxX);
        const cloZ = clamp(pz, b.minZ, b.maxZ);
        let dx = px - cloX;
        let dz = pz - cloZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) continue;
        if (d2 > EPS) {
          const d = Math.sqrt(d2);
          const push = r - d;
          out.x += (dx / d) * push;
          out.z += (dz / d) * push;
        } else {
          // Centre is inside the box: eject along the shallowest axis.
          const left = px - b.minX;
          const right = b.maxX - px;
          const back = pz - b.minZ;
          const front = b.maxZ - pz;
          const m = Math.min(left, right, back, front);
          if (m === left) out.x -= left + r;
          else if (m === right) out.x += right + r;
          else if (m === back) out.z -= back + r;
          else out.z += front + r;
        }
        moved = true;
        out.hit = true;
      }
      if (!moved) break;
    }
    return out;
  }

  /**
   * Ray vs all solid geometry. Returns the closest hit or null.
   * Ramps are tested analytically so shots don't hit invisible bounding boxes.
   */
  raycast(origin, dir, maxDist = 200, skipThin = false, skip = null) {
    let bestT = maxDist;
    let hit = null;
    const invX = 1 / (dir.x || 1e-9);
    const invY = 1 / (dir.y || 1e-9);
    const invZ = 1 / (dir.z || 1e-9);

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (skipThin && b.thin) continue;
      if (skip && skip === b) continue;
      let tmin = 0;
      let tmax = bestT;
      // X slab
      let t1 = (b.minX - origin.x) * invX;
      let t2 = (b.maxX - origin.x) * invX;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
      // Y slab
      t1 = (b.y0 - origin.y) * invY;
      t2 = (b.y1 - origin.y) * invY;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
      // Z slab
      t1 = (b.minZ - origin.z) * invZ;
      t2 = (b.maxZ - origin.z) * invZ;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
      if (tmin < 0) {
        if (tmax < 0) continue;
        tmin = 0;
      }
      if (tmin < bestT) {
        bestT = tmin;
        hit = { box: b, dist: tmin, surface: b.surface };
      }
    }

    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      const slope = (r.y1 - r.y0) / (r.axis === 'z' ? r.maxZ - r.minZ : r.maxX - r.minX);
      let t;
      if (r.axis === 'z') {
        const denom = dir.y - slope * dir.z;
        if (Math.abs(denom) < 1e-6) continue;
        t = (r.y0 + slope * (origin.z - r.minZ) - origin.y) / denom;
      } else {
        const denom = dir.y - slope * dir.x;
        if (Math.abs(denom) < 1e-6) continue;
        t = (r.y0 + slope * (origin.x - r.minX) - origin.y) / denom;
      }
      if (t < 0 || t >= bestT) continue;
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      if (px < r.minX || px > r.maxX || pz < r.minZ || pz > r.maxZ) continue;
      const py = origin.y + dir.y * t;
      if (py < r.lo - 0.05 || py > r.hi + 0.05) continue;
      bestT = t;
      hit = { box: r, dist: t, surface: r.surface, ramp: true };
    }

    if (!hit) return null;
    const point = {
      x: origin.x + dir.x * bestT,
      y: origin.y + dir.y * bestT,
      z: origin.z + dir.z * bestT,
    };
    return { ...hit, point, normal: normalFor(hit, origin, point) };
  }

  /** Cheap visibility test used by enemy AI. */
  lineOfSight(a, b, maxCheck = 60) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > maxCheck) return false;
    if (len < 1e-4) return true;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.raycast(a, dir, len - 0.2, true);
    return !hit;
  }
}

function normalFor(hit, origin, point) {
  if (hit.ramp) {
    const r = hit.box;
    const slope = (r.y1 - r.y0) / (r.axis === 'z' ? r.maxZ - r.minZ : r.maxX - r.minX);
    if (r.axis === 'z') {
      const l = Math.hypot(1, slope);
      return { x: 0, y: 1 / l, z: -slope / l };
    }
    const l = Math.hypot(1, slope);
    return { x: -slope / l, y: 1 / l, z: 0 };
  }
  const b = hit.box;
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  const dxMin = Math.abs(px - b.minX);
  const dxMax = Math.abs(px - b.maxX);
  const dyMin = Math.abs(py - b.y0);
  const dyMax = Math.abs(py - b.y1);
  const dzMin = Math.abs(pz - b.minZ);
  const dzMax = Math.abs(pz - b.maxZ);
  const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
  if (m === dyMin) return { x: 0, y: -1, z: 0 };
  if (m === dyMax) return { x: 0, y: 1, z: 0 };
  if (m === dxMin) return { x: -1, y: 0, z: 0 };
  if (m === dxMax) return { x: 1, y: 0, z: 0 };
  if (m === dzMin) return { x: 0, y: 0, z: -1 };
  return { x: 0, y: 0, z: 1 };
}
