// ---------------------------------------------------------------------------
// Heads-up display: vitals, ammo, wave tracker, score, killfeed, hitmarkers,
// damage direction indicators, dynamic crosshair, radar sweep and compass.
// DOM + 2D canvas only, so it costs almost nothing per frame.
// ---------------------------------------------------------------------------

import { clamp, clamp01, lerp, TAU } from '../core/Utils.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor(player, weaponSystem) {
    this.root = $('hud');
    this.player = player;
    this.weapon = weaponSystem;

    this.el = {
      healthFill: $('health-fill'),
      healthNum: $('health-num'),
      staminaFill: $('stamina-fill'),
      armorFill: $('armor-fill'),
      staminaNum: $('stamina-num'),
      armorNum: $('armor-num'),
      vitals: $('vitals'),
      ammoMag: $('ammo-mag'),
      ammoRes: $('ammo-res'),
      ammoWrap: document.querySelector('.wpn-ammo'),
      weaponName: $('weapon-name'),
      firemode: $('firemode'),
      grenades: $('grenade-count'),
      reloadHint: $('reload-hint'),
      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      waveNum: $('wave-num'),
      waveStatus: $('wave-status'),
      waveBar: $('wave-bar'),
      waveThreat: $('wave-threat'),
      score: $('score'),
      streak: $('streak'),
      killfeed: $('killfeed'),
      banners: $('banners'),
      prompt: $('prompt'),
      damageFlash: $('damage-flash'),
      suppression: $('suppression'),
      dmgdir: $('dmgdir'),
      scope: $('scope'),
      killflash: $('killflash'),
      radar: $('radar'),
      compass: $('compass'),
      objective: $('objective'),
    };

    this.radarCtx = this.el.radar.getContext('2d');
    this.compassCtx = this.el.compass.getContext('2d');
    this.radarDpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.radar.width = 152 * this.radarDpr;
    this.el.radar.height = 152 * this.radarDpr;
    this.compassDpr = Math.min(2, window.devicePixelRatio || 1);
    this.compassW = 512;
    this.el.compass.width = this.compassW;
    this.el.compass.height = 48;

    this.damageNumbers = [];
    this._dnPool = [];
    this.killfeedItems = [];
    this.bannerQueue = [];
    this._bannerEl = null;
    this._lastBanner = '';
    this._lastBannerAt = 0;
    this._flashT = 0;
    this.radarAngle = 0;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.fps = 0;
    this.fpsEl = null;
    this.scoped = false;
    this._ammoCache = '';
    this._hpCache = -1;
  }

  show() {
    this.root.classList.remove('hidden');
    requestAnimationFrame(() => this.root.classList.add('active'));
  }

  hide() {
    this.root.classList.remove('active');
    this.root.classList.add('hidden');
  }

  setFpsVisible(on) {
    if (on && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.id = 'fps-counter';
      this.fpsEl.style.cssText =
        'position:absolute;left:8px;bottom:8px;font-size:10px;letter-spacing:.12em;color:rgba(134,255,176,.75);font-family:ui-monospace,monospace;';
      this.root.appendChild(this.fpsEl);
    }
    if (this.fpsEl) this.fpsEl.style.display = on ? 'block' : 'none';
  }

  // ------------------------------------------------------------ feedback ---

  hitmarker(kill = false, headshot = false) {
    const hm = this.el.hitmarker;
    hm.classList.remove('show', 'kill');
    void hm.offsetWidth;
    if (kill) hm.classList.add('kill');
    if (headshot) hm.style.filter = 'drop-shadow(0 0 6px #ff4438)';
    else hm.style.filter = '';
    hm.classList.add('show');
  }

  killFlash() {
    const k = this.el.killflash;
    k.classList.remove('on');
    void k.offsetWidth;
    k.classList.add('on');
  }

  flashDamage() {
    const f = this.el.damageFlash;
    f.classList.add('hit');
    this._flashT = 0.09;
  }

  damageDirection(worldAngle, yaw) {
    const rel = worldAngle - yaw;
    const deg = (rel * 180) / Math.PI;
    const div = document.createElement('div');
    div.className = 'dmgarc';
    div.style.transform = `rotate(${deg}deg)`;
    this.el.dmgdir.appendChild(div);
    setTimeout(() => div.remove(), 1200);
  }

  banner(text, { sub = '', cls = '', duration = 2.2, key = '' } = {}) {
    const now = performance.now();
    if (key && key === this._lastBanner && now - this._lastBannerAt < 900) return;
    this._lastBanner = key;
    this._lastBannerAt = now;
    const el = document.createElement('div');
    el.className = `banner ${cls}`;
    el.textContent = text;
    this.el.banners.appendChild(el);
    if (sub) {
      const s = document.createElement('div');
      s.className = 'banner sub';
      s.textContent = sub;
      this.el.banners.appendChild(s);
      setTimeout(() => {
        s.classList.add('out');
        setTimeout(() => s.remove(), 450);
      }, duration * 1000);
    }
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }, duration * 1000);
  }

  killfeed(killer, victim, { headshot = false, weapon = '' } = {}) {
    const el = document.createElement('div');
    el.className = 'kf-item';
    el.innerHTML = `<b>${killer}</b> ${weapon}${headshot ? ' <span class="hs">[HEADSHOT]</span>' : ''} ${victim}`;
    this.el.killfeed.appendChild(el);
    this.killfeedItems.push(el);
    if (this.killfeedItems.length > 5) {
      const old = this.killfeedItems.shift();
      old.remove();
    }
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 600);
      this.killfeedItems = this.killfeedItems.filter((i) => i !== el);
    }, 3600);
  }

  damageNumber(worldPos, amount, { headshot = false, kill = false } = {}) {
    let dn = this._dnPool.find((d) => !d.active);
    if (!dn) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;font-family:ui-monospace,monospace;font-weight:700;font-size:15px;pointer-events:none;text-shadow:0 2px 5px #000;will-change:transform,opacity;';
      this.root.appendChild(el);
      dn = { el, active: false, t: 0, x: 0, y: 0, vy: 0 };
      this._dnPool.push(dn);
    }
    dn.active = true;
    dn.t = 0;
    dn.life = 0.9;
    dn.world = worldPos.clone();
    dn.vy = 0;
    dn.el.textContent = kill ? `${Math.round(amount)} ✖` : `${Math.round(amount)}`;
    dn.el.style.color = kill ? '#ffb648' : headshot ? '#ff6b5e' : '#ffffff';
    dn.el.style.fontSize = headshot ? '19px' : kill ? '18px' : '15px';
    dn.el.style.opacity = '1';
  }

  prompt(text) {
    if (!text) {
      this.el.prompt.classList.add('hidden');
      return;
    }
    this.el.prompt.textContent = text;
    this.el.prompt.classList.remove('hidden');
  }

  setScope(on) {
    if (on === this.scoped) return;
    this.scoped = on;
    this.el.scope.classList.toggle('hidden', !on);
  }

  // -------------------------------------------------------------- update ---

  update(dt, state) {
    const p = this.player;
    const w = this.weapon;

    // ---- vitals ---------------------------------------------------------
    const hp = Math.round(p.health);
    if (hp !== this._hpCache) {
      this._hpCache = hp;
      this.el.healthNum.textContent = hp;
      this.el.healthFill.style.width = `${clamp01(p.health / p.maxHealth) * 100}%`;
      this.el.vitals.classList.toggle('low', p.health < 35);
    }
    this.el.staminaFill.style.width = `${clamp01(p.stamina / 100) * 100}%`;
    this.el.armorFill.style.width = `${clamp01(p.armor / p.maxArmor) * 100}%`;
    this.el.armorNum.textContent = Math.round(p.armor);
    this.el.staminaNum.textContent = Math.round(p.stamina);

    // ---- weapon ----------------------------------------------------------
    const st = w.ammoState;
    const key = `${st.mag}/${st.reserve}/${w.def.id}`;
    if (key !== this._ammoCache) {
      this._ammoCache = key;
      this.el.ammoMag.textContent = st.mag;
      this.el.ammoRes.textContent = st.reserve;
      this.el.weaponName.textContent = w.def.name;
      this.el.firemode.textContent = w.def.auto ? 'AUTO' : 'SEMI';
      this.el.ammoWrap.classList.toggle('empty', st.mag === 0);
    }
    this.el.grenades.textContent = p.grenades > 0 ? '◆'.repeat(p.grenades) : '—';
    const needReload = st.mag === 0 || (st.mag <= Math.max(3, w.def.mag * 0.18) && st.reserve > 0);
    this.el.reloadHint.classList.toggle('hidden', !needReload || w.reloading);

    // ---- crosshair --------------------------------------------------------
    const spread = w.spreadDeg;
    const gap = clamp(5 + spread * 3.4, 5, 34);
    this.el.crosshair.style.setProperty('--gap', `${gap}px`);
    this.el.crosshair.classList.toggle('ads', w.adsT > 0.65);
    this.el.crosshair.style.opacity = w.isScoped ? '0' : '1';

    // ---- wave / score ------------------------------------------------------
    if (state) {
      if (state.wave !== undefined) this.el.waveNum.textContent = state.wave;
      if (state.remaining !== undefined) this.el.waveStatus.textContent = `${state.remaining} REMAINING`;
      if (state.waveProgress !== undefined) this.el.waveBar.style.width = `${clamp01(state.waveProgress) * 100}%`;
      if (state.threat) this.el.waveThreat.textContent = `THREAT LEVEL: ${state.threat}`;
      if (state.score !== undefined) this.el.score.textContent = state.score.toLocaleString();
      if (state.streak !== undefined) this.el.streak.textContent = state.streak;
      if (state.radar) this._drawRadar(state.radar, state.yaw);
      if (state.yaw !== undefined) this._drawCompass(state.yaw);
      this._updateDamageNumbers(dt, state.project);
      if (state.suppression !== undefined) {
        this.el.suppression.style.opacity = state.suppression;
      }
    }

    // ---- damage flash -------------------------------------------------------
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0) this.el.damageFlash.classList.remove('hit');
    }

    // ---- fps ---------------------------------------------------------------
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      if (this.fpsEl && this.fpsEl.style.display !== 'none') {
        this.fpsEl.textContent = `${this.fps} FPS`;
      }
    }
  }

  _updateDamageNumbers(dt, project) {
    for (const dn of this._dnPool) {
      if (!dn.active) continue;
      dn.t += dt;
      const k = dn.t / dn.life;
      if (k >= 1) {
        dn.active = false;
        dn.el.style.opacity = '0';
        continue;
      }
      const p = dn.world.clone();
      p.y += k * 0.75;
      const screen = project ? project(p) : null;
      if (!screen || !screen.visible) {
        dn.el.style.opacity = '0';
        continue;
      }
      dn.el.style.transform = `translate(${screen.x}px, ${screen.y}px) translate(-50%,-50%) scale(${lerp(1.25, 0.92, clamp01(k * 3))})`;
      dn.el.style.opacity = `${1 - Math.pow(k, 3)}`;
    }
  }

  // -------------------------------------------------------------- radar ----

  _drawRadar(data, playerYaw) {
    const ctx = this.radarCtx;
    const size = 152;
    const dpr = this.radarDpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2;
    const range = data.range || 46;
    const scale = (size / 2 - 6) / range;

    // grid
    ctx.strokeStyle = 'rgba(126,231,255,0.16)';
    ctx.lineWidth = 1;
    for (const r of [range / 3, (range * 2) / 3, range]) {
      ctx.beginPath();
      ctx.arc(c, c, r * scale, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c, 4);
    ctx.lineTo(c, size - 4);
    ctx.moveTo(4, c);
    ctx.lineTo(size - 4, c);
    ctx.stroke();

    // sweep
    this.radarAngle += 0.045;
    const grad = ctx.createLinearGradient(c, c, c + Math.sin(this.radarAngle) * size, c - Math.cos(this.radarAngle) * size);
    grad.addColorStop(0, 'rgba(126,231,255,0.0)');
    grad.addColorStop(1, 'rgba(126,231,255,0.34)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.sin(this.radarAngle) * (size / 2 - 6), c - Math.cos(this.radarAngle) * (size / 2 - 6));
    ctx.stroke();

    const cos = Math.cos(-playerYaw);
    const sin = Math.sin(-playerYaw);
    const toRadar = (wx, wz) => {
      const dx = wx - data.px;
      const dz = wz - data.pz;
      // rotate into player space (player faces -Z in world at yaw 0)
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return { x: c + rx * scale, y: c + rz * scale };
    };

    // cover / barrels
    if (data.barrels) {
      ctx.fillStyle = 'rgba(255,150,60,0.5)';
      for (const b of data.barrels) {
        const p = toRadar(b.x, b.z);
        if (Math.hypot(p.x - c, p.y - c) > size / 2 - 5) continue;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
    }
    // pickups
    if (data.pickups) {
      ctx.fillStyle = 'rgba(134,255,176,0.85)';
      for (const b of data.pickups) {
        const p = toRadar(b.x, b.z);
        if (Math.hypot(p.x - c, p.y - c) > size / 2 - 5) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, TAU);
        ctx.fill();
      }
    }
    // enemies
    if (data.enemies) {
      for (const e of data.enemies) {
        const p = toRadar(e.x, e.z);
        const d = Math.hypot(p.x - c, p.y - c);
        if (d > size / 2 - 5) continue;
        const hot = e.firing;
        ctx.fillStyle = hot ? '#ff4438' : e.aware ? '#ff7a5a' : 'rgba(255,80,60,0.55)';
        if (hot) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, TAU);
          ctx.fillStyle = 'rgba(255,68,56,0.25)';
          ctx.fill();
          ctx.fillStyle = '#ff4438';
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, TAU);
        ctx.fill();
        // facing tick
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.sin(e.yaw - playerYaw + Math.PI) * 7, p.y + Math.cos(e.yaw - playerYaw + Math.PI) * 7);
        ctx.stroke();
      }
    }

    // player chevron
    ctx.fillStyle = '#86ffb0';
    ctx.beginPath();
    ctx.moveTo(c, c - 7);
    ctx.lineTo(c - 5.5, c + 5);
    ctx.lineTo(c, c + 2);
    ctx.lineTo(c + 5.5, c + 5);
    ctx.closePath();
    ctx.fill();

    // outer ring + north marker
    ctx.strokeStyle = 'rgba(126,231,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, size / 2 - 3, 0, TAU);
    ctx.stroke();
    const nAng = -playerYaw - Math.PI / 2;
    ctx.fillStyle = 'rgba(255,182,72,0.9)';
    ctx.font = 'bold 8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', c + Math.cos(nAng) * (size / 2 - 11), c + Math.sin(nAng) * (size / 2 - 11));
  }

  // ------------------------------------------------------------ compass ----

  _drawCompass(yaw) {
    const ctx = this.compassCtx;
    const W = this.compassW;
    const H = 48;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const degreesPerPixel = 220 / W; // the strip spans 220 degrees
    const heading = ((-yaw * 180) / Math.PI + 360) % 360;
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = -180; d <= 180; d += 5) {
      let rel = d - ((heading + 180) % 360 - 180);
      rel = ((rel + 540) % 360) - 180;
      const x = W / 2 + rel / degreesPerPixel;
      if (x < -40 || x > W + 40) continue;
      const abs = ((d % 360) + 360) % 360;
      const isMajor = abs % 45 === 0;
      const isMid = abs % 15 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(255,182,72,0.95)' : isMid ? 'rgba(223,231,226,0.5)' : 'rgba(223,231,226,0.25)';
      ctx.lineWidth = isMajor ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 6 : isMid ? 12 : 18);
      ctx.lineTo(x, isMajor ? 20 : isMid ? 20 : 22);
      ctx.stroke();
      if (labels[abs]) {
        ctx.fillStyle = abs === 0 ? '#ffb648' : 'rgba(223,231,226,0.9)';
        ctx.font = 'bold 20px ui-monospace, monospace';
        ctx.fillText(labels[abs], x, 36);
      } else if (isMajor) {
        ctx.fillStyle = 'rgba(223,231,226,0.55)';
        ctx.font = '16px ui-monospace, monospace';
        ctx.fillText(String(abs), x, 36);
      }
    }
  }
}
