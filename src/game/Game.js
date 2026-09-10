// ---------------------------------------------------------------------------
// Mission director: wave scheduling, enemy pool, scoring, pickups, explosive
// props, difficulty curve and the per-frame update order for the whole game.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { NavGrid } from '../world/NavGrid.js';
import { Enemy, ENEMY_TYPES, soldierGeometry, soldierMaterial } from '../entities/Enemy.js';
import { Pickup, Grenade } from '../entities/Projectile.js';
import { clamp, clamp01, damp, lerp, rand, randInt, pick, chance, TAU } from '../core/Utils.js';
import { formatTime } from '../core/Utils.js';

const INTERMISSION = 15;

export class Game {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.enemies = [];
    this.pickups = [];
    this.grenades = [];
    this.grenade = null;
    this.targets = [];
    this.wave = 0;
    this.reinforcements = 0;
    this.waveState = 'idle'; // idle | active | intermission
    this.waveTimer = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.remaining = 0;
    this.spawnedThisWave = 0;
    this.totalThisWave = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.kills = 0;
    this.headshots = 0;
    this.killsThisLife = 0;
    this.startedAt = 0;
    this.elapsed = 0;
    this.rewardTier = 0;
    this.state = 'menu'; // menu | playing | paused | dead
    this._project = new THREE.Vector3();
    this._lastGrenadeAt = -99;
    this._blinkHintAt = 0;

    // Shared context handed to entity instances (enemies, grenades, pickups).
    const game = this;
    this.hooks = this.hooks || {};
    this.reinforcements = 0;
    this.entityHooks = {
      onEnemyKilled: (enemy, headshot, dir) => game.onEnemyKilled(enemy, headshot, dir),
      onEnemyDamaged: (enemy, dmg, part, source) => {
        const p = enemy.root.position;
        game.hud.damageNumber(
          new THREE.Vector3(p.x + rand(-0.2, 0.2), p.y + (part === 'head' ? 1.75 : 1.25), p.z),
          dmg,
          { headshot: part === 'head' }
        );
        if (source === game.player) game.score += Math.round(dmg * 0.6);
      },
      onPlayerHit: () => {
        game._recentNearMiss = 1;
      },
      onNearMiss: (from, dir, player) => {
        // a round snapped past the player: whizz + suppression vignette
        const d = Math.hypot(player.position.x - from.x, player.position.z - from.z);
        if (d < 4) return;
        game.audio.bulletWhiz(player.position);
        game._recentNearMiss = Math.min(1, (game._recentNearMiss || 0) + 0.5);
      },
      onExplosion: () => {},
    };
    // shared flow-field navigation (one field, every attacker reads it)
    this.nav = new NavGrid(this.collision, { cell: 1.2, half: 78, agentRadius: 0.34 });
    this.nav.bake();
    this._navTimer = 0;

    this.entityCtx = {
      scene: this.scene,
      collision: this.collision,
      effects: this.effects,
      audio: this.audio,
      player: this.player,
      nav: this.nav,
      hooks: this.entityHooks,
      get difficulty() {
        return game.difficulty;
      },
    };

    // pooled soldiers
    const poolSize = Math.max(10, this.quality.maxEnemies + 6);
    for (let i = 0; i < poolSize; i++) {
      this.enemies.push(new Enemy(this.entityCtx));
    }
    for (let i = 0; i < 8; i++) this.pickups.push(new Pickup(this.entityCtx));
    this.grenades.push(new Grenade(this.entityCtx));
    this.grenades.push(new Grenade(this.entityCtx));
    this.grenade = this.grenades[0];

    // pre-warm the shared soldier geometry so the first spawn doesn't hitch
    soldierGeometry();
    soldierMaterial();
  }

  // -------------------------------------------------------------- hooks ----

  initHooks() {
    this.player.hooks = {
      onDamaged: (amount, fromPos, severity) => {
        this.hud.flashDamage();
        if (fromPos && this.player.alive) {
          const ang = Math.atan2(fromPos.x - this.player.position.x, fromPos.z - this.player.position.z);
          this.hud.damageDirection(ang + Math.PI, this.player.yaw + Math.PI);
        }
        void amount;
        void severity;
      },
      onDeath: () => this.onPlayerDeath(),
    };

    this.weaponSystem.hooks = {
      onAmmo: () => {},
      onWeaponChange: (def, st) => {
        this.hud.banner(def.name, { sub: def.cls, cls: 'sub-only', duration: 1.3 });
        void st;
      },
      onHit: (target, part, kill) => {
        const headshot = part === 'head';
        if (!kill) this.hud.hitmarker(false, headshot);
      },
      onShot: (origin, dir, dist) => this.onPlayerShot(origin, dir, dist),
    };
  }

  // -------------------------------------------------------------- state ----

  start(loadoutId) {
    this.reset();
    this.weaponSystem.equipLoadout(loadoutId);
    this.state = 'playing';
    this.startedAt = performance.now();
    this.hud.show();
    this.hud.setFpsVisible(this.settings.get('showFps'));
    this.audio.waveAlarm();
    this.startWave(1);
    this.hud.banner('OPERATION START', { sub: 'HOLD THE COMPOUND', cls: 'gold', duration: 2.4 });
  }

  reset() {
    for (const e of this.enemies) {
      if (e.active) e.despawn();
      e.pelvis.rotation.set(0, 0, 0);
      e.pelvis.position.set(0, 0, 0);
      e.head.rotation.set(0, 0, 0);
      e.material.opacity = 1;
      e.material.transparent = false;
    }
    for (const p of this.pickups) p.despawn();
    for (const g of this.grenades) {
      g.active = false;
      g.mesh.visible = false;
      g.indicator.intensity = 0;
    }
    for (const b of this.map.barrels) {
      b.alive = true;
      b.health = 45;
      if (b.mesh) b.mesh.visible = true;
      b.pendingExplode = undefined;
    }
    this.wave = 0;
    this.reinforcements = 0;
    this.waveState = 'idle';
    this.spawnQueue.length = 0;
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.kills = 0;
    this.headshots = 0;
    this.killsThisLife = 0;
    this.elapsed = 0;
    this.rewardTier = 0;
    this._lastGrenadeAt = -99;
    this.player.health = this.player.maxHealth;
    this.player.armor = 0;
    this.player.stamina = 100;
    this.player.alive = true;
    this.player.grenades = 3;
    this.player.position.set(this.map.playerStart.x, 0.05, this.map.playerStart.z);
    this.player.velocity.set(0, 0, 0);
    this.player.yaw = this.map.playerStart.yaw;
    this.player.pitch = 0;
    this.weaponSystem.shotsFired = 0;
    this.weaponSystem.shotsHit = 0;
    this.weaponSystem.bloom = 0;
  }

  // -------------------------------------------------------------- waves ----

  get difficulty() {
    const w = this.wave;
    return {
      damageMul: Math.min(1.85, 1 + (w - 1) * 0.055),
      healthMul: Math.min(1.6, 1 + (w - 1) * 0.045),
      accuracyMul: Math.min(1.4, 1 + (w - 1) * 0.03),
    };
  }

  startWave(n) {
    this.wave = n;
    this.waveState = 'active';
    this.spawnQueue.length = 0;
    this.spawnedThisWave = 0;
    const budget = Math.min(this.quality.maxEnemies + 4 + Math.floor(n * 0.9), 30);
    const total = Math.min(6 + Math.floor(n * 1.7), 26);
    this.totalThisWave = total;
    this.remaining = total;

    const roster = [];
    const weights = [
      { type: 'rifleman', w: 10 },
      { type: 'rusher', w: n >= 2 ? 5 + n * 0.4 : 0 },
      { type: 'heavy', w: n >= 4 ? 3 + n * 0.3 : 0 },
      { type: 'marksman', w: n >= 3 ? 2 + n * 0.35 : 0 },
    ];
    let totalW = 0;
    for (const r of weights) totalW += r.w;
    for (let i = 0; i < total; i++) {
      let roll = Math.random() * totalW;
      let chosen = 'rifleman';
      for (const r of weights) {
        roll -= r.w;
        if (roll <= 0) {
          chosen = r.type;
          break;
        }
      }
      roster.push(chosen);
    }
    // schedule spawns with randomised spacing
    let t = rand(0.4, 1.4);
    const points = this.map.spawnPoints;
    const towers = points.filter((p) => p.tower);
    const ground = points.filter((p) => !p.tower);
    for (let i = 0; i < roster.length; i++) {
      const type = roster[i];
      let sp;
      if (type === 'marksman' && towers.length && chance(0.6)) {
        sp = pick(towers);
      } else {
        // prefer spawn points away from the player
        let best = null;
        let bestD = -1;
        for (let k = 0; k < 3; k++) {
          const cand = pick(ground);
          const d = Math.hypot(cand.x - this.player.position.x, cand.z - this.player.position.z);
          if (d > bestD) {
            bestD = d;
            best = cand;
          }
        }
        sp = best;
      }
      this.spawnQueue.push({ type, point: sp, at: t });
      t += rand(0.5, 2.1) * clamp(1 - n * 0.02, 0.55, 1);
    }
    this.spawnTimer = 0;
    const labels = {
      1: 'INITIAL CONTACT',
      2: 'SCOUTING PARTY',
      3: 'PROBING ATTACK',
      4: 'MAIN ASSAULT',
      5: 'ARMOURED PUSH',
    };
    this.hud.banner(`WAVE ${n}`, {
      sub: labels[n] || 'SUSTAINED ATTACK',
      cls: 'danger',
      duration: 2.6,
      key: `wave${n}`,
    });
    this.audio.waveAlarm();
    void budget;
  }

  endWave() {
    this.waveState = 'intermission';
    this.waveTimer = INTERMISSION;
    const bonus = 250 * this.wave;
    this.score += bonus;
    this.hud.banner(`WAVE ${this.wave} CLEARED`, {
      sub: `+${bonus} BONUS · RESUPPLY INBOUND`,
      cls: 'gold',
      duration: 3,
    });
    this.audio.pickup();
    // resupply crates
    this.spawnPickup('ammo', { x: this.map.playerStart.x, y: 0, z: this.map.playerStart.z - 4 });
    this.spawnPickup('health', { x: rand(-16, 16), y: 0, z: rand(-6, 22) });
    if (this.wave % 2 === 0) this.spawnPickup('armor', { x: rand(-24, 24), y: 0, z: rand(-24, 6) });
    for (const e of this.enemies) if (e.alive) e.awareness = Math.max(e.awareness, 0.6);
  }

  spawnEnemy(type, point) {
    let e = this.enemies.find((x) => !x.active);
    if (!e) return null;
    const target = point.path && point.path.length ? point.path[0] : point.waypoint;
    const yaw = Math.atan2(target ? target.x - point.x : 0, target ? target.z - point.z : -1);
    e.spawn(type, { x: point.x, y: point.y ?? 0.05, z: point.z }, {
      yaw,
      waypoint: point.waypoint,
      path: point.path,
      tower: point.tower,
      stationary: point.stationary,
      awareness: point.tower ? 0.7 : 0,
    });
    return e;
  }

  /**
   * Re-route a stuck attacker to a fresh approach. Used sparingly (only for
   * soldiers that have made no progress for 22 s and are out of the player's
   * line of sight) so a wave can never stall just out of view.
   */
  reinforce(enemy) {
    const ground = this.map.spawnPoints.filter((sp) => !sp.tower && sp.path && sp.path.length);
    if (!ground.length) return false;
    let best = null;
    let bestScore = -Infinity;
    for (const sp of ground) {
      const d = Math.hypot(sp.x - this.player.position.x, sp.z - this.player.position.z);
      const score = d + Math.random() * 12;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    if (!best) return false;
    const target = best.path[0];
    enemy.spawn(enemy.type.id, { x: best.x, y: best.y ?? 0.05, z: best.z }, {
      yaw: Math.atan2(target.x - best.x, target.z - best.z),
      waypoint: best.waypoint,
      path: best.path,
      tower: false,
      stationary: false,
      awareness: 0.8,
    });
    enemy.stallTime = 0;
    this.reinforcements++;
    return true;
  }

  spawnPickup(kind, pos) {
    const free = this.pickups.find((p) => !p.active);
    if (!free) return;
    const y = this.collision.groundAt(pos.x, pos.z, pos.y + 3);
    free.spawn(kind, { x: pos.x, y, z: pos.z });
  }

  // ------------------------------------------------------------- events ----

  onPlayerShot(origin, dir, dist) {
    // near-miss suppression for enemies downrange
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const c = e.root.position;
      const t = (c.x - origin.x) * dir.x + (c.y + 1.2 - origin.y) * dir.y + (c.z - origin.z) * dir.z;
      if (t < 0 || t > dist) continue;
      const px = origin.x + dir.x * t;
      const py = origin.y + dir.y * t;
      const pz = origin.z + dir.z * t;
      const miss = Math.hypot(px - c.x, py - (c.y + 1.2), pz - c.z);
      if (miss < 2.6) e.onSuppressed(dir);
    }
  }

  onEnemyKilled(enemy, headshot, dir) {
    this.kills++;
    this.killsThisLife++;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (headshot) this.headshots++;
    const base = enemy.type.xp;
    const gained = Math.round(base * (headshot ? 1.5 : 1) + this.streak * 5);
    this.score += gained;
    this.player.kills = this.kills;
    this.hud.hitmarker(true, headshot);
    this.hud.killFlash();
    this.hud.killfeed('YOU', enemy.type.label, { headshot, weapon: this.weaponSystem.def.short });

    // streak rewards
    if (this.streak === 5) this.reward('SUPPLY DROP', 'ammo');
    else if (this.streak === 10) this.reward('BODY ARMOUR', 'armor');
    else if (this.streak === 15) this.reward('COMBAT STIM', 'health');
    else if (this.streak > 0 && this.streak % 20 === 0) this.reward('FIELD PROMOTION +1000', null, 1000);

    // loot drop
    if (chance(0.28)) {
      const kind = chance(0.45) ? 'ammo' : chance(0.6) ? 'health' : 'armor';
      this.spawnPickup(kind, enemy.root.position);
    }
    void dir;
  }

  reward(label, kind, score = 0) {
    if (score) this.score += score;
    this.hud.banner(label, { cls: 'gold', sub: kind ? 'RESUPPLY INBOUND' : '', duration: 2.2, key: label });
    this.audio.pickup();
    if (kind) {
      this.spawnPickup(kind, {
        x: this.player.position.x + rand(-4, 4),
        z: this.player.position.z + rand(-4, 4),
      });
    }
  }

  onPlayerDeath() {
    this.state = 'dead';
    this.audio.setHeartbeat(false);
    setTimeout(() => {
      if (this.hooks.onGameOver) this.hooks.onGameOver(this.stats());
    }, 1400);
  }

  stats() {
    const w = this.weaponSystem;
    return {
      waves: this.waveState === 'active' ? this.wave - 1 : this.wave,
      kills: this.kills,
      headshots: this.headshots,
      accuracy: w.accuracy,
      time: this.elapsed,
      score: this.score,
      bestStreak: this.bestStreak,
    };
  }

  // -------------------------------------------------------------- update ---

  update(dt) {
    if (this.state !== 'playing' && this.state !== 'dead') return;

    this.elapsed += dt;
    const p = this.player;

    // ---- navigation field (shared by every attacker) ----------------------
    // Re-flood only when the goal really moved: re-running it on every jitter
    // makes the gradient flip direction under the AI's feet, which reads as
    // soldiers dithering in a doorway.
    this._navTimer -= dt;
    const navMoved = Math.hypot(p.position.x - this.nav.target.x, p.position.z - this.nav.target.z);
    if (this._navTimer <= 0 && navMoved > 2.5) {
      this.nav.computeField(p.position.x, p.position.z);
      this._navTimer = 2.0;
    }

    // ---- wave scheduling --------------------------------------------------
    if (this.waveState === 'active') {
      this.spawnTimer += dt;
      // Anti-stall: after 45 seconds the survivors actively push the position.
      if (this.spawnTimer > 45) {
        for (const e of this.enemies) {
          if (e.alive && e.awareness < 0.85) e.awareness = 0.85;
        }
      }
      // A soldier that cannot find a way in for a long time is quietly moved
      // to a fresh approach: waves must never deadlock on one straggler.
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.root.position.x - p.position.x, e.root.position.z - p.position.z);
        // "Progress" = closing distance. Anything that stops closing for 22 s
        // (outside the player's view) gets re-routed to a different approach.
        if (e.progressBest === undefined || d < e.progressBest - 3) {
          e.progressBest = d;
          e.stallTime = 0;
        } else {
          e.stallTime = (e.stallTime || 0) + dt;
        }
        if (e.stallTime > 18 && !this.collision.lineOfSight(p.eyePosition, e.aimPoint, 90)) {
          this.reinforce(e);
        }
      }
      while (this.spawnQueue.length && this.spawnQueue[0].at <= this.spawnTimer) {
        const s = this.spawnQueue.shift();
        const alive = this.enemies.filter((e) => e.alive).length;
        if (alive >= this.quality.maxEnemies) {
          s.at = this.spawnTimer + 1.2;
          this.spawnQueue.unshift(s);
          break;
        }
        if (this.spawnEnemy(s.type, s.point)) this.spawnedThisWave++;
      }
      const alive = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
      this.remaining = alive + this.spawnQueue.length;
      if (this.remaining === 0 && this.spawnedThisWave >= 1) {
        this.endWave();
      }
    } else if (this.waveState === 'intermission') {
      this.waveTimer -= dt;
      if (this.waveTimer <= 1.2 && this.waveTimer + dt > 1.2) {
        this.hud.banner(`WAVE ${this.wave + 1} INCOMING`, { cls: 'danger', sub: '', duration: 1.6, key: 'inc' });
      }
      if (this.waveTimer <= 0) this.startWave(this.wave + 1);
    }

    // ---- enemies ----------------------------------------------------------
    for (const e of this.enemies) {
      if (!e.active) continue;
      e.update(dt, p, this.enemies);
    }

    // ---- grenades ---------------------------------------------------------
    for (const g of this.grenades) {
      if (g.active) g.update(dt, p, this.enemies, null);
    }

    // ---- pickups ----------------------------------------------------------
    for (const pk of this.pickups) {
      if (!pk.active) continue;
      if (pk.update(dt, p)) {
        this.applyPickup(pk.kind);
        pk.despawn();
      }
    }

    // ---- explosive barrels ------------------------------------------------
    for (const b of this.map.barrels) {
      if (b.pendingExplode !== undefined && b.pendingExplode > 0) {
        b.pendingExplode -= dt;
        if (b.pendingExplode <= 0) this.detonateBarrel(b);
      }
    }

    // ---- camera shake from world events ------------------------------------
    if (this.effects.shake > 0.02) {
      p.shake = Math.max(p.shake, this.effects.shake * 0.55);
    }

    // ---- low health feedback ------------------------------------------------
    this.audio.setHeartbeat(p.alive && p.health < 34, p.health < 20 ? 128 : 96);

    // ---- stray enemy bullets whizzing past ----------------------------------
    if (p.alive) {
      this.suppressionLevel = damp(this.suppressionLevel || 0, this._recentNearMiss || 0, 6, dt);
      this._recentNearMiss = Math.max(0, (this._recentNearMiss || 0) - dt * 1.6);
    }

    // ---- targets list for ballistics ----------------------------------------
    this.targets.length = 0;
    for (const e of this.enemies) if (e.alive) this.targets.push(e);
    for (const b of this.map.barrels) if (b.alive) this.targets.push(this._barrelTarget(b));

    // ---- update HUD state ---------------------------------------------------
    this.updateHud(dt);
  }

  applyPickup(kind) {
    if (kind === 'health') {
      this.player.heal(38);
      this.hud.banner('+38 HEALTH', { cls: 'gold', duration: 1.2, key: 'hp' });
    } else if (kind === 'armor') {
      this.player.addArmor(55);
      this.hud.banner('+55 ARMOUR', { cls: 'gold', duration: 1.2, key: 'ar' });
    } else {
      for (const id of this.weaponSystem.slots) {
        const st = this.weaponSystem.ammo[id];
        if (!st) continue;
        st.reserve = Math.min(400, st.reserve + 90);
      }
      this.player.grenades = Math.min(4, this.player.grenades + 1);
      this.hud.banner('AMMO RESUPPLY', { cls: 'gold', duration: 1.2, key: 'am' });
    }
    this.audio.pickup();
  }

  // -------------------------------------------------------------- barrels ---

  _barrelTarget(b) {
    if (b._target) return b._target;
    const self = this;
    b._target = {
      isBarrel: true,
      alive: true,
      aimPoint: new THREE.Vector3(b.x, b.y + 0.5, b.z),
      root: { position: new THREE.Vector3(b.x, b.y + 0.55, b.z) },
      position: new THREE.Vector3(b.x, b.y, b.z),
      get alive() {
        return b.alive;
      },
      hitTest(origin, dir, maxDist) {
        if (!b.alive) return null;
        const t = raySphereSimple(origin, dir, b.x, b.y + 0.52, b.z, 0.42);
        if (t === null || t < 0 || t > maxDist) return null;
        const point = {
          x: origin.x + dir.x * t,
          y: origin.y + dir.y * t,
          z: origin.z + dir.z * t,
        };
        return { dist: t, part: 'barrel', point };
      },
      applyDamage(amount) {
        if (!b.alive) return;
        b.health -= amount;
        if (b.health <= 0 && b.pendingExplode === undefined) {
          b.pendingExplode = rand(0.05, 0.22);
        }
        self.hud.hitmarker(false, false);
      },
    };
    return b._target;
  }

  detonateBarrel(b) {
    if (!b.alive) return;
    b.alive = false;
    b.pendingExplode = undefined;
    const pos = new THREE.Vector3(b.x, b.y + 0.5, b.z);
    this.effects.spawnExplosion(pos, 7.5);
    this.audio.explosion(pos);
    this.hud.banner('FUEL DRUM DETONATED', { cls: 'danger', duration: 1.1, key: 'barrel' });

    // damage enemies
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const c = e.root.position;
      const d = Math.hypot(c.x - b.x, c.y + 1 - pos.y, c.z - b.z);
      if (d > 9) continue;
      const los = this.collision.lineOfSight(
        { x: b.x, y: pos.y, z: b.z },
        { x: c.x, y: c.y + 1.1, z: c.z },
        11
      );
      if (!los && d > 2.4) continue;
      const dmg = 170 * Math.pow(1 - d / 9, 1.2);
      e.applyDamage(dmg, 'torso', { x: c.x, y: c.y + 1, z: c.z }, new THREE.Vector3(0, 0.4, 0).normalize(), this.player);
    }
    // hurt the player
    const p = this.player;
    const d = Math.hypot(p.position.x - b.x, p.position.y + 0.9 - pos.y, p.position.z - b.z);
    if (d < 9 && p.alive) {
      const los = this.collision.lineOfSight(
        { x: b.x, y: pos.y, z: b.z },
        { x: p.position.x, y: p.position.y + 1.1, z: p.position.z },
        11
      );
      const dmg = 110 * Math.pow(1 - d / 9, 1.2) * (los ? 1 : 0.4);
      if (dmg > 3) p.takeDamage(dmg, pos);
    }
    // chain reaction
    for (const other of this.map.barrels) {
      if (!other.alive || other === b) continue;
      const dd = Math.hypot(other.x - b.x, other.z - b.z);
      if (dd < 8) other.pendingExplode = rand(0.12, 0.4);
    }
    // hide the mesh
    if (b.mesh) b.mesh.visible = false;
  }

  // ---------------------------------------------------------------- HUD -----

  updateHud(dt) {
    const p = this.player;
    const radar = {
      px: p.position.x,
      pz: p.position.z,
      range: 46,
      enemies: [],
      barrels: [],
      pickups: [],
    };
    const now = performance.now() / 1000;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      radar.enemies.push({
        x: e.root.position.x,
        z: e.root.position.z,
        yaw: e.yaw,
        aware: e.awareness > 0.5,
        firing: now - (e.lastFiredAt || 0) < 0.4 || e.burstLeft > 0,
      });
    }
    for (const b of this.map.barrels) if (b.alive) radar.barrels.push(b);
    for (const pk of this.pickups) if (pk.active) radar.pickups.push(pk.pos);

    const threat = this.waveState === 'active' ? (this.wave >= 6 ? 'EXTREME' : this.wave >= 4 ? 'HIGH' : this.wave >= 2 ? 'MODERATE' : 'LOW') : 'STANDBY';

    this.hud.update(dt, {
      wave: Math.max(1, this.wave),
      remaining: this.remaining,
      waveProgress: this.totalThisWave ? 1 - this.remaining / this.totalThisWave : 1,
      threat,
      score: this.score,
      streak: this.streak,
      radar,
      yaw: p.yaw,
      project: this.project.bind(this),
      suppression: clamp01((this.suppressionLevel || 0) * 0.8),
    });
    this.hud.setScope(this.weaponSystem.isScoped);
  }

  project(v) {
    this._project.copy(v).project(this.camera);
    const visible = this._project.z < 1;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return {
      x: (this._project.x * 0.5 + 0.5) * w,
      y: (-this._project.y * 0.5 + 0.5) * h,
      visible,
    };
  }

  // ------------------------------------------------------------ actions -----

  throwGrenade() {
    const now = performance.now() / 1000;
    if (this.player.grenades <= 0 || now - this._lastGrenadeAt < 0.9) return false;
    this._lastGrenadeAt = now;
    this.player.grenades--;
    this.player.grenadeCooldown = 0.5;
    // pick an idle grenade
    let g = this.grenades.find((x) => !x.active);
    if (!g && this.grenades.length < 4) {
      g = new Grenade(this.entityCtx);
      this.grenades.push(g);
    }
    if (!g) return false;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const origin = this.player.eyePosition.addScaledVector(dir, 0.4);
    origin.y -= 0.1;
    g.throwFrom(origin, dir, 1);
    this.audio.reload('bolt');
    return true;
  }

  requestReload() {
    this.weaponSystem.reload();
  }
}

function raySphereSimple(origin, dir, cx, cy, cz, r) {
  const mx = origin.x - cx;
  const my = origin.y - cy;
  const mz = origin.z - cz;
  const b = mx * dir.x + my * dir.y + mz * dir.z;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return null;
  const discr = b * b - c;
  if (discr < 0) return null;
  let t = -b - Math.sqrt(discr);
  if (t < 0) t = 0;
  return t;
}
