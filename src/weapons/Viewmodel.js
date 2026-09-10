// ---------------------------------------------------------------------------
// Weapon definitions + procedural first-person viewmodels.
//
// Every gun is modelled from primitives in code (no external assets) and
// exposes named sub-parts so the animation layer can cycle bolts, drop
// magazines and flash muzzles.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { getMaterial } from '../core/Textures.js';

let MATS = null;

export function weaponMaterials() {
  if (MATS) return MATS;
  const gunNormal = getMaterial('metal').normalMap;
  const nm = gunNormal ? gunNormal.clone() : null;
  if (nm) {
    nm.repeat.set(4, 4);
    nm.needsUpdate = true;
  }
  MATS = {
    body: new THREE.MeshStandardMaterial({ color: 0x27292b, metalness: 0.72, roughness: 0.46, normalMap: nm, normalScale: new THREE.Vector2(0.28, 0.28), envMapIntensity: 1.1 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x121416, metalness: 0.06, roughness: 0.82, normalMap: nm, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 0.7 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x8c9196, metalness: 0.96, roughness: 0.26, envMapIntensity: 1.3 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0a0b0c, metalness: 0.35, roughness: 0.62, envMapIntensity: 0.8 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc39a48, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.4 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5f3d22, metalness: 0.04, roughness: 0.68, normalMap: nm, envMapIntensity: 0.6 }),
    tan: new THREE.MeshStandardMaterial({ color: 0x8b7c5f, metalness: 0.1, roughness: 0.85, envMapIntensity: 0.6 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x3a352c, metalness: 0.05, roughness: 0.92, envMapIntensity: 0.5 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x3f4433, metalness: 0.04, roughness: 0.95, envMapIntensity: 0.45 }),
    lens: new THREE.MeshStandardMaterial({ color: 0x0b1a12, metalness: 0.2, roughness: 0.08, envMapIntensity: 1.6 }),
    dot: new THREE.MeshBasicMaterial({ color: 0xff2a18, toneMapped: false }),
  };
  return MATS;
}

function bx(parent, w, h, d, x, y, z, mat, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

function cyl(parent, r0, r1, h, x, y, z, mat, axis = 'z', seg = 12) {
  const geo = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false);
  const m = new THREE.Mesh(geo, mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Gloved hands + forearms, roughly placed on the grip and handguard. */
function addHands(root, M, cfg) {
  const hand = cfg.hand || { grip: [0, -0.085, 0.055], guard: [0, -0.05, -0.22] };
  const right = new THREE.Group();
  bx(right, 0.055, 0.062, 0.085, 0, 0, 0, M.glove);
  bx(right, 0.048, 0.05, 0.045, 0, -0.015, -0.05, M.glove);
  const rArm = new THREE.Group();
  bx(rArm, 0.075, 0.085, 0.30, 0, 0, 0, M.sleeve);
  rArm.position.set(0, -0.03, 0.16);
  rArm.rotation.set(-0.12, -0.22, 0.1);
  right.add(rArm);
  right.position.set(...hand.grip);
  right.rotation.set(0.12, 0.06, -0.06);
  root.add(right);

  const left = new THREE.Group();
  bx(left, 0.058, 0.06, 0.09, 0, 0, 0, M.glove);
  bx(left, 0.05, 0.052, 0.05, 0, 0, -0.05, M.glove);
  const lArm = new THREE.Group();
  bx(lArm, 0.078, 0.088, 0.32, 0, 0, 0, M.sleeve);
  lArm.position.set(0.02, -0.02, 0.17);
  lArm.rotation.set(-0.2, 0.5, -0.15);
  left.add(lArm);
  left.position.set(...hand.guard);
  left.rotation.set(-0.1, 0, 0.1);
  root.add(left);
  root.userData.hands = { right, left };
}

function addSights(root, M, cfg) {
  // Rear + front iron sights (always present as a backup).
  bx(root, 0.03, 0.035, 0.012, 0, cfg.ironY, cfg.ironRear, M.dark);
  bx(root, 0.012, 0.03, 0.012, 0, cfg.ironY + 0.005, cfg.ironFront, M.dark);
  if (cfg.optic === 'reddot') {
    const tube = cyl(root, 0.026, 0.026, 0.085, 0, cfg.optY, cfg.optZ, M.dark);
    tube.rotation.x = Math.PI / 2;
    const housing = bx(root, 0.046, 0.05, 0.03, 0, cfg.optY, cfg.optZ + 0.045, M.dark);
    housing.rotation.x = 0;
    cyl(root, 0.021, 0.021, 0.006, 0, cfg.optY, cfg.optZ + 0.042, M.lens);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), M.dot);
    dot.position.set(0, cfg.optY, cfg.optZ + 0.02);
    dot.userData.isDot = true;
    root.add(dot);
    const mount = bx(root, 0.036, 0.03, 0.06, 0, cfg.optY - 0.035, cfg.optZ, M.dark);
    void mount;
  } else if (cfg.optic === 'scope') {
    cyl(root, 0.032, 0.032, 0.30, 0, cfg.optY, cfg.optZ, M.dark, 'z', 14);
    cyl(root, 0.038, 0.032, 0.05, 0, cfg.optY, cfg.optZ - 0.16, M.dark, 'z', 14);
    cyl(root, 0.036, 0.04, 0.05, 0, cfg.optY, cfg.optZ + 0.16, M.dark, 'z', 14);
    cyl(root, 0.031, 0.031, 0.004, 0, cfg.optY, cfg.optZ - 0.185, M.lens, 'z', 14);
    bx(root, 0.026, 0.028, 0.02, 0, cfg.optY + 0.045, cfg.optZ, M.dark);
    bx(root, 0.03, 0.045, 0.022, 0, cfg.optY - 0.045, cfg.optZ - 0.08, M.dark);
    bx(root, 0.03, 0.045, 0.022, 0, cfg.optY - 0.045, cfg.optZ + 0.08, M.dark);
  }
}

// ------------------------------------------------------------- models -------

export function buildM4() {
  const M = weaponMaterials();
  const root = new THREE.Group();
  const parts = {};
  bx(root, 0.052, 0.078, 0.30, 0, 0, 0.02, M.body); // receiver
  bx(root, 0.046, 0.052, 0.045, 0, -0.005, 0.19, M.body); // buffer tube collar
  cyl(root, 0.019, 0.019, 0.17, 0, 0.005, 0.28, M.dark); // buffer tube
  bx(root, 0.05, 0.075, 0.13, 0, -0.005, 0.34, M.polymer); // stock
  bx(root, 0.054, 0.02, 0.05, 0, 0.04, 0.31, M.polymer);
  bx(root, 0.05, 0.055, 0.24, 0, 0, -0.24, M.polymer); // handguard
  for (let i = 0; i < 5; i++) {
    bx(root, 0.056, 0.008, 0.012, 0, 0.028, -0.14 - i * 0.045, M.dark);
  }
  cyl(root, 0.011, 0.011, 0.30, 0, 0, -0.5, M.steel);
  cyl(root, 0.02, 0.018, 0.075, 0, 0, -0.62, M.steel); // flash hider
  bx(root, 0.03, 0.05, 0.11, 0, -0.055, 0.035, M.polymer, 0.32); // grip
  parts.mag = bx(root, 0.03, 0.17, 0.075, 0, -0.115, -0.045, M.dark, 0.06);
  bx(root, 0.032, 0.03, 0.08, 0, -0.2, -0.05, M.dark, 0.06);
  parts.bolt = bx(root, 0.05, 0.02, 0.05, 0, 0.045, 0.115, M.steel);
  bx(root, 0.056, 0.014, 0.34, 0, 0.046, -0.06, M.dark); // top rail
  bx(root, 0.02, 0.03, 0.05, 0, -0.05, -0.16, M.polymer); // foregrip nub
  addSights(root, M, { ironY: 0.058, ironRear: 0.09, ironFront: -0.36, optic: 'reddot', optY: 0.085, optZ: -0.02 });
  addHands(root, M, { hand: { grip: [0, -0.085, 0.045], guard: [0, -0.075, -0.26] } });
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, 0, -0.66);
  root.add(parts.muzzle);
  parts.eject = new THREE.Object3D();
  parts.eject.position.set(0.03, 0.02, 0.06);
  root.add(parts.eject);
  root.userData.parts = parts;
  root.userData.ads = { pos: [0, -0.085, -0.05], zoom: 1.32 };
  root.userData.hip = { pos: [0.17, -0.16, -0.12] };
  return root;
}

export function buildMP5() {
  const M = weaponMaterials();
  const root = new THREE.Group();
  const parts = {};
  bx(root, 0.05, 0.075, 0.26, 0, 0, 0.02, M.body);
  bx(root, 0.048, 0.05, 0.17, 0, 0, -0.19, M.polymer);
  cyl(root, 0.012, 0.012, 0.16, 0, 0, -0.35, M.steel);
  cyl(root, 0.019, 0.019, 0.05, 0, 0, -0.43, M.steel);
  bx(root, 0.02, 0.02, 0.02, 0, 0.03, -0.44, M.dark);
  bx(root, 0.03, 0.05, 0.1, 0, -0.055, 0.04, M.polymer, 0.3);
  parts.mag = bx(root, 0.032, 0.22, 0.07, 0.005, -0.14, -0.04, M.dark, 0.04);
  bx(root, 0.034, 0.035, 0.075, 0.005, -0.245, -0.05, M.dark, 0.04);
  cyl(root, 0.019, 0.019, 0.14, 0, 0.005, 0.26, M.dark);
  bx(root, 0.048, 0.07, 0.11, 0, -0.005, 0.31, M.polymer);
  parts.bolt = bx(root, 0.05, 0.022, 0.06, 0, 0.045, 0.1, M.steel);
  bx(root, 0.05, 0.012, 0.3, 0, 0.045, -0.05, M.dark);
  bx(root, 0.045, 0.05, 0.09, 0, -0.02, -0.3, M.polymer); // foregrip
  addSights(root, M, { ironY: 0.056, ironRear: 0.13, ironFront: -0.36, optic: null });
  // drum rear sight ring
  cyl(root, 0.026, 0.026, 0.02, 0, 0.06, 0.13, M.dark);
  addHands(root, M, { hand: { grip: [0, -0.085, 0.05], guard: [0, -0.06, -0.3] } });
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, 0, -0.46);
  root.add(parts.muzzle);
  parts.eject = new THREE.Object3D();
  parts.eject.position.set(0.03, 0.025, 0.05);
  root.add(parts.eject);
  root.userData.parts = parts;
  root.userData.ads = { pos: [0, -0.062, -0.04], zoom: 1.28 };
  root.userData.hip = { pos: [0.16, -0.15, -0.1] };
  return root;
}

export function buildM9() {
  const M = weaponMaterials();
  const root = new THREE.Group();
  const parts = {};
  bx(root, 0.032, 0.045, 0.19, 0, 0, 0, M.steel); // slide
  bx(root, 0.03, 0.035, 0.17, 0, -0.032, 0.005, M.polymer); // frame
  bx(root, 0.028, 0.085, 0.05, 0, -0.075, 0.055, M.polymer, 0.24);
  parts.mag = bx(root, 0.024, 0.075, 0.035, 0, -0.12, 0.062, M.dark, 0.2);
  cyl(root, 0.009, 0.009, 0.05, 0, -0.008, -0.11, M.steel);
  bx(root, 0.014, 0.02, 0.008, 0, 0.024, -0.08, M.dark);
  bx(root, 0.02, 0.028, 0.012, 0, 0.022, 0.075, M.dark);
  parts.bolt = bx(root, 0.034, 0.016, 0.04, 0, 0.012, 0.055, M.steel);
  cyl(root, 0.006, 0.006, 0.02, 0, -0.02, 0.09, M.dark, 'z', 8);
  addHands(root, M, { hand: { grip: [0, -0.09, 0.06], guard: [0.02, -0.075, -0.02] } });
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, -0.008, -0.14);
  root.add(parts.muzzle);
  parts.eject = new THREE.Object3D();
  parts.eject.position.set(0.022, 0.015, 0.02);
  root.add(parts.eject);
  root.userData.parts = parts;
  root.userData.ads = { pos: [0, -0.036, -0.03], zoom: 1.2 };
  root.userData.hip = { pos: [0.15, -0.16, -0.1] };
  return root;
}

export function buildM24() {
  const M = weaponMaterials();
  const root = new THREE.Group();
  const parts = {};
  bx(root, 0.05, 0.07, 0.34, 0, 0, 0.02, M.body);
  bx(root, 0.052, 0.085, 0.34, 0, -0.012, 0.34, M.wood); // stock
  bx(root, 0.05, 0.05, 0.12, 0, 0.03, 0.2, M.wood); // cheek riser
  bx(root, 0.056, 0.02, 0.05, 0, -0.05, 0.42, M.dark); // butt pad
  bx(root, 0.032, 0.055, 0.1, 0, -0.055, 0.04, M.wood, 0.3); // grip
  bx(root, 0.048, 0.05, 0.22, 0, -0.005, -0.25, M.wood); // fore end
  cyl(root, 0.012, 0.012, 0.52, 0, 0, -0.6, M.steel);
  cyl(root, 0.021, 0.018, 0.06, 0, 0, -0.86, M.steel);
  parts.bolt = new THREE.Object3D();
  cyl(root, 0.011, 0.011, 0.13, 0.038, 0.012, 0.1, M.steel);
  bx(root, 0.026, 0.026, 0.03, 0.1, 0.012, 0.1, M.steel);
  bx(root, 0.02, 0.028, 0.06, 0, 0.05, 0.06, M.dark); // bolt body
  parts.mag = bx(root, 0.028, 0.06, 0.09, 0, -0.05, -0.02, M.dark);
  addSights(root, M, { ironY: 0.05, ironRear: 0.12, ironFront: -0.5, optic: 'scope', optY: 0.085, optZ: -0.1 });
  addHands(root, M, { hand: { grip: [0, -0.085, 0.05], guard: [0, -0.05, -0.26] } });
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, 0, -0.9);
  root.add(parts.muzzle);
  parts.eject = new THREE.Object3D();
  parts.eject.position.set(0.05, 0.03, 0.08);
  root.add(parts.eject);
  root.userData.parts = parts;
  root.userData.ads = { pos: [0, -0.085, 0.05], zoom: 4.2 };
  root.userData.hip = { pos: [0.17, -0.17, -0.16] };
  return root;
}

export function buildM249() {
  const M = weaponMaterials();
  const root = new THREE.Group();
  const parts = {};
  bx(root, 0.062, 0.095, 0.36, 0, 0, 0.0, M.body);
  bx(root, 0.055, 0.06, 0.16, 0, 0.005, -0.28, M.body);
  cyl(root, 0.014, 0.014, 0.5, 0, 0, -0.6, M.steel);
  cyl(root, 0.024, 0.02, 0.09, 0, 0, -0.86, M.steel);
  bx(root, 0.05, 0.06, 0.16, 0, -0.01, 0.24, M.polymer);
  bx(root, 0.05, 0.075, 0.12, 0, -0.005, 0.36, M.polymer);
  bx(root, 0.032, 0.05, 0.1, 0, -0.075, 0.06, M.polymer, 0.3);
  parts.mag = bx(root, 0.075, 0.11, 0.19, 0, -0.105, -0.10, M.dark);
  bx(root, 0.08, 0.03, 0.2, 0, -0.165, -0.1, M.dark);
  parts.bolt = bx(root, 0.055, 0.022, 0.06, 0, 0.06, 0.14, M.steel);
  bx(root, 0.03, 0.12, 0.03, 0, 0.1, 0.02, M.steel); // carry handle
  bx(root, 0.02, 0.02, 0.16, 0, 0.16, 0.02, M.steel, 0.2);
  // bipod
  bx(root, 0.014, 0.19, 0.014, -0.03, -0.17, -0.55, M.steel, 0, 0, 0.4);
  bx(root, 0.014, 0.19, 0.014, 0.03, -0.17, -0.55, M.steel, 0, 0, -0.4);
  addSights(root, M, { ironY: 0.07, ironRear: 0.16, ironFront: -0.55, optic: 'reddot', optY: 0.11, optZ: 0.02 });
  addHands(root, M, { hand: { grip: [0, -0.1, 0.07], guard: [0, -0.07, -0.3] } });
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, 0, -0.9);
  root.add(parts.muzzle);
  parts.eject = new THREE.Object3D();
  parts.eject.position.set(0.035, 0.03, 0.05);
  root.add(parts.eject);
  root.userData.parts = parts;
  root.userData.ads = { pos: [0, -0.11, -0.02], zoom: 1.3 };
  root.userData.hip = { pos: [0.19, -0.17, -0.13] };
  return root;
}

export const WEAPONS = {
  m4: {
    id: 'm4',
    name: 'M4A1 CARBINE',
    short: 'M4A1',
    cls: 'ASSAULT RIFLE',
    build: buildM4,
    auto: true,
    damage: 27,
    headMul: 2.35,
    limbMul: 0.86,
    rpm: 780,
    mag: 30,
    reserve: 240,
    reserveMax: 300,
    reloadTime: 2.05,
    reloadEmptyTime: 2.7,
    adsTime: 0.2,
    adsSpread: 0.28,
    baseSpread: 1.1,
    moveSpread: 2.6,
    recoil: { vert: 0.95, horiz: 0.42, kick: 1.0 },
    mobility: 1.0,
    sound: 'rifle',
    falloff: 90,
    loadout: 'ASSAULT',
  },
  mp5: {
    id: 'mp5',
    name: 'MP5A3 SUBMACHINE GUN',
    short: 'MP5A3',
    cls: 'SMG',
    build: buildMP5,
    auto: true,
    damage: 21,
    headMul: 1.9,
    limbMul: 0.85,
    rpm: 880,
    mag: 30,
    reserve: 240,
    reserveMax: 300,
    reloadTime: 1.9,
    reloadEmptyTime: 2.5,
    adsTime: 0.17,
    adsSpread: 0.42,
    baseSpread: 1.3,
    moveSpread: 1.8,
    recoil: { vert: 0.62, horiz: 0.36, kick: 0.75 },
    mobility: 1.12,
    sound: 'smg',
    falloff: 55,
    loadout: 'BREACHER',
  },
  m9: {
    id: 'm9',
    name: 'M9 SIDEARM',
    short: 'M9',
    cls: 'PISTOL',
    build: buildM9,
    auto: false,
    damage: 26,
    headMul: 2.1,
    limbMul: 0.9,
    rpm: 420,
    mag: 15,
    reserve: 105,
    reserveMax: 150,
    reloadTime: 1.7,
    reloadEmptyTime: 2.15,
    adsTime: 0.14,
    adsSpread: 0.5,
    baseSpread: 1.5,
    moveSpread: 1.6,
    recoil: { vert: 0.9, horiz: 0.5, kick: 0.7 },
    mobility: 1.25,
    sound: 'pistol',
    falloff: 40,
    loadout: 'SIDEARM',
  },
  m24: {
    id: 'm24',
    name: 'M24 MARKSMAN RIFLE',
    short: 'M24',
    cls: 'MARKSMAN',
    build: buildM24,
    auto: false,
    damage: 95,
    headMul: 2.2,
    limbMul: 0.8,
    rpm: 52,
    mag: 5,
    reserve: 40,
    reserveMax: 60,
    reloadTime: 3.0,
    reloadEmptyTime: 3.4,
    adsTime: 0.34,
    adsSpread: 0.02,
    baseSpread: 2.4,
    moveSpread: 4.5,
    recoil: { vert: 3.0, horiz: 0.5, kick: 2.4 },
    mobility: 0.9,
    sound: 'sniper',
    falloff: 200,
    scope: true,
    loadout: 'RECON',
  },
  m249: {
    id: 'm249',
    name: 'M249 LIGHT MACHINE GUN',
    short: 'M249',
    cls: 'LMG',
    build: buildM249,
    auto: true,
    damage: 32,
    headMul: 1.8,
    limbMul: 0.85,
    rpm: 700,
    mag: 100,
    reserve: 300,
    reserveMax: 400,
    reloadTime: 3.6,
    reloadEmptyTime: 4.4,
    adsTime: 0.3,
    adsSpread: 0.7,
    baseSpread: 2.4,
    moveSpread: 3.4,
    recoil: { vert: 1.15, horiz: 0.7, kick: 1.3 },
    mobility: 0.82,
    sound: 'rifle',
    falloff: 85,
    loadout: 'SUPPORT',
  },
};

export const LOADOUTS = [
  { id: 'assault', name: 'ASSAULT', primary: 'm4', secondary: 'm9', desc: 'Balanced rifle + sidearm. Recommended.' },
  { id: 'breacher', name: 'BREACHER', primary: 'mp5', secondary: 'm9', desc: 'Fast handling SMG. Best in tight spaces.' },
  { id: 'recon', name: 'RECON', primary: 'm24', secondary: 'm9', desc: 'Scoped marksman rifle. One shot, one kill.' },
  { id: 'support', name: 'SUPPORT', primary: 'm249', secondary: 'm9', desc: '100-round belt. Suppress everything.' },
];
