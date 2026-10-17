/**
 * Loads every JSON content document listed in the manifest and validates the
 * shapes the engine depends on. Content is fetched at runtime rather than
 * bundled so a future map editor or weapon builder can hand the engine a
 * document it has never seen.
 */

const SCHEMA = 1;

const KINDS = {
  maps: { dir: 'maps', required: ['brushes', 'spawns'], validate: validateMap },
  weapons: { dir: 'weapons', required: ['fire'], validate: validateWeapon },
  characters: { dir: 'characters', required: ['hitbox', 'move'], validate: validateCharacter },
  modes: { dir: 'modes', required: ['rules'] },
  mutators: { dir: 'mutators', required: ['patches'] },
  bots: { dir: 'bots', required: ['reactionTimeSec', 'aimErrorDeg'] },
};

export class ContentError extends Error {}

function check(condition, message) {
  if (!condition) throw new ContentError(message);
}

function validateDoc(kind, id, doc) {
  check(doc && typeof doc === 'object', `${kind}/${id}: not an object`);
  check(doc.schema === SCHEMA, `${kind}/${id}: schema ${doc.schema} (expected ${SCHEMA})`);
  check(doc.id === id, `${kind}/${id}: id field is "${doc.id}"`);
  for (const field of KINDS[kind].required) {
    check(doc[field] !== undefined, `${kind}/${id}: missing "${field}"`);
  }
  KINDS[kind].validate?.(id, doc);
  return doc;
}

function validateMap(id, doc) {
  check(Array.isArray(doc.brushes) && doc.brushes.length > 0, `maps/${id}: needs at least one brush`);
  for (const [i, b] of doc.brushes.entries()) {
    check(b.pos?.length === 3 && b.size?.length === 3, `maps/${id}: brush ${i} needs pos[3] and size[3]`);
    check(b.size.every((s) => s > 0), `maps/${id}: brush ${i} has a non-positive size`);
  }
  check(Array.isArray(doc.spawns) && doc.spawns.length > 0, `maps/${id}: needs at least one spawn`);
  for (const pad of doc.jumpPads ?? []) {
    check(pad.pos?.length === 3 && pad.size?.length === 3 && pad.launch?.length === 3,
      `maps/${id}: jump pad needs pos[3], size[3] and launch[3]`);
  }
  const ids = new Set();
  for (const node of doc.waypoints?.nodes ?? []) {
    check(node.pos?.length === 3, `maps/${id}: waypoint "${node.id}" needs pos[3]`);
    check(!ids.has(node.id), `maps/${id}: duplicate waypoint id "${node.id}"`);
    ids.add(node.id);
  }
  for (const link of doc.waypoints?.links ?? []) {
    check(ids.has(link.from) && ids.has(link.to),
      `maps/${id}: link ${link.from} -> ${link.to} references a missing waypoint`);
  }
}

function validateWeapon(id, doc) {
  const fire = doc.fire;
  check(['hitscan', 'projectile'].includes(fire.type), `weapons/${id}: fire.type must be hitscan or projectile`);
  check(fire.rpm > 0, `weapons/${id}: fire.rpm must be positive`);
  check(fire.damage >= 0, `weapons/${id}: fire.damage must be >= 0`);
  if (fire.type === 'projectile') {
    check(doc.projectile?.speed > 0, `weapons/${id}: projectile.speed must be positive`);
    const bounce = doc.projectile.bounce;
    if (bounce) {
      check(bounce.restitution >= 0 && bounce.restitution <= 1,
        `weapons/${id}: projectile.bounce.restitution must sit between 0 and 1`);
      check(bounce.maxBounces >= 1,
        `weapons/${id}: projectile.bounce.maxBounces must be at least 1 to be worth having`);
    }
    if (doc.projectile.fuseSec !== undefined) {
      check(doc.projectile.fuseSec > 0, `weapons/${id}: projectile.fuseSec must be positive`);
    }
  }
  if (doc.splash) {
    check(doc.splash.radius > 0, `weapons/${id}: splash.radius must be positive`);
    check(doc.splash.damage >= doc.splash.minDamage,
      `weapons/${id}: splash.damage must be >= splash.minDamage`);
  }
}

function validateCharacter(id, doc) {
  const h = doc.hitbox;
  check(h.radius > 0 && h.height > 0, `characters/${id}: hitbox needs positive radius and height`);
  check(h.eyeHeight > 0 && h.eyeHeight <= h.height, `characters/${id}: eyeHeight must sit inside the hitbox`);
  check(doc.move.maxSpeed > 0, `characters/${id}: move.maxSpeed must be positive`);
}

/**
 * @param {(path: string) => Promise<object>} readJson resolves a path relative
 *   to the data root; the browser build passes a fetch wrapper, tests pass fs.
 * @param {(done: number, total: number, path: string) => void} [onProgress]
 *   called as each document arrives, so a slow or stalled fetch is visible.
 */
export async function loadContent(readJson, onProgress) {
  const manifest = await readJson('manifest.json');
  check(manifest.schema === SCHEMA, `manifest: schema ${manifest.schema} (expected ${SCHEMA})`);

  const content = { manifest, maps: {}, weapons: {}, characters: {}, modes: {}, mutators: {}, bots: {} };

  const total = Object.keys(KINDS)
    .reduce((sum, kind) => sum + (manifest.content[kind]?.length ?? 0), 0);
  let done = 0;
  const track = async (path) => {
    const doc = await readJson(path);
    done += 1;
    onProgress?.(done, total, path);
    return doc;
  };

  await Promise.all(Object.entries(KINDS).map(async ([kind, spec]) => {
    const ids = manifest.content[kind] ?? [];
    const docs = await Promise.all(ids.map((id) => track(`${spec.dir}/${id}.json`)));
    ids.forEach((id, i) => { content[kind][id] = validateDoc(kind, id, docs[i]); });
  }));

  validateDefaults(content);
  return content;
}

function validateDefaults(content) {
  const d = content.manifest.defaults ?? {};
  check(content.maps[d.map], `manifest: default map "${d.map}" was not loaded`);
  check(content.modes[d.mode], `manifest: default mode "${d.mode}" was not loaded`);
  check(content.characters[d.character], `manifest: default character "${d.character}" was not loaded`);
  check(content.bots[d.botProfile], `manifest: default bot profile "${d.botProfile}" was not loaded`);
  for (const weaponId of d.loadout ?? []) {
    check(content.weapons[weaponId], `manifest: default loadout weapon "${weaponId}" was not loaded`);
  }
}

/** Browser loader: resolves against Vite's base URL so Pages subpaths work. */
export function browserReader(baseUrl) {
  return async (path) => {
    const response = await fetch(`${baseUrl}data/${path}`, { cache: 'no-cache' });
    if (!response.ok) throw new ContentError(`failed to load data/${path} (${response.status})`);
    return response.json();
  };
}
