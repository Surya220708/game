// ---------------------------------------------------------------------------
// LEVEL: forward outpost "EAGLE-7".
//
// The whole map is authored procedurally from boxes, ramps and cylinders.
// Geometry is merged per material so the finished level costs roughly a dozen
// draw calls, while the collision world keeps a primitive list for movement,
// ground queries and ballistics.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  getMaterial,
  tintedMaterial,
  fenceMaterial,
  grassTexture,
  MATERIAL_NAMES,
} from '../core/Textures.js';
import { CollisionWorld } from './Collision.js';
import { mulberry32, clamp, lerp, smoothstep, randInt, TAU } from '../core/Utils.js';

// Texture density: metres covered by one texture tile for each surface.
const TEXDENS = {
  concrete: 1 / 3.0,
  bricks: 1 / 2.2,
  dirt: 1 / 9,
  sand: 1 / 12,
  metal: 1 / 2.2,
  corrugated: 1 / 1.7,
  sandbag: 1 / 1.0,
  wood: 1 / 1.1,
  asphalt: 1 / 8,
  camo: 1 / 1.4,
  plastic: 1 / 1.1,
  grating: 1 / 1.4,
};

const SURFACE_TAGS = {
  concrete: 'concrete',
  bricks: 'concrete',
  dirt: 'dirt',
  sand: 'sand',
  metal: 'metal',
  corrugated: 'metal',
  sandbag: 'sand',
  wood: 'wood',
  asphalt: 'concrete',
  camo: 'dirt',
  plastic: 'metal',
  grating: 'metal',
};

/** Ground level outside the compound. Flat (0.02) inside the perimeter. */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  const flat = smoothstep(50, 78, r);
  if (flat <= 0.0001) return 0.02;
  const dunes =
    Math.sin(x * 0.021 + 1.2) * Math.cos(z * 0.026 - 0.4) * 3.6 +
    Math.sin(x * 0.052 - 0.7) * Math.sin(z * 0.041 + 2.1) * 1.9 +
    Math.sin((x + z) * 0.013) * 2.4;
  const ripple = Math.sin(x * 0.33) * Math.cos(z * 0.29) * 0.07;
  return 0.02 + flat * (dunes * 0.5 - 0.5) + ripple * flat;
}

function scaleBoxUVs(geo, w, h, d, scale, uo = 0, vo = 0) {
  const uv = geo.attributes.uv;
  const normal = geo.attributes.normal;
  const su = scale;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    let u;
    let v;
    if (nx > 0.5) {
      u = d;
      v = h;
    } else if (ny > 0.5) {
      u = w;
      v = d;
    } else {
      u = w;
      v = h;
    }
    uv.setXY(i, uv.getX(i) * u * su + uo, uv.getY(i) * v * su + vo);
  }
  uv.needsUpdate = true;
  return geo;
}

class Builder {
  constructor(scene, collision, quality) {
    this.scene = scene;
    this.col = collision;
    this.quality = quality;
    this.groups = new Map(); // material -> geometry[]
    this.static = new Map();
    this.extras = [];
    this.materials = new Map();
    this._initMaterials();
  }

  _initMaterials() {
    this.materials.set('fence', fenceMaterial());
    const t = (name, color, opts) => this.materials.set(name, tintedMaterial(name.match(/^[a-z]+/)[0], color, opts));
    this.materials.set('containerRed', tintedMaterial('corrugated', 0x8a3524));
    this.materials.set('containerGreen', tintedMaterial('corrugated', 0x3b5340));
    this.materials.set('containerBlue', tintedMaterial('corrugated', 0x36485c));
    this.materials.set('containerTan', tintedMaterial('corrugated', 0x7d7355));
    this.materials.set('crate', tintedMaterial('wood', 0xc19a63));
    this.materials.set('crateDark', tintedMaterial('wood', 0x8d6c46));
    this.materials.set('barrelRed', tintedMaterial('metal', 0xb8341f, { roughness: 0.55 }));
    this.materials.set('barrelRust', tintedMaterial('metal', 0x7a5230, { roughness: 0.8 }));
    this.materials.set('barrelDark', tintedMaterial('metal', 0x3d4740, { roughness: 0.5 }));
    this.materials.set('barrier', tintedMaterial('concrete', 0xd8d2c2));
    this.materials.set('roofPanel', tintedMaterial('metal', 0x585c4e, { roughness: 0.7 }));
    this.materials.set('rock', tintedMaterial('concrete', 0x8a7c68, { roughness: 1 }));
    this.materials.set('mountain', tintedMaterial('concrete', 0x6a6058, { roughness: 1, metalness: 0 }));
    this.materials.set('vehicle', tintedMaterial('metal', 0x4c5540, { roughness: 0.65 }));
    this.materials.set('vehicleDark', tintedMaterial('metal', 0x232824, { roughness: 0.8 }));
    this.materials.set('tarp', tintedMaterial('camo', 0x77745a, { roughness: 0.95 }));
    this.materials.set('lamp', tintedMaterial('metal', 0x9aa09c, { roughness: 0.4 }));
    this.materials.set('rubber', tintedMaterial('plastic', 0x2a2a2c, { roughness: 0.95 }));
    void t;
  }

  /** Resolve a material key to a THREE material. */
  mat(key) {
    if (this.materials.has(key)) return this.materials.get(key);
    if (MATERIAL_NAMES.includes(key)) {
      let m = this.materials.get(key);
      if (!m) {
        m = getMaterial(key);
        this.materials.set(key, m);
      }
      return m;
    }
    return getMaterial('concrete');
  }

  push(material, geo) {
    let arr = this.groups.get(material);
    if (!arr) {
      arr = [];
      this.groups.set(material, arr);
    }
    arr.push(geo);
  }

  /**
   * Axis-aligned box: `cx,cz` is the footprint centre, `y0` the base height.
   * Set `o.collide = false` for decoration.
   */
  box(cx, cz, w, d, y0, h, matKey = 'concrete', o = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const dens = TEXDENS[matKey] ?? 0.42;
    scaleBoxUVs(geo, w, h, d, dens, o.uo || 0, o.vo || 0);
    if (o.rotY) geo.rotateY(o.rotY);
    if (o.rotZ) geo.rotateZ(o.rotZ);
    if (o.rotX) geo.rotateX(o.rotX);
    geo.translate(cx, y0 + h / 2, cz);
    this.push(this.mat(matKey), geo);
    const cw = o.collideBox ? o.collideBox[0] : w;
    const cd = o.collideBox ? o.collideBox[1] : d;
    if (o.collide !== false) {
      this.col.addBox(cx, cz, cw, cd, y0, h, o.surface || SURFACE_TAGS[matKey] || 'concrete', {
        thin: o.thin,
      });
    }
    return geo;
  }

  /** Vertical cylinder (posts, barrels, poles). */
  cyl(cx, cz, radius, h, y0, matKey = 'metal', o = {}) {
    const seg = o.seg || (radius > 0.7 ? 16 : 10);
    const geo = new THREE.CylinderGeometry(radius, radius * (o.taper ?? 1), h, seg, 1, false);
    const dens = TEXDENS[matKey] ?? 0.42;
    scaleBoxUVs(geo, radius * 2, h, radius * 2, dens, o.uo || 0, o.vo || 0);
    if (o.rotX) geo.rotateX(o.rotX);
    if (o.rotZ) geo.rotateZ(o.rotZ);
    geo.translate(cx, y0 + h / 2, cz);
    this.push(this.mat(matKey), geo);
    if (o.collide !== false) {
      this.col.addBox(cx, cz, radius * 2, radius * 2, y0, h, o.surface || SURFACE_TAGS[matKey], {});
    }
    return geo;
  }

  /** Horizontal ground patch — also registers the walkable surface. */
  pad(cx, cz, w, d, topY, matKey = 'concrete', o = {}) {
    const thick = 0.5;
    const geo = new THREE.PlaneGeometry(w, d, 1, 1);
    const dens = TEXDENS[matKey] ?? 0.42;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * w * dens + (o.uo || 0), uv.getY(i) * d * dens + (o.vo || 0));
    }
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, topY, cz);
    this.push(this.mat(matKey), geo);
    this.col.addBox(cx, cz, w, d, topY - thick, thick, o.surface || SURFACE_TAGS[matKey] || 'concrete');
    return geo;
  }

  ramp(cx, cz, w, d, y0, y1, matKey = 'concrete', axis = 'z') {
    const rise = y1 - y0;
    const len = Math.hypot(d, rise);
    const thickness = 0.3;
    const geo = new THREE.BoxGeometry(w, thickness, len);
    scaleBoxUVs(geo, w, thickness, len, TEXDENS[matKey] ?? 0.42);
    const angle = Math.atan2(rise, d);
    geo.rotateX(axis === 'z' ? -angle : 0);
    if (axis === 'x') geo.rotateZ(angle);
    geo.translate(cx, (y0 + y1) / 2 - (thickness / 2) * Math.cos(angle), cz);
    this.push(this.mat(matKey), geo);
    this.col.addRamp(cx, cz, w, d, y0, y1, axis, SURFACE_TAGS[matKey] || 'concrete');
    return geo;
  }

  /** Staircase made of stacked slabs (climbed by the step-up logic). */
  stairs(cx, cz, w, d, y0, y1, steps, matKey = 'concrete', axis = 'z') {
    const rise = y1 - y0;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const h = rise / steps;
      const seg = d / steps;
      if (axis === 'z') {
        this.box(cx, cz - d / 2 + seg * (i + 0.5), w, seg, y0, h * (i + 1), matKey, { collide: false });
        this.col.addBox(cx, cz - d / 2 + seg * (i + 0.5), w, seg, y0, h * (i + 1), SURFACE_TAGS[matKey] || 'concrete');
      } else {
        this.box(cx - d / 2 + seg * (i + 0.5), cz, seg, w, y0, h * (i + 1), matKey, { collide: false });
        this.col.addBox(cx - d / 2 + seg * (i + 0.5), cz, seg, w, y0, h * (i + 1), SURFACE_TAGS[matKey] || 'concrete');
      }
      void t;
    }
  }

  /** Railing: posts plus two rails, collision only on the top rail band. */
  railing(x0, z0, x1, z1, y0, matKey = 'metal', { collide = true, height = 1.05 } = {}) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    const posts = Math.max(2, Math.round(len / 1.6) + 1);
    for (let i = 0; i < posts; i++) {
      const t = i / (posts - 1);
      this.box(x0 + dx * t, z0 + dz * t, 0.09, 0.09, y0, height, matKey, { collide: false });
    }
    for (const hh of [height * 0.55, height * 0.98]) {
      this.box((x0 + x1) / 2, (z0 + z1) / 2, 0.07, len, y0 + hh, 0.07, matKey, {
        rotY: ang,
        collide: false,
        collideBox: [0.25, len],
      });
      // collideBox for a rotated rail is approximated below by an explicit thin box
    }
    if (collide) {
      const midX = (x0 + x1) / 2;
      const midZ = (z0 + z1) / 2;
      const w = Math.abs(dx) + 0.2;
      const d = Math.abs(dz) + 0.2;
      this.col.addBox(midX, midZ, w, d, y0 + height * 0.45, height * 0.55, 'metal', { thin: true });
    }
  }

  /** Sandbag revetment: a run of individual bags with jitter for a rough look. */
  sandbags(x0, z0, x1, z1, y0, rng, rows = 3) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    const bagW = 0.62;
    const count = Math.max(1, Math.round(len / bagW));
    for (let row = 0; row < rows; row++) {
      const h = 0.33;
      const shrink = row * 0.045;
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const jitterA = (rng() - 0.5) * 0.09;
        const jitterB = (rng() - 0.5) * 0.05;
        const cx = lerp(x0, x1, t) + Math.cos(ang) * jitterB;
        const cz = lerp(z0, z1, t) - Math.sin(ang) * jitterB;
        this.box(cx, cz, bagW * 1.02 + shrink * 0.5, bagW * 0.95 + shrink, y0 + row * h + jitterA * 0.1, h * 1.02, 'sandbag', {
          rotY: ang + (rng() - 0.5) * 0.12,
          collide: false,
          collideBox: [bagW * 1.15, bagW * 1.15],
        });
        if (row === 0 || (row === 1 && i % 2 === 0)) {
          this.col.addBox(cx, cz, bagW * 1.05, bagW * 1.05, y0 + row * h, h * 1.05, 'sand', {});
        }
      }
    }
  }

  finish(quality) {
    const meshes = [];
    this.groups.forEach((geos, material) => {
      if (!geos.length) return;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) return;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = true;
      this.scene.add(mesh);
      meshes.push(mesh);
      if (geos.length > 1) geos.forEach((g) => g.dispose());
    });
    void quality;
    return meshes;
  }
}

// ---------------------------------------------------------------------------

export class WorldMap {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.collision = new CollisionWorld(terrainHeight);
    this.spawnPoints = [];
    this.coverPoints = [];
    this.barrels = [];
    this.gates = [];
    this.meshes = [];
    this.playerStart = { x: 0, z: 14, yaw: Math.PI };
    this.build();
  }

  build() {
    const q = this.quality;
    const B = new Builder(this.scene, this.collision, q);
    const rng = mulberry32(1337);

    this._ground(B, q);
    this._perimeter(B, rng);
    this._commandPost(B, rng);
    this._towers(B, rng);
    this._containers(B, rng);
    this._emplacements(B, rng);
    this._yardProps(B, rng);
    this._vehicles(B, rng);
    this._fuelDepot(B, rng);
    this._mast(B);
    this._outside(B, rng);
    this._distant(B, rng);
    this.meshes = B.finish(q);
    this._grass(q, rng);

    // camera-visible surface bookkeeping for the effects system
    this.surfaceMeshes = this.meshes;
  }

  // ------------------------------------------------------------- ground -----

  _ground(B, q) {
    const size = 620;
    const seg = q.textureSize >= 256 ? 150 : 100;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(0xb59a6d);
    const dirt = new THREE.Color(0x7d6a4d);
    const rock = new THREE.Color(0x8a8378);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, terrainHeight(x, z));
      const h = clamp((terrainHeight(x, z) - 0.2) / 3.5, 0, 1);
      const r = Math.hypot(x, z);
      tmp.copy(sand).lerp(dirt, clamp(h * 1.6, 0, 1)).lerp(rock, smoothstep(120, 260, r) * 0.55);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const uv = geo.attributes.uv;
    const dens = TEXDENS.sand;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * size * dens, uv.getY(i) * size * dens);
    }
    const mat = getMaterial('sand').clone();
    mat.vertexColors = true;
    mat.roughness = 0.95;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.terrainMesh = mesh;

    // Compound surfaces: dirt yard with concrete pads and asphalt roads.
    B.pad(0, 0, 104, 104, 0.05, 'dirt');
    B.pad(-2, -8, 30, 20, 0.09, 'concrete');
    B.pad(0, 20, 62, 22, 0.07, 'asphalt');
    B.pad(0, -22, 58, 16, 0.07, 'asphalt');
    B.pad(-28, 0, 16, 52, 0.07, 'asphalt');
    B.pad(28, 0, 16, 52, 0.07, 'asphalt');
    B.pad(20, -18, 18, 16, 0.09, 'concrete');
    B.pad(18, 12, 16, 14, 0.09, 'concrete');
    B.pad(-30, -24, 20, 14, 0.09, 'concrete');
  }

  // ---------------------------------------------------------- perimeter -----

  _perimeter(B, rng) {
    const R = 45;
    const gap = 7; // gate width
    const panelH = 2.75;
    const sides = [
      { axis: 'x', sign: 1 }, // +Z side
      { axis: 'x', sign: -1 },
      { axis: 'z', sign: 1 }, // +X side
      { axis: 'z', sign: -1 },
    ];
    const addRun = (x0, z0, x1, z1) => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.round(len / 3.4));
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const mx = lerp(x0, x1, (t0 + t1) / 2);
        const mz = lerp(z0, z1, (t0 + t1) / 2);
        const ang = Math.atan2(dx, dz);
        // Chain-link: drawn, but it stops nothing — you can see and shoot
        // through it, so the wire never blinds the player or the AI. Hard
        // cover lives in the compound walls, sandbags and blast barriers.
        B.box(mx, mz, 0.05, len / steps, 0.06, panelH, 'fence', { rotY: ang, collide: false });
      }
      // posts + top rail
      const posts = Math.max(2, Math.round(len / 3.4));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        B.box(lerp(x0, x1, t), lerp(z0, z1, t), 0.11, 0.11, 0.06, panelH + 0.16, 'metal', { collide: false });
      }
      B.box((x0 + x1) / 2, (z0 + z1) / 2, 0.07, len, 0.06 + panelH + 0.1, 0.07, 'metal', {
        rotY: Math.atan2(dx, dz),
        collide: false,
      });
    };

    for (const s of sides) {
      const coords = [];
      // build a run per side, split around the central gate
      const segments = [
        [-R, -gap / 2],
        [gap / 2, R],
      ];
      for (const [a, b] of segments) {
        if (s.axis === 'x') {
          addRun(a, R * s.sign, b, R * s.sign);
        } else {
          addRun(R * s.sign, a, R * s.sign, b);
        }
      }
      coords.push(0);
      void coords;
      // gate markers
      const sign = s.sign;
      this.gates.push(
        s.axis === 'x'
          ? { x: 0, z: sign * R }
          : { x: sign * R, z: 0 }
      );
    }

    // Gate posts and warning barriers
    for (const g of this.gates) {
      const along = g.z !== 0 ? 'x' : 'z';
      for (const dir of [-1, 1]) {
        const px = along === 'x' ? g.x + dir * 3.5 : g.x;
        const pz = along === 'x' ? g.z : g.z + dir * 3.5;
        B.box(px, pz, 0.24, 0.24, 0.06, 3.3, 'concrete', { rotY: 0 });
      }
    }

    // Interior corner berms so the arena reads as a fortified position.
    const berms = [
      [-40, 40, 10, 2.6, 'x'],
      [40, 40, 10, 2.6, 'x'],
      [-40, -40, 10, 2.6, 'x'],
      [40, -40, 10, 2.6, 'x'],
    ];
    for (const [x, z, len, h] of berms) {
      B.sandbags(x - len / 2, z, x + len / 2, z, 0.05, rng, Math.round(h / 0.33));
      B.sandbags(x, z - len / 2, x, z + len / 2, 0.05, rng, Math.round(h / 0.33));
    }

    // Spawn ring: just outside the wire, each with an approach gate.
    const spawnAngles = [0.35, 0.9, 1.45, 2.0, 2.6, 3.2, 3.75, 4.3, 4.85, 5.4, 5.95, 0.05, 1.7, 3.5];
    for (let i = 0; i < spawnAngles.length; i++) {
      const a = spawnAngles[i];
      const r = 48 + (i % 3) * 4.5;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // pick the nearest gate as the approach waypoint
      let best = this.gates[0];
      let bestD = Infinity;
      for (const g of this.gates) {
        const d = Math.hypot(g.x - x, g.z - z);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
      // Staged ingress: hold outside the wire, pass through the gate, then
      // push into the compound. The fence square is convex, so the leg from
      // the spawn to the outer staging point never crosses the wire.
      const gl = Math.hypot(best.x, best.z) || 1;
      const dirX = best.x / gl;
      const dirZ = best.z / gl;
      // dir points outward from the compound centre, so the staging point is
      // outside the wire and the push point is inside it.
      const outer = { x: best.x + dirX * 7, z: best.z + dirZ * 7 };
      const inner = { x: best.x - dirX * 9, z: best.z - dirZ * 9 };
      this.spawnPoints.push({
        x,
        z,
        y: terrainHeight(x, z),
        path: [outer, { x: best.x, z: best.z }, inner],
        waypoint: inner,
        gate: best,
      });
    }

    // Cover positions used by the AI for flanking decisions.
    const coverSpots = [
      [-16, 20], [16, -18], [0, 26], [-30, -6], [28, 4], [6, -32], [-34, 14], [34, -12],
      [22, 18], [-22, -16], [12, 30], [-12, -30], [-38, -20], [38, 24], [10, 4], [-8, -2],
    ];
    for (const [x, z] of coverSpots) this.coverPoints.push(new THREE.Vector3(x, 0, z));
  }

  // ------------------------------------------------------- command post -----

  _commandPost(B, rng) {
    const cx = -2;
    const cz = -8;
    const W = 24;
    const D = 13;
    const wallT = 0.34;
    const wallH = 3.7;
    const x0 = cx - W / 2;
    const x1 = cx + W / 2;
    const z0 = cz - D / 2;
    const z1 = cz + D / 2;

    // floor slab (interior)
    B.pad(cx, cz, W - 0.2, D - 0.2, 0.19, 'concrete');
    // roof slab + parapet
    B.box(cx, cz, W + 0.5, D + 0.5, wallH, 0.32, 'concrete');
    B.pad(cx, cz, W + 0.4, D + 0.4, wallH + 0.33, 'concrete', { uo: 3, vo: 1 });

    const wallRun = (ax0, az0, ax1, az1, holes = []) => {
      // holes: [{at, width, bottom, top}] measured along the run
      const dx = ax1 - ax0;
      const dz = az1 - az0;
      const len = Math.hypot(dx, dz);
      const ang = Math.atan2(dx, dz);
      const cut = (s, e, yb, yt) => {
        const mid = (s + e) / 2;
        const px = lerp(ax0, ax1, mid / len);
        const pz = lerp(az0, az1, mid / len);
        const segLen = e - s;
        if (yt <= 0.01) return;
        if (yb <= 0.001) {
          B.box(px, pz, wallT, segLen, 0.19, yt, 'bricks', { rotY: ang, collide: false });
          B.col.addBox(px, pz, Math.abs(dx / len) * segLen + wallT, Math.abs(dz / len) * segLen + wallT, 0.19, yt, 'concrete');
        } else {
          // lintel above an opening
          B.box(px, pz, wallT, segLen, 0.19 + yb, yt - yb, 'bricks', { rotY: ang, collide: false });
          B.col.addBox(px, pz, Math.abs(dx / len) * segLen + wallT, Math.abs(dz / len) * segLen + wallT, 0.19 + yb, yt - yb, 'concrete');
        }
      };
      const sorted = holes.slice().sort((a, b) => a.at - b.at);
      let cursor = 0;
      for (const h of sorted) {
        const s = h.at - h.width / 2;
        const e = h.at + h.width / 2;
        if (s > cursor) cut(cursor, s, 0, wallH);
        // sill below the window
        if (h.bottom > 0.01) cut(s, e, 0, h.bottom);
        cut(s, e, h.top, wallH);
        // collidable sill
        if (h.bottom > 0.01) {
          const mid = (s + e) / 2;
          const px = lerp(ax0, ax1, mid / len);
          const pz = lerp(az0, az1, mid / len);
          B.col.addBox(px, pz, Math.abs(dx / len) * h.width + wallT, Math.abs(dz / len) * h.width + wallT, 0.19, h.bottom, 'concrete');
        }
        cursor = e;
      }
      if (cursor < len) cut(cursor, len, 0, wallH);
    };

    // south wall (z1) with two doors
    wallRun(x0, z1, x1, z1, [
      { at: 6.4, width: 2.6, bottom: 0, top: 2.4 },
      { at: 17.6, width: 2.6, bottom: 0, top: 2.4 },
    ]);
    // north wall (z0) with a door and a window
    wallRun(x0, z0, x1, z0, [
      { at: 12, width: 2.6, bottom: 0, top: 2.4 },
      { at: 4, width: 2.2, bottom: 1.1, top: 2.3 },
    ]);
    // west wall (x0)
    wallRun(x0, z0, x0, z1, [{ at: 6.5, width: 2.4, bottom: 1.1, top: 2.3 }]);
    // east wall (x1)
    wallRun(x1, z0, x1, z1, [{ at: 4.5, width: 2.4, bottom: 1.1, top: 2.3 }]);

    // interior partitions
    B.box(cx + 4, cz - 4.2, 0.28, 4.6, 0.19, wallH - 0.5, 'bricks');
    B.box(cx - 6, cz - 1.5, 0.28, 4.4, 0.19, wallH - 0.5, 'bricks');
    // roof access parapet breaks + sandbag firing positions
    B.sandbags(x0 + 1, z1 - 1.1, x0 + 7, z1 - 1.1, wallH + 0.33, rng, 2);
    B.sandbags(x1 - 7, z0 + 1.1, x1 - 1, z0 + 1.1, wallH + 0.33, rng, 2);

    // external stair (ramp) up the west side + landing
    B.ramp(x0 - 3.2, cz + 1.5, 2.8, 8.4, 0.05, wallH + 0.33, 'concrete', 'z');
    B.box(x0 - 1.6, cz + 5.7, 2.8, 2.6, wallH + 0.03, 0.3, 'concrete');
    B.railing(x0 - 4.6, cz - 2.7, x0 - 4.6, cz + 6.6, 0.05, 'metal', { height: 1.1 });
    B.railing(x0 - 1.8, cz + 7.0, x0, cz + 7.0, wallH + 0.33, 'metal', { height: 1.0, collide: false });

    // interior clutter
    for (let i = 0; i < 9; i++) {
      const bx = x0 + 2.2 + rng() * (W - 5);
      const bz = z0 + 1.6 + rng() * (D - 3.4);
      const s = 0.85 + rng() * 0.35;
      B.box(bx, bz, s, s, 0.19, s, rng() > 0.5 ? 'crate' : 'crateDark', { rotY: (rng() - 0.5) * 0.7, collideBox: [s * 1.25, s * 1.25] });
    }
    // roof hatch box + antenna
    B.box(cx + 2, cz - 2, 1.4, 1.4, wallH + 0.65, 1.1, 'roofPanel');
    B.cyl(cx + 2, cz - 2, 0.06, 3.4, wallH + 1.7, 'metal');

    this.commandPost = { x: cx, z: cz, w: W, d: D, roofY: wallH + 0.65 };
  }

  // -------------------------------------------------------------- towers ----

  _towers(B, rng) {
    const towers = [
      { x: -33, z: 30, ry: 0.4 },
      { x: 33, z: 26, ry: -0.5 },
      { x: 30, z: -32, ry: 2.2 },
    ];
    this.towers = [];
    for (const t of towers) {
      const legH = 4.9;
      const s = 1.5;
      for (const [ox, oz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
        B.box(t.x + ox, t.z + oz, 0.24, 0.24, 0.05, legH, 'metal');
      }
      // cross bracing
      for (const y of [1.6, 3.4]) {
        B.box(t.x, t.z, s * 2, 0.12, y, 0.12, 'metal', { collide: false });
        B.box(t.x, t.z, 0.12, s * 2, y, 0.12, 'metal', { collide: false });
      }
      // platform
      B.box(t.x, t.z, 3.9, 3.9, legH, 0.3, 'wood');
      B.pad(t.x, t.z, 3.8, 3.8, legH + 0.31, 'wood');
      // railings
      const r = 1.85;
      B.railing(t.x - r, t.z - r, t.x + r, t.z - r, legH + 0.3, 'metal');
      B.railing(t.x - r, t.z + r, t.x + r, t.z + r, legH + 0.3, 'metal');
      B.railing(t.x - r, t.z - r, t.x - r, t.z + r, legH + 0.3, 'metal');
      B.railing(t.x + r, t.z - r, t.x + r, t.z + r, legH + 0.3, 'metal');
      // roof + sandbags
      B.box(t.x, t.z, 3.4, 3.4, legH + 3.1, 0.14, 'corrugated', { rotY: 0.1 });
      for (const [ox, oz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
        B.box(t.x + ox * 0.7, t.z + oz * 0.7, 0.16, 0.16, legH + 0.3, 3.1, 'metal', { collide: false });
      }
      B.sandbags(t.x - 1.5, t.z - 1.5, t.x + 1.5, t.z - 1.5, legH + 0.31, rng, 2);
      // access ramp on the inner side
      const dir = Math.sign(-t.x) || 1;
      const rampX = t.x + dir * 5.4;
      B.ramp(rampX, t.z, 2.4, 8.6, 0.05, legH + 0.31, 'metal', 'z');
      B.box(rampX, t.z - 5.4, 2.4, 1.4, legH + 0.01, 0.3, 'metal');
      B.railing(rampX - 1.3, t.z - 4.3, rampX - 1.3, t.z + 4.3, 0.05, 'metal', { height: 1.05 });
      B.railing(rampX + 1.3, t.z - 4.3, rampX + 1.3, t.z + 4.3, 0.05, 'metal', { height: 1.05 });
      // searchlight
      B.cyl(t.x, t.z, 0.55, 0.5, legH + 3.3, 'lamp', { rotX: Math.PI / 2 });
      // Tower garrison: hold the platform and shoot from elevation.
      this.spawnPoints.push({
        x: t.x + (dir > 0 ? 0.9 : -0.9),
        z: t.z + 0.9,
        y: legH + 0.31,
        tower: true,
        stationary: true,
        towerY: legH + 0.31,
      });
      this.coverPoints.push(new THREE.Vector3(t.x, legH + 0.31, t.z));
      this.towers.push({ x: t.x, z: t.z, platformY: legH + 0.31 });
      void t.ry;
    }
  }

  // ---------------------------------------------------------- containers ----

  _containers(B, rng) {
    const place = (x, z, len, along, y0, matKey, rot = 0) => {
      const w = along === 'x' ? len : 2.6;
      const d = along === 'x' ? 2.6 : len;
      B.box(x, z, w, d, y0, 2.72, matKey, { rotY: rot, collideBox: [w, d] });
      // corrugation ribs on the long sides
      const ribs = Math.round(len / 0.9);
      for (let i = 0; i <= ribs; i++) {
        const t = i / ribs - 0.5;
        const rx = along === 'x' ? x + t * len : x + (along === 'x' ? 0 : 1.32);
        const rz = along === 'x' ? z + 1.32 : z + t * len;
        B.box(rx, rz, along === 'x' ? 0.16 : 0.12, along === 'x' ? 0.12 : 0.16, y0 + 0.1, 2.5, 'metal', { collide: false });
        if (along === 'x') B.box(rx, 2 * z - rz, 0.16, 0.12, y0 + 0.1, 2.5, 'metal', { collide: false });
        else B.box(2 * x - rx, rz, 0.12, 0.16, y0 + 0.1, 2.5, 'metal', { collide: false });
      }
      // door seam
      B.box(along === 'x' ? x + len / 2 : x, along === 'x' ? z : z + len / 2, along === 'x' ? 0.1 : 2.6, along === 'x' ? 2.6 : 0.1, y0 + 0.1, 2.4, 'metal', { collide: false });
      this.coverPoints.push(new THREE.Vector3(x, y0, z));
    };

    // Cluster A near the east concrete pad
    place(17, 7.5, 6.6, 'x', 0.09, 'containerRed');
    place(17, 10.6, 6.6, 'x', 0.09, 'containerGreen');
    place(17, 7.5, 6.6, 'x', 2.81, 'containerBlue', -0.02);
    place(24.5, 9, 6.2, 'z', 0.09, 'containerTan');
    // crate stair up to the container roof
    B.box(13.2, 7.5, 1.1, 1.1, 0.09, 0.9, 'crate');
    B.box(13.2, 7.5, 1.1, 1.1, 0.99, 0.9, 'crateDark');
    B.box(12.1, 7.5, 1.2, 1.2, 1.89, 0.9, 'crate');
    B.ramp(11.1, 7.5, 1.6, 2.2, 2.79, 2.81, 'wood', 'z');

    // Cluster B on the west side
    place(-30, -24, 6.6, 'z', 0.09, 'containerGreen');
    place(-26.6, -27, 6.6, 'x', 0.09, 'containerBlue');
    place(-26.6, -24, 6.2, 'z', 2.81, 'containerTan', 0.03);

    // Lone container at the north gate for cover
    place(-6, -34, 6.4, 'x', 0.05, 'containerRed', 0.06);

    // Tarped pallets
    for (let i = 0; i < 4; i++) {
      const x = -20 + i * 2.4 + rng() * 1.2;
      const z = 30 + rng() * 3;
      B.box(x, z, 1.6, 1.3, 0.05, 1.1, 'tarp', { rotY: (rng() - 0.5) * 0.6, collideBox: [1.9, 1.7] });
    }
  }

  // ------------------------------------------------------- emplacements -----

  _emplacements(B, rng) {
    const nests = [
      { x: -16, z: 20, facing: 'e' },
      { x: 16, z: -18, facing: 'w' },
      { x: 0, z: 27, facing: 's' },
      { x: -30, z: -6, facing: 'e' },
      { x: 28, z: 4, facing: 'w' },
      { x: 6, z: -31, facing: 'n' },
    ];
    for (const n of nests) {
      const L = 5.2;
      const H = 1.35;
      // two arms + back wall forming a U facing outward
      let ax0;
      let az0;
      let ax1;
      let az1;
      let bx0;
      let bz0;
      let bx1;
      let bz1;
      let cx0;
      let cz0;
      let cx1;
      let cz1;
      const back = 1.6;
      if (n.facing === 'e' || n.facing === 'w') {
        const s = n.facing === 'e' ? 1 : -1;
        ax0 = n.x - s * back;
        az0 = n.z - L / 2;
        ax1 = n.x - s * back;
        az1 = n.z + L / 2;
        bx0 = n.x - s * back;
        bz0 = n.z - L / 2;
        bx1 = n.x + s * back;
        bz1 = n.z - L / 2;
        cx0 = n.x - s * back;
        cz0 = n.z + L / 2;
        cx1 = n.x + s * back;
        cz1 = n.z + L / 2;
      } else {
        const s = n.facing === 's' ? 1 : -1;
        ax0 = n.x - L / 2;
        az0 = n.z - s * back;
        ax1 = n.x + L / 2;
        az1 = n.z - s * back;
        bx0 = n.x - L / 2;
        bz0 = n.z - s * back;
        bx1 = n.x - L / 2;
        bz1 = n.z + s * back;
        cx0 = n.x + L / 2;
        cz0 = n.z - s * back;
        cx1 = n.x + L / 2;
        cz1 = n.z + s * back;
      }
      const rows = Math.round(H / 0.33);
      B.sandbags(ax0, az0, ax1, az1, 0.05, rng, rows);
      B.sandbags(bx0, bz0, bx1, bz1, 0.05, rng, rows);
      B.sandbags(cx0, cz0, cx1, cz1, 0.05, rng, rows);
      // ammo crate inside the nest
      const off = n.facing === 'e' ? -1.1 : n.facing === 'w' ? 1.1 : 0;
      B.box(n.x + off, n.z + (n.facing === 's' ? -1.1 : n.facing === 'n' ? 1.1 : 0), 1.1, 0.8, 0.05, 0.55, 'crateDark');
      // mounted machine gun prop
      const gunY = 1.15;
      const gx = n.x + (n.facing === 'w' ? 1.2 : n.facing === 'e' ? -1.2 : 0);
      const gz = n.z + (n.facing === 'n' ? 1.2 : n.facing === 's' ? -1.2 : 0);
      B.cyl(gx, gz, 0.07, 0.85, 0.05, 'metal');
      B.box(gx, gz, 1.35, 0.16, gunY, 0.2, 'metal', { rotY: n.facing === 'e' || n.facing === 'w' ? 0 : Math.PI / 2, collide: false });
      B.box(gx, gz, 0.2, 0.16, gunY + 0.2, 0.22, 'metal', { collide: false });
      this.coverPoints.push(new THREE.Vector3(n.x, 0, n.z));
    }

    // Jersey barriers along the main road
    const barriers = [
      [-14, 20, 4, 'x'], [-6, 20, 4, 'x'], [4, 20, 4, 'x'], [14, 20, 4, 'x'],
      [-20, -18, 3.2, 'x'], [-24, 12, 3.2, 'z'], [22, -22, 3.2, 'z'], [10, -28, 3.2, 'x'],
    ];
    for (const [x, z, len, ax] of barriers) {
      const w = ax === 'x' ? len : 0.55;
      const d = ax === 'x' ? 0.55 : len;
      B.box(x, z, w, d + 0.0, 0.07, 0.42, 'barrier');
      B.box(x, z, ax === 'x' ? len : 0.3, ax === 'x' ? 0.3 : len, 0.49, 0.52, 'barrier', { collide: false });
    }
  }

  // ------------------------------------------------------------ yard --------

  _yardProps(B, rng) {
    // Crates
    const stacks = 14;
    for (let i = 0; i < stacks; i++) {
      const x = (rng() - 0.5) * 78;
      const z = (rng() - 0.5) * 78;
      if (Math.hypot(x + 2, z + 8) < 16) continue;
      const n = randInt(1, 3);
      const s = 0.95;
      for (let k = 0; k < n; k++) {
        B.box(
          x + (rng() - 0.5) * 0.3,
          z + (rng() - 0.5) * 0.3,
          s * (1 - k * 0.06),
          s * (1 - k * 0.06),
          0.05 + k * s,
          s,
          k === 1 ? 'crateDark' : 'crate',
          { rotY: (rng() - 0.5) * 0.5, collideBox: [s * 1.2, s * 1.2] }
        );
      }
    }

    // Oil drums (some tipped)
    for (let i = 0; i < 26; i++) {
      const x = (rng() - 0.5) * 84;
      const z = (rng() - 0.5) * 84;
      if (Math.hypot(x + 2, z + 8) < 15) continue;
      const tipped = rng() > 0.78;
      const key = rng() > 0.6 ? 'barrelRust' : 'barrelDark';
      if (tipped) {
        B.cyl(x, z, 0.33, 0.95, 0.05, key, { rotX: Math.PI / 2, collide: false });
        B.col.addBox(x, z, 0.7, 0.7, 0.05, 0.66, 'metal');
      } else {
        B.cyl(x, z, 0.33, 0.95, 0.05, key);
      }
    }

    // Explosive fuel drums (red): standalone meshes so they can be removed
    // when they detonate, and registered as damageable world targets.
    const barrels = [
      [10, -12], [-13, 9], [22, 22], [-24, 28], [30, -6], [-8, 32],
    ];
    const barrelMat = B.mat('barrelRed');
    const capMat = B.mat('metal');
    for (const [x, z] of barrels) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.02, 14, 1, false), barrelMat);
      body.castShadow = true;
      body.receiveShadow = true;
      body.position.y = 0.51;
      group.add(body);
      for (const y of [0.34, 0.68]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.375, 0.028, 6, 14), capMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        ring.castShadow = true;
        group.add(ring);
      }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 8, 1, false), capMat);
      cap.position.set(0.14, 1.05, 0);
      group.add(cap);
      group.position.set(x, 0.05, z);
      this.scene.add(group);
      const record = { x, y: 0.05, z, radius: 0.46, alive: true, health: 45, height: 1.05, mesh: group };
      this.barrels.push(record);
      B.col.addBox(x, z, 0.74, 0.74, 0.05, 1.05, 'metal');
    }

    // Light poles
    const poles = [
      [-14, 26], [14, 26], [-20, -30], [26, -22], [-36, 8], [36, -8], [0, -40],
    ];
    for (const [x, z] of poles) {
      B.cyl(x, z, 0.14, 7.2, 0.05, 'lamp');
      B.box(x, z + 0.6, 0.3, 1.4, 7.0, 0.22, 'lamp');
      B.box(x, z + 1.2, 0.5, 0.6, 6.8, 0.3, 'lamp', { collide: false });
    }

    // Concrete blocks & rubble piles around the perimeter
    for (let i = 0; i < 18; i++) {
      const a = rng() * TAU;
      const r = 34 + rng() * 9;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 1.1 + rng() * 0.8;
      B.box(x, z, s * 1.6, s, 0.05, s * 0.8, 'concrete', {
        rotY: rng() * TAU,
        collideBox: [s * 1.8, s * 1.8],
      });
    }

    // Rubble / rocks
    for (let i = 0; i < 60; i++) {
      const a = rng() * TAU;
      const r = 12 + rng() * 40;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x + 2, z + 8) < 17) continue;
      const s = 0.16 + rng() * 0.5;
      B.cyl(x, z, s, s * (0.6 + rng() * 0.8), 0.05, 'rock', { seg: 6, collide: false });
    }
  }

  // --------------------------------------------------------- vehicles -------

  _vehicles(B, rng) {
    const buildVehicle = (x, z, rot, matKey, wrecked) => {
      const bodyY = 0.52;
      // chassis
      B.box(x, z, 2.35, 4.9, bodyY, 0.75, matKey, { rotY: rot, collideBox: [3.2, 5.4], surface: 'metal' });
      // cabin
      B.box(x - Math.sin(rot) * 0.55, z - Math.cos(rot) * 0.55, 2.15, 2.0, bodyY + 0.75, 0.85, matKey, {
        rotY: rot, collideBox: [2.6, 2.6],
      });
      // hood + bed
      B.box(x + Math.sin(rot) * 1.7, z + Math.cos(rot) * 1.7, 2.1, 1.1, bodyY + 0.75, 0.4, matKey, { rotY: rot, collide: false });
      // roll bar
      B.box(x - Math.sin(rot) * 1.7, z - Math.cos(rot) * 1.7, 2.0, 0.18, bodyY + 1.15, 1.0, matKey, { rotY: rot, collide: false });
      // wheels
      for (const [ox, oz] of [[-1.25, 1.6], [1.25, 1.6], [-1.25, -1.6], [1.25, -1.6]]) {
        const wx = x + ox * Math.cos(rot) - oz * Math.sin(rot);
        const wz = z - ox * Math.sin(rot) - oz * Math.cos(rot);
        B.cyl(wx, wz, 0.52, 0.34, 0, 'rubber', { rotZ: Math.PI / 2, seg: 14, collide: false });
      }
      if (wrecked) {
        B.box(x, z, 2.3, 4.6, bodyY + 1.4, 0.25, 'vehicleDark', { rotY: rot, collide: false });
        B.cyl(x + 1.2, z, 0.5, 2.2, 0.1, 'vehicleDark', { rotX: Math.PI / 2, collide: false });
      } else {
        // roof-mounted gun
        B.cyl(x - Math.sin(rot) * 0.55, z - Math.cos(rot) * 0.55, 0.08, 0.5, bodyY + 1.6, 'metal');
        B.box(x - Math.sin(rot) * 0.55, z - Math.cos(rot) * 0.55, 1.5, 0.18, bodyY + 2.0, 0.2, 'metal', { rotY: rot, collide: false });
      }
      // stowage crate
      B.box(x, z + 1.9, 1.2, 0.8, bodyY + 0.75, 0.5, 'crateDark', { rotY: rot, collide: false });
      this.coverPoints.push(new THREE.Vector3(x, 0.5, z));
    };

    buildVehicle(11, 22, 0.22, 'vehicle', false);
    buildVehicle(-19, 6, 2.4, 'vehicle', false);
    buildVehicle(-34, 30, 1.1, 'vehicleDark', true);
    buildVehicle(24, -30, -0.6, 'vehicleDark', true);
    void rng;
  }

  // ------------------------------------------------------- fuel depot -------

  _fuelDepot(B, rng) {
    const x = 24;
    const z = -18;
    // shed
    const w = 8;
    const d = 5.4;
    const h = 3.1;
    B.box(x, z - d / 2, w, 0.3, 0.09, h, 'corrugated');
    B.box(x, z + d / 2, w, 0.3, 0.09, h, 'corrugated');
    B.box(x - w / 2, z, 0.3, d, 0.09, h, 'corrugated');
    B.box(x + w / 2, z, 0.3, d, 0.09, h, 'corrugated');
    B.box(x + 1.5, z + d / 2, 2.2, 0.3, 0.09, 2.2, 'corrugated', { collide: false }); // doorway
    B.box(x, z, w + 0.6, d + 0.6, h, 0.22, 'roofPanel', { rotX: 0.06 });
    B.sandbags(x - w / 2 - 2, z - d / 2 - 1, x - w / 2 - 2, z + d / 2 + 1, 0.09, rng, 3);
    // pumps + drums
    B.box(x, z + d / 2 + 1.6, 0.9, 0.9, 0.09, 1.5, 'metal');
    B.box(x + 1.4, z + d / 2 + 1.6, 0.9, 0.9, 0.09, 1.5, 'barrelRust');
    for (let i = 0; i < 5; i++) {
      B.cyl(x - 5 + i * 1.1, z + d / 2 + 3.4, 0.34, 0.98, 0.09, i % 2 ? 'barrelRust' : 'barrelDark');
    }
    // spill stain
    B.pad(x, z + d / 2 + 2.2, 6, 5, 0.1, 'asphalt', { uo: 2 });
  }

  // ------------------------------------------------------------- mast -------

  _mast(B) {
    const x = -13;
    const z = 15;
    const h = 15;
    const s = 0.75;
    for (const [ox, oz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
      B.box(x + ox, z + oz, 0.14, 0.14, 0.05, h, 'metal');
    }
    for (let i = 1; i < 9; i++) {
      const y = i * (h / 9);
      const shrink = 1 - i * 0.055;
      B.box(x, z, s * 2 * shrink, 0.09, y, 0.09, 'metal', { collide: false });
      B.box(x, z, 0.09, s * 2 * shrink, y, 0.09, 'metal', { collide: false });
      B.box(x, z, s * 1.4 * shrink, 0.07, y - h / 18, 5.4, 'metal', { rotZ: 0.62, collide: false });
    }
    B.box(x, z, 1.6, 1.6, h, 0.3, 'metal');
    B.cyl(x, z, 0.06, 2.2, h + 0.3, 'metal');
    B.cyl(x, z, 1.1, 0.28, h + 2.4, 'lamp', { rotX: 0.25, seg: 16 });
    // guy wires
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const ex = x + Math.cos(a) * 6.5;
      const ez = z + Math.sin(a) * 6.5;
      B.box((x + ex) / 2, (z + ez) / 2, 0.05, Math.hypot(ex - x, ez - z), 0.05, h * 0.8, 'metal', {
        rotY: Math.atan2(ex - x, ez - z),
        rotZ: 0.42,
        collide: false,
      });
      B.cyl(ex, ez, 0.14, 0.5, 0.05, 'metal');
    }
    this.coverPoints.push(new THREE.Vector3(x, 0, z));
  }

  // ------------------------------------------------ outside the wire --------

  _outside(B, rng) {
    // Approach cover on the spawn ring so attackers aren't in the open.
    const rng2 = mulberry32(88);
    for (let i = 0; i < 26; i++) {
      const a = rng2() * TAU;
      const r = 48 + rng2() * 16;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const kind = rng2();
      const y = terrainHeight(x, z);
      if (kind < 0.34) {
        // HESCO bastion
        const len = 4 + rng2() * 3;
        const ang = rng2() * TAU;
        B.box(x, z, len, 1.7, y - 0.3, 2.2, 'sandbag', { rotY: ang, collideBox: [len * 0.8, len * 0.8], surface: 'sand' });
      } else if (kind < 0.6) {
        // concrete blast wall
        B.box(x, z, 3.4, 0.5, y - 0.3, 2.4, 'concrete', { rotY: rng2() * TAU, collideBox: [3.0, 3.0] });
      } else if (kind < 0.78) {
        // rock outcrop
        const s = 1.4 + rng2() * 1.6;
        B.cyl(x, z, s, s * (0.8 + rng2() * 0.9), y - 0.5, 'rock', { seg: 7, collide: false });
        B.col.addBox(x, z, s * 1.5, s * 1.5, y - 0.5, s * 1.1, 'sand');
      } else {
        // wrecked hulk / drum cluster
        for (let k = 0; k < 3; k++) {
          B.cyl(x + k * 1.1 - 1.1, z + (rng2() - 0.5), 0.34, 1, y - 0.1, k % 2 ? 'barrelRust' : 'barrelDark');
        }
      }
    }

    // Dead trees + scrub scattered across the dunes
    for (let i = 0; i < 70; i++) {
      const a = rng() * TAU;
      const r = 60 + rng() * 110;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeight(x, z);
      if (rng() > 0.55) {
        const h = 2.4 + rng() * 3.4;
        B.cyl(x, z, 0.14, h, y, 'wood', { seg: 6, collide: false });
        for (let k = 0; k < 3; k++) {
          const ang = rng() * TAU;
          B.box(x, z, 0.09, 1.6 + rng(), y + h * (0.55 + k * 0.13), 0.09, 'wood', {
            rotY: ang,
            rotZ: 0.5 + rng() * 0.4,
            collide: false,
          });
        }
      } else {
        const s = 0.5 + rng() * 0.8;
        B.cyl(x, z, s, s * 0.9, y, 'rock', { seg: 5, collide: false });
      }
    }

    // Outer berm so the arena reads as a bowl
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU;
      const r = 96 + Math.sin(a * 3) * 6;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeight(x, z);
      B.box(x, z, 16, 7, y - 1.5, 3 + Math.sin(a * 5) * 0.8, 'sand', {
        rotY: a + Math.PI / 2,
        collideBox: [10, 10],
        surface: 'sand',
      });
    }
  }

  // ------------------------------------------------------- distant set ------

  _distant(B, rng) {
    // Mountain ring — flat-shaded cones fading into the haze.
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU + rng() * 0.14;
      const r = 250 + rng() * 90;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = 26 + rng() * 44;
      const rad = 40 + rng() * 46;
      const geo = new THREE.ConeGeometry(rad, h, 5 + ((rng() * 3) | 0), 1);
      geo.translate(x, h / 2 - 6, z);
      geo.rotateY(rng() * TAU);
      B.push(B.mat('mountain'), geo);
    }
    // Two distant structures on the horizon
    B.box(-120, 170, 26, 26, 0, 30, 'concrete', { collide: false });
    B.box(160, -140, 34, 22, 0, 22, 'concrete', { collide: false });
    B.cyl(150, -150, 2.2, 46, 22, 'metal', { seg: 8, collide: false });
  }

  // ---------------------------------------------------------- grass ---------

  _grass(q, rng) {
    if (!q.grass) return;
    const tex = grassTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.4,
    });
    const count = 900;
    const geo = new THREE.PlaneGeometry(0.9, 0.7);
    const g2 = geo.clone();
    g2.rotateY(Math.PI / 2);
    const merged = mergeGeometries([geo, g2], false);
    const inst = new THREE.InstancedMesh(merged, mat, count);
    const m = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 8) {
      const a = rng() * TAU;
      const r = 14 + Math.sqrt(rng()) * 66;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (this.collision.overlaps(x, z, 0.5, 0.2, 1.2)) continue;
      if (Math.hypot(x + 2, z + 8) < 15) continue;
      const y = this.collision.groundAt(x, z, 999);
      q4.setFromEuler(new THREE.Euler(0, rng() * TAU, 0));
      v.set(x, y + 0.25, z);
      const sc = 0.6 + rng() * 0.9;
      s.set(sc, sc * (0.7 + rng() * 0.6), sc);
      m.compose(v, q4, s);
      inst.setMatrixAt(placed++, m);
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = true;
    inst.computeBoundingSphere();
    this.scene.add(inst);
    this.meshes.push(inst);
  }

  getBarrels() {
    return this.barrels;
  }
}
