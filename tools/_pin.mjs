import { installDom } from './dom-stub.mjs';
installDom();
const THREE = await import('three');
const { configureTextures, getMaterial, MATERIAL_NAMES } = await import('../src/core/Textures.js');
const { WorldMap } = await import('../src/world/Map.js');
const { QUALITY_PRESETS } = await import('../src/core/Settings.js');
configureTextures({ size: 32, anisotropy: 1 });
for (const n of MATERIAL_NAMES) getMaterial(n);
const scene = new THREE.Scene();
const map = new WorldMap(scene, QUALITY_PRESETS.low);
const cw = map.collision;
for (const [x, z] of [[26.2, 7.2], [-14.6, -4.3], [30.1, 2.4], [-17.5, -10.7]]) {
  console.log(`\n=== pin candidate (${x}, ${z}) ===`);
  const inside = [];
  for (const b of cw.boxes) {
    const d = 0.6;
    if (x > b.minX - d && x < b.maxX + d && z > b.minZ - d && z < b.maxZ + d && b.y0 < 2.2 && b.y1 > 0.2) {
      inside.push(`[${b.surface}] x:${b.minX.toFixed(1)}..${b.maxX.toFixed(1)} z:${b.minZ.toFixed(1)}..${b.maxZ.toFixed(1)} y:${b.y0.toFixed(2)}..${b.y1.toFixed(2)} thin=${b.thin}`);
    }
  }
  console.log(inside.length ? inside.join('\n') : '  no nearby collision boxes');
  const dirs = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const free = [0.8, 1.6, 2.4].findIndex((r) => !cw.overlaps(x + Math.sin(a) * r, z + Math.cos(a) * r, 0.42, 0.6, 2.0));
    dirs.push(`${(a * 180 / Math.PI).toFixed(0)}°:${free === -1 ? 'BLOCKED' : 'free@' + [0.8, 1.6, 2.4][free]}`);
  }
  console.log('  probes: ' + dirs.join(' '));
}
