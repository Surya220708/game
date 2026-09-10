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
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');
configureTextures({ size: 32, anisotropy: 1 });
for (const n of MATERIAL_NAMES) getMaterial(n);
const q = QUALITY_PRESETS.low;
const scene = new THREE.Scene();
const map = new WorldMap(scene, q);
const camera = new THREE.PerspectiveCamera(80, 1.7, 0.06, 900);
camera.rotation.order = 'YXZ';
const effects = new Effects(scene, map.collision, q, new THREE.Fog(0x6b6152, 48, 420));
const input = new Input(settings);
const player = new Player({ start: map.playerStart, camera, collision: map.collision, audio, effects, settings, hooks: {}, weapon: null });
const weapon = new WeaponSystem({ camera, scene, renderer: fakeRenderer(), collision: map.collision, effects, audio, settings, input, hooks: {}, environment: null, player });
player.ctx.weapon = weapon;
const fake = {
  axis: { x: 0, y: 0 }, sprinting: false, crouching: false, usingTouch: false, _lastLook: {x:0,y:0},
  down: new Set(), pressed: new Set(),
  isDown(a){return this.down.has(a);}, wasPressed(a){return this.pressed.has(a);}, wasReleased: ()=>false,
  consumeLook: () => ({x:0,y:0}), endFrame(){},
};
weapon.equipLoadout('assault');
const dt = 1/60;
for (let i = 0; i < 200; i++) {
  fake.down.add('ads');
  player.update(dt, fake, weapon);
  weapon.adsHeld = true;
  weapon.tryFire(false, false);
  weapon.update(dt, player, []);
  if (i % 20 === 0) console.log(i, 'adsT', weapon.adsT.toFixed(3), 'reloading', weapon.reloading, 'switching', weapon.switching, 'sprinting', player.sprinting, 'adsHeld', weapon.adsHeld, 'def', weapon.def && weapon.def.id, 'fov', camera.fov.toFixed(1));
}
console.log('spread', weapon.spreadDeg, 'zoom target', weapon.ads.zoom, weapon.def.adsTime);
