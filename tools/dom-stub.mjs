// ---------------------------------------------------------------------------
// Minimal DOM + canvas stub so the game's logic modules can run inside Node
// for headless smoke testing (no browser binaries required).
// ---------------------------------------------------------------------------

class FakeGradient {
  addColorStop() {}
}
class FakeCtx {
  constructor(w = 300, h = 150) {
    this.canvas = { width: w, height: h };
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData() {}
  createRadialGradient() {
    return new FakeGradient();
  }
  createLinearGradient() {
    return new FakeGradient();
  }
  createPattern() {
    return null;
  }
  measureText(t) {
    return { width: (t || '').length * 6 };
  }
  drawImage() {}
}
const NOOP_METHODS = [
  'fillRect', 'clearRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'arcTo', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'save',
  'restore', 'translate', 'rotate', 'scale', 'setTransform', 'transform', 'setLineDash',
  'fillText', 'strokeText', 'resetTransform',
];
for (const m of NOOP_METHODS) FakeCtx.prototype[m] = function () {};

class FakeCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.style = {};
    this._ctx = new FakeCtx();
    this.classList = fakeClassList();
  }
  getContext() {
    return this._ctx;
  }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  requestPointerLock() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
  }
  appendChild() {}
}

function fakeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => {
      if (on === undefined) (set.has(c) ? set.delete(c) : set.add(c));
      else if (on) set.add(c);
      else set.delete(c);
      return set.has(c);
    },
    contains: (c) => set.has(c),
  };
}

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.style = new Proxy(
      { setProperty() {}, getPropertyValue: () => '' },
      {
        get(t, p) {
          if (p in t) return t[p];
          return '';
        },
        set(t, p, v) {
          t[p] = v;
          return true;
        },
      }
    );
    this.dataset = {};
    this.classList = fakeClassList();
    this.children = [];
    this._text = '';
    this._html = '';
    this.value = '0';
    this.checked = false;
    this.type = '';
    this.offsetWidth = 100;
    this.parentNode = { insertBefore() {}, appendChild() {} };
    this.width = 300;
    this.height = 150;
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    // naive child synthesis for querySelectorAll support
    const count = (String(v).match(/<(\w+)/g) || []).length;
    this.children = [];
    for (let i = 0; i < count; i++) this.children.push(new FakeElement('div'));
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  get nextSibling() {
    return this.children[0] || null;
  }
  insertBefore(c) {
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
  }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute(k, v) {
    this[k] = v;
  }
  getAttribute(k) {
    return this[k];
  }
  querySelector() {
    return new FakeElement('div');
  }
  querySelectorAll(sel) {
    if (sel === '.tb') return [];
    return this.children;
  }
  closest() {
    return null;
  }
  getContext(type) {
    if (type === '2d') return new FakeCtx();
    return null; // no WebGL in node
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
  }
  focus() {}
}

export function installDom() {
  const g = globalThis;
  if (g.__domInstalled) return;
  g.__domInstalled = true;

  const elements = new Map();
  g.ImageData = class ImageData {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };

  g.document = {
    createElement: (tag) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag)),
    createElementNS: (ns, tag) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag)),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
      return elements.get(id);
    },
    querySelector: (sel) => {
      if (!elements.has(sel)) elements.set(sel, new FakeElement('div', sel));
      return elements.get(sel);
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    pointerLockElement: null,
    exitPointerLock: () => {},
    hidden: false,
    fullscreenElement: null,
    fullscreenEnabled: false,
  };

  g.window = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    AudioContext: undefined,
    webkitAudioContext: undefined,
    location: { href: 'http://localhost/' },
    navigator: undefined,
  };
  // Node 22 exposes some of these as getter-only globals.
  const define = (key, value) => {
    try {
      Object.defineProperty(g, key, { value, configurable: true, writable: true });
    } catch (e) {
      /* ignore */
    }
  };
  define('window', g.window);
  define('document', g.document);
  define('ImageData', g.ImageData);
  define('navigator', {
    userAgent: 'node-smoke',
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
  });
  define('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  define('matchMedia', g.window.matchMedia);
  define('requestAnimationFrame', g.window.requestAnimationFrame);
  define('cancelAnimationFrame', g.window.cancelAnimationFrame);
  define('innerWidth', 1280);
  define('innerHeight', 720);
  define('devicePixelRatio', 1);
  define('screen', { orientation: { lock: () => Promise.resolve() } });

  g.outerWidth = 1280;
  g.outerHeight = 720;
}

/** Fake renderer that satisfies the RenderSystem's surface area. */
export function fakeRenderer() {
  return {
    domElement: new FakeCanvas(),
    autoClear: true,
    render() {},
    setRenderTarget() {},
    clearDepth() {},
    setSize() {},
    setPixelRatio() {},
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v) => ({ x: 1280, y: 720 }),
    info: { reset() {}, render: {}, memory: {}, autoReset: false },
    shadowMap: { enabled: true, type: 0, autoUpdate: true },
    capabilities: { getMaxAnisotropy: () => 8 },
    outputColorSpace: '',
    toneMapping: 0,
    toneMappingExposure: 1,
    getClearColor: (c) => c,
    getClearAlpha: () => 1,
    setClearColor() {},
    setClearAlpha() {},
    clear() {},
    getContext: () => ({}),
    compile() {},
  };
}
