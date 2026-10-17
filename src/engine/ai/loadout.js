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

export function botLoadoutSpec(content) {
  return content.manifest.defaults?.botLoadout ?? {};
}

/**
 * @param {object} content loaded content bundle
 * @param {{chance: (p: number) => boolean, pick: (list: any[]) => any}} rng
 * @returns {string[]} a loadout, always at least one weapon that exists
 */
export function pickBotLoadout(content, rng) {
  const spec = botLoadoutSpec(content);
  const exists = (id) => typeof id === 'string' && !!content.weapons[id];

  const specialists = (spec.specialists ?? []).filter(exists);
  const chance = Math.max(0, Math.min(1, spec.specialistChance ?? 0));
  if (specialists.length > 0 && rng.chance(chance)) {
    return [rng.pick(specialists)];
  }

  const allRounder = exists(spec.allRounder)
    ? spec.allRounder
    // Fall back to the first default-loadout weapon, then to any weapon at
    // all, so a manifest without a botLoadout block still produces bots.
    : (content.manifest.defaults?.loadout ?? []).find(exists)
      ?? Object.keys(content.weapons)[0];
  return [allRounder];
}
