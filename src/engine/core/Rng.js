/**
 * Deterministic 32-bit RNG (mulberry32). Every stochastic decision in the sim
 * draws from a seeded stream so a match can be replayed, and so the host and a
 * future remote peer can agree on bot behaviour.
 */
export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). Accepts a [lo, hi] tuple for JSON-authored ranges. */
  range(lo, hi) {
    if (Array.isArray(lo)) [lo, hi] = lo;
    return lo + (hi - lo) * this.next();
  }

  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }

  pick(list) {
    return list.length ? list[this.int(list.length)] : undefined;
  }

  chance(p) {
    return this.next() < p;
  }

  /** Unit vector in a cone of `angleRad` around +Z, for spread patterns. */
  coneOffset(angleRad) {
    const theta = this.next() * Math.PI * 2;
    // sqrt keeps the distribution uniform over the cap rather than centre-heavy.
    const radius = Math.sqrt(this.next()) * Math.tan(angleRad);
    return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
  }
}
