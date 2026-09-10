// ---------------------------------------------------------------------------
// Enemy soldiers: procedurally modelled, procedurally animated, and driven by
// a small state machine (advance / engage / suppress / flank / dead).
//
// The body is merged into four vertex-coloured parts (torso, head, two legs)
// which keeps a fully animated soldier at four draw calls each while still
// supporting per-enemy material fading on death.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getMaterial } from '../core/Textures.js';
import { clamp, clamp01, damp, lerp, rand, randInt, pick, chance, TAU, DEG } from '../core/Utils.js';

// ------------------------------------------------------------ geometry -----

const PALETTE = {
  camoA: 0x4a5038,
  camoB: 0x39402d,
  camoC: 0x5c5c40,
  camoD: 0x2c3124,
  gear: 0x22251f,
  gearLight: 0x3a3f34,
  skin: 0x9a7a5e,
  boot: 0x14150f,
  metal: 0x2b2d2c,
  helmet: 0x35392c,
  visor: 0x121a1c,
};

function applyColor(geo, color, camoSeed = 0) {
  const c = new THREE.Color(color);
  const pos = geo.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const tmp = new THREE.Color();
  const camo = camoSeed > 0;
  for (let i = 0; i < n; i++) {
    if (camo) {
      // quantise space into blobs for a blocky BDU pattern
      const gx = Math.floor(pos.getX(i) * 9 + camoSeed * 3.1);
      const gy = Math.floor(pos.getY(i) * 9 + camoSeed * 1.7);
      const gz = Math.floor(pos.getZ(i) * 9 + camoSeed * 2.3);
      const h = ((gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791)) >>> 0;
      const k = (h % 1000) / 1000;
      tmp.setHex(
        k < 0.3 ? PALETTE.camoA : k < 0.58 ? PALETTE.camoB : k < 0.84 ? PALETTE.camoC : PALETTE.camoD
      );
      tmp.multiplyScalar(0.92 + ((h >> 7) % 100) / 500);
    } else {
      tmp.copy(c);
    }
    arr[i * 3] = tmp.r;
    arr[i * 3 + 1] = tmp.g;
    arr[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function part(geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, camoSeed = 0) {
  applyColor(geo, color, camoSeed);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

const box = (w, h, d, sx = 1, sy = 1, sz = 1) => new THREE.BoxGeometry(w, h, d, sx, sy, sz);
const cyl = (r0, r1, h, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg, 1);

let GEO_CACHE = null;

export function soldierGeometry() {
  if (GEO_CACHE) return GEO_CACHE;

  // ---- torso group: chest, vest, pouches, arms held on the rifle, weapon ---
  const body = [];
  body.push(part(box(0.42, 0.56, 0.26, 4, 5, 3), PALETTE.camoA, 0, 1.22, 0, 0, 0, 0, 1));
  // plate carrier
  body.push(part(box(0.40, 0.42, 0.30, 3, 3, 3), PALETTE.gear, 0, 1.26, -0.005));
  body.push(part(box(0.10, 0.12, 0.07), PALETTE.gearLight, -0.12, 1.16, -0.17));
  body.push(part(box(0.10, 0.12, 0.07), PALETTE.gearLight, 0.12, 1.16, -0.17));
  body.push(part(box(0.20, 0.14, 0.08), PALETTE.gearLight, 0, 1.36, -0.18));
  // shoulders
  body.push(part(box(0.16, 0.16, 0.22), PALETTE.gear, -0.26, 1.42, 0));
  body.push(part(box(0.16, 0.16, 0.22), PALETTE.gear, 0.26, 1.42, 0));
  // hips
  body.push(part(box(0.38, 0.22, 0.25, 3, 2, 2), PALETTE.camoB, 0, 0.9, 0, 0, 0, 0, 2));
  // belt + canteen
  body.push(part(box(0.40, 0.07, 0.27), PALETTE.gear, 0, 1.0, 0));
  body.push(part(box(0.1, 0.14, 0.08), PALETTE.gearLight, 0.19, 0.95, 0.12));
  // arms in a rifle-carry pose
  const armL = [
    part(box(0.13, 0.44, 0.15, 2, 3, 2), PALETTE.camoA, 0, 0, 0, 0.55, 0, 0.16, 3),
    part(box(0.12, 0.36, 0.13, 2, 3, 2), PALETTE.camoB, 0, 0, 0, -0.9, 0, -0.6, 4),
  ];
  body.push(...armL.map((g) => g.translate(-0.30, 1.34, 0.0)));
  const armR = [
    part(box(0.13, 0.42, 0.15, 2, 3, 2), PALETTE.camoA, 0, 0, 0, 0.32, 0, -0.2, 5),
    part(box(0.12, 0.34, 0.13, 2, 3, 2), PALETTE.camoB, 0, 0, 0, -1.05, 0, 0.5, 6),
  ];
  body.push(...armR.map((g) => g.translate(0.30, 1.3, -0.06)));
  // gloves
  body.push(part(box(0.11, 0.11, 0.13), PALETTE.gear, -0.17, 1.16, -0.30));
  body.push(part(box(0.11, 0.11, 0.13), PALETTE.gear, 0.16, 1.14, -0.24));
  // rifle held across the chest
  body.push(part(box(0.06, 0.09, 0.52), PALETTE.metal, 0.0, 1.2, -0.30, 0, 0.14, 0));
  body.push(part(box(0.05, 0.06, 0.34), PALETTE.metal, -0.03, 1.2, -0.6, 0, 0.14, 0));
  body.push(part(box(0.05, 0.14, 0.09), PALETTE.metal, 0.02, 1.12, -0.26, 0, 0.14, 0));
  body.push(part(cyl(0.012, 0.012, 0.3), PALETTE.metal, -0.09, 1.22, -0.72, Math.PI / 2, 0, 0.14));

  // ---- head -------------------------------------------------------------
  const head = [];
  head.push(part(box(0.19, 0.23, 0.21, 2, 2, 2), PALETTE.skin, 0, 0, 0.01));
  head.push(part(box(0.20, 0.08, 0.09), PALETTE.gear, 0, 0.09, -0.07)); // goggles
  head.push(part(box(0.06, 0.05, 0.05), PALETTE.visor, -0.055, 0.085, -0.11));
  head.push(part(box(0.06, 0.05, 0.05), PALETTE.visor, 0.055, 0.085, -0.11));
  // helmet
  head.push(part(cyl(0.135, 0.145, 0.13, 12), PALETTE.helmet, 0, 0.15, 0));
  head.push(part(box(0.21, 0.06, 0.24), PALETTE.helmet, 0, 0.11, 0.005));
  head.push(part(box(0.05, 0.1, 0.06), PALETTE.gear, 0.09, 0.1, 0.06));
  head.push(part(box(0.10, 0.05, 0.12), PALETTE.camoC, 0, 0.2, 0, 0, 0, 0, 7));

  // ---- legs -------------------------------------------------------------
  const leg = (side) => {
    const s = side;
    return [
      part(box(0.16, 0.42, 0.19, 2, 3, 2), PALETTE.camoA, 0, 0, 0, 0, 0, s * 0.03, 8 + side),
      part(box(0.14, 0.40, 0.16, 2, 3, 2), PALETTE.camoB, 0, 0, 0, 0, 0, 0, 9 + side),
      part(box(0.15, 0.13, 0.26), PALETTE.boot, 0, 0, 0, 0, 0, 0),
      part(box(0.16, 0.10, 0.10), PALETTE.gear, 0, 0, 0, 0, 0, 0), // knee pad
    ]
      .map((g, i) => {
        const y = i === 0 ? -0.21 : i === 1 ? -0.61 : i === 2 ? -0.86 : -0.32;
        const z = i === 2 ? 0.05 : i === 3 ? -0.08 : 0;
        return g.translate(0, y, z);
      });
  };

  GEO_CACHE = {
    body: mergeGeometries(body, false),
    head: mergeGeometries(head, false),
    legL: mergeGeometries(leg(-1), false),
    legR: mergeGeometries(leg(1), false),
  };
  return GEO_CACHE;
}

export function soldierMaterial() {
  if (!GEO_CACHE || !GEO_CACHE.mat) {
    const detail = getMaterial('plastic');
    const map = detail.map ? detail.map.clone() : null;
    if (map) {
      map.repeat.set(3, 3);
      map.needsUpdate = true;
    }
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map,
      metalness: 0.12,
      roughness: 0.82,
      envMapIntensity: 0.55,
    });
    GEO_CACHE.mat = mat;
  }
  return GEO_CACHE.mat;
}

// --------------------------------------------------------------- types -----

export const ENEMY_TYPES = {
  rifleman: {
    id: 'rifleman',
    health: 100,
    speed: 3.5,
    damage: 9,
    burst: [3, 5],
    burstGap: 0.11,
    restTime: [0.55, 1.25],
    aimCone: 0.075,
    engageDist: [10, 58],
    preferredRange: 22,
    reaction: [0.35, 0.7],
    xp: 100,
    label: 'RIFLEMAN',
  },
  rusher: {
    id: 'rusher',
    health: 80,
    speed: 4.8,
    damage: 7,
    burst: [4, 8],
    burstGap: 0.075,
    restTime: [0.4, 0.9],
    aimCone: 0.1,
    engageDist: [4, 24],
    preferredRange: 9,
    reaction: [0.2, 0.45],
    xp: 120,
    label: 'BREACHER',
  },
  heavy: {
    id: 'heavy',
    health: 185,
    speed: 2.8,
    damage: 13,
    burst: [5, 9],
    burstGap: 0.1,
    restTime: [0.7, 1.5],
    aimCone: 0.06,
    engageDist: [10, 50],
    preferredRange: 16,
    reaction: [0.4, 0.8],
    xp: 220,
    label: 'HEAVY',
  },
  marksman: {
    id: 'marksman',
    health: 85,
    speed: 3.2,
    damage: 26,
    burst: [1, 1],
    burstGap: 0.2,
    restTime: [1.4, 2.4],
    aimCone: 0.022,
    engageDist: [24, 80],
    preferredRange: 40,
    reaction: [0.6, 1.1],
    xp: 180,
    label: 'MARKSMAN',
  },
};

// ----------------------------------------------------------------- enemy ----

let NEXT_ID = 1;

export class Enemy {
  constructor(ctx) {
    this.ctx = ctx; // { scene, collision, effects, audio, player, difficulty }
    this.id = NEXT_ID++;
    this.types = ENEMY_TYPES;
    this.model = null;
    this.alive = false;
    this.active = false;
    this._initModel();
    this.hitSpheres = [
      { part: 'head', x: 0, y: 1.66, z: 0.02, r: 0.145 },
      { part: 'torso', x: 0, y: 1.26, z: -0.02, r: 0.26 },
      { part: 'pelvis', x: 0, y: 0.95, z: 0, r: 0.22 },
      { part: 'arm', x: -0.3, y: 1.3, z: -0.02, r: 0.13 },
      { part: 'arm', x: 0.3, y: 1.28, z: -0.03, r: 0.13 },
      { part: 'leg', x: -0.12, y: 0.55, z: 0, r: 0.17 },
      { part: 'leg', x: 0.12, y: 0.55, z: 0, r: 0.17 },
      { part: 'leg', x: -0.12, y: 0.2, z: 0, r: 0.14 },
      { part: 'leg', x: 0.12, y: 0.2, z: 0, r: 0.14 },
    ];
    this.aimPoint = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  _initModel() {
    const geo = soldierGeometry();
    const mat = soldierMaterial().clone();
    mat.transparent = false;
    this.material = mat;
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;
    this.pelvis = new THREE.Group();
    this.root.add(this.pelvis);

    this.bodyMesh = new THREE.Mesh(geo.body, mat);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.pelvis.add(this.bodyMesh);

    this.head = new THREE.Group();
    this.head.position.set(0, 1.55, 0);
    this.headMesh = new THREE.Mesh(geo.head, mat);
    this.headMesh.castShadow = true;
    this.head.add(this.headMesh);
    this.pelvis.add(this.head);

    this.legL = new THREE.Group();
    this.legL.position.set(-0.12, 0.86, 0);
    const legLMesh = new THREE.Mesh(geo.legL, mat);
    legLMesh.castShadow = true;
    this.legL.add(legLMesh);
    this.pelvis.add(this.legL);

    this.legR = new THREE.Group();
    this.legR.position.set(0.12, 0.86, 0);
    const legRMesh = new THREE.Mesh(geo.legR, mat);
    legRMesh.castShadow = true;
    this.legR.add(legRMesh);
    this.pelvis.add(this.legR);

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(-0.09, 1.22, -0.86);
    this.pelvis.add(this.muzzle);

    this.root.visible = false;
    this.ctx.scene.add(this.root);
    this.geoRef = geo;
  }

  get position() {
    return this.root.position;
  }

  spawn(typeId, pos, opts = {}) {
    const t = ENEMY_TYPES[typeId] || ENEMY_TYPES.rifleman;
    this.type = t;
    this.health = t.health * (this.ctx.difficulty?.healthMul || 1);
    this.maxHealth = this.health;
    this.alive = true;
    this.active = true;
    this.root.visible = true;
    this.root.position.set(pos.x, pos.y ?? 0.02, pos.z);
    this.root.rotation.set(0, opts.yaw ?? 0, 0);
    this.yaw = opts.yaw ?? 0;
    this.vel = new THREE.Vector3();
    this.state = 'advance';
    this.stateTime = 0;
    this.awareness = opts.awareness ?? 0;
    this.path = opts.path ? opts.path.map((w) => ({ x: w.x, z: w.z })) : null;
    this.pathIndex = 0;
    this.target = opts.waypoint ? new THREE.Vector3(opts.waypoint.x, 0, opts.waypoint.z) : null;
    this.waypoint = opts.path && opts.path.length ? { ...opts.path[0] } : opts.waypoint || null;
    this.burstLeft = 0;
    this.fireTimer = rand(0.4, 1.4);
    this.reactionTimer = 0;
    this.suppressed = 0;
    this.flinch = 0;
    this.deadTime = 0;
    this.deathAxis = new THREE.Vector3(0, 0, 1);
    this.fallDir = 1;
    this.strafeDir = chance(0.5) ? 1 : -1;
    this.strafeTimer = rand(0.8, 2.2);
    this.stuckTime = 0;
    this._navOut = { x: 0, z: 0 };
    this._wallSide = 0; // -1/1 while sliding along an obstacle, 0 when the way is clear
    this._wallTime = 0;
    this.animPhase = rand(0, TAU);
    this.walkSpeed = 0;
    this.tower = !!opts.tower;
    this.stationary = !!opts.stationary || this.tower;
    this.material.opacity = 1;
    this.material.transparent = false;
    this.material.needsUpdate = true;
    this.bodyMesh.castShadow = true;
    this.setLod(true);
    return this;
  }

  despawn() {
    this.alive = false;
    this.active = false;
    this.root.visible = false;
  }

  setLod(near) {
    this.near = near;
    this.bodyMesh.castShadow = near;
    this.headMesh.castShadow = near;
    this.legL.children[0].castShadow = near;
    this.legR.children[0].castShadow = near;
  }

  // ------------------------------------------------------------ physics ---

  update(dt, player, others) {
    if (!this.active) return;
    if (!this.alive) {
      this._updateDeath(dt);
      return;
    }

    const dist = this._distanceTo(player.position);
    this.aliveTarget = this.awareness > 0.25 && player.alive ? player : null;
    this.aimPoint.set(this.root.position.x, this.root.position.y + 1.3, this.root.position.z);

    // ---- perception -----------------------------------------------------
    const canSee = this._canSeePlayer(player);
    if (canSee) this.awareness = Math.min(1, this.awareness + dt * 1.6);
    else this.awareness = Math.max(0, this.awareness - dt * 0.12);

    if (this.state === 'advance' && canSee && dist < this.type.engageDist[1] + 8) {
      this._setState('engage');
    }

    // ---- state machine --------------------------------------------------
    this.stateTime += dt;
    this.suppressed = Math.max(0, this.suppressed - dt * 1.4);
    this.flinch = Math.max(0, this.flinch - dt * 3.4);

    switch (this.state) {
      case 'advance':
        this._doAdvance(dt, player, dist, canSee);
        break;
      case 'engage':
        this._doEngage(dt, player, dist, canSee);
        break;
      case 'reposition':
        this._doReposition(dt, player, dist);
        if (this.stateTime > 1.1) {
          this.stateTime = 0;
          this._setState(canSee ? 'engage' : 'advance');
        }
        break;
      default:
        this._setState('advance');
    }

    // ---- separation from other soldiers --------------------------------
    if (others && others.length) {
      let sx = 0;
      let sz = 0;
      for (const o of others) {
        if (o === this || !o.alive) continue;
        const dx = this.root.position.x - o.root.position.x;
        const dz = this.root.position.z - o.root.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1.6 * 1.6 && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (1.6 - d) / 1.6;
          sx += (dx / d) * push;
          sz += (dz / d) * push;
        }
      }
      this.vel.x += sx * 12 * dt;
      this.vel.z += sz * 12 * dt;
    }

    // ---- integrate + collide -------------------------------------------
    this.root.position.x += this.vel.x * dt;
    this.root.position.z += this.vel.z * dt;
    const out = this.ctx.collision.resolveXZ(
      this.root.position,
      0.38,
      this.root.position.y,
      1.75,
      0.5,
      this._colOut || (this._colOut = { x: 0, z: 0, hit: false }),
      true
    );
    if (out.hit) {
      this.root.position.x += out.x;
      this.root.position.z += out.z;
      this.stuckTime = Math.min(30, this.stuckTime + dt);
    } else {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    }
    // gravity / ground
    this.vel.y -= 24 * dt;
    this.root.position.y += this.vel.y * dt;
    const groundY = this.ctx.collision.groundAt(this.root.position.x, this.root.position.z, this.root.position.y, 0.6);
    if (this.root.position.y <= groundY) {
      this.root.position.y = groundY;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // ---- facing ---------------------------------------------------------
    let faceYaw = this.yaw;
    if (this.aliveTarget && this.awareness > 0.25) {
      const dx = player.position.x - this.root.position.x;
      const dz = player.position.z - this.root.position.z;
      faceYaw = Math.atan2(dx, dz);
    } else if (this.vel.lengthSq() > 0.2) {
      faceYaw = Math.atan2(this.vel.x, this.vel.z);
    }
    let diff = ((faceYaw - this.yaw + Math.PI * 3) % TAU) - Math.PI;
    this.yaw += diff * clamp(dt * 7, 0, 1);
    this.root.rotation.y = this.yaw;

    // ---- animation -------------------------------------------------------
    this._animate(dt, player, dist);

    // ---- LOD -------------------------------------------------------------
    const near = dist < 34;
    if (near !== this.near) this.setLod(near);
  }

  _distanceTo(p) {
    return Math.hypot(p.x - this.root.position.x, p.z - this.root.position.z);
  }

  _canSeePlayer(player) {
    if (!player.alive) return false;
    const from = this._tmp.set(
      this.root.position.x,
      this.root.position.y + 1.5,
      this.root.position.z
    );
    const to = this._tmp2.set(
      player.position.x,
      player.position.y + player.eyeHeight * 0.85,
      player.position.z
    );
    const d = from.distanceTo(to);
    if (d > 85) return false;
    // field of view (wider when already alerted)
    const look = this._tmp2.clone().sub(from).normalize();
    const facing = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const dot = facing.dot(look);
    const cone = this.awareness > 0.5 ? -0.35 : 0.25;
    if (dot < cone) return false;
    return this.ctx.collision.lineOfSight(from, to, 90);
  }

  _setState(s) {
    this.state = s;
    this.stateTime = 0;
    this._wallSide = 0;
    if (s === 'engage') this.reactionTimer = rand(this.type.reaction[0], this.type.reaction[1]);
  }

  // --------------------------------------------------------------- AI -----

  _probeBlocked(a, r) {
    const p = this.root.position;
    const y = this.root.position.y;
    return this.ctx.collision.overlaps(
      p.x + Math.sin(a) * r,
      p.z + Math.cos(a) * r,
      0.44,
      y + 0.3,
      y + 1.6
    );
  }

  /**
   * Brute-force escape hatch: sweep rings around the actor and return the
   * heading closest to the desired one that is actually walkable.
   */
  _findFreeDir(dx, dz) {
    const p = this.root.position;
    const y = this.root.position.y;
    const base = Math.atan2(dx, dz);
    for (const r of [0.95, 1.8, 2.7]) {
      for (const off of [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, 2.2, -2.2, Math.PI]) {
        const a = base + off;
        if (!this.ctx.collision.overlaps(p.x + Math.sin(a) * r, p.z + Math.cos(a) * r, 0.42, y + 0.3, y + 1.6)) {
          return a;
        }
      }
    }
    return base + Math.PI;
  }

  /**
   * Local steering: walk the desired bearing when it is clear, otherwise
   * commit to one side of the blocking obstacle and slide along it until the
   * bearing opens up again. Sticking to a side (instead of re-deciding every
   * frame) is what stops corner ping-pong.
   */
  _updateSteer(dt, dirX, dirZ) {
    const want = Math.atan2(dirX, dirZ);
    const free = (a, r) => !this._probeBlocked(a, r);
    this._wallTime += dt;

    if (this._wallSide === 0) {
      if (free(want, 1.35) && this.stuckTime < 0.45) return want;
      this._wallSide = free(want + 1.2 * this.strafeDir, 1.15) ? this.strafeDir : -this.strafeDir;
      this._wallTime = 0;
    } else if (free(want, 1.35) && this.stuckTime < 0.4) {
      // opening found: go back to the direct bearing
      this._wallSide = 0;
      this._wallTime = 0;
      return want;
    }

    for (const off of [0.9, 1.2, 1.5, 1.85, 2.3]) {
      const a = want + this._wallSide * off;
      if (free(a, 1.15)) return a;
    }
    if (this._wallTime > 1.2) {
      this._wallSide *= -1;
      this._wallTime = 0;
      return want + this._wallSide * 2.3;
    }
    return this._findFreeDir(dirX, dirZ);
  }

  _doAdvance(dt, player, dist, canSee) {
    // 1) Walk the staged ingress path (outside -> gate -> inside) first.
    const onPath = !!(this.path && this.pathIndex < this.path.length);
    if (onPath) {
      const wp = this.path[this.pathIndex];
      const d = Math.hypot(wp.x - this.root.position.x, wp.z - this.root.position.z);
      if (d < 3.0 || this.stuckTime > 5) {
        // Blocked long enough (gate traffic, debris) — push on to the next node.
        if (this.stuckTime > 5) this.stuckTime = 0;
        this._wallSide = 0;
        this.pathIndex++;
        this.waypoint = this.pathIndex < this.path.length ? { ...this.path[this.pathIndex] } : null;
      } else {
        this.waypoint = { x: wp.x, z: wp.z };
      }
    } else if (this.path) {
      this.pathIndex = this.path.length;
      this.waypoint = null;
    }

    // 2) Once the path is done, hunt the player.
    const chasing = !!(this.aliveTarget && this.awareness > 0.3 && !(this.path && this.pathIndex < this.path.length));
    // No waypoint left and no visual? Push the objective anyway — attackers
    // must never idle outside the wire.
    const tgt = chasing || !this.waypoint ? player.position : this.waypoint;
    if (!tgt) {
      this.vel.x = damp(this.vel.x, 0, 6, dt);
      this.vel.z = damp(this.vel.z, 0, 6, dt);
      this.walkSpeed = 0;
      return;
    }

    const speed =
      this.type.speed *
      (this.path && this.pathIndex < this.path.length ? 1.32 : this.awareness > 0.4 ? 1 : 0.78);

    let dx = tgt.x - this.root.position.x;
    let dz = tgt.z - this.root.position.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;

    // Obstacle avoidance: commit to a sideways move for a moment so the actor
    // can slip past corners instead of grinding into them.
    // Shared flow field gives the global bearing; local steering handles the
    // last few metres around cover.
    const nav = this.ctx.nav;
    const navDir = chasing && nav ? nav.sample(this.root.position.x, this.root.position.z, this._navOut) : null;
    const ang = this._updateSteer(dt, navDir ? navDir.x : dx, navDir ? navDir.z : dz);
    const ax = Math.sin(ang);
    const az = Math.cos(ang);

    // Stop at the preferred fighting range only when hunting the player;
    // waypoints must be reached, not orbited.
    // Only settle at fighting range when the target is actually in view;
    // otherwise keep pushing until line of sight opens up.
    const stopDist = chasing && canSee ? this.type.preferredRange : 1.5;
    const move = this.stationary
      ? 0
      : this._wallSide !== 0
        ? 1
        : d > stopDist + 1.5
          ? 1
          : d < stopDist - 6
            ? -0.5
            : 0;
    this.vel.x = damp(this.vel.x, ax * speed * move, 5, dt);
    this.vel.z = damp(this.vel.z, az * speed * move, 5, dt);
    this.walkSpeed = Math.hypot(this.vel.x, this.vel.z);
  }

  _doEngage(dt, player, dist, canSee) {
    // Lost contact for a while? Push to re-establish it.
    if (!canSee && this.stateTime > 2.5) {
      this._setState('advance');
      return;
    }
    this.walkSpeed = damp(this.walkSpeed, 0, 6, dt);
    // strafe to stay alive, and close/back off to the preferred range
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(0.9, 2.4);
      this.strafeDir *= chance(0.35) ? -1 : 1;
    }
    const toPlayerX = player.position.x - this.root.position.x;
    const toPlayerZ = player.position.z - this.root.position.z;
    const len = Math.hypot(toPlayerX, toPlayerZ) || 1;
    const nx = toPlayerX / len;
    const nz = toPlayerZ / len;
    // Hold position while actually shooting: constant full-speed strafing
    // makes them feel like Olympic sprinters and near-impossible to track.
    const firing = this.burstLeft > 0;
    const strafeScale = this.stationary ? 0 : firing ? 0.22 : 0.55;
    let moveX = -nz * this.strafeDir * strafeScale;
    let moveZ = nx * this.strafeDir * strafeScale;
    const rangeErr = len - this.type.preferredRange;
    if (Math.abs(rangeErr) > 4) {
      const s = clamp(rangeErr / 14, -1, 1);
      moveX += nx * s * strafeScale;
      moveZ += nz * s * strafeScale;
    }
    const speed = this.type.speed * (1 - this.suppressed * 0.5);
    this.vel.x = damp(this.vel.x, moveX * speed, 5, dt);
    this.vel.z = damp(this.vel.z, moveZ * speed, 5, dt);

    // ---- shooting -------------------------------------------------------
    const inRange = len < this.type.engageDist[1] && len > 2;
    if (!inRange || !canSee) {
      this.reactionTimer = Math.max(this.reactionTimer, 0.25);
      return;
    }
    if (this.suppressed > 1.0) {
      // freshly pinned down: a short beat before returning fire
      this.reactionTimer = Math.max(this.reactionTimer, 0.2);
      return;
    }
    this.reactionTimer -= dt;
    if (this.reactionTimer > 0) return;

    this.fireTimer -= dt;
    if (this.burstLeft > 0) {
      if (this.fireTimer <= 0) {
        this._shoot(player, len);
        this.burstLeft--;
        this.fireTimer = this.type.burstGap * rand(0.85, 1.2);
        if (this.burstLeft <= 0) {
          this.fireTimer = rand(this.type.restTime[0], this.type.restTime[1]);
          if (chance(0.4)) this.ctx.audio.reload('magin');
          // sidestep to a new firing position between bursts
          if (chance(0.22) && !this.stationary) this._setState('reposition');
        }
      }
    } else if (this.fireTimer <= 0) {
      this.burstLeft = randInt(this.type.burst[0], this.type.burst[1]);
      this.fireTimer = 0;
    }
  }

  _doReposition(dt, player, dist) {
    const ang = Math.atan2(this.root.position.x - player.position.x, this.root.position.z - player.position.z);
    const a = ang + this.strafeDir * 1.15;
    const speed = this.type.speed * 1.15;
    this.vel.x = damp(this.vel.x, Math.sin(a) * speed, 5, dt);
    this.vel.z = damp(this.vel.z, Math.cos(a) * speed, 5, dt);
    this.walkSpeed = Math.hypot(this.vel.x, this.vel.z);
  }

  _shoot(player, dist) {
    const t = this.type;
    const cone = t.aimCone * (this.suppressed > 0 ? 1.7 : 1) * (0.7 + (this.ctx.difficulty?.accuracyMul ?? 1) * 0.4);
    // muzzle -> player chest with a cone sample
    const from = this.muzzle.getWorldPosition(new THREE.Vector3());
    const target = new THREE.Vector3(
      player.position.x,
      player.position.y + (this.aliveTarget ? 1.2 : 1.0),
      player.position.z
    );
    const dir = target.clone().sub(from).normalize();
    // random cone offset
    const a = rand(0, TAU);
    const r = Math.sqrt(Math.random()) * cone * (1 + dist / 30);
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const up = dir.clone().cross(right).normalize();
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

    this.lastFiredAt = performance.now() / 1000;
    this.ctx.audio.gunshot(null, 'enemy', false);
    this.ctx.effects.spawnMuzzleFlash(from, dir, 1.3, false);

    // trace against the world and the player capsule
    const worldHit = this.ctx.collision.raycast(from, dir, 120, false);
    const worldDist = worldHit ? worldHit.dist : 120;
    const p = rayCapsule(
      from,
      dir,
      player.position,
      0.36,
      player.position.y + (player.crouching ? 1.15 : 1.7),
      worldDist
    );
    const end = from.clone().addScaledVector(dir, p ? p.t : worldDist);
    if (Math.random() < 0.45) this.ctx.effects.spawnTracer(from, end, { color: [2.2, 1.2, 0.5], size: 0.075, speed: 260 });

    if (p) {
      const dmg = t.damage * (this.ctx.difficulty?.damageMul ?? 1);
      player.takeDamage(dmg, this.root.position);
      this.ctx.effects.spawnBlood(p.point, dir.clone().negate(), 0.5);
      if (this.ctx.hooks?.onPlayerHit) this.ctx.hooks.onPlayerHit(this);
    } else {
      this.ctx.hooks?.onNearMiss?.(from, dir, player);
    }
  }

  // ------------------------------------------------------------ damage ----

  hitTest(origin, dir, maxDist) {
    if (!this.alive) return null;
    const ex = this.root.position.x;
    const ey = this.root.position.y;
    const ez = this.root.position.z;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = origin.x - ex;
    const dy = origin.y - ey;
    const dz = origin.z - ez;
    const lox = dx * c - dz * s;
    const loz = dx * s + dz * c;
    const ldx = dir.x * c - dir.z * s;
    const ldz = dir.x * s + dir.z * c;
    let best = null;
    for (const hs of this.hitSpheres) {
      const t = raySphere(lox, dy, loz, ldx, dir.y, ldz, hs.x, hs.y, hs.z, hs.r);
      if (t !== null && t >= 0 && t < (best ? best.dist : maxDist)) {
        best = { dist: t, part: hs.part, dist_alt: t };
      }
    }
    if (!best) return null;
    const point = {
      x: origin.x + dir.x * best.dist,
      y: origin.y + dir.y * best.dist,
      z: origin.z + dir.z * best.dist,
    };
    return { dist: best.dist, part: best.part, point, pointObj: new THREE.Vector3(point.x, point.y, point.z) };
  }

  applyDamage(amount, part, point, dir, source) {
    if (!this.alive) return;
    const headMul = part === 'head' ? 2.4 : part === 'torso' || part === 'pelvis' ? 1 : 0.78;
    const dmg = amount * headMul;
    this.health -= dmg;
    this.flinch = 1;
    this.awareness = 1;
    if (this.state === 'advance') this._setState('engage');
    // stagger impulse
    if (dir) {
      this.vel.x += dir.x * 0.6;
      this.vel.z += dir.z * 0.6;
    }
    this.ctx.hooks?.onEnemyDamaged?.(this, dmg, part, source);
    if (this.health <= 0) this.die(dir, part === 'head');
    else this.ctx.audio.fleshHit(this.root.position);
  }

  die(dir, headshot = false) {
    if (!this.alive) return;
    this.alive = false;
    this.deadTime = 0;
    this.state = 'dead';
    this.burstLeft = 0;
    this.headshot = headshot;
    if (dir) this.deathAxis.set(dir.x, 0, dir.z).normalize();
    else this.deathAxis.set(0, 0, 1);
    this.fallDir = chance(0.5) ? 1 : -1;
    this.ctx.effects.spawnBlood(
      { x: this.root.position.x, y: this.root.position.y + 1.3, z: this.root.position.z },
      new THREE.Vector3(this.deathAxis.x, 0.4, this.deathAxis.z).normalize(),
      1.6
    );
    this.ctx.effects.addDecal(
      'blood',
      { x: this.root.position.x, y: this.ctx.collision.groundAt(this.root.position.x, this.root.position.z, this.root.position.y + 1), z: this.root.position.z },
      { x: 0, y: 1, z: 0 },
      rand(0.8, 1.3)
    );
    this.ctx.hooks?.onEnemyKilled?.(this, headshot, dir);
  }

  _updateDeath(dt) {
    this.deadTime += dt;
    const t = clamp01(this.deadTime / 0.85);
    const ease = 1 - Math.pow(1 - t, 3);
    // fall over and settle
    this.pelvis.rotation.x = ease * -1.55 * this.fallDir;
    this.pelvis.position.y = -ease * 0.55;
    this.head.rotation.x = ease * 0.4;
    this.legL.rotation.x = ease * 0.5 * this.fallDir;
    this.legR.rotation.x = ease * -0.3 * this.fallDir;
    if (this.deadTime > 6) {
      const fade = clamp01((this.deadTime - 6) / 3);
      this.material.transparent = true;
      this.material.opacity = 1 - fade;
      if (fade >= 1) this.despawn();
    }
  }

  onSuppressed(dir) {
    this.suppressed = Math.min(1.2, this.suppressed + 0.5);
    if (this.alive) {
      this.awareness = 1;
      if (chance(0.3)) this.strafeDir *= -1;
      if (this.state === 'engage' && chance(0.28)) this._setState('reposition');
    }
  }

  // --------------------------------------------------------- animation ----

  _animate(dt, player, dist) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.animPhase += dt * (2.2 + speed * 1.9);
    const swing = Math.sin(this.animPhase) * clamp(speed / this.type.speed, 0, 1.4) * 0.85;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.pelvis.position.y = Math.abs(Math.cos(this.animPhase)) * 0.035 * clamp01(speed / 3);

    // aim pitch: torso tilts with the vertical angle to the player
    let pitch = 0;
    if (this.awareness > 0.3 && player.alive) {
      const dy = player.position.y + 1.2 - (this.root.position.y + 1.2);
      pitch = clamp(Math.atan2(dy, Math.max(2, dist)), -0.5, 0.5);
    }
    this.pelvis.rotation.x = damp(this.pelvis.rotation.x, -pitch + this.flinch * 0.18, 8, dt);
    this.head.rotation.x = damp(this.head.rotation.x, -pitch * 0.35, 8, dt);
    this.pelvis.rotation.z = damp(this.pelvis.rotation.z, this.strafeDir * clamp01(speed / 4) * 0.06, 6, dt);
    this.bodyMesh.position.y = this.flinch * 0.03;
  }
}

// ------------------------------------------------------------- ray helpers --

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return null;
  const discr = b * b - c;
  if (discr < 0) return null;
  let t = -b - Math.sqrt(discr);
  if (t < 0) t = 0;
  return t;
}

/** Ray vs vertical capsule. Returns {t, point} or null. */
export function rayCapsule(origin, dir, basePos, radius, topY, maxDist) {
  const y0 = basePos.y + 0.35;
  const y1 = topY;
  const dx = origin.x - basePos.x;
  const dz = origin.z - basePos.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-6) {
    const b = 2 * (dx * dir.x + dz * dir.z);
    const c = dx * dx + dz * dz - radius * radius;
    const discr = b * b - 4 * a * c;
    if (discr >= 0) {
      const sq = Math.sqrt(discr);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0 || t > maxDist) continue;
        const y = origin.y + dir.y * t;
        if (y < y0 || y > y1) continue;
        return {
          t,
          point: new THREE.Vector3(origin.x + dir.x * t, y, origin.z + dir.z * t),
        };
      }
    }
  }
  // caps
  for (const [cy, sign] of [[y0, 1], [y1, -1]]) {
    if (Math.abs(dir.y) < 1e-5) continue;
    const t = (cy - origin.y) / dir.y;
    if (t < 0 || t > maxDist) continue;
    const x = origin.x + dir.x * t;
    const z = origin.z + dir.z * t;
    if ((x - basePos.x) ** 2 + (z - basePos.z) ** 2 > radius * radius) continue;
    if (sign > 0 && dir.y > 0) continue;
    if (sign < 0 && dir.y < 0) continue;
    return { t, point: new THREE.Vector3(x, cy, z) };
  }
  return null;
}
