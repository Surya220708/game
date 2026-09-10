// ---------------------------------------------------------------------------
// Throwables and pickups: frag grenades with bounce physics + radius damage,
// and floating resupply crates.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { getMaterial } from '../core/Textures.js';
import { clamp, clamp01, rand, TAU } from '../core/Utils.js';

const G = 24;

export class Grenade {
  constructor(ctx) {
    this.ctx = ctx;
    const M = getMaterial('metal');
    const bodyGeo = new THREE.SphereGeometry(0.075, 12, 10);
    bodyGeo.scale(1, 1.25, 1);
    this.mesh = new THREE.Mesh(
      bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0x39402c, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.8 })
    );
    this.mesh.castShadow = true;
    this.lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.1, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x8d9298, metalness: 0.9, roughness: 0.3 })
    );
    this.mesh.add(this.lever);
    this.lever.position.set(0.055, 0.045, 0);
    this.mesh.visible = false;
    ctx.scene.add(this.mesh);
    this.active = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.fuse = 2.6;
    this.radius = 6.5;
    this.damage = 140;
    this.bounces = 0;
    void M;

    // a small blinking indicator light so you can track your own grenade
    this.indicator = new THREE.PointLight(0xff4020, 0, 3, 2);
    ctx.scene.add(this.indicator);
  }

  throwFrom(origin, dir, power = 1) {
    this.active = true;
    this.fuse = 2.6;
    this.bounces = 0;
    this.pos.copy(origin);
    this.vel.copy(dir).multiplyScalar(17 * power);
    this.vel.y += 3.4;
    this.mesh.visible = true;
    this.mesh.position.copy(this.pos);
    this.spin = new THREE.Vector3(rand(-8, 8), rand(-8, 8), rand(-8, 8));
  }

  update(dt, player, targets, colliders) {
    if (!this.active) return;
    this.fuse -= dt;
    this.vel.y -= G * dt;
    const prev = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);

    // ---- collide with the level ------------------------------------------
    const r = 0.085;
    for (const b of this.ctx.collision.boxes) {
      if (
        this.pos.x + r < b.minX || this.pos.x - r > b.maxX ||
        this.pos.z + r < b.minZ || this.pos.z - r > b.maxZ ||
        this.pos.y + r < b.y0 || this.pos.y - r > b.y1
      ) {
        continue;
      }
      // resolve along the axis of least penetration relative to the previous position
      const pen = [
        { axis: 'x', v: b.minX - (this.pos.x + r), n: -1 },
        { axis: 'x', v: b.maxX - (this.pos.x - r), n: 1 },
        { axis: 'y', v: b.y0 - (this.pos.y + r), n: -1 },
        { axis: 'y', v: b.y1 - (this.pos.y - r), n: 1 },
        { axis: 'z', v: b.minZ - (this.pos.z + r), n: -1 },
        { axis: 'z', v: b.maxZ - (this.pos.z - r), n: 1 },
      ];
      // choose the axis that was crossed between prev and now
      let best = null;
      for (const p of pen) {
        const a = p.axis;
        if (p.n < 0 && prev[a] - r >= p.v - 0.0001) continue;
        if (p.n > 0 && prev[a] + r <= p.v + 0.0001) continue;
        const d = Math.abs(p.v);
        if (!best || d < best.d) best = { ...p, d };
      }
      if (!best) best = pen[2];
      const a = best.axis;
      if (best.n < 0) this.pos[a] += best.v + 0.001;
      else this.pos[a] += best.v - 0.001;
      if (best.n < 0 ? this.vel[a] < 0 : this.vel[a] > 0) {
        const e = 0.42;
        this.vel[a] = -this.vel[a] * e;
        this.vel.x *= 0.86;
        this.vel.z *= 0.86;
        if (Math.abs(this.vel[a]) > 1.2) {
          this.bounces++;
          this.ctx.audio.grenadeBounce(this.pos);
        }
      }
    }
    // ground
    const groundY = this.ctx.collision.groundAt(this.pos.x, this.pos.z, this.pos.y, 0.2) + r;
    if (this.pos.y < groundY) {
      this.pos.y = groundY;
      if (this.vel.y < -1) {
        this.vel.y = -this.vel.y * 0.4;
        this.vel.x *= 0.7;
        this.vel.z *= 0.7;
        this.ctx.audio.grenadeBounce(this.pos);
      } else {
        this.vel.y = 0;
        this.vel.x *= 0.86;
        this.vel.z *= 0.86;
      }
    }

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += this.spin.x * dt;
    this.mesh.rotation.y += this.spin.y * dt;
    this.mesh.rotation.z += this.spin.z * dt;
    const blink = this.fuse < 1.2 ? (Math.sin(this.fuse * 34) > 0 ? 1 : 0.15) : 0.25;
    this.indicator.position.copy(this.pos).setY(this.pos.y + 0.2);
    this.indicator.intensity = blink * 1.5;
    void colliders;

    if (this.fuse <= 0) this.explode(player, targets);
  }

  explode(player, targets) {
    this.active = false;
    this.mesh.visible = false;
    this.indicator.intensity = 0;
    this.ctx.effects.spawnExplosion(this.pos.clone().setY(this.pos.y + 0.15), this.radius);
    this.ctx.audio.explosion(this.pos);

    // damage enemies with falloff + line of sight
    if (targets) {
      for (const t of targets) {
        if (!t.alive) continue;
        const c = t.root ? t.root.position : t.position;
        const d = Math.hypot(c.x - this.pos.x, c.y + 1 - this.pos.y, c.z - this.pos.z);
        if (d > this.radius) continue;
        const los = this.ctx.collision.lineOfSight(
          { x: this.pos.x, y: this.pos.y + 0.2, z: this.pos.z },
          { x: c.x, y: c.y + 1.1, z: c.z },
          this.radius + 2
        );
        if (!los && d > 2) continue;
        const dmg = this.damage * Math.pow(1 - d / this.radius, 1.3) * (los ? 1 : 0.55);
        if (dmg <= 1) continue;
        const dir = new THREE.Vector3(c.x - this.pos.x, 0.3, c.z - this.pos.z).normalize();
        t.applyDamage(dmg, 'torso', { x: c.x, y: c.y + 1, z: c.z }, dir, player);
      }
    }

    // hurt the player
    if (player && player.alive) {
      const pe = player.position;
      const d = Math.hypot(pe.x - this.pos.x, pe.y + 0.9 - this.pos.y, pe.z - this.pos.z);
      if (d < this.radius) {
        const los = this.ctx.collision.lineOfSight(
          { x: this.pos.x, y: this.pos.y + 0.2, z: this.pos.z },
          { x: pe.x, y: pe.y + 1.1, z: pe.z },
          this.radius + 2
        );
        const dmg = 95 * Math.pow(1 - d / this.radius, 1.2) * (los ? 1 : 0.4);
        if (dmg > 2) player.takeDamage(dmg, this.pos);
      }
      player.addShake(clamp01(1 - d / (this.radius * 2)) * 1.2);
    }

    this.ctx.hooks?.onExplosion?.(this.pos.clone(), this.radius);
  }
}

// ------------------------------------------------------------- pickups ------

const PICKUP_DEFS = {
  ammo: { color: 0xffc46a, emissive: 0x6b4a10, label: 'AMMO' },
  health: { color: 0xff6a6a, emissive: 0x6b1010, label: 'MEDKIT' },
  armor: { color: 0x8fb0ff, emissive: 0x10204b, label: 'ARMOUR' },
};

export class Pickup {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.42, 0.3, 0.32);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.3,
      emissive: 0x000000,
      emissiveIntensity: 1.4,
      envMapIntensity: 0.9,
    });
    this.box = new THREE.Mesh(geo, this.mat);
    this.box.castShadow = true;
    this.group.add(this.box);
    this.icon = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.1, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    );
    this.icon.position.y = 0.21;
    this.group.add(this.icon);
    this.glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.group.add(this.glow);
    this.group.visible = false;
    ctx.scene.add(this.group);
    this.active = false;
    this.pos = new THREE.Vector3();
    this.t = 0;
  }

  spawn(kind, pos) {
    const def = PICKUP_DEFS[kind] || PICKUP_DEFS.ammo;
    this.kind = kind;
    this.active = true;
    this.t = 0;
    this.pos.set(pos.x, pos.y + 0.35, pos.z);
    const ground = this.ctx.collision.groundAt(pos.x, pos.z, pos.y + 2);
    this.baseY = Math.max(ground + 0.42, this.pos.y);
    this.mat.color.setHex(def.color);
    this.mat.emissive.setHex(def.emissive);
    this.icon.material.color.setHex(def.color);
    this.glow.material.color.setHex(def.color);
    this.group.visible = true;
    this.life = 45;
  }

  despawn() {
    this.active = false;
    this.group.visible = false;
  }

  update(dt, player) {
    if (!this.active) return false;
    this.t += dt;
    this.life -= dt;
    this.group.position.set(this.pos.x, this.baseY + Math.sin(this.t * 2.2) * 0.09, this.pos.z);
    this.group.rotation.y += dt * 1.4;
    this.box.rotation.z = Math.sin(this.t * 1.6) * 0.08;
    if (this.life < 5) {
      const blink = Math.sin(this.life * 12) > 0 ? 1 : 0.25;
      this.mat.opacity = blink;
      this.mat.transparent = true;
    }
    if (this.life <= 0) {
      this.despawn();
      return false;
    }
    if (player.alive && player.position.distanceTo(this.pos) < 1.5) {
      return true; // picked up
    }
    return false;
  }
}
