/**
 * Loads every JSON content document listed in the manifest and validates the
 * shapes the engine depends on. Content is fetched at runtime rather than
 * bundled so a future map editor or weapon builder can hand the engine a
 * document it has never seen.
 */

import { DEFAULT_RULES } from '../engine/rules/RuleSet.js';
import { knownWeaponPaths, WEAPON_PATCH_OPS } from '../engine/rules/WeaponOverlay.js';

const SCHEMA = 1;

const KINDS = {
  maps: { dir: 'maps', required: ['brushes', 'spawns'], validate: validateMap },
  weapons: { dir: 'weapons', required: ['fire'], validate: validateWeapon },
  characters: { dir: 'characters', required: ['hitbox', 'move'], validate: validateCharacter },
  modes: { dir: 'modes', required: ['rules'], validate: validateMode },
  mutators: { dir: 'mutators', required: ['patches'], validate: validatePatchList },
  // No required field: a note may change only rules, only weapons, or both.
  // validateNote enforces that it changes something.
  notes: { dir: 'notes', required: [], validate: validateNote },
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
  const types = ['hitscan', 'projectile', 'beam', 'melee'];
  check(types.includes(fire.type), `weapons/${id}: fire.type must be one of ${types.join(', ')}`);
  // A beam's clock is its tickSec, not an rpm, so it is the one type that
  // does not need one.
  if (fire.type !== 'beam') {
    check(fire.rpm > 0, `weapons/${id}: fire.rpm must be positive`);
  }
  if (fire.type === 'beam') {
    check(fire.damagePerSec >= 0, `weapons/${id}: a beam needs fire.damagePerSec >= 0`);
    check(fire.range > 0, `weapons/${id}: a beam needs a positive fire.range`);
    if (fire.tickSec !== undefined) {
      check(fire.tickSec > 0, `weapons/${id}: fire.tickSec must be positive`);
    }
  } else {
    check(fire.damage >= 0, `weapons/${id}: fire.damage must be >= 0`);
  }
  if (fire.type === 'melee') {
    check(fire.range > 0, `weapons/${id}: a melee weapon needs a positive fire.range`);
    check(fire.arcDeg > 0 && fire.arcDeg <= 360,
      `weapons/${id}: fire.arcDeg must sit between 0 and 360`);
  }
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

/**
 * Patches are checked against the real rule bag at load, not when they are
 * applied. A mutator's typo shows up when you tick it; a patch note's typo
 * would otherwise show up two minutes into somebody's match.
 */
function validatePatchList(id, doc) {
  check(Array.isArray(doc.patches), `${id}: patches must be a list`);
  for (const [i, patch] of doc.patches.entries()) {
    check(typeof patch?.path === 'string', `${id}: patch ${i} needs a path`);
    check(patch.path in DEFAULT_RULES,
      `${id}: patch ${i} targets unknown rule "${patch.path}"`);
    check(['set', 'add', 'mul', 'min', 'max', 'toggle'].includes(patch.op ?? 'set'),
      `${id}: patch ${i} has unknown op "${patch.op}"`);
  }
}

function validateNote(id, doc) {
  if (doc.patches?.length) validatePatchList(id, doc);
  check((doc.patches?.length ?? 0) + (doc.weaponPatches?.length ?? 0) > 0,
    `notes/${id}: changes nothing`);
  for (const [i, patch] of (doc.weaponPatches ?? []).entries()) {
    check(typeof patch?.weapon === 'string', `notes/${id}: weapon patch ${i} needs a weapon id`);
    check(typeof patch?.path === 'string', `notes/${id}: weapon patch ${i} needs a path`);
    check(WEAPON_PATCH_OPS.includes(patch.op ?? 'set'),
      `notes/${id}: weapon patch ${i} has unknown op "${patch.op}"`);
  }
  check(doc.headline || doc.name, `notes/${id}: needs a headline`);
  const tier = doc.tier ?? 1;
  check(Number.isInteger(tier) && tier >= 1 && tier <= 5,
    `notes/${id}: tier must be 1-5, got ${tier}`);
}

function validateMode(id, doc) {
  const spec = doc.patchNotes;
  if (!spec) return;
  check(spec.intervalSec > 0, `modes/${id}: patchNotes.intervalSec must be positive`);
  if (spec.firstDelaySec !== undefined) {
    check(spec.firstDelaySec >= 0, `modes/${id}: patchNotes.firstDelaySec cannot be negative`);
  }
  if (spec.pool !== undefined) {
    check(Array.isArray(spec.pool), `modes/${id}: patchNotes.pool must be a list of note ids`);
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

  const content = {
    manifest, maps: {}, weapons: {}, characters: {}, modes: {}, mutators: {}, notes: {}, bots: {},
  };

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
  // Weapon patches are checked against the shape of the weapons that were
  // actually loaded: a path is legal if some weapon has it. That catches a
  // typo like "fire.atuo" while still letting a note give a rocket a burst
  // block it does not have yet, because another weapon does.
  const legalPaths = knownWeaponPaths(content.weapons);
  for (const note of Object.values(content.notes)) {
    for (const patch of note.weaponPatches ?? []) {
      check(content.weapons[patch.weapon],
        `notes/${note.id}: patches unknown weapon "${patch.weapon}"`);
      check(legalPaths.has(patch.path),
        `notes/${note.id}: patches "${patch.path}", which no weapon has`);
    }
  }
  for (const mode of Object.values(content.modes)) {
    for (const noteId of mode.patchNotes?.pool ?? []) {
      check(content.notes[noteId],
        `modes/${mode.id}: patch note "${noteId}" was not loaded`);
    }
  }
  // A forced loadout is only discovered when a note lands, so check them now.
  for (const doc of [...Object.values(content.notes), ...Object.values(content.mutators)]) {
    for (const patch of doc.patches ?? []) {
      if (patch.path !== 'forcedLoadout' || !Array.isArray(patch.value)) continue;
      for (const weaponId of patch.value) {
        check(content.weapons[weaponId],
          `${doc.id}: forces unknown weapon "${weaponId}"`);
      }
    }
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
