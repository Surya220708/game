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
const { Enemy } = await import('../src/entities/Enemy.js');
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');
configureTextures({ size: 32, anisotropy: 1 });
for (const n of MATERIAL_NAMES) getMaterial(n);
const quality = QUALITY_PRESETS.low;
const scene = new THREE.Scene();
const map = new WorldMap(scene, quality);
const camera = new THREE.PerspectiveCamera(80, 1.7, 0.06, 900);
const effects = new Effects(scene, map.collision, quality, new THREE.Fog(0x6b6152, 48, 420));
const input = new Input(settings);
const player = new Player({ start: { x: 0, z: 6, yaw: 0 }, camera, collision: map.collision, audio, effects, settings, hooks: {}, weapon: null });
const ctx = { scene, collision: map.collision, effects, audio, player, hooks: {}, get difficulty(){ return {damageMul:1,healthMul:1,accuracyMul:1}; } };
const sp = map.spawnPoints[5];
console.log('spawn', sp, '\n');
const e = new Enemy(ctx);
const t = sp.path[0];
e.spawn('rifleman', { x: sp.x, y: sp.y, z: sp.z }, { yaw: Math.atan2(t.x - sp.x, t.z - sp.z), waypoint: sp.waypoint, path: sp.path, awareness: 0 });
const origAdvance = e._doAdvance.bind(e);
e._doAdvance = function (dt, p, dist, canSee) {
  const before = { x: this.root.position.x, z: this.root.position.z };
  origAdvance(dt, p, dist, canSee);
  this._dbg = { tv: { x: this.vel.x, z: this.vel.z }, wp: this.waypoint, before, canSee, dist, stuck: this.stuckTime };
};
const dt = 1/60;
for (let f = 0; f < 60*8; f++) {
  e.update(dt, player, []);
  if (f % 30 === 0) {
    const d = this_dbg(e);
    console.log(`t=${(f/60).toFixed(1)} pos=(${e.root.position.x.toFixed(2)},${e.root.position.y.toFixed(2)},${e.root.position.z.toFixed(2)}) vel=(${e.vel.x.toFixed(2)},${e.vel.z.toFixed(2)}) wp=${JSON.stringify(e.waypoint)} canSee=${e._dbg?.canSee} dist=${e._dbg?.dist?.toFixed(1)} stuck=${e.stuckTime.toFixed(2)} hp=${e.health}`);
  }
}
function this_dbg() { return null; }
