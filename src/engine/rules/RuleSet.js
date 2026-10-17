/**
 * Game modes are not classes. A mode is a bag of base rule values, and a
 * mutator is an ordered list of patches against that bag. Stacking "low
 * gravity" and "big heads" is just applying two patch lists in sequence, which
 * is why new modes are a JSON file rather than a code change.
 */

export const DEFAULT_RULES = {
  // Match flow
  teams: false,
  friendlyFire: false,
  scoreLimit: 25,
  timeLimitSec: 600,
  respawnDelaySec: 1.6,
  warmupSec: 0,
  scorePerKill: 1,
  scorePerSuicide: -1,

  // Physics and movement multipliers
  gravityScale: 1,
  moveSpeedScale: 1,
  jumpScale: 1,
  airAccelScale: 1,
  knockbackScale: 1,

  // Combat
  damageScale: 1,
  selfDamage: true,
  startHealth: 100,
  maxHealth: 100,
  infiniteAmmo: false,
  headshots: true,
  // 0 means only headshots count. Kept as a scale rather than a flag so a
  // patch note can halve body damage instead of deleting it.
  bodyDamageScale: 1,
  explosionsHeal: false,
  lastPlaceOnlyDamage: false,

  // Verbs. Patch Notes Mode takes these away one at a time; everything here
  // is a thing a player can normally do, so "removed X" is a rule and not a
  // special case buried in the input layer.
  canJump: true,
  canCrouch: true,
  canReload: true,
  canSwapWeapon: true,

  // 0 is clear. The renderer reads it; the simulation does not care how far
  // anyone can see.
  fogDensity: 0,

  // How many weapons you can carry at once. Picking up a third while holding
  // three swaps rather than hoarding.
  maxWeapons: 3,
  // Whether dying scatters what you were carrying. Off by default so
  // deathmatch plays as it always has.
  dropOnDeath: false,

  // Cosmetic/hitbox toggles
  headScale: 1,
  bodyScale: 1,

  // null means "use the loadout the player picked"
  forcedLoadout: null,
};

const OPS = {
  set: (_current, value) => value,
  add: (current, value) => (typeof current === 'number' ? current + value : value),
  mul: (current, value) => (typeof current === 'number' ? current * value : value),
  min: (current, value) => Math.min(current, value),
  max: (current, value) => Math.max(current, value),
  toggle: (current) => !current,
};

/** Apply one mutator's patch list in place. Unknown paths are rejected loudly. */
export function applyPatches(rules, patches, source = 'mutator') {
  for (const patch of patches ?? []) {
    const { path, op = 'set', value } = patch;
    if (!(path in rules)) {
      throw new Error(`${source}: unknown rule "${path}"`);
    }
    const fn = OPS[op];
    if (!fn) throw new Error(`${source}: unknown op "${op}" on "${path}"`);
    rules[path] = fn(rules[path], value);
  }
  return rules;
}

/**
 * Resolve the rule bag for a match.
 * @param {object} mode      a mode JSON document
 * @param {object[]} mutators mutator JSON documents, applied in order
 */
export function buildRuleSet(mode, mutators = []) {
  const rules = { ...DEFAULT_RULES, ...(mode?.rules ?? {}) };
  for (const mutator of mutators) {
    applyPatches(rules, mutator.patches, `mutator "${mutator.id}"`);
  }
  return rules;
}

/** Mode files may name mutators they always imply (e.g. an instagib mode). */
export function resolveMutatorIds(mode, extraIds = []) {
  const ids = [...(mode?.mutators ?? []), ...extraIds];
  return [...new Set(ids)];
}
