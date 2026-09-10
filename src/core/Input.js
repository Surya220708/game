// ---------------------------------------------------------------------------
// Unified input: keyboard + mouse (pointer lock, with a pointer-steering
// fallback for embedded contexts) and multi-touch (dynamic stick + look zone
// + action buttons). Everything funnels into the same action vocabulary so
// gameplay code never cares which device is in use.
// ---------------------------------------------------------------------------

import { clamp, damp } from './Utils.js';

const KEY_ACTIONS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowLeft: 'lookLeft',
  ArrowRight: 'lookRight',
  ArrowUp: 'lookUp',
  ArrowDown: 'lookDown',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouchHold',
  ControlRight: 'crouchHold',
  KeyC: 'crouchToggle',
  Space: 'jump',
  KeyR: 'reload',
  KeyG: 'grenade',
  KeyF: 'melee',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  KeyQ: 'swap',
  Escape: 'pause',
  KeyP: 'pause',
  Tab: 'scoreboard',
};

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.canvas = null;

    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.actionsDown = new Set();

    this.lookX = 0; // accumulated pixels since last consume
    this.lookY = 0;
    this.lookKeyX = 0; // keyboard/analog look, held
    this.lookKeyY = 0;

    this.shiftSprint = false; // double-tap-forward sprint latch
    this.crouchToggle = false;
    this.usingTouch = false;
    this.touchActive = false;

    this.moveStick = { x: 0, y: 0, active: false, magnitude: 0, pointerId: null };
    this.lookTouch = { pointerId: null, lastX: 0, lastY: 0 };
    this.smoothStick = { x: 0, y: 0 };

    this.pointerLocked = false;
    this.pointerLockUnavailable = false;
    this.steerMode = false; // fallback: steer with pointer offset from centre
    this.steer = { x: 0, y: 0 };
    this.steerTarget = { x: 0, y: 0 };
    this.mousePos = { x: 0, y: 0, inside: false };
    this.enabled = false;
    this._lastForwardTap = -1;
    this._lookSens = 1;

    this._bind();
  }

  attach(canvas) {
    this.canvas = canvas;
    this._bindCanvas();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.keys.clear();
      this.actionsDown.clear();
      this.moveStick.active = false;
      this.moveStick.pointerId = null;
      this.lookTouch.pointerId = null;
      this.steerTarget.x = 0;
      this.steerTarget.y = 0;
    }
  }

  // ------------------------------------------------------------- keyboard ---

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) {
        // still block scrolling keys while playing
        if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
        return;
      }
      const act = KEY_ACTIONS[e.code];
      if (act && this.enabled && ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.enabled) return;
      this.usingTouch = false;
      this.keys.add(e.code);
      if (act) {
        if (act === 'crouchToggle') {
          this.crouchToggle = !this.crouchToggle;
          this.pressedThisFrame.add('crouchToggle');
        } else {
          this._press(act);
        }
      }
      // double-tap W -> sprint latch
      if (e.code === 'KeyW') {
        const now = performance.now();
        if (now - this._lastForwardTap < 280) this.shiftSprint = true;
        this._lastForwardTap = now;
      }
      if (e.code === 'Escape' || e.code === 'KeyP') {
        this.pressedThisFrame.add('pause');
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const act = KEY_ACTIONS[e.code];
      if (act) this._release(act);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.actionsDown.clear();
      this.shiftSprint = false;
      this._releaseAll();
    });
  }

  _press(action) {
    if (this.actionsDown.has(action)) return;
    this.actionsDown.add(action);
    this.pressedThisFrame.add(action);
  }

  _release(action) {
    if (action === 'forward') this.shiftSprint = false;
    if (!this.actionsDown.has(action)) return;
    this.actionsDown.delete(action);
    this.releasedThisFrame.add(action);
  }

  _releaseAll() {
    this.actionsDown.forEach((a) => this.releasedThisFrame.add(a));
    this.actionsDown.clear();
  }

  // --------------------------------------------------------- mouse / look ---

  _bindCanvas() {
    const c = this.canvas;
    if (!c) return;

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.usingTouch = false;
      if (e.button === 0) this._press('fire');
      if (e.button === 2) this._press('ads');
      if (e.button === 1) this._press('melee');
      this.requestPointerLock();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._release('fire');
      if (e.button === 2) this._release('ads');
      if (e.button === 1) this._release('melee');
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === c;
      if (!this.pointerLocked) {
        this._release('fire');
        this._release('ads');
      }
    });
    document.addEventListener('pointerlockerror', () => {
      // Embedded frames often deny pointer lock — fall back to pointer steering.
      this.pointerLockUnavailable = true;
      this.steerMode = true;
      this.pointerLocked = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.mousePos.x = e.clientX;
      this.mousePos.y = e.clientY;
      this.mousePos.inside = true;
      if (this.pointerLocked) {
        this.lookX += e.movementX || 0;
        this.lookY += e.movementY || 0;
      } else {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.steerTarget.x = (e.clientX / w) * 2 - 1;
        this.steerTarget.y = (e.clientY / h) * 2 - 1;
      }
    });

    document.addEventListener('mouseleave', () => {
      this.mousePos.inside = false;
    });

    window.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.pressedThisFrame.add(e.deltaY > 0 ? 'slot2' : 'slot1');
    }, { passive: true });

    // Touch-drag steering for hybrid devices when not locked.
    c.addEventListener('touchstart', () => {
      this.usingTouch = true;
    }, { passive: true });
  }

  requestPointerLock() {
    if (this.pointerLocked || this.pointerLockUnavailable || !this.canvas) return;
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => {
      this.pointerLockUnavailable = true;
      this.steerMode = true;
    });
    // Some browsers simply never fire the change event: verify shortly after.
    setTimeout(() => {
      if (!this.pointerLocked && !this.touchActive && this.enabled) {
        this.steerMode = true;
      }
    }, 700);
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.steerMode = false;
    this.steerTarget.x = 0;
    this.steerTarget.y = 0;
  }

  // ------------------------------------------------------------------ touch --

  bindTouch(container) {
    if (!container) return;
    this.touchRoot = container;
    const stickZone = container.querySelector('#stick-zone');
    const lookZone = container.querySelector('#look-zone');
    const stickBase = container.querySelector('#stick-base');
    const stickKnob = container.querySelector('#stick-knob');
    const hint = container.querySelector('#touch-hint');
    this.stickBase = stickBase;
    this.stickKnob = stickKnob;
    this.hintEl = hint;

    const STICK_RADIUS = 62;

    const placeStick = (x, y) => {
      const r = stickBase.getBoundingClientRect();
      stickBase.style.left = `${x}px`;
      stickBase.style.top = `${y}px`;
      stickBase.classList.add('on');
      return r;
    };

    if (stickZone) {
      stickZone.addEventListener('pointerdown', (e) => {
        if (!this.enabled || this.moveStick.pointerId !== null) return;
        e.preventDefault();
        this.usingTouch = true;
        this.moveStick.pointerId = e.pointerId;
        this.moveStick.active = true;
        this.moveStick.originX = e.clientX;
        this.moveStick.originY = e.clientY;
        stickZone.setPointerCapture(e.pointerId);
        placeStick(e.clientX, e.clientY);
        this._hintFade();
      });
      stickZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.moveStick.pointerId) return;
        e.preventDefault();
        const dx = e.clientX - this.moveStick.originX;
        const dy = e.clientY - this.moveStick.originY;
        const len = Math.hypot(dx, dy);
        const clamped = Math.min(len, STICK_RADIUS);
        const nx = len > 0.001 ? (dx / len) * (clamped / STICK_RADIUS) : 0;
        const ny = len > 0.001 ? (dy / len) * (clamped / STICK_RADIUS) : 0;
        this.moveStick.x = nx;
        this.moveStick.y = ny;
        this.moveStick.magnitude = clamped / STICK_RADIUS;
        if (stickKnob) stickKnob.style.transform = `translate(${nx * STICK_RADIUS}px, ${ny * STICK_RADIUS}px)`;
      });
      const endStick = (e) => {
        if (e.pointerId !== this.moveStick.pointerId) return;
        this.moveStick.pointerId = null;
        this.moveStick.active = false;
        this.moveStick.x = this.moveStick.y = 0;
        this.moveStick.magnitude = 0;
        stickBase.classList.remove('on');
        if (stickKnob) stickKnob.style.transform = 'translate(0,0)';
      };
      stickZone.addEventListener('pointerup', endStick);
      stickZone.addEventListener('pointercancel', endStick);
      stickZone.addEventListener('pointerleave', endStick);
    }

    if (lookZone) {
      lookZone.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.usingTouch = true;
        if (this.lookTouch.pointerId === null) {
          this.lookTouch.pointerId = e.pointerId;
          this.lookTouch.lastX = e.clientX;
          this.lookTouch.lastY = e.clientY;
          lookZone.setPointerCapture(e.pointerId);
        }
        this._hintFade();
      });
      lookZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.lookTouch.pointerId) return;
        e.preventDefault();
        const dx = e.clientX - this.lookTouch.lastX;
        const dy = e.clientY - this.lookTouch.lastY;
        this.lookTouch.lastX = e.clientX;
        this.lookTouch.lastY = e.clientY;
        // small movement threshold removes jitter from a resting thumb
        this.lookX += dx;
        this.lookY += dy;
      });
      const endLook = (e) => {
        if (e.pointerId !== this.lookTouch.pointerId) return;
        this.lookTouch.pointerId = null;
      };
      lookZone.addEventListener('pointerup', endLook);
      lookZone.addEventListener('pointercancel', endLook);
      lookZone.addEventListener('pointerleave', endLook);
    }

    // action buttons
    container.querySelectorAll('.tb').forEach((btn) => {
      const act = btn.dataset.act;
      const down = (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        e.stopPropagation();
        this.usingTouch = true;
        btn.setPointerCapture?.(e.pointerId);
        btn.classList.add('press');
        if (act === 'crouch') {
          this.crouchToggle = !this.crouchToggle;
          btn.classList.toggle('active', this.crouchToggle);
          this.pressedThisFrame.add('crouchToggle');
        } else if (act === 'ads') {
          const on = !this.actionsDown.has('ads');
          if (on) this._press('ads');
          else this._release('ads');
          btn.classList.toggle('active', on);
        } else {
          this._press(act);
        }
        this._hintFade();
      };
      const up = (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.remove('press');
        if (act === 'fire' || act === 'jump' || act === 'grenade' || act === 'reload' || act === 'swap') {
          this._release(act);
        }
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', (e) => {
        if (e.buttons === 0) btn.classList.remove('press');
      });
    });
  }

  _hintFade() {
    if (this.hintEl && !this.hintEl.classList.contains('gone')) {
      this.hintEl.classList.add('gone');
    }
  }

  setTouchActive(on) {
    this.touchActive = on;
    if (on) {
      this.usingTouch = true;
      this.steerMode = false;
    } else {
      this.moveStick.active = false;
      this.moveStick.pointerId = null;
      this.lookTouch.pointerId = null;
    }
  }

  // ------------------------------------------------------------ accessors ---

  /** Movement axis in [-1,1]: x = strafe (right positive), y = forward. */
  get axis() {
    let x = 0;
    let y = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW')) y += 1;
      if (this.keys.has('KeyS')) y -= 1;
      if (this.keys.has('KeyD')) x += 1;
      if (this.keys.has('KeyA')) x -= 1;
    }
    if (this.moveStick.active) {
      x = clamp(x + this.moveStick.x, -1, 1);
      y = clamp(y - this.moveStick.y, -1, 1);
    }
    return { x, y };
  }

  get sprinting() {
    if (!this.enabled) return false;
    const stickSprint = this.moveStick.active && this.moveStick.magnitude > 0.94;
    return this.actionsDown.has('sprint') || this.shiftSprint || stickSprint;
  }

  get crouching() {
    return this.actionsDown.has('crouchHold') || this.crouchToggle;
  }

  isDown(action) {
    return this.actionsDown.has(action);
  }

  wasPressed(action) {
    return this.pressedThisFrame.has(action);
  }

  wasReleased(action) {
    return this.releasedThisFrame.has(action);
  }

  /**
   * Returns pixel-space look movement for this frame, including keyboard
   * turning and the pointer-steering fallback.
   */
  consumeLook(dt) {
    let dx = this.lookX;
    let dy = this.lookY;
    this.lookX = 0;
    this.lookY = 0;

    // keyboard turning
    let kx = 0;
    let ky = 0;
    if (this.enabled) {
      if (this.keys.has('ArrowLeft')) kx -= 1;
      if (this.keys.has('ArrowRight')) kx += 1;
      if (this.keys.has('ArrowUp')) ky -= 1;
      if (this.keys.has('ArrowDown')) ky += 1;
    }
    if (kx || ky) {
      const speed = 340 * dt * (this.actionsDown.has('ads') ? 0.55 : 1);
      dx += kx * speed;
      dy -= ky * speed * 0.8;
    }

    // pointer steering fallback (dead zone in the middle third)
    if (this.steerMode && !this.usingTouch) {
      this.steer.x = damp(this.steer.x, this.steerTarget.x, 14, dt);
      this.steer.y = damp(this.steer.y, this.steerTarget.y, 14, dt);
      const dead = 0.16;
      const curve = (v) => {
        const s = Math.sign(v);
        const a = Math.abs(v);
        if (a < dead) return 0;
        const t = (a - dead) / (1 - dead);
        return s * t * t;
      };
      dx += curve(this.steer.x) * 1100 * dt;
      dy += curve(this.steer.y) * 900 * dt;
    }

    return { x: dx, y: dy };
  }

  /** Called at the very end of the game loop. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }
}
