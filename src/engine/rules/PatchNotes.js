import { applyPatches } from './RuleSet.js';

/**
 * Patch Notes Mode: the developers keep changing the game while you are
 * playing it.
 *
 * A note is a mutator that arrives late. That is not a metaphor — RuleSet
 * already describes a mutator as "an ordered list of patches against that
 * bag", and already stacks them in order, so a note is the same document
 * with a changelog headline on it and a timer in front of it. All this class
 * owns is *when*, and *which one next*.
 *
 * Notes are drawn without replacement from a shuffled pool, so a match never
 * ships the same change twice and the order is different every time. The
 * shuffle comes off the world's seeded RNG, which means a replayed match gets
 * the same patch notes in the same order.
 */
export class PatchNotes {
  /**
   * @param {object[]} notes note documents, each {id, headline, patches}
   * @param {{int: (n: number) => number}} rng the world's RNG
   * @param {object} [options] from the mode's `patchNotes` block
   */
  constructor(notes, rng, options = {}) {
    this.intervalSec = Math.max(5, options.intervalSec ?? 120);
    // The first note lands sooner than the rest by default: two minutes of an
    // unchanged game is a slow joke.
    this.firstDelaySec = Math.max(0, options.firstDelaySec ?? this.intervalSec);
    this.maxNotes = options.maxNotes ?? Infinity;

    this.pool = shuffled(notes, rng);
    this.applied = [];
    this.nextAt = this.firstDelaySec;
  }

  get remaining() {
    return this.pool.length;
  }

  get exhausted() {
    return this.pool.length === 0 || this.applied.length >= this.maxNotes;
  }

  /**
   * The note due at this time, or null. Call once per tick; it deliberately
   * releases at most one note per call so two notes never land on the same
   * frame and scroll past each other unread.
   */
  due(time) {
    if (this.exhausted || time < this.nextAt) return null;
    const note = this.pool[0];
    this.record(note);
    this.nextAt = time + this.intervalSec;
    return note;
  }

  /**
   * Mark a note as live. The scheduler calls this, and so does a note forced
   * from outside the schedule — the applied list is what the HUD lists and
   * what a joining client replays, so a note that skipped it would be
   * invisible to everyone but the host.
   */
  record(note) {
    if (this.applied.includes(note)) return;
    const index = this.pool.indexOf(note);
    if (index >= 0) this.pool.splice(index, 1);
    this.applied.push(note);
  }

  /** Apply a note to a live rule bag. Throws on an unknown rule path. */
  static apply(rules, note) {
    return applyPatches(rules, note.patches, `note "${note.id}"`);
  }

  snapshot() {
    return {
      applied: this.applied.map((n) => ({
        id: n.id, headline: n.headline ?? n.name, tier: n.tier ?? 1,
      })),
      nextAt: this.exhausted ? null : this.nextAt,
      remaining: this.pool.length,
    };
  }
}

/** Fisher-Yates off the seeded RNG, so a replay deals the same hand. */
function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
