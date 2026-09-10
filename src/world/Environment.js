// ---------------------------------------------------------------------------
// Sky, atmosphere and lighting rig. The sky is baked into an equirectangular
// canvas texture which doubles as the scene background, the image-based
// lighting source (via PMREM) and the fog reference colour.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { skyTexture, horizonColor, getMaterial } from '../core/Textures.js';
import { clamp, damp, lerp } from '../core/Utils.js';

const SUN_AZIMUTH = 0.62;
const SUN_ELEVATION = 0.30;
const FOG_NEAR = 48;
const FOG_FAR = 420;

export class Environment {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = quality;

    // ---- sky -------------------------------------------------------------
    const sky = skyTexture();
    scene.background = sky;
    scene.backgroundIntensity = 1.0;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    this.envRT = pmrem.fromEquirectangular(sky);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.85;
    pmrem.dispose();
    this.envTexture = this.envRT.texture;

    // ---- lights ----------------------------------------------------------
    const sunDir = new THREE.Vector3(
      Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
      Math.sin(SUN_ELEVATION),
      Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH)
    ).normalize();
    this.sunDirection = sunDir;

    this.sun = new THREE.DirectionalLight(0xffd9a8, 3.1);
    this.sun.position.copy(sunDir).multiplyScalar(90);
    this.sun.castShadow = true;
    const shadowSize = quality.shadowMap;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.setShadowExtent(quality.shadowMap >= 2048 ? 62 : 44);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.045;
    if (quality.softShadows) {
      this.sun.shadow.radius = 3;
      this.sun.shadow.blurSamples = 12;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.HemisphereLight(0xbcd2ea, 0x6b5c45, 1.15);
    scene.add(this.fill);

    this.bounce = new THREE.DirectionalLight(0xffc98a, 0.42);
    this.bounce.position.set(-sunDir.x * 40, 22, -sunDir.z * 40);
    scene.add(this.bounce);

    // ---- atmosphere -------------------------------------------------------
    this.fogColor = horizonColor();
    scene.fog = new THREE.Fog(this.fogColor, FOG_NEAR, FOG_FAR);
    this.fog = scene.fog;

    this._target = new THREE.Vector3();
  }

  setShadowExtent(extent) {
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.updateProjectionMatrix();
    this.shadowExtent = extent;
  }

  /** Keeps the shadow frustum glued to the player without shimmering. */
  update(dt, focusPos) {
    const snap = (v, texelWorld) => Math.round(v / texelWorld) * texelWorld;
    const texelWorld = (this.shadowExtent * 2) / this.quality.shadowMap * 2;
    this._target.set(
      snap(focusPos.x, texelWorld),
      snap(focusPos.y, texelWorld),
      snap(focusPos.z, texelWorld)
    );
    this.sun.target.position.copy(this._target);
    this.sun.position.copy(this._target).addScaledVector(this.sunDirection, 90);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  setQuality(quality) {
    this.quality = quality;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.setShadowExtent(quality.shadowMap >= 2048 ? 62 : 44);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.castShadow = quality.shadows;
    this.scene.fog = quality.fog ? this.fog : null;
    this.scene.environmentIntensity = quality.label === 'LOW' ? 0.6 : 0.85;
  }

  dispose() {
    if (this.envRT) this.envRT.dispose();
    getMaterial;
    void clamp; void damp; void lerp;
  }
}
