import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Renders the first-person view model on top of the world pass.
 *
 * The viewmodel lives in its own scene with its own camera so it can never
 * clip into world geometry. It is composited into the composer's read buffer
 * (not the screen) so the bloom pass still sees the muzzle flash and optic
 * dot, and `needsSwap = false` keeps the world pass's colour buffer intact —
 * only the depth buffer is cleared before drawing.
 */
export class PassthroughPass extends Pass {
  constructor(viewScene, viewCamera) {
    super();
    this.viewScene = viewScene;
    this.viewCamera = viewCamera;
    this.needsSwap = false;
    this.clear = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.viewScene || !this.viewCamera) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    // World depth is irrelevant to a mesh 30 cm from the eye.
    renderer.clearDepth();
    renderer.render(this.viewScene, this.viewCamera);
    renderer.autoClear = previousAutoClear;
  }

  setSize() {}

  dispose() {}
}
