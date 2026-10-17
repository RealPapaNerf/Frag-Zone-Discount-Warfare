/**
 * A per-match view of the weapon documents, with changes layered on top.
 *
 * Patch Notes Mode needs "rockets are full auto" to mean something, and that
 * is not a rule — it is a field inside a weapon document. Writing it straight
 * into `content.weapons` would be the obvious thing and the wrong one: content
 * is loaded once and shared by every match, the lobby and the weapon workshop,
 * so a note in one match would quietly follow you into the next.
 *
 * So the overlay is copy-on-write. Until a weapon is patched it is the loaded
 * document, by reference and with no copying at all; the first patch clones it
 * and every later read of that id sees the clone. Throwing the overlay away
 * restores the game.
 */

const OPS = {
  set: (_current, value) => value,
  add: (current, value) => (typeof current === 'number' ? current + value : value),
  mul: (current, value) => (typeof current === 'number' ? current * value : value),
  min: (current, value) => Math.min(current, value),
  max: (current, value) => Math.max(current, value),
  toggle: (current) => !current,
};

export const WEAPON_PATCH_OPS = Object.keys(OPS);

/** Deep clone of a plain JSON document. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

/**
 * Every dotted path a document contains, for validating that a patch is
 * aimed at a field some weapon actually has.
 */
export function weaponPaths(doc, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(doc ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      weaponPaths(value, path, out);
    }
  }
  return out;
}

/** The union of the paths across every loaded weapon. */
export function knownWeaponPaths(weapons) {
  const out = new Set();
  for (const doc of Object.values(weapons ?? {})) weaponPaths(doc, '', out);
  return out;
}

export class WeaponOverlay {
  /** @param {Record<string, object>} base the loaded weapon documents */
  constructor(base) {
    this.base = base ?? {};
    this.overrides = new Map();
  }

  /** The live document for an id: the override if there is one, else the original. */
  get(id) {
    return this.overrides.get(id) ?? this.base[id] ?? null;
  }

  has(id) {
    return this.get(id) !== null;
  }

  /** Every weapon id, patched or not. */
  ids() {
    return Object.keys(this.base);
  }

  /**
   * Apply weapon patches. `rev` is bumped on every patched document so a
   * consumer that caches by weapon id — the first-person view model does —
   * can notice that the same id is now a different weapon.
   *
   * @param {{weapon: string, path: string, op?: string, value?: any}[]} patches
   * @returns {string[]} the ids that changed
   */
  apply(patches, source = 'weapon patch') {
    const touched = new Set();
    for (const patch of patches ?? []) {
      const current = this.get(patch.weapon);
      if (!current) throw new Error(`${source}: unknown weapon "${patch.weapon}"`);

      const doc = this.overrides.get(patch.weapon) ?? clone(current);
      writePath(doc, patch, source);
      doc.rev = (doc.rev ?? 0) + 1;
      this.overrides.set(patch.weapon, doc);
      touched.add(patch.weapon);
    }
    return [...touched];
  }

  /** Back to the unmodified documents. */
  reset() {
    this.overrides.clear();
  }
}

/** Walk a dotted path and apply one op at the leaf, creating objects as needed. */
function writePath(doc, { path, op = 'set', value }, source) {
  const fn = OPS[op];
  if (!fn) throw new Error(`${source}: unknown op "${op}" on "${path}"`);

  const segments = String(path).split('.');
  let node = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    // A patch may reach into a block the weapon does not have yet — giving a
    // rocket a burst, say — so build the path rather than giving up on it.
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  const leaf = segments[segments.length - 1];
  node[leaf] = fn(node[leaf], value);
  return doc;
}
