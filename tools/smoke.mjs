// ---------------------------------------------------------------------------
// Headless smoke test: boots the world, actor and combat systems against a
// stubbed DOM and plays a scripted match, asserting that nothing throws and
// that the core combat loop actually functions.
//
//   npm run smoke
// ---------------------------------------------------------------------------

import { installDom, fakeRenderer } from './dom-stub.mjs';
installDom();

// Deterministic mode: SEED=123 node tools/smoke.mjs
if (process.env.SEED) {
  const { mulberry32 } = await import('../src/core/Utils.js');
  Math.random = mulberry32(Number(process.env.SEED) | 0);
}

const THREE = await import('three');
const { configureTextures, getMaterial, MATERIAL_NAMES } = await import('../src/core/Textures.js');
const { settings } = await import('../src/core/Settings.js');
const { audio } = await import('../src/core/Audio.js');
const { Input } = await import('../src/core/Input.js');
const { WorldMap } = await import('../src/world/Map.js');
const { Effects } = await import('../src/fx/Effects.js');
const { Player } = await import('../src/entities/Player.js');
const { WeaponSystem } = await import('../src/weapons/WeaponSystem.js');
const { Game } = await import('../src/game/Game.js');
const { HUD } = await import('../src/ui/HUD.js');
const { Screens } = await import('../src/ui/Screens.js');
const { enemyCount } = await import('../src/entities/Enemy.js');
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`);
}

const t0 = Date.now();
const quality = QUALITY_PRESETS.low;
configureTextures({ size: 64, anisotropy: 1 });

console.log('\n[1] procedural materials');
for (const name of MATERIAL_NAMES) {
  const m = getMaterial(name);
  if (!m || !m.map) {
    check(`material ${name}`, false);
  }
}
check('all surface materials generated', MATERIAL_NAMES.every((n) => getMaterial(n).map));

console.log('\n[2] level construction');
const scene = new THREE.Scene();
const map = new WorldMap(scene, quality);
check('collision boxes built', map.collision.boxes.length > 100, `(${map.collision.boxes.length})`);
check('ramps built', map.collision.ramps.length >= 4, `(${map.collision.ramps.length})`);
check('spawn points', map.spawnPoints.length >= 12, `(${map.spawnPoints.length})`);
check('explosive barrels', map.barrels.length === 6, `(${map.barrels.length})`);
check('merged draw calls', map.meshes.length < 45, `(${map.meshes.length} meshes)`);
check('terrain height flat inside', Math.abs(map.collision.terrainHeight(0, 0) - 0.02) < 0.001);

console.log('\n[3] actors');
const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.06, 900);
camera.rotation.order = 'YXZ';
const effects = new Effects(scene, map.collision, quality, new THREE.Fog(0x6b6152, 48, 420));
const input = new Input(settings);
input.attach(document.createElement('canvas'));
input.bindTouch(document.getElementById('touch'));
const player = new Player({
  start: map.playerStart,
  camera,
  collision: map.collision,
  audio,
  effects,
  settings,
  hooks: {},
  weapon: null,
});
const weapon = new WeaponSystem({
  camera,
  scene,
  renderer: fakeRenderer(),
  collision: map.collision,
  effects,
  audio,
  settings,
  input,
  hooks: {},
  environment: null,
  player,
});
player.ctx.weapon = weapon;
const hud = new HUD(player, weapon);
const game = new Game({
  scene,
  camera,
  renderer: fakeRenderer(),
  collision: map.collision,
  effects,
  audio,
  input,
  settings,
  hud,
  weaponSystem: weapon,
  map,
  player,
  quality,
  hooks: { onGameOver: (s) => (globalThis.__gameOver = s) },
});
game.initHooks();
check('enemy pool created', game.enemies.length >= 10, `(${game.enemies.length})`);
check('player standing on ground', Math.abs(player.position.y - 0.05) < 0.2, `y=${player.position.y.toFixed(3)}`);

console.log('\n[4] simulated combat');
const fakeInput = {
  axis: { x: 0, y: 0 },
  sprinting: false,
  crouching: false,
  usingTouch: false,
  _lastLook: { x: 0, y: 0 },
  down: new Set(),
  pressed: new Set(),
  isDown(a) {
    return this.down.has(a);
  },
  wasPressed(a) {
    return this.pressed.has(a);
  },
  wasReleased: () => false,
  consumeLook() {
    return { x: 0, y: 0 };
  },
  endFrame() {
    this.pressed.clear();
  },
};

let enemyShots = 0;
let noTargetFor = 0;
let botBest = Infinity;
let botStuck = 0;
let botSide = 1;
let botSideFor = 0;
const seenStates = new Set();
const origFlash = effects.spawnMuzzleFlash.bind(effects);
effects.spawnMuzzleFlash = (pos, dir, scale, fromPlayer) => {
  if (!fromPlayer) enemyShots++;
  return origFlash(pos, dir, scale, fromPlayer);
};

game.start('assault');
let maxEnemiesSeen = 0;
let shotsBefore = 0;
let framesRun = 0;
const dt = 1 / 60;
const simSeconds = 150;

for (let f = 0; f < simSeconds * 60; f++) {
  const t = f * dt;
  framesRun++;

  // aim at the closest live enemy
  let best = null;
  let bestD = Infinity;
  const eye = player.eyePosition;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const d = e.root.position.distanceTo(player.position);
    if (d > 70) continue;
    // only shoot at what we can actually see, like a real player
    const los = map.collision.lineOfSight(eye, e.aimPoint, 80);
    if (!los) continue;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  // No target in sight for a while? Move to contact like a real player would,
  // which also mines the level for navigation regressions.
  noTargetFor = best ? 0 : noTargetFor + dt;
  const hunt = !best && noTargetFor > 6 && game.enemies.some((e) => e.alive);
  let huntTarget = null;
  let huntDist = Infinity;
  if (hunt) {
    let bd = Infinity;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const d = e.root.position.distanceTo(player.position);
      if (d < bd) {
        bd = d;
        huntTarget = e;
      }
    }
  }
  if (huntTarget) {
    huntDist = huntTarget.root.position.distanceTo(player.position);
    // crude pathing for the test bot: if it stops closing, sidestep for a bit —
    // otherwise it grinds into the first wall between it and the straggler.
    if (huntDist < botBest - 0.5) {
      botBest = huntDist;
      botStuck = 0;
    } else {
      botStuck += dt;
    }
    if (botStuck > 2.2 && botSideFor <= 0) {
      botSide *= -1;
      botSideFor = 1.4;
      botStuck = 0;
      botBest = Infinity;
    }
    const dx = huntTarget.root.position.x - player.position.x;
    const dz = huntTarget.root.position.z - player.position.z;
    const wantYaw = Math.atan2(dx, dz) + Math.PI;
    player.yaw += Math.atan2(Math.sin(wantYaw - player.yaw), Math.cos(wantYaw - player.yaw)) * 0.4;
    const dy = huntTarget.root.position.y + 1.2 - (player.position.y + player.eyeHeight);
    player.pitch += (Math.atan2(dy, Math.max(2, huntDist)) - player.pitch) * 0.3;
  }

  if (best) {
    const dx = best.root.position.x - player.position.x;
    const dz = best.root.position.z - player.position.z;
    const wantYaw = Math.atan2(dx, dz) + Math.PI;
    player.yaw += Math.atan2(Math.sin(wantYaw - player.yaw), Math.cos(wantYaw - player.yaw)) * 0.5;
    const dy = best.root.position.y + 1.25 - (player.position.y + player.eyeHeight);
    player.pitch += (Math.atan2(dy, bestD) - player.pitch) * 0.5;
  }

  // scripted behaviour: hold a defensive position, aim down sights, shoot
  if (botSideFor > 0) botSideFor -= dt;
  if (huntTarget) {
    fakeInput.axis.x = botSideFor > 0 ? botSide : 0;
    fakeInput.axis.y = 1;
  } else {
    fakeInput.axis.x = best && bestD > 30 ? Math.sin(t * 0.6) : 0;
    fakeInput.axis.y = best && bestD > 32 ? 1 : 0;
  }
  fakeInput.crouching = false;
  fakeInput.down.delete('sprint');
  fakeInput.down.add('ads');
  if (f % 90 < 55 && best) fakeInput.down.add('fire');
  else fakeInput.down.delete('fire');
  if (Math.abs(t - Math.floor(t / 6) * 6 - 0.1) < dt) fakeInput.pressed.add('reload');
  if (Math.abs(t - Math.floor(t / 37) * 37 - 0.3) < dt) fakeInput.pressed.add('grenade');
  if (Math.abs(t - Math.floor(t / 53) * 53 - 0.5) < dt) fakeInput.pressed.add('swap');
  if (Math.abs(t - Math.floor(t / 59) * 59 - 0.2) < dt) fakeInput.pressed.add('reload');
  if (Math.abs(t - Math.floor(t / 71) * 71 - 0.4) < dt) fakeInput.pressed.add('slot1');
  if (Math.abs(t - Math.floor(t / 47) * 47 - 0.2) < dt && player.grounded) {
    player.velocity.y = 7.3;
    player.grounded = false;
  }
  // exercise the explosive props
  if (Math.abs(t - 100) < dt) {
    for (const b of map.barrels) if (b.alive) { b.pendingExplode = 0.01; break; }
  }
  if (Math.abs(t - 120) < dt) {
    player.alive = true;
    player.health = 100;
    game.state = 'playing';
    player.takeDamage(45, { x: 20, y: 0, z: 20 });   // damage-direction indicator
  }
  if (Math.abs(t - 130) < dt) {
    game.throwGrenade();
  }

  // ---- frame ----------------------------------------------------------
  try {
    player.update(dt, fakeInput, weapon);
    if (fakeInput.pressed.has('reload')) weapon.reload();
    if (fakeInput.pressed.has('grenade')) game.throwGrenade();
    if (fakeInput.pressed.has('swap')) weapon.cycle();
    weapon.adsHeld = fakeInput.down.has('ads');
    weapon.tryFire(fakeInput.down.has('fire'), fakeInput.pressed.has('fire'));
    weapon.update(dt, player, game.targets);
    game.update(dt);
    effects.update(dt);
    audio.updateListener(camera);
    hud.update(dt, { wave: game.wave, remaining: game.remaining, score: game.score, streak: game.streak, radar: { px: player.position.x, pz: player.position.z, enemies: [], barrels: [], pickups: [] }, yaw: player.yaw, project: game.project.bind(game) });
    fakeInput.endFrame();
  } catch (err) {
    check(`frame ${f} (t=${t.toFixed(1)}s)`, false, err.stack.split('\n').slice(0, 3).join(' | '));
    break;
  }

  if (globalThis.VERBOSE && f % 600 === 0) {
    const alive = game.enemies.filter((e) => e.alive);
    const states = alive.reduce((a, e) => ((a[e.state] = (a[e.state] || 0) + 1), a), {});
    const nearest = alive.map((e) => Math.hypot(e.root.position.x - player.position.x, e.root.position.z - player.position.z)).sort((a, b) => a - b)[0];
    console.log(
      `   t=${(f / 60).toFixed(0)}s wave=${game.wave} queue=${game.spawnQueue.length} alive=${alive.length} ` +
        `${JSON.stringify(states)} nearest=${nearest ? nearest.toFixed(1) : '-'}m hp=${player.health.toFixed(0)} alive=${player.alive} state=${game.state} shots=${weapon.shotsFired} enemyShots=${enemyShots}`
    );
  }
  if (globalThis.VERBOSE && (f === 60 * 60 || f === 120 * 60)) {
    for (const e of game.enemies) {
      if (!e.alive) continue;
      console.log(
        `   [diag] state=${e.state} stationary=${e.stationary} tower=${e.tower} target=${e.aliveTarget ? 'yes' : 'no'} ` +
          `aware=${e.awareness.toFixed(2)} vel=(${e.vel.x.toFixed(2)},${e.vel.z.toFixed(2)}) walk=${e.walkSpeed.toFixed(2)} ` +
          `wp=${e.waypoint ? JSON.stringify(e.waypoint) : 'null'} pathIdx=${e.pathIndex} wall=${e._wallSide} type=${e.type.id} navD=${e.ctx.nav && e.ctx.nav.distanceTo(e.root.position.x, e.root.position.z).toFixed(1)}`
      );
    }
  }
  if (globalThis.VERBOSE && f % 600 === 0) {
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const nav = e.ctx.nav;
      console.log(
        `      [nav] ${e.state} pos=(${e.root.position.x.toFixed(1)},${e.root.position.z.toFixed(1)}) ` +
          `field=${nav ? nav.distanceTo(e.root.position.x, e.root.position.z).toFixed(1) : '-'} ` +
          `true=${Math.hypot(e.root.position.x - player.position.x, e.root.position.z - player.position.z).toFixed(1)} ` +
          `vel=${e.walkSpeed.toFixed(2)} wall=${e._wallSide} pathIdx=${e.pathIndex} aware=${e.awareness.toFixed(2)}` +
          (nav ? ` cell=${(() => { const c = nav.cellOf(e.root.position.x, e.root.position.z); return nav.blocked[nav.index(c.ix, c.iz)] ? 'BLOCKED' : 'open'; })()} flow=${(() => { const d = nav.sample(e.root.position.x, e.root.position.z, { x: 0, z: 0 }); return d ? `${d.x.toFixed(2)},${d.z.toFixed(2)}` : 'none'; })()}` : '')
      );
    }
  }
  for (const e of game.enemies) if (e.alive) seenStates.add(e.state);
  if (f % 120 === 0) {
    const alive = game.enemies.filter((e) => e.alive).length;
    maxEnemiesSeen = Math.max(maxEnemiesSeen, alive);
    if (!Number.isFinite(player.position.x + player.position.y + player.position.z)) {
      check('player position finite', false);
      break;
    }
  }
  // revive occasionally so the run keeps exercising systems
  if (!player.alive && !globalThis.__gameOver) {
    player.alive = true;
    player.health = 100;
    game.state = 'playing';
    game.player.alive = true;
  }
  if (globalThis.__gameOver && f > 60) {
    // restart the run to exercise reset()
    globalThis.__gameOver = null;
    game.reset();
    game.start('recon');
    player.alive = true;
    game.state = 'playing';
    shotsBefore = weapon.shotsFired;
  }
}

console.log(
  `\n  ran ${framesRun} frames (${(framesRun / 60).toFixed(0)}s sim) killed=${game.kills} headshots=${game.headshots} ` +
    `shots=${weapon.shotsFired} hits=${weapon.shotsHit} waves=${game.wave} score=${game.score} enemiesSpawned≈${game.spawnedThisWave}`
);

console.log('\n[5] invariants');
check('enemies returned fire', enemyShots > 8, `enemy shots=${enemyShots}`);
check('barrels detonated cleanly', map.barrels.filter((b) => !b.alive).length >= 1);
check('enemy states populated', seenStates.has('engage') && seenStates.has('advance'), `states seen: ${[...seenStates].join(',')}`);
check('combat produced kills', game.kills > 0, `kills=${game.kills}`);
check('shots were fired', weapon.shotsFired > 50, `shots=${weapon.shotsFired}`);
check('hits registered', weapon.shotsHit > 0, `hits=${weapon.shotsHit}`);
check('waves advanced', game.wave >= 2, `wave=${game.wave}`);
check('hit rate plausible', weapon.shotsFired < 50 || weapon.shotsHit / weapon.shotsFired > 0.08, `rate=${(weapon.shotsHit / Math.max(1, weapon.shotsFired) * 100).toFixed(1)}%`);
check('score accumulated', game.score > 500, `score=${game.score}`);
check('enemies got damaged or died', game.enemies.some((e) => !e.alive || e.health < e.maxHealth));
check('player position finite', Number.isFinite(player.position.x + player.position.y + player.position.z));
check('player stayed in bounds', Math.abs(player.position.x) < 130 && Math.abs(player.position.z) < 130);
check('particles pooled', effects.alphaPool.data.length > 0 && effects.firePool.data.length > 0);
check('player health within range', player.health >= 0 && player.health <= 100, `hp=${player.health.toFixed(1)}`);
check('all weapon slots resolvable', weapon.slots.every((id) => !!id));
check('ammo never negative', weapon.slots.every((id) => weapon.ammo[id].mag >= 0 && weapon.ammo[id].reserve >= 0));
check('no NaN in enemy positions', game.enemies.every((e) => Number.isFinite(e.root.position.x + e.root.position.z)));

console.log('\n[6] collision unit checks');
const cw = map.collision;
const ground = cw.groundAt(0, 0, 5);
check('compound ground height', Math.abs(ground - 0.05) < 0.06, `y=${ground.toFixed(3)}`);
const hit = cw.raycast(new THREE.Vector3(0, 6, 0), new THREE.Vector3(0, -1, 0), 20);
check('raycast hits compound floor', !!hit && Math.abs(hit.point.y - 0.05) < 0.12, hit ? `y=${hit.point.y.toFixed(3)}` : 'miss');
const wallHit = cw.raycast(new THREE.Vector3(0, 1.6, 4), new THREE.Vector3(0, 0, -1), 30);
check('raycast hits command post wall', !!wallHit, wallHit ? `d=${wallHit.dist.toFixed(2)}` : 'miss');
const insideWall = cw.overlaps(-2, -12.2, 0.4, 1.0, 2.0);
check('overlap detects interior partition', !!insideWall, `@(-2,-12.2)`);
check('overlap detects west wall', !!cw.overlaps(-14, -8, 0.4, 1.0, 2.0));
check('overlap clear in open compound', !cw.overlaps(4, 34, 0.4, 0.3, 1.6));
const losBlocked = cw.lineOfSight({ x: 0, y: 1.6, z: 6 }, { x: 0, y: 1.6, z: -20 }, 40);
check('line of sight blocked by building', losBlocked === false);

// ---- navigation field: can every approach actually reach the player? -----
const nav = game.nav;
const out = { x: 0, z: 0 };
let reachable = 0;
const unreachable = [];
const walkSpawns = map.spawnPoints.filter((sp) => !sp.tower);
for (let i = 0; i < walkSpawns.length; i++) {
  const sp = walkSpawns[i];
  let x = sp.x;
  let z = sp.z;
  let d = nav.distanceTo(x, z);
  const startD = d;
  let ok = Number.isFinite(d);
  for (let step = 0; step < 1200 && ok; step++) {
    const dir = nav.sample(x, z, out);
    if (!dir) break;
    const nx = x + dir.x * 0.25;
    const nz = z + dir.z * 0.25;
    const nd = nav.distanceTo(nx, nz);
    if (!(nd < d)) {
      // allow sideways steps around corners, but never a stall
      if (nd > d + 0.75) { ok = false; break; }
    }
    x = nx;
    z = nz;
    d = nd;
    if (d < 1.8) break;
  }
  if (ok && d < 1.8) {
    reachable++;
  } else {
    unreachable.push(`#${i}(${sp.x.toFixed(0)},${sp.z.toFixed(0)}) ${startD.toFixed(0)}m->${Number.isFinite(d) ? d.toFixed(1) : 'inf'}m`);
  }
}
check(
  'nav field routes every spawn to the player',
  reachable === walkSpawns.length,
  `${reachable}/${walkSpawns.length}${unreachable.length ? ' | ' + unreachable.slice(0, 5).join(' ') : ''}`
);

const states = {};
for (const e of game.enemies) states[e.state] = (states[e.state] || 0) + 1;
for (const e of game.enemies) {
  if (!e.alive) continue;
  const d = Math.hypot(e.root.position.x - player.position.x, e.root.position.z - player.position.z);
  console.log(
    `   alive ${String(e.state).padEnd(11)} pos=(${e.root.position.x.toFixed(1)},${e.root.position.z.toFixed(1)}) ` +
      `dist=${d.toFixed(1)} stuck=${e.stuckTime.toFixed(1)} pathIdx=${e.pathIndex}/${e.path ? e.path.length : '-'} aware=${e.awareness.toFixed(2)} hp=${e.health.toFixed(0)}`
  );
}
console.log(
  `   waveState=${game.waveState} wave=${game.wave} remaining=${game.remaining} queue=${game.spawnQueue.length} ` +
    `spawnTimer=${game.spawnTimer.toFixed(1)} reinforced=${game.reinforcements} active=${game.enemies.filter((e) => e.active).length}`
);
console.log('  enemy state histogram:', JSON.stringify(states));

// ---------------------------------------------------------------------------
// [7] menu / settings screens
// ---------------------------------------------------------------------------
console.log('\n[7] menus and settings');
{
  const { Screens } = await import('../src/ui/Screens.js');
  const { LOADOUTS } = await import('../src/weapons/Viewmodel.js');
  let err = '';
  try {
    let deployed = null;
    let changed = null;
    const screens = new Screens(settings, {
      onDeploy: (id) => {
        deployed = id;
      },
      onSettingsChanged: (info) => {
        changed = info;
      },
    });
    screens.setLoading(0.42, 'LOADING');
    screens.setTip('test tip');
    screens.show('menu');
    check('menu screen shown', screens.current === 'menu');
    check('loadout cards built', (screens.loadoutCards || []).length === LOADOUTS.length, `${screens.loadoutCards?.length}`);

    screens.setLoadout('recon');
    check('loadout selection stored', screens.loadoutId === 'recon' && settings.get('loadout') === 'recon');

    screens.fields.sens.input.value = '2.5';
    screens._onFieldChanged(screens.fields.sens);
    check('sensitivity slider applies', Math.abs(settings.get('sensitivity') - 2.5) < 1e-6 && changed?.key === 'sensitivity');

    screens.fields.quality.input.value = 'low';
    screens._onFieldChanged(screens.fields.quality);
    check('quality change flagged', settings.get('quality') === 'low' && changed?.qualityChanged === true);

    screens.fields.fps.input.checked = true;
    screens._onFieldChanged(screens.fields.fps);
    check('checkbox setting applies', settings.get('showFps') === true);

    screens.pauseStats({ waves: 3, kills: 21, accuracy: 0.62, time: 121 });
    screens.gameOver({ waves: 3, kills: 21, headshots: 7, accuracy: 0.62, time: 121, score: 8451 });
    check('game over stats filled', screens.current === 'gameover' && screens.el.stats.score.textContent !== '0');
    screens.error('boom');
    check('error screen reachable', screens.current === 'error');
    screens.show('none');
    check('hud shown when playing', screens.el.hud.classList.contains('active'));
  } catch (e) {
    err = e.stack.split('\n').slice(0, 2).join(' | ');
  }
  check('screens module runs', !err, err);
}

console.log(`\ncompleted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
