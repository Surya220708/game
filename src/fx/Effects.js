// ---------------------------------------------------------------------------
// Visual effects: GPU-instanced particle pools (additive + soft alpha),
// projected decals, travelling tracers, muzzle flashes, explosions and
// camera shake. Everything is pooled so the game never allocates mid-fight.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  smokeTexture,
  sparkTexture,
  glowTexture,
  flashTexture,
  bulletHoleTexture,
  bloodTexture,
  scorchTexture,
} from '../core/Textures.js';
import { rand, randInt, clamp01, lerp, TAU } from '../core/Utils.js';

const PARTICLE_VS = /* glsl */ `
  attribute float aAlpha;
  attribute float aRot;
  attribute vec3 aTint;
  varying float vAlpha;
  varying vec3 vTint;
  varying vec2 vUv;
  varying float vDist;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    vTint = aTint;
    vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 mv = viewMatrix * center;
    float sx = length(instanceMatrix[0].xyz);
    float sy = length(instanceMatrix[1].xyz);
    float c = cos(aRot);
    float s = sin(aRot);
    vec2 off = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    mv.xy += off * vec2(sx, sy);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FS = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying float vAlpha;
  varying vec3 vTint;
  varying vec2 vUv;
  varying float vDist;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vAlpha;
    if (a < 0.003) discard;
    vec3 col = t.rgb * vTint;
    float fog = smoothstep(uFogNear, uFogFar, vDist);
    col = mix(col, uFogColor, fog * 0.9);
    gl_FragColor = vec4(col, a);
  }
`;

class ParticlePool {
  constructor(scene, capacity, texture, blending, fog) {
    this.capacity = capacity;
    this.count = 0;
    this._next = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    const inst = new THREE.InstancedMesh(geo, null, capacity);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.count = 0;
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    geo.setAttribute('aAlpha', this.alpha);
    geo.setAttribute('aRot', this.rot);
    geo.setAttribute('aTint', this.tint);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    this.rot.setUsage(THREE.DynamicDrawUsage);
    this.tint.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uFogColor: { value: fog.color.clone() },
        uFogNear: { value: fog.near },
        uFogFar: { value: fog.far },
      },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending,
      side: THREE.DoubleSide,
    });
    inst.material = mat;
    inst.frustumCulled = false;
    inst.renderOrder = 4;
    this.mesh = inst;
    this.material = mat;
    scene.add(inst);

    this.data = [];
    for (let i = 0; i < capacity; i++) {
      this.data.push({
        alive: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1,
        s0: 0.2, s1: 0.4,
        a0: 1, a1: 0,
        rot: 0, rotVel: 0,
        r: 1, g: 1, b: 1,
        gravity: 0, drag: 1, bounce: 0, groundY: 0,
      });
    }
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  spawn(cfg) {
    let p = null;
    if (this._next === undefined || !Number.isFinite(this._next)) this._next = 0;
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this._next + i) % this.capacity;
      if (!this.data[idx].alive) {
        p = this.data[idx];
        this._next = (idx + 1) % this.capacity;
        p.index = idx;
        break;
      }
    }
    if (!p) {
      p = this.data[this._next];
      p.index = this._next;
      this._next = (this._next + 1) % this.capacity;
    }
    p.alive = true;
    p.x = cfg.x; p.y = cfg.y; p.z = cfg.z;
    p.vx = cfg.vx || 0; p.vy = cfg.vy || 0; p.vz = cfg.vz || 0;
    p.life = 0;
    p.maxLife = cfg.life || 0.5;
    p.s0 = cfg.s0 ?? 0.2;
    p.s1 = cfg.s1 ?? p.s0;
    p.a0 = cfg.a0 ?? 1;
    p.a1 = cfg.a1 ?? 0;
    p.rot = cfg.rot ?? rand(0, TAU);
    p.rotVel = cfg.rotVel ?? rand(-2, 2);
    const t = cfg.tint || [1, 1, 1];
    p.r = t[0]; p.g = t[1]; p.b = t[2];
    p.gravity = cfg.gravity ?? 0;
    p.drag = cfg.drag ?? 1;
    p.bounce = cfg.bounce ?? 0;
    p.groundY = cfg.groundY ?? 0;
    return p;
  }

  update(dt) {
    const m = this._m;
    const v = this._v;
    const q = this._q;
    const s = this._s;
    let maxIndex = -1;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.data[i];
      if (!p.alive) continue;
      p.life += dt;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        p.alive = false;
        m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, m);
        this.alpha.array[i] = 0;
        continue;
      }
      if (p.gravity) p.vy -= p.gravity * dt;
      if (p.drag !== 1) {
        const d = Math.pow(p.drag, dt * 60);
        p.vx *= d; p.vy *= d; p.vz *= d;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.bounce > 0 && p.y < p.groundY) {
        p.y = p.groundY;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.7;
        p.vz *= 0.7;
        if (Math.abs(p.vy) < 0.35) {
          p.vy = 0;
          p.bounce = 0;
          p.vx *= 0.5;
          p.vz *= 0.5;
        }
      }
      const size = lerp(p.s0, p.s1, t);
      const alpha = lerp(p.a0, p.a1, t);
      p.rot += p.rotVel * dt;
      v.set(p.x, p.y, p.z);
      q.set(0, 0, 0, 1);
      s.set(size, size, size);
      m.compose(v, q, s);
      this.mesh.setMatrixAt(i, m);
      this.alpha.array[i] = alpha;
      this.rot.array[i] = p.rot;
      this.tint.array[i * 3] = p.r;
      this.tint.array[i * 3 + 1] = p.g;
      this.tint.array[i * 3 + 2] = p.b;
      if (i > maxIndex) maxIndex = i;
    }
    this.mesh.count = Math.min(this.capacity, maxIndex + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.rot.needsUpdate = true;
    this.tint.needsUpdate = true;
  }
}

export class Effects {
  constructor(scene, collision, quality, fog) {
    this.scene = scene;
    this.collision = collision;
    this.quality = quality;
    this.fog = fog;
    this.settings = { tracers: true, particles: 1 };
    this.shake = 0;
    this.shakeDecay = 3.4;
    this._scheduled = [];

    const smoke = smokeTexture(96);
    const glow = glowTexture(64);
    this.alphaPool = new ParticlePool(scene, Math.round(520 * quality.particles), smoke, THREE.NormalBlending, fog);
    this.firePool = new ParticlePool(scene, Math.round(340 * quality.particles), glow, THREE.AdditiveBlending, fog);
    this._next = 0;

    // --- decals ---------------------------------------------------------
    this.decals = [];
    this.decalIndex = 0;
    const maxDecals = quality.decals;
    const decalMats = {
      hole: new THREE.MeshBasicMaterial({
        map: bulletHoleTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        opacity: 0.95,
      }),
      blood: new THREE.MeshBasicMaterial({
        map: bloodTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        opacity: 0.9,
        color: 0x8a1c14,
      }),
      scorch: new THREE.MeshBasicMaterial({
        map: scorchTexture(),
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
        opacity: 0.92,
      }),
    };
    this.decalMats = decalMats;
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < maxDecals; i++) {
      const mesh = new THREE.Mesh(decalGeo, decalMats.hole);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      mesh.renderOrder = 2;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.decals.push({ mesh, born: -1, life: 26 });
    }

    // --- muzzle lights --------------------------------------------------
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffb257, 0, 12, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push({ light: l, life: 0, dur: 0.06, intensity: 0 });
    }

    // --- explosion shells ----------------------------------------------
    this.blasts = [];
    const blastGeo = new THREE.SphereGeometry(1, 16, 12);
    const blastMat = new THREE.MeshBasicMaterial({
      color: 0xffb057,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringGeo = new THREE.RingGeometry(0.6, 1, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xdcb684,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 3; i++) {
      const core = new THREE.Mesh(blastGeo, blastMat.clone());
      core.visible = false;
      scene.add(core);
      const ring = new THREE.Mesh(ringGeo, ringMat.clone());
      ring.visible = false;
      scene.add(ring);
      this.blasts.push({ core, ring, life: 0, dur: 0.5, radius: 3 });
    }

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._zc = new THREE.Vector3(0, 0, 1);
  }

  setFog(fog) {
    this.fog = fog;
    for (const pool of [this.alphaPool, this.firePool]) {
      pool.material.uniforms.uFogColor.value.copy(fog.color);
      pool.material.uniforms.uFogNear.value = fog.near;
      pool.material.uniforms.uFogFar.value = fog.far;
    }
  }

  schedule(delay, fn) {
    this._scheduled.push({ at: delay, fn });
  }

  // -------------------------------------------------------------- decals ---

  addDecal(type, point, normal, size = 0.24, opts = {}) {
    const slot = this.decals[this.decalIndex % this.decals.length];
    this.decalIndex++;
    const mesh = slot.mesh;
    mesh.material = this.decalMats[type] || this.decalMats.hole;
    mesh.visible = true;
    if (opts.opacity !== undefined) {
      // share material; tint via per-instance not possible on basic material
    }
    mesh.position.set(
      point.x + normal.x * 0.014,
      point.y + normal.y * 0.014,
      point.z + normal.z * 0.014
    );
    this._v1.set(normal.x, normal.y, normal.z).normalize();
    this._q.setFromUnitVectors(this._zc, this._v1);
    const roll = new THREE.Quaternion().setFromAxisAngle(this._v1, rand(0, TAU));
    mesh.quaternion.copy(roll).multiply(this._q);
    const s = size * (opts.scale ?? 1);
    mesh.scale.set(s, s, s);
    slot.born = performance.now() / 1000;
    return mesh;
  }

  // ----------------------------------------------------------- particles ---

  spawnImpact(point, normal, surface = 'concrete', power = 1) {
    const n = surface;
    const q = this.quality.particles;
    // dust puff
    const count = Math.round((n === 'sand' || n === 'dirt' ? 7 : 5) * q * power);
    for (let i = 0; i < count; i++) {
      const spread = 0.9;
      const tint =
        n === 'sand' || n === 'dirt'
          ? [0.62, 0.55, 0.42]
          : n === 'wood'
            ? [0.5, 0.38, 0.24]
            : [0.6, 0.58, 0.55];
      this.alphaPool.spawn({
        x: point.x + normal.x * 0.05 + rand(-0.05, 0.05),
        y: point.y + normal.y * 0.05 + rand(-0.05, 0.05),
        z: point.z + normal.z * 0.05 + rand(-0.05, 0.05),
        vx: normal.x * rand(0.6, 2.4) + rand(-spread, spread),
        vy: Math.abs(normal.y) * rand(0.4, 1.6) + rand(0.2, 1.5),
        vz: normal.z * rand(0.6, 2.4) + rand(-spread, spread),
        life: rand(0.35, 0.75),
        s0: rand(0.12, 0.26),
        s1: rand(0.6, 1.0),
        a0: 0.55,
        a1: 0,
        gravity: 0.5,
        drag: 0.9,
        tint,
      });
    }
    // sparks on hard surfaces
    if (n === 'metal' || n === 'concrete') {
      const sc = Math.round(9 * q * power);
      for (let i = 0; i < sc; i++) {
        this.firePool.spawn({
          x: point.x + normal.x * 0.06,
          y: point.y + normal.y * 0.06,
          z: point.z + normal.z * 0.06,
          vx: normal.x * rand(1, 5) + rand(-2.4, 2.4),
          vy: normal.y * rand(1, 3) + rand(0.5, 3.4),
          vz: normal.z * rand(1, 5) + rand(-2.4, 2.4),
          life: rand(0.14, 0.42),
          s0: rand(0.03, 0.07),
          s1: 0.005,
          a0: 1,
          a1: 0,
          gravity: 9.5,
          drag: 0.94,
          tint: [2.4, 1.35, 0.5],
        });
      }
      // brief flash
      this.spawnLight(point, 0.35 * power, 0xffc070, 0.05);
    }
    if (n === 'metal' && Math.random() < 0.5) this.onRicochet && this.onRicochet(point);
  }

  spawnBlood(point, dir, amount = 1) {
    const q = this.quality.particles;
    const count = Math.round(11 * q * amount);
    for (let i = 0; i < count; i++) {
      const speed = rand(1.5, 6.5) * amount;
      this.alphaPool.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: dir.x * speed * rand(0.4, 1) + rand(-1.6, 1.6),
        vy: dir.y * speed * rand(0.3, 0.9) + rand(0.4, 2.6),
        vz: dir.z * speed * rand(0.4, 1) + rand(-1.6, 1.6),
        life: rand(0.28, 0.7),
        s0: rand(0.06, 0.18),
        s1: rand(0.22, 0.5),
        a0: 0.92,
        a1: 0,
        gravity: 8,
        drag: 0.93,
        tint: [0.42, 0.035, 0.02],
      });
    }
  }

  spawnHitSpark(point) {
    for (let i = 0; i < 3; i++) {
      this.firePool.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: rand(-2, 2),
        vy: rand(1, 3),
        vz: rand(-2, 2),
        life: 0.12,
        s0: 0.06,
        s1: 0.01,
        a0: 1,
        a1: 0,
        tint: [2.6, 1.6, 0.7],
      });
    }
  }

  /** Muzzle flash: ember spray, smoke wisp, a light and a smoke puff. */
  spawnMuzzleFlash(pos, dir, scale = 1, fromPlayer = false) {
    const q = this.quality.particles;
    const embers = Math.round(5 * q);
    for (let i = 0; i < embers; i++) {
      this.firePool.spawn({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: dir.x * rand(3, 12) + rand(-1.6, 1.6),
        vy: dir.y * rand(3, 10) + rand(-1, 1.6),
        vz: dir.z * rand(3, 12) + rand(-1.6, 1.6),
        life: rand(0.05, 0.16),
        s0: rand(0.06, 0.16) * scale,
        s1: 0.01,
        a0: 1,
        a1: 0,
        gravity: 2,
        drag: 0.9,
        tint: [2.8, 1.7, 0.75],
      });
    }
    const puffs = Math.round(3 * q);
    for (let i = 0; i < puffs; i++) {
      this.alphaPool.spawn({
        x: pos.x + dir.x * 0.4,
        y: pos.y + dir.y * 0.4,
        z: pos.z + dir.z * 0.4,
        vx: dir.x * rand(1.4, 3.4) + rand(-0.5, 0.5),
        vy: dir.y * rand(1, 2.4) + rand(0.2, 0.9),
        vz: dir.z * rand(1.4, 3.4) + rand(-0.5, 0.5),
        life: rand(0.3, 0.75),
        s0: 0.14 * scale,
        s1: rand(0.7, 1.3) * scale,
        a0: 0.32,
        a1: 0,
        drag: 0.88,
        tint: [0.72, 0.7, 0.67],
      });
    }
    if (!fromPlayer) this.spawnLight(pos, 1.5, 0xffb060, 0.055);
  }

  spawnLight(pos, intensity, color = 0xffb060, dur = 0.06) {
    let slot = null;
    for (const s of this.lights) {
      if (s.life <= 0) {
        slot = s;
        break;
      }
    }
    if (!slot) slot = this.lights[0];
    slot.light.position.set(pos.x, pos.y, pos.z);
    slot.light.color.setHex(color);
    slot.intensity = intensity;
    slot.light.intensity = intensity;
    slot.dur = dur;
    slot.life = dur;
    slot.light.visible = true;
  }

  /** Bullet tracer: a stream of bright dots racing along the path. */
  spawnTracer(from, to, { speed = 320, color = [2.6, 1.7, 0.8], size = 0.09, delay = 0 } = {}) {
    if (!this.settings.tracers) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.5) return;
    const steps = Math.max(2, Math.min(26, Math.round(dist / 1.4)));
    const travel = Math.min(0.35, dist / speed);
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const p = {
        x: from.x + dx * t,
        y: from.y + dy * t,
        z: from.z + dz * t,
      };
      const d = delay + travel * t;
      this.schedule(d, () => {
        this.firePool.spawn({
          x: p.x,
          y: p.y,
          z: p.z,
          life: 0.075,
          s0: size * (i === steps - 1 ? 0.5 : 1),
          s1: 0.01,
          a0: 0.85,
          a1: 0,
          tint: color,
        });
      });
    }
  }

  spawnShell(pos, dir, up = 1) {
    this.alphaPool.spawn({
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: dir.x * rand(1.5, 3.6) + rand(-0.6, 0.6),
      vy: rand(1.6, 3.2) * up,
      vz: dir.z * rand(1.5, 3.6) + rand(-0.6, 0.6),
      life: rand(0.7, 1.4),
      s0: 0.045,
      s1: 0.045,
      a0: 1,
      a1: 0,
      gravity: 14,
      drag: 0.99,
      bounce: 0.42,
      groundY: pos.y - 0.5,
      tint: [1.4, 1.0, 0.42],
      rotVel: rand(6, 16),
    });
  }

  spawnExplosion(pos, radius = 5) {
    let slot = null;
    for (const b of this.blasts) {
      if (b.life <= 0) {
        slot = b;
        break;
      }
    }
    if (!slot) slot = this.blasts[0];
    slot.life = slot.dur;
    slot.radius = radius;
    slot.core.position.copy(pos);
    slot.core.visible = true;
    slot.ring.position.set(pos.x, Math.max(pos.y - 0.9, 0.06), pos.z);
    slot.ring.visible = true;
    slot.ring.scale.setScalar(radius * 0.7);
    this.spawnLight(pos, 9, 0xffa040, 0.22);

    const q = this.quality.particles;
    // fireball
    for (let i = 0; i < Math.round(26 * q); i++) {
      const a = rand(0, TAU);
      const el = rand(-0.5, 1.0);
      const sp = rand(2, 11);
      this.firePool.spawn({
        x: pos.x + rand(-0.4, 0.4),
        y: pos.y + rand(-0.4, 0.8),
        z: pos.z + rand(-0.4, 0.4),
        vx: Math.cos(a) * Math.cos(el) * sp,
        vy: Math.sin(el) * sp + 3,
        vz: Math.sin(a) * Math.cos(el) * sp,
        life: rand(0.3, 0.85),
        s0: rand(0.5, 1.6),
        s1: rand(1.4, 3.4),
        a0: 0.95,
        a1: 0,
        drag: 0.86,
        tint: [2.6, 1.15, 0.35],
      });
    }
    // smoke
    for (let i = 0; i < Math.round(20 * q); i++) {
      const a = rand(0, TAU);
      const sp = rand(1, 6);
      this.alphaPool.spawn({
        x: pos.x + rand(-0.6, 0.6),
        y: pos.y + rand(0, 1.2),
        z: pos.z + rand(-0.6, 0.6),
        vx: Math.cos(a) * sp,
        vy: rand(1.2, 4.2),
        vz: Math.sin(a) * sp,
        life: rand(0.9, 2.2),
        s0: rand(0.8, 1.8),
        s1: rand(3, 6.5),
        a0: 0.8,
        a1: 0,
        drag: 0.9,
        tint: [0.26, 0.24, 0.22],
      });
    }
    // dust ring
    for (let i = 0; i < Math.round(22 * q); i++) {
      const a = (i / 22) * TAU + rand(-0.1, 0.1);
      const sp = rand(6, 13);
      this.alphaPool.spawn({
        x: pos.x,
        y: pos.y - radius * 0.16,
        z: pos.z,
        vx: Math.cos(a) * sp,
        vy: rand(0.1, 1.2),
        vz: Math.sin(a) * sp,
        life: rand(0.5, 1.1),
        s0: 1.1,
        s1: rand(2.4, 4.2),
        a0: 0.55,
        a1: 0,
        drag: 0.88,
        tint: [0.62, 0.55, 0.42],
      });
    }
    // debris
    for (let i = 0; i < Math.round(14 * q); i++) {
      const a = rand(0, TAU);
      const sp = rand(6, 20);
      this.firePool.spawn({
        x: pos.x,
        y: pos.y,
        z: pos.z,
        vx: Math.cos(a) * sp,
        vy: rand(4, 14),
        vz: Math.sin(a) * sp,
        life: rand(0.6, 1.5),
        s0: rand(0.05, 0.16),
        s1: 0.02,
        a0: 1,
        a1: 0,
        gravity: 16,
        drag: 0.98,
        tint: [1.8, 1.1, 0.5],
      });
    }
    this.addDecal('scorch', { x: pos.x, y: this.groundY(pos), z: pos.z }, { x: 0, y: 1, z: 0 }, radius * 0.55, { scale: 1.1 });
    this.shake = Math.min(1.6, this.shake + 1.15);
  }

  groundY(pos) {
    return this.collision.groundAt(pos.x, pos.z, pos.y + 2) + 0.02;
  }

  spawnDust(pos, amount = 1, tint = [0.62, 0.55, 0.43], up = 1) {
    const q = this.quality.particles;
    for (let i = 0; i < Math.round(5 * amount * q); i++) {
      this.alphaPool.spawn({
        x: pos.x + rand(-0.2, 0.2),
        y: pos.y + rand(0.02, 0.2),
        z: pos.z + rand(-0.2, 0.2),
        vx: rand(-1, 1),
        vy: rand(0.2, 1.3) * up,
        vz: rand(-1, 1),
        life: rand(0.4, 0.9),
        s0: rand(0.2, 0.4),
        s1: rand(0.9, 1.6),
        a0: 0.38 * amount,
        a1: 0,
        drag: 0.9,
        tint,
      });
    }
  }

  spawnSmokeColumn(pos, height = 6, life = 6) {
    // Used for burning wrecks: a slow, tall, looping plume.
    this.smokeEmitters = this.smokeEmitters || [];
    this.smokeEmitters.push({ x: pos.x, y: pos.y, z: pos.z, t: 0, life, height });
  }

  update(dt) {
    // scheduled emissions (tracers etc.)
    if (this._scheduled.length) {
      const keep = [];
      for (const s of this._scheduled) {
        s.at -= dt;
        if (s.at <= 0) s.fn();
        else keep.push(s);
      }
      this._scheduled = keep;
    }

    this.alphaPool.update(dt);
    this.firePool.update(dt);

    // muzzle lights
    for (const s of this.lights) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = clamp01(s.life / s.dur);
      s.light.intensity = s.intensity * k * k;
      if (s.life <= 0) s.light.visible = false;
    }

    // explosions
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const t = 1 - clamp01(b.life / b.dur);
      const coreS = b.radius * (0.35 + t * 0.9);
      b.core.scale.setScalar(coreS);
      b.core.material.opacity = 0.95 * Math.pow(1 - t, 1.5);
      const ringS = b.radius * (0.7 + t * 1.5);
      b.ring.scale.set(ringS, 1, ringS);
      b.ring.material.opacity = 0.5 * Math.pow(1 - t, 2);
      if (b.life <= 0) {
        b.core.visible = false;
        b.ring.visible = false;
      }
    }

    // smoke emitters
    if (this.smokeEmitters) {
      for (let i = this.smokeEmitters.length - 1; i >= 0; i--) {
        const e = this.smokeEmitters[i];
        e.t += dt;
        if (e.t > e.life) {
          this.smokeEmitters.splice(i, 1);
          continue;
        }
        e.acc = (e.acc || 0) + dt;
        while (e.acc > 0.09) {
          e.acc -= 0.09;
          this.alphaPool.spawn({
            x: e.x + rand(-0.4, 0.4),
            y: e.y + rand(0, 0.6),
            z: e.z + rand(-0.4, 0.4),
            vx: rand(-0.3, 0.3),
            vy: rand(0.7, 1.7),
            vz: rand(-0.3, 0.3),
            life: rand(2.4, 4.6),
            s0: rand(0.5, 1.0),
            s1: rand(3.4, 6.2),
            a0: 0.4,
            a1: 0,
            drag: 0.97,
            tint: [0.18, 0.17, 0.16],
          });
        }
      }
    }

    // decal lifetime (fade the oldest away rather than popping)
    const now = performance.now() / 1000;
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      const age = now - d.born;
      if (age > d.life) {
        const fade = 1 - clamp01((age - d.life) / 3);
        d.mesh.material.opacity = Math.max(0, fade * 0.92);
        if (fade <= 0.01) {
          d.mesh.visible = false;
          d.mesh.material.opacity = 0.92;
        }
      }
    }

    this.shake = Math.max(0, this.shake - this.shakeDecay * dt);
  }

  /** Renders decals/particles from the far side of the world correctly. */
  setRenderOrder() {
    this.alphaPool.mesh.renderOrder = 4;
    this.firePool.mesh.renderOrder = 5;
  }
}
