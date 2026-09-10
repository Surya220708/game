// ---------------------------------------------------------------------------
// Menus, modals and the loading sequence.
//
// Everything here is plain DOM: the 3D canvas keeps rendering behind the
// overlays, so the menu sits on top of a live orbit view of the outpost.
// ---------------------------------------------------------------------------

import { LOADOUTS, WEAPONS } from '../weapons/Viewmodel.js';
import { formatTime } from '../core/Utils.js';

const TIPS = [
  'Aim for the head — headshots deal double damage.',
  'Crouching tightens your spread and steadies the optic.',
  'Ammo crates and medkits drop from downed attackers.',
  'Shoot the fuel drums when a crowd bottlenecks at the gate.',
  'Reload behind hard cover: the enemy pushes while you fumble.',
  'Holding the trigger long enough walks your aim upward. Tap-fire at range.',
  'Grenades bounce. Cook the corner, not the wall in front of you.',
  'Stamina drains while sprinting — you cannot shoot accurately winded.',
  'The radar shows hostiles that are moving. Standing still hides you too.',
  'Streaks at 5, 10, 15 and 20 kills resupply you — push for the next one.',
  'The marksman rifle one-shots to the chest. Hold your breath.',
  'Watch your ammo counter: the M249 belt is deep but the reload is slow.',
];

const $ = (id) => document.getElementById(id);

export class Screens {
  constructor(settings, hooks = {}) {
    this.settings = settings;
    this.hooks = hooks;
    this.current = 'loading';
    this.loadoutId = this.settings.get('loadout') || 'assault';
    this.touchChoice = this.settings.get('forceTouch') ? 'on' : 'auto';
    this.tipIndex = Math.floor(Math.random() * TIPS.length);

    this.el = {
      hud: $('hud'),
      touch: $('touch'),
      canvas: $('game'),
      loadFill: $('load-fill'),
      loadLog: $('load-log'),
      loadTip: $('load-tip'),
      pauseStats: $('pause-stats'),
      kiaSub: $('kia-sub'),
      stats: {
        waves: $('st-waves'),
        kills: $('st-kills'),
        heads: $('st-heads'),
        acc: $('st-acc'),
        time: $('st-time'),
        score: $('st-score'),
      },
      device: $('menu-device'),
      touchToggle: $('btn-touch-toggle'),
      errorMsg: $('error-msg'),
    };

    for (const name of ['loading', 'menu', 'briefing', 'settings', 'pause', 'gameover', 'error']) {
      this.el[name] = $(`screen-${name}`);
    }

    this._buildLoadoutPicker();
    this._bindSettingsUi();
    this._bindButtons();
    this.setTip();
  }

  // ------------------------------------------------------------ loading ----

  setLoading(fraction, text) {
    const pct = Math.max(0, Math.min(1, fraction));
    if (this.el.loadFill) this.el.loadFill.style.width = `${(pct * 100).toFixed(1)}%`;
    if (text && this.el.loadLog) this.el.loadLog.textContent = text;
  }

  setTip(text) {
    if (!this.el.loadTip) return;
    const tip = text || TIPS[this.tipIndex % TIPS.length];
    this.el.loadTip.textContent = `TIP: ${tip}`;
  }

  cycleTip() {
    this.tipIndex++;
    this.setTip();
  }

  /** 'none' hides every overlay (gameplay view). */
  show(name) {
    for (const key of ['loading', 'menu', 'briefing', 'settings', 'pause', 'gameover', 'error']) {
      const node = this.el[key];
      if (!node) continue;
      node.classList.toggle('hidden', key !== name);
    }
    this.current = name || 'none';
    const playing = this.current === 'none';
    this.el.hud?.classList.toggle('active', playing);
    if (this.el.hud) this.el.hud.setAttribute('aria-hidden', playing ? 'false' : 'true');
    this.setTouchVisible(playing);
    if (this.el.canvas) this.el.canvas.classList.toggle('hidden-canvas', !playing && this.current === 'loading');
  }

  flashLoadingOverlay(showIt) {
    this.el.loading?.classList.toggle('hidden', !showIt);
  }

  setTouchVisible(on) {
    const wantTouch = on && this.touchChoice !== 'off';
    this.el.touch?.classList.toggle('active', !!wantTouch);
    this.el.touch?.classList.toggle('hidden', !wantTouch);
  }

  // ------------------------------------------------------------- loadout ---

  _buildLoadoutPicker() {
    const menu = this.el.menu?.querySelector('.menu-inner');
    if (!menu) return;
    const grid = document.createElement('div');
    grid.className = 'loadout-grid';
    const label = document.createElement('div');
    label.className = 'loadout-label';
    label.textContent = 'SELECT LOADOUT';
    const row = document.createElement('div');
    row.className = 'loadout-row';
    this.loadoutCards = [];
    for (const lo of LOADOUTS) {
      const weapon = WEAPONS[lo.primary];
      const card = document.createElement('button');
      card.className = 'loadout-card';
      card.type = 'button';
      card.dataset.loadout = lo.id;
      card.innerHTML =
        `<b>${lo.name}</b><i>${weapon ? weapon.short : lo.primary.toUpperCase()}</i>` +
        `<span>${lo.desc || ''}</span>`;
      card.addEventListener('click', () => this.setLoadout(lo.id));
      row.appendChild(card);
      this.loadoutCards.push(card);
    }
    const note = document.createElement('div');
    note.className = 'loadout-note';
    note.innerHTML = 'SIDEARM: <b>M9</b> · SWITCH WEAPONS WITH <kbd>1</kbd>/<kbd>2</kbd> OR <kbd>Q</kbd>';
    grid.append(label, row, note);
    const buttons = menu.querySelector('.menu-buttons');
    if (buttons?.nextSibling) menu.insertBefore(grid, buttons.nextSibling);
    else menu.appendChild(grid);
    this.setLoadout(this.loadoutId);
  }

  setLoadout(id) {
    this.loadoutId = id;
    this.settings.set('loadout', id);
    for (const card of this.loadoutCards || []) {
      card.classList.toggle('selected', card.dataset.loadout === id);
    }
  }

  // ------------------------------------------------------------ settings ---

  _bindSettingsUi() {
    this.fields = {
      sens: { input: $('set-sens'), out: $('val-sens'), key: 'sensitivity', fmt: (v) => Number(v).toFixed(2) },
      adsens: { input: $('set-adsens'), out: $('val-adsens'), key: 'adsSensitivity', fmt: (v) => Number(v).toFixed(2) },
      fov: { input: $('set-fov'), out: $('val-fov'), key: 'fov', fmt: (v) => `${Math.round(v)}°` },
      vol: { input: $('set-vol'), out: $('val-vol'), key: 'volume', fmt: (v) => `${Math.round(v * 100)}%` },
      scale: { input: $('set-scale'), out: $('val-scale'), key: 'renderScale', fmt: (v) => Number(v).toFixed(2) },
      quality: { input: $('set-quality'), key: 'quality', fmt: (v) => String(v).toUpperCase() },
      invert: { input: $('set-invert'), key: 'invertY', bool: true },
      assist: { input: $('set-assist'), key: 'aimAssist', bool: true },
      touch: { input: $('set-touch'), key: 'forceTouch', bool: true },
      fx: { input: $('set-fx'), key: 'effects', bool: true },
      fps: { input: $('set-fps'), key: 'showFps', bool: true },
    };
    for (const field of Object.values(this.fields)) {
      if (!field.input) continue;
      const evt = field.bool ? 'change' : 'input';
      field.input.addEventListener(evt, () => this._onFieldChanged(field));
    }
    $('btn-reset-settings')?.addEventListener('click', () => {
      this.settings.reset();
      this.syncSettings();
      this.hooks.onSettingsChanged?.({ qualityChanged: true });
    });
    this.syncSettings();
  }

  _onFieldChanged(field) {
    const raw = field.bool ? field.input.checked : field.input.value;
    const value = field.bool ? !!raw : field.key === 'quality' ? raw : Number(raw);
    const prevQuality = this.settings.get('quality');
    this.settings.set(field.key, value);
    if (field.out) field.out.textContent = field.fmt(value);
    if (field.key === 'forceTouch') this.touchChoice = value ? 'on' : 'off';
    this.hooks.onSettingsChanged?.({
      key: field.key,
      value,
      qualityChanged: field.key === 'quality' && prevQuality !== value,
    });
  }

  syncSettings() {
    for (const field of Object.values(this.fields)) {
      if (!field.input) continue;
      const value = this.settings.get(field.key);
      if (field.bool) field.input.checked = !!value;
      else field.input.value = value;
      if (field.out) field.out.textContent = field.fmt(value);
    }
  }

  // ------------------------------------------------------------- buttons ---

  _bindButtons() {
    const on = (id, fn) => $(id)?.addEventListener('click', fn);

    on('btn-deploy', () => this.hooks.onDeploy?.(this.loadoutId));
    on('btn-briefing', () => this.show('briefing'));
    on('btn-briefing-close', () => this.show('menu'));
    on('btn-settings-menu', () => this.show('settings'));
    on('btn-settings-pause', () => this.show('settings'));
    on('btn-settings-close', () => this.hooks.onCloseSettings?.() ?? this.show('menu'));
    on('btn-resume', () => this.hooks.onResume?.());
    on('btn-restart', () => this.hooks.onRestart?.());
    on('btn-quit', () => this.hooks.onQuit?.());
    on('btn-retry', () => this.hooks.onDeploy?.(this.loadoutId));
    on('btn-gameover-menu', () => this.hooks.onQuit?.());
    on('btn-touch-toggle', () => this._cycleTouch());

    this._syncTouchLabel();
  }

  _cycleTouch() {
    this.touchChoice = this.touchChoice === 'off' ? 'on' : this.touchChoice === 'on' ? 'auto' : 'off';
    const apply = this.touchChoice === 'on';
    this.settings.set('forceTouch', apply);
    const box = this.fields?.touch?.input;
    if (box) box.checked = apply;
    this._syncTouchLabel();
    this.hooks.onTouchModeChanged?.(this.touchChoice);
  }

  _syncTouchLabel() {
    if (!this.el.touchToggle) return;
    const label = this.touchChoice === 'on' ? 'ON' : this.touchChoice === 'off' ? 'OFF' : 'AUTO';
    this.el.touchToggle.textContent = `TOUCH CONTROLS: ${label}`;
  }

  setDevice(isTouch) {
    if (this.el.device) this.el.device.textContent = `DEVICE: ${isTouch ? 'TOUCH — TABLET / PHONE' : 'DESKTOP'}`;
  }

  // --------------------------------------------------------------- stats ---

  pauseStats(stats) {
    if (!this.el.pauseStats) return;
    this.el.pauseStats.innerHTML = `
      <div><b>${stats.waves}</b><span>WAVE</span></div>
      <div><b>${stats.kills}</b><span>KILLS</span></div>
      <div><b>${Math.round(stats.accuracy * 100)}%</b><span>ACCURACY</span></div>
      <div><b>${formatTime(stats.time)}</b><span>TIME</span></div>`;
  }

  gameOver(stats) {
    const s = this.el.stats;
    if (s.waves) s.waves.textContent = stats.waves;
    if (s.kills) s.kills.textContent = stats.kills;
    if (s.heads) s.heads.textContent = stats.headshots;
    if (s.acc) s.acc.textContent = `${Math.round(stats.accuracy * 100)}%`;
    if (s.time) s.time.textContent = formatTime(stats.time);
    if (s.score) s.score.textContent = stats.score.toLocaleString();
    if (this.el.kiaSub) {
      this.el.kiaSub.textContent =
        stats.waves >= 5
          ? `OUTPOST EAGLE-7 HELD FOR ${stats.waves} WAVES`
          : 'OUTPOST EAGLE-7 HAS FALLEN';
    }
    this.show('gameover');
  }

  error(message) {
    if (this.el.errorMsg) this.el.errorMsg.textContent = message;
    this.show('error');
  }
}
