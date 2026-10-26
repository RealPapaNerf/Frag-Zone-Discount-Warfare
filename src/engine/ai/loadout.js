/**
 * What a bot spawns holding.
 *
 * Bots used to be handed the *player's* loadout, which worked only because
 * there were two weapons and one of them was the all-rounder. It stops working
 * the moment the roster has a shotgun and a sniper in it: a bot scores its
 * weapons by little more than "does it explode", so it would happily pick a
 * shotgun and plink at you from across the map.
 *
 * The fix is the loadout rather than the scoring. Nearly every bot carries the
 * all-rounder — the thing that is never the wrong choice at any range — and
 * roughly one in ten carries something lopsided instead. A specialist carries
 * *only* its specialty, so there is no choice for the scorer to get wrong, and
 * the weapon's own `bot` block tells it what range to play at.
 */

import { weaponAllowed, weaponIdsForMode } from '../rules/weaponPool.js';

export function botLoadoutSpec(content) {
  return content.manifest.defaults?.botLoadout ?? {};
}

/**
 * @param {object} content loaded content bundle
 * @param {{chance: (p: number) => boolean, pick: (list: any[]) => any}} rng
 * @param {object} [mode] the mode document, so bots draw from the same
 *   shelves the lobby offers — a deathmatch bot should not turn up with a
 *   Ped Egg because the mode does not allow one.
 * @returns {string[]} a loadout, always at least one weapon that exists
 */
export function pickBotLoadout(content, rng, mode = null) {
  const spec = botLoadoutSpec(content);
  const exists = (id) => typeof id === 'string'
    && !!content.weapons[id]
    && (!mode || weaponAllowed(content.weapons[id], mode));

  const specialists = (spec.specialists ?? []).filter(exists);
  const chance = Math.max(0, Math.min(1, spec.specialistChance ?? 0));
  if (specialists.length > 0 && rng.chance(chance)) {
    return [rng.pick(specialists)];
  }

  // A themed mode names its own all-rounder: the manifest's is an arena
  // rifle, which an As Seen On TV match has no shelf for.
  const allRounder = [mode?.botAllRounder, spec.allRounder].find(exists)
    // Then the first default-loadout weapon, then the first weapon the mode
    // allows at all, so a manifest without a botLoadout block still produces
    // bots and none of them turns up holding something the mode forbids.
    ?? (content.manifest.defaults?.loadout ?? []).find(exists)
    ?? (mode ? weaponIdsForMode(content, mode)[0] : null)
    ?? Object.keys(content.weapons)[0];
  return [allRounder];
}
