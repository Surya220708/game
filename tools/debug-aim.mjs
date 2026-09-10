// Diagnostic: dump per-shot ballistics so we can see why rounds miss.
import { installDom, fakeRenderer } from './dom-stub.mjs';
installDom();
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
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');

configureTextures({ size: 32, anisotropy: 1 });
for (const n of MATERIAL_NAMES) getMaterial(n);
const quality = QUALITY_PRESETS.low;
const scene = new THREE.Scene();
const map = new WorldMap(scene, quality);
const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.06, 900);
camera.rotation.order = 'YXZ';
const effects = new Effects(scene, map.collision, quality, new THREE.Fog(0x6b6152, 48, 420));
const input = new Input(settings);
const player = new Player({ start: map.playerStart, camera, collision: map.collision, audio, effects, settings, hooks: {}, weapon: null });
const weapon = new WeaponSystem({
  camera, scene, renderer: fakeRenderer(), collision: map.collision, effects, audio, settings, input,
  hooks: {}, environment: null, player,
});
player.ctx.weapon = weapon;
const hud = new HUD(player, weapon);
const game = new Game({
  scene, camera, renderer: fakeRenderer(), collision: map.collision, effects, audio, input, settings,
  hud, weaponSystem: weapon, map, player, quality, hooks: {},
});
game.initHooks();

const fakeInput = {
  axis: { x: 0, y: 0 }, sprinting: false, crouching: false, usingTouch: false, _lastLook: { x: 0, y: 0 },
  down: new Set(['ads']), pressed: new Set(),
  isDown(a) { return this.down.has(a); },
  wasPressed(a) { return this.pressed.has(a); },
  wasReleased: () => false,
  consumeLook: () => ({ x: 0, y: 0 }),
  endFrame() { this.pressed.clear(); },
};

game.start('assault');
const dt = 1 / 60;
const log = [];
const origShoot = weapon._shoot.bind(weapon);
weapon._shoot = function (p, targets) {
  const before = weapon.shotsHit;
  origShoot(p, targets);
  camera.getWorldDirection(new THREE.Vector3());
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const origin = camera.getWorldPosition(new THREE.Vector3());
  let bestE = null;
  let bestD = Infinity;
  let bestAng = null;
  for (const t of targets) {
    const c = t.root.position;
    const to = new THREE.Vector3(c.x, c.y + 1.25, c.z).sub(origin);
    const d = to.length();
    to.normalize();
    const ang = (Math.acos(Math.max(-1, Math.min(1, to.dot(dir)))) * 180) / Math.PI;
    if (d < bestD) {
      bestD = d;
      bestE = t;
      bestAng = ang;
    }
  }
  const wh = map.collision.raycast(origin.clone().addScaledVector(dir, 0.35), dir, 240);
  log.push({
    hit: weapon.shotsHit > before,
    enemyDist: +bestD.toFixed(2),
    aimErrDeg: bestAng === null ? null : +bestAng.toFixed(2),
    worldDist: wh ? +wh.dist.toFixed(2) : null,
    surface: wh ? wh.surface : null,
    enemyState: bestE ? bestE.state : null,
    aware: bestE && bestE.awareness !== undefined ? +bestE.awareness.toFixed(2) : null,
    isBarrel: !!(bestE && bestE.isBarrel),
  });
};

for (let f = 0; f < 60 * 40; f++) {
  const t = f * dt;
  let best = null;
  let bestD = Infinity;
  const eyeR = player.eyePosition;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const d = e.root.position.distanceTo(player.position);
    if (d > 70) continue;
    if (!map.collision.lineOfSight(eyeR, e.aimPoint, 80)) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best) {
    const dx = best.root.position.x - player.position.x;
    const dz = best.root.position.z - player.position.z;
    const wantYaw = Math.atan2(dx, dz) + Math.PI;
    player.yaw += Math.atan2(Math.sin(wantYaw - player.yaw), Math.cos(wantYaw - player.yaw)) * 0.5;
    const dy = best.root.position.y + 1.25 - (player.position.y + player.eyeHeight);
    player.pitch += (Math.atan2(dy, bestD) - player.pitch) * 0.5;
  }
  fakeInput.axis.x = 0;
  fakeInput.axis.y = bestD > 32 ? 1 : 0;
  fakeInput.down.add('ads');
  if (best) fakeInput.down.add('fire');
  else fakeInput.down.delete('fire');
  player.update(dt, fakeInput, weapon);
  weapon.adsHeld = fakeInput.down.has('ads');
  weapon.tryFire(fakeInput.down.has('fire'), false);
  weapon.update(dt, player, game.targets);
  game.update(dt);
  effects.update(dt);
  fakeInput.endFrame();
}

console.log('shots:', log.length, 'hits:', log.filter((l) => l.hit).length);
console.log('player pos', player.position.toArray().map((v) => v.toFixed(1)).join(','));
console.log('adsT', weapon.adsT.toFixed(2), 'spreadDeg', weapon.spreadDeg.toFixed(3), 'reloading', weapon.reloading);
console.log('\nfirst 14 shots:');
for (const l of log.slice(0, 14)) console.log(JSON.stringify(l));
const near = log.filter((l) => l.enemyDist < 30);
console.log('\nshots with enemy < 30m:', near.length, 'hits:', near.filter((l) => l.hit).length);
console.log('sample:', JSON.stringify(near.slice(0, 8)));
const angles = log.filter((l) => l.aimErrDeg !== null).map((l) => l.aimErrDeg).sort((a, b) => a - b);
console.log('aim error median:', angles[angles.length >> 1], 'p90:', angles[Math.floor(angles.length * 0.9)]);
console.log('enemy states:', JSON.stringify(game.enemies.reduce((a, e) => ((a[e.state] = (a[e.state] || 0) + 1), a), {})));
