/**
 * Match flow: score, the clock, and when it ends. Reads its limits from the
 * resolved rule set, so a mode JSON or a mutator can change any of it.
 */
export class Match {
  constructor(world) {
    this.world = world;
    this.state = 'active'; // 'warmup' | 'active' | 'over'
    this.elapsed = 0;
    this.winnerId = null;
    this.killFeed = [];
  }

  get rules() {
    return this.world.rules;
  }

  get timeRemaining() {
    const limit = this.rules.timeLimitSec;
    if (!limit || limit <= 0) return Infinity;
    return Math.max(0, limit - this.elapsed);
  }

  recordKill({ attacker, victim, weapon, cause, headshot }) {
    const rules = this.rules;
    const victimActor = this.world.actorById(victim);
    const attackerActor = attacker != null ? this.world.actorById(attacker) : null;

    if (victimActor) victimActor.deaths += 1;

    if (attackerActor && attackerActor.id !== victim) {
      attackerActor.kills += 1;
      attackerActor.score += rules.scorePerKill;
    } else if (victimActor) {
      victimActor.score += rules.scorePerSuicide;
    }

    const entry = {
      t: this.world.time,
      attacker: attackerActor?.id ?? null,
      attackerName: attackerActor?.name ?? null,
      victim,
      victimName: victimActor?.name ?? null,
      weapon,
      cause,
      headshot: !!headshot,
    };
    this.killFeed.push(entry);
    if (this.killFeed.length > 32) this.killFeed.shift();
    return entry;
  }

  step(dt) {
    if (this.state !== 'active') return;
    this.elapsed += dt;

    const rules = this.rules;
    if (rules.scoreLimit > 0) {
      for (const actor of this.world.actors) {
        if (actor.score >= rules.scoreLimit) return this.#finish(actor.id, 'scoreLimit');
      }
    }
    if (this.timeRemaining <= 0) {
      const leader = this.standings()[0];
      return this.#finish(leader?.id ?? null, 'timeLimit');
    }
  }

  #finish(winnerId, reason) {
    this.state = 'over';
    this.winnerId = winnerId;
    this.world.events.emit('matchEnd', { winner: winnerId, reason, standings: this.standings() });
  }

  /** Scoreboard order: score, then fewest deaths, then name for stability. */
  standings() {
    return this.world.actors
      .map((a) => ({
        id: a.id, name: a.name, score: a.score, kills: a.kills,
        deaths: a.deaths, isBot: a.isBot, team: a.team, alive: a.alive,
      }))
      .sort((a, b) => b.score - a.score || a.deaths - b.deaths || a.name.localeCompare(b.name));
  }

  snapshot() {
    return {
      state: this.state,
      elapsed: this.elapsed,
      timeRemaining: this.timeRemaining,
      scoreLimit: this.rules.scoreLimit,
      winnerId: this.winnerId,
      standings: this.standings(),
    };
  }
}
