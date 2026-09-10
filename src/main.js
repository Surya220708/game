// ---------------------------------------------------------------------------
// OPERATION BLACKOUT — entry point.
//
// Boot order matters: textures take the longest and everything downstream
// (materials, map, view model) bakes them in, so they go first while the
// loading screen is still up.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

import { settings, QUALITY_PRESETS, isTouchDevice } from './core/Settings.js';
import { configureTextures, getMaterial, MATERIAL_NAMES, horizonColor } from './core/Textures.js';
import { audio } from './core/Audio.js';
import { Input } from './core/Input.js';
import { nextFrame, clamp } from './core/Utils.js';

import { WorldMap } from './world/Map.js';
import { Environment } from './world/Environment.js';
import { Effects } from './fx/Effects.js';
import { RenderSystem } from './render/RenderSystem.js';

import { Player } from './entities/Player.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';

import { HUD } from './ui/HUD.js';
import { Screens } from './ui/Screens.js';
import { Game } from './game/Game.js';

const canvas = document.getElementById('game');
const touchRoot = document.getElementById('touch');

const state = {
  phase: 'boot', // boot | menu | playing | paused | dead
  quality: settings.preset,
  lastTipAt: 0,
};

let renderSystem = null;
let environment = null;
let map = null;
let effects = null;
let input = null;
let player = null;
let weapon = null;
let hud = null;
let screens = null;
let game = null;
let camera = null;

const clock = new THREE.Clock();
let rafId = 0;
let resizeTimer = 0;
let orbit = 0;

function note(text) {
  if (hud?.prompt) hud.prompt(text);
  else console.log(`[blackout] ${text}`);
}

// --------------------------------------------------------------- boot ------

async function boot() {
  screens = new Screens(settings, {
    onDeploy: (loadoutId) => deploy(loadoutId),
    onResume: () => resume(),
    onRestart: () => restart(),
    onQuit: () => quitToMenu(),
    onCloseSettings: () => closeSettings(),
    onSettingsChanged: (info) => onSettingsChanged(info),
    onTouchModeChanged: (mode) => applyTouchMode(mode),
  });

  screens.setDevice(isTouchDevice());
  screens.show('loading');
  screens.setLoading(0.02, 'BOOTING TACTICAL SUITE…');
  await nextFrame();

  const quality = settings.preset;

  try {
    screens.setLoading(0.05, 'GENERATING MATERIALS…');
    await nextFrame();
    configureTextures({ size: quality.textureSize, anisotropy: Math.min(quality.aniso, 8) });
    for (const name of MATERIAL_NAMES) getMaterial(name);

    screens.setLoading(0.51, 'COMPILING SHADERS…');
    await nextFrame();
    renderSystem = new RenderSystem(canvas, quality);
    const renderer = renderSystem.renderer;
    if (!renderer) throw new Error('Renderer unavailable');

    screens.setLoading(0.58, 'BUILDING OUTPOST EAGLE-7…');
    await nextFrame();
    const scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.06, 900);
    camera.rotation.order = 'YXZ';

    environment = new Environment(scene, renderer, quality);
    map = new WorldMap(scene, quality);
    effects = new Effects(scene, map.collision, quality, {
      color: horizonColor(),
      near: 48,
      far: 420,
    });

    screens.setLoading(0.74, 'CALIBRATING WEAPONS…');
    await nextFrame();

    input = new Input(settings);
    input.attach(canvas);
    if (touchRoot) input.bindTouch(touchRoot);

    player = new Player({
      start: map.playerStart,
      camera,
      collision: map.collision,
      audio,
      effects,
      settings,
      hooks: {},
      weapon: null,
    });

    weapon = new WeaponSystem({
      camera,
      scene,
      renderer,
      collision: map.collision,
      effects,
      audio,
      settings,
      input,
      hooks: {},
      environment,
      player,
    });
    player.ctx.weapon = weapon;

    screens.setLoading(0.86, 'SYNCING COMMAND NET…');
    await nextFrame();

    hud = new HUD(player, weapon);
    renderSystem.setupPost(scene, camera, weapon.viewScene, weapon.viewCamera, quality);

    game = new Game({
      scene,
      camera,
      renderer,
      map,
      collision: map.collision,
      effects,
      audio,
      player,
      weaponSystem: weapon,
      hud,
      settings,
      quality,
    });
    game.hooks.onGameOver = (stats) => onPlayerDeath(stats);
    game.initHooks();

    resize();
    screens.setLoading(1, 'READY');
    await nextFrame();

    game.reset();
    state.phase = 'menu';
    screens.show('menu');
    applyTouchMode(screens.touchChoice);

    // menu backdrop: slow orbit of the outpost
    camera.position.set(34, 12, 34);
    camera.lookAt(0, 2, 0);
    input.setEnabled(false);

    loop();
  } catch (err) {
    console.error(err);
    screens.setLoading(1, 'FAILED');
    screens.error(err?.message || String(err));
    state.phase = 'boot';
  }
}

// --------------------------------------------------------- state changes ---

function deploy(loadoutId) {
  audio.resume();
  audio.init();
  screens.show('none');
  state.phase = 'playing';
  game.start(loadoutId);
  input.setEnabled(true);
  input.setTouchActive(input.usingTouch || settings.get('forceTouch'));
  if (!input.usingTouch && !settings.get('forceTouch')) input.requestPointerLock();
  hud.setFpsVisible(!!settings.get('showFps'));
}

function resume() {
  if (state.phase !== 'paused') return;
  state.phase = 'playing';
  screens.show('none');
  input.setEnabled(true);
  audio.resume();
  game.state = 'playing';
  if (!input.usingTouch && !settings.get('forceTouch')) input.requestPointerLock();
}

function pause() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  game.state = 'paused';
  input.setEnabled(false);
  input.exitPointerLock();
  screens.pauseStats(game.stats());
  screens.show('pause');
}

function restart() {
  screens.show('none');
  state.phase = 'playing';
  game.reset();
  game.start(settings.get('loadout') || 'assault');
  input.setEnabled(true);
  if (!input.usingTouch && !settings.get('forceTouch')) input.requestPointerLock();
}

function quitToMenu() {
  state.phase = 'menu';
  game.reset();
  game.state = 'menu';
  input.setEnabled(false);
  input.exitPointerLock();
  screens.show('menu');
}

function onPlayerDeath(stats) {
  if (state.phase === 'dead') return;
  state.phase = 'dead';
  input.setEnabled(false);
  input.exitPointerLock();
  screens.gameOver(stats);
}

function closeSettings() {
  screens.show(state.phase === 'paused' ? 'pause' : 'menu');
}

function applyTouchMode(mode) {
  const touchOn = mode === 'on' || (mode === 'auto' && isTouchDevice());
  input?.setTouchActive(touchOn);
  const playing = state.phase === 'playing';
  screens?.setTouchVisible(playing && touchOn);
}

function onSettingsChanged(info) {
  if (!info) return;
  if (info.key === 'fov') camera.fov = settings.get('fov');
  if (info.key === 'showFps') hud?.setFpsVisible(!!settings.get('showFps'));
  if (info.key === 'effects') effects?.setEnabled?.(!!settings.get('effects'));
  if (info.key === 'volume') audio.setVolume(settings.get('volume'));
  if (info.qualityChanged) applyQuality();
  if (info.key === 'renderScale') resize();
}

function applyQuality() {
  const quality = settings.preset;
  state.quality = quality;
  if (game) game.quality = quality;
  renderSystem.setQuality(quality, settings);
  environment.setQuality(quality);
  effects.setQuality?.(quality);
  resize();
  note('QUALITY UPDATED — RESTART FOR NEW TEXTURE SIZES');
}

// ------------------------------------------------------------- rendering ---

function resize() {
  const quality = settings.preset;
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(240, window.innerHeight);
  renderSystem.setSize(w, h, quality, settings);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  weapon.setViewport(w, h);
  environment.setShadowExtent(clamp(Math.max(w, h) * 0.055, 26, 52));
}

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 120);
}

// ----------------------------------------------------------------- loop ----

function loop() {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  try {
    if (state.phase === 'playing' || state.phase === 'dead') {
      // ---- actions -------------------------------------------------------
      if (input.wasPressed('pause')) {
        pause();
      }
      if (state.phase === 'playing') {
        if (input.wasPressed('reload')) weapon.reload();
        if (input.wasPressed('grenade')) game.throwGrenade();
        if (input.wasPressed('swap')) weapon.cycle();
        if (input.wasPressed('slot1')) weapon.switchToIndex(0);
        if (input.wasPressed('slot2')) weapon.switchToIndex(1);
        if (input.wasPressed('slot3')) weapon.switchToIndex(2);
      }

      // ---- simulation ----------------------------------------------------
      player.update(dt, input, weapon);
      weapon.adsHeld = input.isDown('ads');
      if (state.phase === 'playing') {
        weapon.tryFire(input.isDown('fire'), input.wasPressed('fire'));
      }
      game.update(dt);
      weapon.update(dt, player, game.targets);
      effects.update(dt);
      audio.updateListener(camera);
      environment.update(dt, player.position);
      weapon.applyZoom(camera, settings.get('fov'));

      renderSystem.render(dt);
    } else {
      // ---- menus: orbit the outpost behind the overlay -------------------
      orbit += dt * 0.045;
      const r = 46;
      camera.position.set(Math.sin(orbit) * r + 6, 15 + Math.sin(orbit * 0.7) * 3.5, Math.cos(orbit) * r + 4);
      camera.lookAt(0, 3, 0);
      audio.updateListener(camera);
      environment.update(dt, { x: 0, y: 0, z: 0 });
      renderSystem.render(dt);
    }

    // ---- loading-screen extras ------------------------------------------
    if (state.phase === 'menu') {
      state.lastTipAt += dt;
      if (state.lastTipAt > 6) {
        state.lastTipAt = 0;
        screens.cycleTip();
      }
    }
  } catch (err) {
    console.error(err);
    screens.error(err?.message || String(err));
    state.phase = 'boot';
    cancelAnimationFrame(rafId);
    return;
  }

  input.endFrame();
}

// ---------------------------------------------------------------- events ---

window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.phase === 'playing') pause();
});

// Browser gesture unlocks WebAudio and pointer lock.
canvas?.addEventListener('pointerdown', () => {
  audio.resume();
  if (state.phase === 'playing' && !input.usingTouch && !input.pointerLocked && !settings.get('forceTouch')) {
    input.requestPointerLock();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && state.phase === 'paused') resume();
});

boot();
