// ---------------------------------------------------------------------------
// First-person player: movement, collision, stance, stamina, health/armour,
// camera feel (bob, lean, landing, shake) and damage intake.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, Spring, rand, TAU, DEG } from '../core/Utils.js';

const GRAVITY = 24;
const JUMP_VELOCITY = 7.3;
const STEP_UP = 0.46;

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.collision = ctx.collision;
    this.audio = ctx.audio;
    this.effects = ctx.effects;
    this.camera = ctx.camera;
    this.settings = ctx.settings;
    this.hooks = ctx.hooks || {};

    this.position = new THREE.Vector3(ctx.start.x, ctx.start.y ?? 0.05, ctx.start.z);
    this.velocity = new THREE.Vector3();
    this.radius = 0.34;
    this.standHeight = 1.78;
    this.crouchHeight = 1.22;
    this.eyeHeight = 1.66;
    this.eyeOffset = 0;

    this.yaw = ctx.start.yaw ?? Math.PI;
    this.pitch = 0;

    this.grounded = true;
    this.crouching = false;
    this.sprinting = false;
    this.stamina = 100;
    this.maxSpeed = 5.4;
    this.sprintSpeed = 8.2;
    this.crouchSpeed = 2.7;
    this.adsSpeedMul = 0.62;

    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;
    this.maxArmor = 100;
    this.alive = true;
    this.lastDamageAt = -99;
    this.lastRegenAt = 0;
    this.kills = 0;
    this.headshots = 0;
    this.damageTaken = 0;

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.landDip = new Spring(0, 260, 20);
    this.shake = 0;
    this.shakeTime = 0;
    this.lookImpulse = { x: 0, y: 0 };
    this.lean = 0;
    this.fallStart = null;
    this.stepDistance = 0;
    this.pitchOffset = 0;
    this.weaponDrop = 0;

    this._resolveOut = { x: 0, z: 0, hit: false };
    this._wish = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.footstepSurface = 'dirt';
    this.grenades = 3;
    this.grenadeCooldown = 0;
    this.lastThrownAt = -99;
  }

  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get eyePosition() {
    return new THREE.Vector3(
      this.position.x,
      this.position.y + this.eyeHeight + this.eyeOffset,
      this.position.z
    );
  }

  get stanceHeight() {
    return this.crouching ? this.crouchHeight : this.standHeight;
  }

  // -------------------------------------------------------------- update ---

  update(dt, input, weapon) {
    if (!this.alive) return;

    // ---------------- look ------------------------------------------------
    const look = input.consumeLook(dt);
    input._lastLook = look;
    const sens = this.settings.get('sensitivity') * 0.0022;
    const ads = weapon ? weapon.adsT : 0;
    const adsScale = lerp(1, this.settings.get('adsSensitivity'), ads);
    const invert = this.settings.get('invertY') ? -1 : 1;
    this.yaw -= look.x * sens * adsScale;
    this.pitch -= look.y * sens * adsScale * invert;
    this.pitch = clamp(this.pitch, -85 * DEG, 85 * DEG);
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;

    // ---------------- stance ----------------------------------------------
    const wantCrouch = input.crouching;
    if (wantCrouch && !this.crouching) {
      // don't stand up into geometry when uncrouching later
      this.crouching = true;
    } else if (!wantCrouch && this.crouching) {
      const test = this.collision.overlaps(
        this.position.x,
        this.position.z,
        this.radius * 0.95,
        this.position.y + this.crouchHeight,
        this.position.y + this.standHeight
      );
      if (!test) this.crouching = false;
    }
    this.eyeOffset = damp(this.eyeOffset, this.crouching ? this.crouchHeight - this.standHeight : 0, 12, dt);

    // ---------------- movement --------------------------------------------
    const axis = input.axis;
    let mag = Math.hypot(axis.x, axis.y);
    if (mag > 1) mag = 1;

    const wantSprint =
      input.sprinting && !this.crouching && axis.y > 0.35 && this.stamina > 2 && this.grenadeCooldown <= 0;
    this.sprinting = wantSprint;

    let target = this.maxSpeed;
    if (this.crouching) target = this.crouchSpeed;
    else if (this.sprinting) target = this.sprintSpeed;
    else if (ads > 0.4) target *= this.adsSpeedMul;
    if (weapon && weapon.def) target *= weapon.def.mobility;

    // stamina
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - 19 * dt);
      if (this.stamina <= 0.5) this.sprinting = false;
    } else {
      this.stamina = Math.min(100, this.stamina + (this.grounded ? 14 : 4) * dt);
    }

    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    this._fwd.set(-sinY, 0, -cosY);
    this._right.set(cosY, 0, -sinY);
    this._wish
      .set(0, 0, 0)
      .addScaledVector(this._fwd, axis.y)
      .addScaledVector(this._right, axis.x);
    if (this._wish.lengthSq() > 1) this._wish.normalize();

    const accel = this.grounded ? 62 : 14;
    const desiredX = this._wish.x * target;
    const desiredZ = this._wish.z * target;
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    this.velocity.x += clamp(desiredX - vx, -accel * dt, accel * dt);
    this.velocity.z += clamp(desiredZ - vz, -accel * dt, accel * dt);

    // friction when idle
    if (mag < 0.02 && this.grounded) {
      const f = Math.exp(-12 * dt);
      this.velocity.x *= f;
      this.velocity.z *= f;
    }

    // jump
    if (input.wasPressed('jump') && this.grounded && this.stamina > 12) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
      this.stamina -= 12;
      this.audio.footstep(this.footstepSurface, 0.6);
    }

    this.velocity.y -= GRAVITY * dt;
    this.velocity.y = Math.max(this.velocity.y, -55);

    // integrate + collide
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    const out = this.collision.resolveXZ(
      this.position,
      this.radius,
      this.position.y,
      this.stanceHeight,
      STEP_UP,
      this._resolveOut
    );
    if (out.hit) {
      this.position.x += out.x;
      this.position.z += out.z;
    }

    // keep inside the world
    const limit = 150;
    this.position.x = clamp(this.position.x, -limit, limit);
    this.position.z = clamp(this.position.z, -limit, limit);

    // ---------------- ground ---------------------------------------------
    const groundY = this.collision.groundAt(this.position.x, this.position.z, this.position.y, STEP_UP);
    if (this.velocity.y <= 0 && this.position.y <= groundY + 0.001) {
      if (!this.grounded) {
        const impact = clamp01(-this.velocity.y / 14);
        this.landDip.kick(-impact * 9);
        this.audio.land(0.4 + impact);
        if (impact > 0.28) {
          this.effects.spawnDust(this.position, 0.7 + impact, [0.62, 0.56, 0.44], 0.7);
          this.addShake(impact * 0.5);
        }
      }
      this.position.y = groundY;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // ---------------- footsteps -------------------------------------------
    const speed = this.horizontalSpeed;
    if (this.grounded && speed > 0.6) {
      this.stepDistance += speed * dt;
      const stride = this.sprinting ? 2.15 : this.crouching ? 2.9 : 2.4;
      if (this.stepDistance > stride) {
        this.stepDistance = 0;
        this.audio.footstep(this.footstepSurface, this.crouching ? 0.4 : this.sprinting ? 1 : 0.75);
        if (this.sprinting && speed > 5) {
          this.effects.spawnDust(
            { x: this.position.x, y: this.position.y - 1.6, z: this.position.z },
            0.25,
            [0.6, 0.54, 0.42],
            0.5
          );
        }
      }
    }

    // ---------------- camera feel -----------------------------------------
    const moving = this.grounded && speed > 0.5;
    this.bobAmount = damp(this.bobAmount, moving ? clamp01(speed / this.maxSpeed) : 0, 7, dt);
    if (moving) this.bobPhase += dt * (6.4 + speed * 1.15);
    const bobY = Math.sin(this.bobPhase * 2) * 0.021 * this.bobAmount;
    const bobRoll = Math.sin(this.bobPhase) * 0.008 * this.bobAmount;

    // strafe lean
    const strafe = this._right.x * this.velocity.x + this._right.z * this.velocity.z;
    this.lean = damp(this.lean, clamp(strafe / this.maxSpeed, -1, 1) * 0.03, 6, dt);

    // damage look impulse
    this.lookImpulse.x = damp(this.lookImpulse.x, 0, 7, dt);
    this.lookImpulse.y = damp(this.lookImpulse.y, 0, 7, dt);

    // shake
    this.shakeTime += dt;
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const shakeX = this.shake > 0 ? Math.sin(this.shakeTime * 47) * this.shake * 0.02 : 0;
    const shakeY = this.shake > 0 ? Math.cos(this.shakeTime * 41) * this.shake * 0.02 : 0;

    // recoil from the weapon
    const rec = this.ctx.weapon ? this.ctx.weapon.aimRecoil : { pitch: 0, yaw: 0 };

    this.camera.position.set(
      this.position.x,
      this.position.y + this.eyeHeight + this.eyeOffset + bobY + this.landDip.value * 0.02,
      this.position.z
    );
    this.camera.rotation.set(
      this.pitch + rec.pitch + this.lookImpulse.y + shakeY + this.landDip.value * 0.012,
      this.yaw + rec.yaw + this.lookImpulse.x + shakeX,
      bobRoll + this.lean
    );
    this.camera.rotation.order = 'YXZ';

    // ---------------- health ----------------------------------------------
    const now = performance.now() / 1000;
    if (this.health < this.maxHealth && now - this.lastDamageAt > 6.5 && this.alive) {
      this.health = Math.min(this.maxHealth, this.health + 13 * dt);
    }
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
    this.pitchOffset = this.landDip.value * 0.01;
  }

  addShake(amount) {
    this.shake = Math.min(2.2, this.shake + amount);
  }

  // ------------------------------------------------------------- damage ---

  takeDamage(amount, fromPos, opts = {}) {
    if (!this.alive) return;
    const now = performance.now() / 1000;
    this.lastDamageAt = now;

    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.damageTaken += amount;

    const severity = clamp01(amount / 40);
    this.audio.playerHurt(0.5 + severity);
    this.addShake(0.35 + severity);
    if (this.hooks.onDamaged) this.hooks.onDamaged(amount, fromPos, severity);

    // knock the aim slightly away from the source
    if (fromPos) {
      const dx = fromPos.x - this.position.x;
      const dz = fromPos.z - this.position.z;
      const ang = Math.atan2(dx, dz);
      const rel = Math.atan2(Math.sin(ang - this.yaw), Math.cos(ang - this.yaw));
      this.lookImpulse.x += clamp(rel, -1, 1) * 0.012 * (0.4 + severity);
      this.lookImpulse.y += rand(-0.008, 0.008);
    }

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.audio.death();
      if (this.hooks.onDeath) this.hooks.onDeath();
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addArmor(amount) {
    this.armor = Math.min(this.maxArmor, this.armor + amount);
  }

  addAmmo(weaponSystem, fraction = 0.5) {
    for (const id of weaponSystem.slots) {
      const st = weaponSystem.ammo[id];
      const def = weaponSystem.constructor === Object ? null : null;
      void def;
      if (st) st.reserve = Math.min(st.reserve + Math.round(60), 400);
    }
    this.grenades = Math.min(4, this.grenades + 1);
    void fraction;
  }
}
