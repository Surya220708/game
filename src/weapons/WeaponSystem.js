// ---------------------------------------------------------------------------
// Weapon handling: firing, ballistics, ammo, reload/ADS/switch animations and
// the first-person viewmodel rig (rendered in its own scene so the gun never
// clips through world geometry).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { WEAPONS, LOADOUTS, weaponMaterials } from './Viewmodel.js';
import { flashTexture, skyTexture } from '../core/Textures.js';
import { Spring, clamp, clamp01, lerp, damp, rand, TAU, DEG } from '../core/Utils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class WeaponSystem {
  constructor(ctx) {
    this.ctx = ctx; // { camera, scene, renderer, collision, effects, audio, settings, input, hooks }
    this.settings = ctx.settings;
    this.effects = ctx.effects;
    this.audio = ctx.audio;
    this.input = ctx.input;
    this.collision = ctx.collision;
    this.camera = ctx.camera;
    this.hooks = ctx.hooks || {};

    // --- viewmodel scene -------------------------------------------------
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(64, 1, 0.008, 8);
    const amb = new THREE.AmbientLight(0xa9b6c4, 0.55);
    this.viewScene.add(amb);
    const key = new THREE.DirectionalLight(0xfff0d8, 2.1);
    key.position.set(-1.4, 2.0, 1.2);
    this.viewScene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb0d8, 0.8);
    rim.position.set(1.6, 0.5, -1.4);
    this.viewScene.add(rim);
    this.viewKeyLight = key;
    if (ctx.environment) this.viewScene.environment = ctx.environment;
    this.viewScene.fog = null;

    this.flashMat = new THREE.MeshBasicMaterial({
      map: flashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), this.flashMat);
    this.flashMesh.visible = false;
    this.flashMesh.renderOrder = 10;
    this.viewScene.add(this.flashMesh);

    this.viewLight = new THREE.PointLight(0xffb060, 0, 3, 2);
    this.viewScene.add(this.viewLight);

    this.weaponRoot = new THREE.Group();
    this.viewScene.add(this.weaponRoot);

    // --- weapon states ---------------------------------------------------
    this.slots = [null, null];
    this.weapon = null;
    this.def = null;
    this.slot = 0;
    this.ammo = {}; // id -> {mag, reserve}
    this.fireTimer = 0;
    this.burstCount = 0;
    this.reloading = false;
    this.reloadT = 0;
    this.switchT = 0;
    this.switching = false;
    this.adsT = 0;
    this.adsHeld = false;
    this.firing = false;
    this.triggerWasDown = false;
    this.bloom = 0;
    this.spreadDeg = 1;
    this.shotsFired = 0;
    this.shotsHit = 0;

    // animation springs
    this.recoilPos = new Spring(0, 340, 26);
    this.recoilRot = new Spring(0, 300, 24);
    this.recoilRoll = new Spring(0, 300, 24);
    this.swayPos = { x: 0, y: 0 };
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.sprintBlend = 0;
    this.aimPitch = 0;
    this.aimYaw = 0;

    // aim recoil applied to the camera (radians)
    this.aimRecoil = { pitch: 0, yaw: 0, vPitch: 0, vYaw: 0 };

    this.lastShotAt = -99;
    this.loadoutId = 'assault';
  }

  // ------------------------------------------------------------- arming ---

  equipLoadout(id) {
    const lo = LOADOUTS.find((l) => l.id === id) || LOADOUTS[0];
    this.loadoutId = lo.id;
    this.slots = [lo.primary, lo.secondary];
    // preserve ammo across redeploys only within a run
    for (const wid of this.slots) {
      const def = WEAPONS[wid];
      if (!this.ammo[wid]) {
        this.ammo[wid] = { mag: def.mag, reserve: def.reserve };
      } else {
        this.ammo[wid] = { mag: def.mag, reserve: def.reserve };
      }
    }
    this.weaponRoot.clear();
    this._instantiate(this.slots[0]);
    this.slot = 0;
    this.reloading = false;
    this.switchT = 0.45;
    this.switching = true;
    this.adsT = 0;
    if (this.hooks.onWeaponChange) this.hooks.onWeaponChange(this.def, this.ammo[this.def.id]);
  }

  _instantiate(id) {
    const def = WEAPONS[id];
    // dispose the previous model's geometries
    this.weaponRoot.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
    this.weaponRoot.clear();
    const model = def.build();
    this.weaponRoot.add(model);
    this.weapon = model;
    this.def = def;
    this.model = model;
    this.parts = model.userData.parts || {};
    this.ads = model.userData.ads || { pos: [0, -0.08, -0.05], zoom: 1.3 };
    this.hipPos = model.userData.hip ? model.userData.hip.pos : [0.17, -0.16, -0.12];
    this.weaponRoot.scale.setScalar(1);
    this.flashMesh.material.map = flashTexture();
    if (this.parts.muzzle) {
      this.parts.muzzle.add(this.flashMesh);
      this.flashMesh.position.set(0, 0, -0.03);
    } else {
      this.viewScene.add(this.flashMesh);
    }
    if (this.parts.muzzle) {
      this.parts.muzzle.add(this.viewLight);
      this.viewLight.position.set(0, 0, -0.1);
    }
    this.spreadDeg = def.baseSpread;
    this.bloom = 0;
    if (this.hooks.onWeaponChange) this.hooks.onWeaponChange(def, this.ammo[def.id]);
  }

  get ammoState() {
    return this.ammo[this.def.id];
  }

  switchTo(slot) {
    if (this.switching && slot === this.slot) return;
    if (slot !== 0 && slot !== 1) return;
    if (slot === this.slot && !this.switching) return;
    if (!this.slots[slot]) return;
    this.slot = slot;
    this.reloading = false;
    this.switching = true;
    this.switchT = 0.62;
    this.firing = false;
    this.audio.reload('bolt');
  }
  /** Slot indirection so 1/2 keys map to primary/secondary. */
  switchToIndex(i) {
    if (i === 1) this.switchTo(0);
    else if (i === 2) this.switchTo(1);
  }

  cycle() {
    this.switchTo(this.slot === 0 ? 1 : 0);
  }

  // ------------------------------------------------------------ firing ----

  get canFire() {
    return !this.reloading && !this.switching && this.switchT <= 0;
  }

  tryFire(down, justPressed) {
    this.triggerWasDown = this.firing;
    this.firing = down;
    if (!this.canFire) {
      if (down && !this.triggerWasDown && this.reloading) return;
      if (down && !this.triggerWasDown && !this.reloading) this.audio.dryFire();
      return;
    }
    if (down && (this.def.auto || justPressed)) {
      // handled in update() so the cadence is frame-rate independent
    }
    if (down && !this.def.auto && !justPressed) return;
  }

  reload() {
    if (this.reloading || this.switching) return;
    const st = this.ammoState;
    if (st.mag >= this.def.mag || st.reserve <= 0) return;
    this.reloading = true;
    this.reloadT = 0;
    this.reloadEmpty = st.mag === 0;
    this.reloadDur = this.reloadEmpty ? this.def.reloadEmptyTime : this.def.reloadTime;
    this._reloadFlags = { magout: false, magin: false, bolt: false };
    this.adsHeld = false;
  }

  /** Effective spread cone in degrees for the current stance. */
  computeSpread(player) {
    const d = this.def;
    const speed = player ? player.horizontalSpeed : 0;
    let s = d.baseSpread;
    s += d.moveSpread * clamp(speed / player.maxSpeed, 0, 1.4) * (player.grounded ? 1 : 1.6);
    if (player && player.crouching) s *= 0.62;
    if (player && !player.grounded) s *= 2.1;
    s = lerp(s, d.adsSpread, this.adsT * this.adsT);
    s += this.bloom;
    return s;
  }

  /** One bullet downrange. */
  _shoot(player, targets) {
    const def = this.def;
    const st = this.ammoState;
    if (st.mag <= 0) {
      this.audio.dryFire();
      this.reloading = true;
      this.reloadT = 0;
      this.reloadEmpty = true;
      this.reloadDur = def.reloadEmptyTime;
      this._reloadFlags = { magout: false, magin: false, bolt: false };
      return;
    }
    st.mag--;
    this.shotsFired++;
    this.lastShotAt = performance.now() / 1000;

    // --- direction -------------------------------------------------------
    this.camera.getWorldDirection(_v);
    const dir = _v.clone();
    const spreadRad = (this.computeSpread(player) * DEG) / 2;
    if (spreadRad > 1e-5) {
      // random point inside the cone
      const a = rand(0, TAU);
      const r = Math.sqrt(Math.random()) * spreadRad;
      const right = _v2.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    this.camera.getWorldPosition(_v);
    const origin = _v.clone();
    // Start the trace just past the muzzle so cover-hugging doesn't eat shots.
    const traceStart = origin.clone().addScaledVector(dir, 0.35);

    // --- aim assist ------------------------------------------------------
    const assist = this.input.usingTouch ? 0.62 : 0.2;
    if (this.settings.get('aimAssist') && (!this.input.usingTouch || this.settings.get('aimAssist'))) {
      const t = this._findAssistTarget(origin, dir, targets);
      if (t) {
        const toTarget = _v2.copy(t.point).sub(origin).normalize();
        dir.lerp(toTarget, assist).normalize();
      }
    }

    // --- trace -----------------------------------------------------------
    const worldHit = this.collision.raycast(traceStart, dir, 240);
    let best = worldHit ? { dist: worldHit.dist + 0.35, hit: worldHit, type: 'world' } : null;
    if (targets) {
      for (const tgt of targets) {
        if (!tgt.alive) continue;
        const r = tgt.hitTest(traceStart, dir, best ? best.dist : 240);
        if (r && (!best || r.dist < best.dist)) {
          best = { dist: r.dist, hit: r, type: 'entity', target: tgt };
        }
      }
    }

    const muzzleLocal = this.parts.muzzle ? this.parts.muzzle.getWorldPosition(new THREE.Vector3()) : origin;
    // muzzle world position (viewmodel space -> world): approximate with the
    // camera-space offset rotated into the world so tracers start at the gun.
    const muzzleWorld = origin
      .clone()
      .addScaledVector(dir, 0.6)
      .addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), 0.14)
      .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion), -0.12);
    void muzzleLocal;

    const endPoint = best
      ? traceStart.clone().addScaledVector(dir, best.dist)
      : traceStart.clone().addScaledVector(dir, 240);

    // --- impact ----------------------------------------------------------
    if (best && best.type === 'entity') {
      const hit = best.hit;
      best.target.applyDamage(def.damage, hit.part, hit.point, dir, this.ctx.player);
      this.shotsHit++;
      this.effects.spawnBlood(hit.point, dir, 1);
      this.audio.fleshHit(hit.point);
      if (this.hooks.onHit) this.hooks.onHit(best.target, hit.part, false);
    } else if (best) {
      const hit = best.hit;
      this.effects.spawnImpact(hit.point, hit.normal, hit.surface || 'concrete', 1);
      this.effects.addDecal('hole', hit.point, hit.normal, rand(0.16, 0.24));
    }

    // --- feedback --------------------------------------------------------
    this.audio.gunshot(null, def.sound, true);
    this.effects.spawnMuzzleFlash(muzzleWorld, dir, def.id === 'm24' ? 1.7 : def.id === 'm249' ? 1.5 : 1, true);
    this._flashTimer = 0.045;
    this.effects.spawnShell(
      origin.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), 0.25),
      new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(1)
    );
    if (this.shotsFired % (def.id === 'm249' ? 2 : 3) === 0) {
      this.effects.spawnTracer(muzzleWorld, endPoint, {
        color: def.id === 'm24' ? [3, 1.4, 0.4] : [2.4, 1.5, 0.7],
        size: def.id === 'm24' ? 0.11 : 0.085,
      });
    }

    // --- recoil ----------------------------------------------------------
    const kick = def.recoil;
    const adsDamp = lerp(1, 0.62, this.adsT);
    this.aimRecoil.vPitch += kick.vert * 0.0075 * adsDamp * rand(0.85, 1.2);
    this.aimRecoil.vYaw += kick.horiz * 0.0075 * adsDamp * rand(-1, 1);
    this.recoilPos.kick(-kick.kick * 3.4);
    this.recoilRot.kick(-kick.vert * 2.6);
    this.recoilRoll.kick(kick.horiz * rand(-2.4, 2.4));
    this.bloom = Math.min(3.4, this.bloom + def.baseSpread * 0.34 + 0.25);
    if (this.hooks.onAmmo) this.hooks.onAmmo(this.ammoState, this.def);
  }

  _findAssistTarget(origin, dir, targets) {
    if (!targets) return null;
    let best = null;
    let bestAngle = 4.2 * DEG;
    for (const t of targets) {
      if (!t.alive || !t.aimPoint) continue;
      _v2.copy(t.aimPoint).sub(origin);
      const dist = _v2.length();
      if (dist > 75) continue;
      _v2.multiplyScalar(1 / dist);
      const dot = _v2.dot(dir);
      const ang = Math.acos(clamp(dot, -1, 1));
      const tol = bestAngle * (1 + dist / 40);
      if (ang < tol && ang < bestAngle * 3) {
        if (this.collision.lineOfSight(origin, t.aimPoint, dist)) {
          best = { point: t.aimPoint, dist };
          bestAngle = ang;
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------- update ---

  update(dt, player, targets) {
    const def = this.def;
    const st = this.ammoState;

    // --- switch animation ------------------------------------------------
    if (this.switching) {
      this.switchT -= dt * 1.9;
      if (this.switchT <= 0) {
        this.switching = false;
        this.switchT = 0;
        this._instantiate(this.slots[this.slot]);
      } else if (this.switchT < 0.5 && this._pendingWeapon !== this.slots[this.slot]) {
        this._pendingWeapon = this.slots[this.slot];
      }
    }

    // --- reload ----------------------------------------------------------
    if (this.reloading) {
      const prev = this.reloadT / this.reloadDur;
      this.reloadT += dt;
      const t = clamp01(this.reloadT / this.reloadDur);
      const f = this._reloadFlags;
      if (t > 0.12 && !f.magout) {
        f.magout = true;
        this.audio.reload('magout');
      }
      if (t > 0.58 && !f.magin) {
        f.magin = true;
        this.audio.reload('magin');
      }
      if (t > 0.82 && !f.bolt) {
        f.bolt = true;
        this.audio.reload('bolt');
      }
      if (t >= 1) {
        const need = def.mag - st.mag;
        const take = Math.min(need, st.reserve);
        st.mag += take;
        st.reserve -= take;
        this.reloading = false;
        if (this.hooks.onAmmo) this.hooks.onAmmo(st, def);
        if (this.hooks.onReloadEnd) this.hooks.onReloadEnd();
      }
      void prev;
    }

    // --- ADS --------------------------------------------------------------
    const wantAds = this.adsHeld && !this.reloading && !this.switching && !player.sprinting;
    const adsSpeed = 1 / Math.max(0.05, def.adsTime);
    this.adsT = clamp01(this.adsT + (wantAds ? dt * adsSpeed : -dt * (adsSpeed * 1.35)));

    // --- trigger ----------------------------------------------------------
    this.fireTimer -= dt;
    if (this.firing && this.canFire && st.mag > 0) {
      const interval = 60 / def.rpm;
      if (this.fireTimer <= 0) {
        this._shoot(player, targets);
        this.fireTimer = interval;
      }
    } else if (this.firing && st.mag <= 0 && !this.reloading && this.canFire) {
      // auto-reload when the trigger is held on an empty gun
      this.reload();
    }

    // --- spread recovery ---------------------------------------------------
    this.bloom = Math.max(0, this.bloom - (def.recoil.vert * 5 + 4) * dt);
    this.spreadDeg = this.computeSpread(player);

    // --- camera recoil ------------------------------------------------------
    const rec = this.aimRecoil;
    rec.pitch += rec.vPitch * dt * 60 * 0.32;
    rec.yaw += rec.vYaw * dt * 60 * 0.32;
    rec.vPitch = damp(rec.vPitch, 0, 9, dt);
    rec.vYaw = damp(rec.vYaw, 0, 9, dt);
    rec.pitch = damp(rec.pitch, 0, 6.5, dt);
    rec.yaw = damp(rec.yaw, 0, 6.5, dt);

    // --- viewmodel transform ----------------------------------------------
    this._animate(dt, player);
  }

  _animate(dt, player) {
    const root = this.weaponRoot;
    const def = this.def;
    const ads = this.ads;
    const hip = this.hipPos;
    const t = this.adsT;
    const eased = t * t * (3 - 2 * t);

    // reload / switch pose
    let posePosZ = 0;
    let poseRotX = 0;
    let poseRotY = 0;
    let poseRotZ = 0;
    let removeMag = 0;
    if (this.switching) {
      const s = clamp01(this.switchT / 0.62);
      poseRotX = -0.6 * s;
      poseRotY = 0.3 * s;
      posePosZ = 0.06 * s;
    }
    if (this.reloading) {
      const p = clamp01(this.reloadT / this.reloadDur);
      const down = Math.sin(clamp01(p / 0.35) * Math.PI * 0.5);
      const up = Math.sin(clamp01((1 - p) / 0.3) * Math.PI * 0.5);
      const dip = Math.min(down, up);
      poseRotX -= 0.45 * dip;
      poseRotZ += 0.3 * dip;
      posePosZ += 0.05 * dip;
      // magazine drops out between 15% and 45%, back in at 60%
      if (p > 0.15 && p < 0.45) removeMag = (p - 0.15) / 0.3;
      else if (p >= 0.45 && p < 0.62) removeMag = 1;
      else if (p >= 0.62) removeMag = 1 - clamp01((p - 0.62) / 0.14);
      if (this.parts.mag) {
        this.parts.mag.position.y = -0.115 - removeMag * 0.22 - (this.def.id === 'm9' ? 0.005 : 0);
        this.parts.mag.visible = removeMag < 0.98;
        this.parts.mag.rotation.z = removeMag * 0.6;
      }
      if (this.parts.bolt) {
        const boltBack = p > 0.78 && p < 0.92 ? 1 : 0;
        this.parts.bolt.position.z = (this.def.id === 'm4' ? 0.115 : 0.1) + boltBack * 0.035;
      }
    }

    // --- sway from look input ---------------------------------------------
    const look = this.input._lastLook || { x: 0, y: 0 };
    this.swayPos.x = damp(this.swayPos.x, clamp(-look.x * 0.00035, -0.03, 0.03), 8, dt);
    this.swayPos.y = damp(this.swayPos.y, clamp(look.y * 0.00035, -0.03, 0.03), 8, dt);

    // --- bob ---------------------------------------------------------------
    const speed = player.horizontalSpeed;
    const moving = player.grounded && speed > 0.4;
    this.bobAmount = damp(this.bobAmount, moving ? clamp(speed / player.maxSpeed, 0, 1.3) : 0, 6, dt);
    if (moving) this.bobPhase += dt * (7.2 + speed * 0.9);
    const bobX = Math.sin(this.bobPhase) * 0.012 * this.bobAmount * (1 - eased * 0.8);
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.009 * this.bobAmount * (1 - eased * 0.8);

    // --- sprint pose -------------------------------------------------------
    this.sprintBlend = damp(this.sprintBlend, player.sprinting ? 1 : 0, 7, dt);
    const sprintRotY = this.sprintBlend * 0.55;
    const sprintRotX = this.sprintBlend * 0.25;
    const sprintPosX = this.sprintBlend * 0.02;
    const sprintPosY = -this.sprintBlend * 0.04;

    // --- assemble transform ------------------------------------------------
    const hipX = lerp(hip[0], ads.pos[0], eased);
    const hipY = lerp(hip[1], ads.pos[1], eased);
    const hipZ = lerp(hip[2], ads.pos[2], eased);
    const rp = this.recoilPos.update(dt) * (1 - eased * 0.55);
    const rr = this.recoilRot.update(dt) * (1 - eased * 0.5);
    const rl = this.recoilRoll.update(dt) * (1 - eased * 0.6);

    root.position.set(
      hipX + this.swayPos.x + bobX + sprintPosX,
      hipY + this.swayPos.y + bobY + sprintPosY,
      hipZ + rp * 0.055 + posePosZ
    );
    root.rotation.set(
      -0.02 + rr * 0.06 + poseRotX + sprintRotX + player.pitchOffset * 0.25,
      0.06 * (1 - eased) + poseRotY + sprintRotY + this.swayPos.x * 0.6,
      rl * 0.05 + poseRotZ + this.sprintBlend * 0.35
    );

    // bolt cycling animation after each shot (non-reload)
    if (this.parts.bolt && !this.reloading) {
      const since = performance.now() / 1000 - this.lastShotAt;
      if (since < 0.055) {
        this.parts.bolt.position.z = (def.id === 'm4' ? 0.115 : def.id === 'mp5' ? 0.1 : def.id === 'm9' ? 0.055 : 0.14) + (1 - since / 0.055) * 0.03;
      }
    }

    // muzzle flash quad
    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      const k = clamp01(this._flashTimer / 0.045);
      this.flashMesh.visible = true;
      const s = (def.id === 'm24' ? 0.5 : def.id === 'm249' ? 0.46 : 0.34) * (0.7 + k * 0.6);
      this.flashMesh.scale.set(s, s, s);
      this.flashMesh.rotation.z = rand(0, TAU);
      this.flashMat.opacity = k;
      this.flashMesh.position.set(0, 0, -0.02);
    } else {
      this.flashMesh.visible = false;
    }
    this.viewLight.intensity = this._flashTimer > 0 ? clamp01(this._flashTimer / 0.045) * 6 : 0;
    this.viewLight.distance = 3.5;
  }

  /** Keeps the ADS zoom in sync with the camera FOV. */
  applyZoom(camera, baseFov) {
    const targetFov = baseFov / lerp(1, this.ads.zoom, this.adsT);
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
    return targetFov;
  }

  render(renderer) {
    this.viewCamera.rotation.copy(this.ctx.camera.rotation);
    renderer.render(this.viewScene, this.viewCamera);
  }

  setViewport(w, h) {
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
  }

  get isScoped() {
    return !!this.def.scope && this.adsT > 0.55;
  }

  get accuracy() {
    return this.shotsFired ? this.shotsHit / this.shotsFired : 0;
  }
}
