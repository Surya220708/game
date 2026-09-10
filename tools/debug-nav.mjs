// Diagnostic: can an enemy walk from every spawn point into the compound?
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
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');
const { Enemy } = await import('../src/entities/Enemy.js');

configureTextures({ size: 32, anisotropy: 1 });
for (const n of MATERIAL_NAMES) getMaterial(n);
const quality = QUALITY_PRESETS.low;
const scene = new THREE.Scene();
const map = new WorldMap(scene, quality);
const camera = new THREE.PerspectiveCamera(80, 1.7, 0.06, 900);
const effects = new Effects(scene, map.collision, quality, new THREE.Fog(0x6b6152, 48, 420));
const input = new Input(settings);
const player = new Player({ start: { x: 0, z: 6, yaw: 0 }, camera, collision: map.collision, audio, effects, settings, hooks: {}, weapon: null });
const weapon = new WeaponSystem({ camera, scene, renderer: fakeRenderer(), collision: map.collision, effects, audio, settings, input, hooks: {}, environment: null, player });
player.ctx.weapon = weapon;
let entityCtx = {
  scene, collision: map.collision, effects, audio, player,
  hooks: {},
  get difficulty() { return { damageMul: 1, healthMul: 1, accuracyMul: 1 }; },
};

// one enemy per spawn point, all pushed at once
const enemies = [];
map.spawnPoints.forEach((sp, i) => {
  const e = new Enemy(entityCtx);
  const t = (sp.path && sp.path.length ? sp.path[0] : sp.waypoint) || { x: 0, z: 0 };
  e.spawn('rifleman', { x: sp.x, y: sp.y ?? 0.05, z: sp.z }, {
    yaw: Math.atan2(t.x - sp.x, t.z - sp.z),
    waypoint: sp.waypoint,
    path: sp.path,
    tower: sp.tower,
    stationary: sp.stationary,
    awareness: 0,
  });
  enemies.push({ e, sp, i, reachedAt: null, start: { ...sp } });
});

const dt = 1 / 60;
const TARGET = { x: 0, z: 14 };
for (let f = 0; f < 60 * 45; f++) {
  for (const rec of enemies) {
    if (!rec.e.alive) continue;
    rec.e.update(dt, player, enemies.map((r) => r.e));
    const rp = rec.e.root.position;
    const d = Math.hypot(rp.x - TARGET.x, rp.z - TARGET.z);
    const insideWire = Math.abs(rp.x) < 44 && Math.abs(rp.z) < 44;
    const engaged = rec.e.state === 'engage' || rec.e.state === 'reposition';
    if (rec.reachedAt === null && (insideWire || (rec.sp.tower && engaged))) rec.reachedAt = f / 60;
  }
  if (f % 300 === 0) {
    const dists = enemies.filter((r) => r.e.alive).map((r) => Math.hypot(r.e.root.position.x - TARGET.x, r.e.root.position.z - TARGET.z));
    const slow = enemies.filter((r) => r.e.alive && r.e.stuckTime > 3).length;
    console.log(`  t=${(f / 60).toFixed(0)}s alive=${dists.length} min=${Math.min(...dists).toFixed(1)} avg=${(dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(1)} stuck>3s=${slow}`);
  }
}
console.log('spawn point ingress (time to reach within 18m of the compound centre):');
let stuck = 0;
for (const rec of enemies) {
  const p = rec.e.root.position;
  const d = Math.hypot(p.x - TARGET.x, p.z - TARGET.z);
  const tag = rec.sp.tower ? 'TOWER' : 'GROUND';
  const ok = rec.reachedAt !== null;
  if (!ok) stuck++;
  console.log(
    `  #${String(rec.i).padStart(2)} ${tag.padEnd(6)} start=(${rec.start.x.toFixed(0)},${rec.start.z.toFixed(0)}) ` +
      `end=(${p.x.toFixed(1)},${p.z.toFixed(1)}) dist=${d.toFixed(1)} ` +
      `${ok ? 'REACHED in ' + rec.reachedAt.toFixed(1) + 's' : '*** STUCK ***'} state=${rec.e.state} pathIdx=${rec.e.pathIndex}`
  );
}
console.log(`\n${enemies.length - stuck}/${enemies.length} reached the objective; ${stuck} stuck`);
