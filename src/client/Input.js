/**
 * Keyboard and mouse into a command object. This is the only place that knows
 * about the DOM side of playing; the simulation just receives commands, which
 * is why a bot can produce the same thing.
 */

const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  scoreboard: ['Tab'],
  reload: ['KeyR'],
};

export class Input {
  constructor(canvas, { sensitivity = 0.0022 } = {}) {
    this.canvas = canvas;
    this.sensitivity = sensitivity;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.lookDelta = { x: 0, y: 0 };
    this.fire = false;
    this.aim = false;
    this.weaponSlot = null;
    this.switchDelta = 0;
    // Reload is an edge, not a held state: one press asks once, however long
    // the key stays down.
    this.reloadRequested = false;
    this.locked = false;
    this.onPause = () => {};
    this.enabled = true;

    this.#bind();
  }

  #bind() {
    const onKey = (event, down) => {
      if (!this.enabled) return;
      // Tab would move focus out of the canvas and Space would scroll.
      if (event.code === 'Tab' || event.code === 'Space') event.preventDefault();
      if (down) this.keys.add(event.code);
      else this.keys.delete(event.code);

      if (!down) return;
      if (event.code === 'Digit1') this.weaponSlot = 0;
      if (event.code === 'Digit2') this.weaponSlot = 1;
      if (event.code === 'Digit3') this.weaponSlot = 2;
      if (event.code === 'KeyQ') this.switchDelta = 1;
      if (this.held('reload')) this.reloadRequested = true;
    };

    this._onKeyDown = (e) => onKey(e, true);
    this._onKeyUp = (e) => onKey(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const limit = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
      this.lookDelta.x += e.movementX * this.sensitivity;
      this.lookDelta.y += e.movementY * this.sensitivity;
    };
    window.addEventListener('mousemove', this._onMouseMove);

    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;   // right button: down the sights
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    };
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);

    // Without this the right button opens the browser menu mid-fight, which
    // also drops pointer lock.
    this._onContextMenu = (e) => { if (this.locked) e.preventDefault(); };
    window.addEventListener('contextmenu', this._onContextMenu);

    this._onWheel = (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.switchDelta += e.deltaY > 0 ? 1 : -1;
    };
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.keys.clear();
        this.fire = false;
        this.aim = false;
        this.onPause();
      }
    };
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestLock() {
    this.canvas.requestPointerLock?.();
  }

  releaseLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  held(action) {
    return DEFAULT_BINDS[action].some((code) => this.keys.has(code));
  }

  get scoreboardHeld() {
    return this.held('scoreboard');
  }

  /** Drain this frame's input into a command for the simulation. */
  takeCommand() {
    const forward = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    const strafe = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);

    const command = {
      forward,
      strafe,
      jump: this.held('jump'),
      crouch: this.held('crouch'),
      fire: this.fire && this.locked,
      aim: this.aim && this.locked,
      yaw: this.yaw,
      pitch: this.pitch,
      weaponSlot: this.weaponSlot,
      switchDelta: this.switchDelta,
      reload: this.reloadRequested && this.locked,
    };
    this.weaponSlot = null;
    this.switchDelta = 0;
    this.reloadRequested = false;
    return command;
  }

  /** Mouse movement since the last call, for weapon sway. */
  takeLookDelta() {
    const delta = { ...this.lookDelta };
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    return delta;
  }

  setLook(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
