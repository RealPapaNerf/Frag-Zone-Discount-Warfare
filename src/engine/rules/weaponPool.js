/**
 * Which weapons a mode will let you carry.
 *
 * Every weapon belongs to a category — the arena set that any normal match
 * draws from, and the themed shelves the joke weapons came off. A mode names
 * the categories it wants; naming none means it wants all of them.
 *
 * This lives in one place because three things need the same answer and must
 * not disagree: the lobby's loadout list, the bot loadout picker, and
 * anything validating that a mode is playable at all.
 */

/** The categories a mode is willing to draw from. `null` means every one. */
export function categoriesForMode(mode) {
  const list = mode?.weaponCategories;
  return Array.isArray(list) && list.length ? list : null;
}

export function weaponAllowed(weapon, mode) {
  if (!weapon || weapon.hidden) return false;
  const allowed = categoriesForMode(mode);
  if (!allowed) return true;
  return allowed.includes(weapon.category ?? 'arena');
}

/**
 * Every weapon a player could pick in this mode, in content order so slot 1
 * is the same weapon for a given set of ticks.
 */
export function weaponsForMode(content, mode) {
  return Object.values(content.weapons ?? {}).filter((w) => weaponAllowed(w, mode));
}

export function weaponIdsForMode(content, mode) {
  return weaponsForMode(content, mode).map((w) => w.id);
}
