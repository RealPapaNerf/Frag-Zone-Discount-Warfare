/**
 * Make weapons by the dozen.
 *
 * Not random numbers: random numbers produce a 4000 rpm rocket launcher that
 * kills you through a wall. Each archetype fixes the shape of the thing — how
 * it kills, roughly how fast — and randomises within a band that keeps the
 * result playable. Then the stats panel tells you whether it actually is.
 */

const ADJECTIVES = ['Discount', 'Surplus', 'Municipal', 'Clearance', 'Off-Brand', 'Refurbished',
  'Generic', 'Budget', 'Economy', 'Bootleg', 'Knockoff', 'Unbranded', 'Reclaimed', 'Salvaged'];
const NOUNS = {
  smg: ['Chatterbox', 'Buzzsaw', 'Stapler', 'Sewing Machine', 'Hornet', 'Woodpecker'],
  rifle: ['Marksman', 'Lawnmower', 'Carbine', 'Workhorse', 'Rivetgun', 'Pulse Rifle'],
  shotgun: ['Doorbell', 'Leafblower', 'Scattergun', 'Boomstick', 'Persuader', 'Spreadsheet'],
  sniper: ['Longshot', 'Telescope', 'Bean Counter', 'Full Stop', 'Surveyor', 'Period'],
  launcher: ['Postbox', 'Kettle', 'Drainpipe', 'Firework', 'Wheelbarrow', 'Catapult'],
  beam: ['Hairdryer', 'Soldering Iron', 'Laser Pointer', 'Sunlamp', 'Toaster'],
};

const PALETTE = [
  ['#9aa6b2', '#36e0ff'], ['#6f7a66', '#ff7a2f'], ['#7d6b57', '#ffd34d'],
  ['#5c6370', '#b980ff'], ['#8a5f5f', '#ff5f6d'], ['#55706b', '#7dffb0'],
  ['#4f5a68', '#ffa3d1'], ['#6b6257', '#9fe9ff'],
];

export const ARCHETYPES = {
  smg: {
    label: 'SMG — fast, close, inaccurate',
    rpm: [780, 1050], damage: [9, 14], spread: [2.2, 3.6], ads: [0.8, 1.6],
    range: [90, 150], ammo: [320, 480], auto: true, type: 'hitscan',
  },
  rifle: {
    label: 'Rifle — the all-rounder',
    rpm: [420, 620], damage: [15, 22], spread: [0.5, 1.1], ads: [0.08, 0.3],
    range: [240, 340], ammo: [180, 280], auto: true, type: 'hitscan',
  },
  shotgun: {
    label: 'Shotgun — a wall of pellets',
    rpm: [60, 110], damage: [8, 13], spread: [6, 10], ads: [4, 7],
    range: [22, 40], ammo: [40, 80], auto: false, type: 'hitscan', pellets: [7, 11],
  },
  sniper: {
    label: 'Sniper — one shot, one apology',
    rpm: [40, 70], damage: [85, 115], spread: [1.6, 3], ads: [0, 0.04],
    range: [400, 600], ammo: [24, 50], auto: false, type: 'hitscan',
  },
  launcher: {
    label: 'Launcher — splash and shove',
    rpm: [55, 85], damage: [70, 100], spread: [0, 0.4], ads: [0, 0.2],
    range: [350, 450], ammo: [16, 36], auto: false, type: 'projectile',
  },
  beam: {
    label: 'Beam — low damage, no let-up',
    rpm: [1100, 1500], damage: [5, 8], spread: [0.3, 0.9], ads: [0.05, 0.2],
    range: [60, 110], ammo: [420, 700], auto: true, type: 'hitscan',
  },
};

const rand = (rng, [lo, hi]) => lo + rng() * (hi - lo);
const randInt = (rng, range) => Math.round(rand(rng, range));
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {string} kind an ARCHETYPES key
 * @param {() => number} rng
 */
export function generateWeapon(kind = 'rifle', rng = Math.random) {
  const a = ARCHETYPES[kind] ?? ARCHETYPES.rifle;
  const [color, accent] = pick(rng, PALETTE);
  const name = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS[kind] ?? NOUNS.rifle)}`;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  const pellets = a.pellets ? randInt(rng, a.pellets) : 1;
  const damage = r2(rand(rng, a.damage));
  const spread = r2(rand(rng, a.spread));

  const weapon = {
    schema: 1,
    id,
    name,
    slot: 1,
    fire: {
      type: a.type,
      rpm: randInt(rng, a.rpm),
      auto: a.auto,
      pellets,
      spreadDeg: spread,
      spreadDegMoving: r2(spread * rand(rng, [2.2, 3.4])),
      spreadDegAds: r2(rand(rng, a.ads)),
      range: randInt(rng, a.range),
      damage,
      headshotMultiplier: a.type === 'projectile' ? 1 : r2(rand(rng, [1.5, 2.4])),
      knockback: r2(rand(rng, [0.8, 2.4])),
    },
    ammo: { max: randInt(rng, a.ammo), start: 0, perShot: 1 },
    recoil: {
      pitch: r2(rand(rng, [0.3, 1.4])),
      yaw: r2(rand(rng, [0.1, 0.5])),
      recovery: r2(rand(rng, [6, 11])),
    },
    view: {
      shape: kind === 'launcher' ? 'launcher' : 'rifle',
      color,
      accent,
      offset: [0.26, -0.24, -0.5],
      muzzle: [0, 0.035, -0.62],
      kick: r2(rand(rng, [0.03, 0.12])),
    },
    tracer: { color: accent, width: r2(rand(rng, [0.015, 0.035])), life: 0.07 },
    onHit: [],
  };
  weapon.ammo.start = Math.round(weapon.ammo.max * 0.65);

  // Hitscan weapons lose damage with distance; a sniper barely, an SMG a lot.
  if (a.type === 'hitscan') {
    const start = randInt(rng, [Math.max(10, a.range[0] * 0.15), a.range[0] * 0.5]);
    weapon.fire.falloff = {
      startDistance: start,
      endDistance: randInt(rng, [start * 2, start * 4]),
      minScale: r2(rand(rng, kind === 'sniper' ? [0.85, 1] : [0.4, 0.7])),
    };
  }

  if (a.type === 'projectile') {
    weapon.projectile = {
      speed: randInt(rng, [34, 60]),
      radius: 0.22,
      gravityScale: r2(rand(rng, [0, 0.35])),
      lifetime: 6,
      spawnOffset: [0.18, -0.12, -0.6],
      color: accent,
      trail: color,
    };
    weapon.splash = {
      radius: r2(rand(rng, [4, 7])),
      damage: r2(damage * rand(rng, [0.85, 1])),
      minDamage: r2(rand(rng, [8, 20])),
      knockback: r2(rand(rng, [12, 20])),
      minKnockback: 4,
      selfDamageScale: r2(rand(rng, [0.35, 0.6])),
      selfKnockbackScale: 1,
      upBias: 0.35,
    };
  }

  return weapon;
}

/** A spread of weapons across every archetype, for filling a loadout list. */
export function generateSet(perKind = 1, rng = Math.random) {
  const out = [];
  for (const kind of Object.keys(ARCHETYPES)) {
    for (let i = 0; i < perKind; i++) out.push(generateWeapon(kind, rng));
  }
  // Ids must be unique even when the name generator repeats itself.
  const seen = new Map();
  for (const w of out) {
    const n = (seen.get(w.id) ?? 0) + 1;
    seen.set(w.id, n);
    if (n > 1) { w.id = `${w.id}_${n}`; w.name = `${w.name} ${['', 'II', 'III', 'IV'][n - 1] ?? n}`; }
  }
  return out;
}
