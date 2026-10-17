/**
 * The map being edited, and every way to change it.
 *
 * The editor never mutates the document in place from the UI: every change
 * goes through a method here, which snapshots the previous state onto an undo
 * stack and then tells listeners. That is the whole reason the viewport can
 * stay dumb — it rebuilds from `doc` whenever this says something changed.
 *
 * The document is exactly the JSON the game loads. There is no editor-side
 * format that gets exported later, because a format you only convert at the
 * end is a format you find out is wrong at the end.
 */

const DEFAULT_MATERIALS = {
  floor: { color: '#6f7887', grid: true },
  wall: { color: '#59616e' },
  deck: { color: '#929ba9' },
  stair: { color: '#8b94a2' },
  tower: { color: '#767f8d' },
  trim: { color: '#ffb347' },
  crate: { color: '#8a7a66' },
  brick: { color: '#8d6a5b' },
  roof: { color: '#4a4f58' },
  hedge: { color: '#4f6b43' },
};

export function blankMap(id = 'untitled') {
  return {
    format: 'fragzone-map/1',
    schema: 1,
    id,
    name: 'Untitled arena',
    author: '',
    gravity: -22,
    killZ: -25,
    bounds: { min: [-40, -25, -40], max: [40, 30, 40] },
    environment: {
      sky: '#20303f',
      fog: { color: '#20303f', near: 70, far: 200 },
      ambient: { sky: '#bcd4f5', ground: '#6b6050', intensity: 2.1 },
      sun: { direction: [-0.45, -1, -0.3], color: '#fff4e2', intensity: 2.4 },
    },
    materials: { ...DEFAULT_MATERIALS },
    brushes: [{ pos: [0, -0.5, 0], size: [64, 1, 64], material: 'floor' }],
    jumpPads: [],
    spawns: [{ pos: [0, 0.1, 8], yaw: 0 }],
    pickups: [],
    waypoints: { autoLink: { maxDistance: 11, maxStepUp: 1.9, requireLineOfSight: true, eyeHeight: 0.9 }, nodes: [], links: [] },
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export class MapDoc {
  constructor(doc = blankMap()) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.selection = null; // {kind:'brush'|'spawn'|'pad', index:number}
    this.dirty = false;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #emit(what = 'doc') {
    for (const fn of this.listeners) fn(what, this);
  }

  /**
   * Run `fn`, with whatever it changes recorded as one undoable step. Nested
   * calls collapse into the outer one, so a prefab that adds nine brushes is
   * one Ctrl+Z rather than nine.
   */
  edit(label, fn) {
    if (this.inEdit) return fn();
    this.inEdit = true;
    this.undoStack.push({ label, doc: clone(this.doc), selection: this.selection });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    try {
      return fn();
    } finally {
      this.inEdit = false;
      this.dirty = true;
      this.#emit();
    }
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.redoStack.push({ label: step.label, doc: clone(this.doc), selection: this.selection });
    this.doc = step.doc;
    this.selection = this.#clampSelection(step.selection);
    this.#emit();
    return true;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.undoStack.push({ label: step.label, doc: clone(this.doc), selection: this.selection });
    this.doc = step.doc;
    this.selection = this.#clampSelection(step.selection);
    this.#emit();
    return true;
  }

  #clampSelection(sel) {
    if (!sel) return null;
    const list = this.listFor(sel.kind);
    return sel.index < list.length ? sel : null;
  }

  listFor(kind) {
    if (kind === 'brush') return this.doc.brushes;
    if (kind === 'spawn') return this.doc.spawns;
    if (kind === 'pad') return (this.doc.jumpPads ??= []);
    return [];
  }

  select(kind, index) {
    this.selection = kind == null ? null : { kind, index };
    this.#emit('selection');
  }

  get selected() {
    if (!this.selection) return null;
    return this.listFor(this.selection.kind)[this.selection.index] ?? null;
  }

  // --- brushes --------------------------------------------------------------

  addBrush(pos, size, material = 'wall') {
    return this.edit('add brush', () => {
      this.doc.brushes.push({ pos: [...pos], size: [...size], material });
      this.selection = { kind: 'brush', index: this.doc.brushes.length - 1 };
      return this.doc.brushes.length - 1;
    });
  }

  addBrushes(brushes, label = 'add prefab') {
    return this.edit(label, () => {
      for (const b of brushes) this.doc.brushes.push(clone(b));
      this.selection = { kind: 'brush', index: this.doc.brushes.length - 1 };
    });
  }

  updateSelected(patch) {
    const item = this.selected;
    if (!item) return;
    this.edit('edit', () => Object.assign(item, clone(patch)));
  }

  deleteSelected() {
    if (!this.selection) return;
    const { kind, index } = this.selection;
    const list = this.listFor(kind);
    if (index >= list.length) return;
    // The floor is the one thing a map cannot do without.
    if (kind === 'spawn' && list.length === 1) return;
    this.edit('delete', () => {
      list.splice(index, 1);
      this.selection = null;
    });
  }

  duplicateSelected(offset = [2, 0, 0]) {
    const item = this.selected;
    if (!item || this.selection.kind !== 'brush') return;
    this.edit('duplicate', () => {
      const copy = clone(item);
      copy.pos = [item.pos[0] + offset[0], item.pos[1] + offset[1], item.pos[2] + offset[2]];
      this.doc.brushes.push(copy);
      this.selection = { kind: 'brush', index: this.doc.brushes.length - 1 };
    });
  }

  // --- spawns and pads ------------------------------------------------------

  addSpawn(pos, yaw = 0) {
    return this.edit('add spawn', () => {
      this.doc.spawns.push({ pos: [...pos], yaw });
      this.selection = { kind: 'spawn', index: this.doc.spawns.length - 1 };
    });
  }

  addJumpPad(pos, launch = [0, 15, 0]) {
    return this.edit('add jump pad', () => {
      (this.doc.jumpPads ??= []).push({
        pos: [...pos], size: [3, 0.2, 3], launch: [...launch], color: '#53e0ff',
      });
      this.selection = { kind: 'pad', index: this.doc.jumpPads.length - 1 };
    });
  }

  setMeta(patch) {
    this.edit('map settings', () => Object.assign(this.doc, clone(patch)));
  }

  setWaypoints(nodes, links) {
    this.edit('waypoints', () => {
      this.doc.waypoints ??= {};
      this.doc.waypoints.autoLink ??= { maxDistance: 11, maxStepUp: 1.9, requireLineOfSight: true, eyeHeight: 0.9 };
      this.doc.waypoints.nodes = nodes;
      this.doc.waypoints.links = links;
    });
  }

  toJSON() {
    return JSON.stringify(this.doc, null, 2) + '\n';
  }
}
