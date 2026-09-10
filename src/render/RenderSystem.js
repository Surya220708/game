// ---------------------------------------------------------------------------
// Renderer + post-processing stack.
//
// Order: world -> viewmodel (second scene, depth-cleared) -> bloom -> output.
// Rendering the viewmodel into the main composition means muzzle flashes and
// the optic dot pick up bloom exactly like the rest of the frame.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { PassthroughPass } from './PassthroughPass.js';

export class RenderSystem {
  constructor(canvas, quality) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.pixelRatio <= 1.05,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x0a0d10, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.canvas = canvas;
    this.viewSize = new THREE.Vector2(1, 1);
    this.composer = null;
    this.quality = quality;
    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this._passes = {};
  }

  get domElement() {
    return this.canvas;
  }

  /** (Re)builds the post stack for a quality preset. */
  setupPost(scene, camera, viewScene, viewCamera, quality) {
    this.quality = quality;
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.scene = scene;
    this.camera = camera;
    this.viewScene = viewScene;
    this.viewCamera = viewCamera;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(this.renderer);
    composer.setSize(size.x, size.y);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const viewPass = new PassthroughPass(viewScene, viewCamera);
    composer.addPass(viewPass);
    if (quality.bloom) {
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        quality.bloomStrength,
        0.62,
        0.86
      );
      composer.addPass(bloom);
      this._passes.bloom = bloom;
    }
    this.composer = composer;
  }

  setSize(w, h, quality, settings) {
    const dpr = Math.min(window.devicePixelRatio || 1, quality.pixelRatio) * (settings?.get('renderScale') ?? 1);
    this.renderer.setPixelRatio(Math.min(dpr, 2.5));
    this.renderer.setSize(w, h, false);
    this.viewSize.set(w, h);
    if (this.composer) {
      this.composer.setPixelRatio(Math.min(dpr, 2.5));
      this.composer.setSize(w, h);
      const bloom = this._passes.bloom;
      if (bloom) bloom.setSize(w, h);
    }
  }

  setQuality(quality, settings) {
    this.quality = quality;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.composer && this._passes.bloom) {
      this._passes.bloom.strength = quality.bloom ? quality.bloomStrength : 0;
      this._passes.bloom.enabled = quality.bloom;
    }
    void settings;
  }

  render(dt) {
    this.renderer.info.reset();
    // view camera mirrors the world camera orientation
    this.viewCamera.rotation.copy(this.camera.rotation);
    if (this.composer) {
      this.composer.render(dt);
    } else {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
      this.renderer.autoClear = true;
    }
  }
}
