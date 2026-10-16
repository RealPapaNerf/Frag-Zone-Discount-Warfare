// Authoring script for public/data/maps/blockout_arena.json.
// The JSON is the artifact the engine loads; this file is just how it was
// produced, kept around because the seeded map generator will grow out of it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Arena } from '../src/engine/sim/Arena.js';

const round = (v) => Math.round(v * 1000) / 1000;
const brushes = [];
const box = (pos, size, material) => brushes.push({ pos, size, material });
/** A box described by its footprint and the height of its walking surface. */
const platform = (cx, cz, sx, sz, top, material) =>
  box([cx, top / 2, cz], [sx, top, sz], material);

const HALF = 32;      // arena is 64 x 64
const WALL_H = 17;

// --- shell -----------------------------------------------------------------
box([0, -0.5, 0], [HALF * 2, 1, HALF * 2], 'floor');
box([0, WALL_H / 2, -HALF - 1], [HALF * 2 + 4, WALL_H, 2], 'wall');
box([0, WALL_H / 2, HALF + 1], [HALF * 2 + 4, WALL_H, 2], 'wall');
box([-HALF - 1, WALL_H / 2, 0], [2, WALL_H, HALF * 2 + 4], 'wall');
box([HALF + 1, WALL_H / 2, 0], [2, WALL_H, HALF * 2 + 4], 'wall');

// --- central raised platform (top at y=5), 16 x 16 -------------------------
const CENTER_TOP = 5;
platform(0, 0, 16, 16, CENTER_TOP, 'platform');
// A shin-high lip so the top reads as a place rather than a slab. It is split
// around the 5-wide stair opening, or it would wall the stairs off entirely.
const STAIR_W = 5;
const lipLen = (16 - STAIR_W) / 2;
const lipX = STAIR_W / 2 + lipLen / 2;
for (const sz of [-1, 1]) {
  for (const sx of [-1, 1]) {
    box([lipX * sx, CENTER_TOP + 0.4, 7.6 * sz], [lipLen, 0.8, 0.8], 'trim');
  }
}

// --- stairs up the north and south faces -----------------------------------
// 9 steps of 0.5 (under the 0.52 step height), 0.6 deep, 5 wide.
for (let k = 1; k <= 9; k++) {
  const top = k * 0.5;
  const offset = 8 + (10 - k) * 0.6 - 0.3;
  platform(0, -offset, 5, 0.6, top, 'stair');
  platform(0, offset, 5, 0.6, top, 'stair');
}

// --- corner towers (top at y=8) and the ring walkway joining them ----------
const TOWER = 22;
const RING_TOP = 8;
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    platform(TOWER * sx, TOWER * sz, 9, 9, RING_TOP, 'tower');
  }
}
// Walkway decks: 0.8 thick, surface flush with the tower tops.
const DECK = 0.8;
const deckSpan = TOWER * 2 - 9; // between the inner faces of two towers
for (const s of [-1, 1]) {
  box([TOWER * s, RING_TOP - DECK / 2, 0], [4, DECK, deckSpan], 'deck');
  box([0, RING_TOP - DECK / 2, TOWER * s], [deckSpan, DECK, 4], 'deck');
}
// Guard rails on the outer edge of each deck, so bots do not walk off instantly.
for (const s of [-1, 1]) {
  box([TOWER * s + 2.1 * s, RING_TOP + 0.5, 0], [0.3, 1, deckSpan], 'trim');
  box([0, RING_TOP + 0.5, TOWER * s + 2.1 * s], [deckSpan, 1, 0.3], 'trim');
}

// --- ground-floor cover ----------------------------------------------------
const cover = [
  [-14, -6, 3, 2.6, 3], [14, 6, 3, 2.6, 3],
  [-6, 14, 4, 1.4, 3], [6, -14, 4, 1.4, 3],
  [-26, -6, 2.4, 3.4, 6], [26, 6, 2.4, 3.4, 6],
  [-6, -26, 6, 3.4, 2.4], [6, 26, 6, 3.4, 2.4],
  [-16, 16, 3.5, 1.2, 3.5], [16, -16, 3.5, 1.2, 3.5],
];
for (const [cx, cz, sx, h, sz] of cover) platform(cx, cz, sx, sz, h, 'crate');

// --- jump pads -------------------------------------------------------------
// Pads are set inboard of the ring and launched outward: a straight-up pad
// directly beneath the walkway just fires you into its underside. Arcs are
// solved against g = 22 so each one lands on the surface it advertises.
//   y(t) = vy*t - g/2*t^2  ->  land when y(t) = target height, descending.
function arcTo(fromX, fromZ, toX, toZ, targetY, vy) {
  const g = 22;
  const disc = vy * vy - 2 * g * targetY;
  const t = (vy + Math.sqrt(disc)) / g; // descending root
  return [round((toX - fromX) / t), vy, round((toZ - fromZ) / t)];
}

// Ring pads sit on the diagonals and throw you onto the corner towers. They
// deliberately avoid the cardinal axes: the stairs run up the +/-Z faces and
// the centre pads sit on the +/-X axis, so an on-axis pad would hijack anyone
// running at the stairs.
const PAD_DIAG = 14;
const PAD_CTR = 12;
const jumpPads = [];
for (const sx of [-1, 1]) {
  for (const sz of [-1, 1]) {
    jumpPads.push({
      pos: [PAD_DIAG * sx, 0.08, PAD_DIAG * sz],
      launch: arcTo(PAD_DIAG * sx, PAD_DIAG * sz, TOWER * sx, TOWER * sz, RING_TOP, 22),
    });
  }
}
jumpPads.push(
  { pos: [PAD_CTR, 0.08, 0], launch: arcTo(PAD_CTR, 0, 5, 0, CENTER_TOP, 16) },
  { pos: [-PAD_CTR, 0.08, 0], launch: arcTo(-PAD_CTR, 0, -5, 0, CENTER_TOP, 16) },
);
for (const pad of jumpPads) pad.size = [3, 0.16, 3];

// --- spawns ----------------------------------------------------------------
const spawns = [];
const spawnRing = [
  [-27, -27], [27, -27], [-27, 27], [27, 27],
  [-28, 0], [28, 0], [0, -28], [0, 28],
  [-17, -9], [17, 9],
];
for (const [x, z] of spawnRing) {
  spawns.push({ pos: [x, 0.1, z], yaw: Math.round(Math.atan2(-x, -z) * 1000) / 1000 });
}

// --- navigation graph ------------------------------------------------------
// Nodes are sampled from the geometry rather than hand-placed: drop a column
// at each grid point, keep every flat surface a player could actually stand
// on, and let NavGraph derive the walk edges. The seeded map generator in a
// later milestone needs exactly this, so it lives here from the start.
const provisional = {
  id: 'blockout_arena',
  bounds: { min: [-HALF, -25, -HALF], max: [HALF, 40, HALF] },
  brushes,
  jumpPads,
  spawns: [],
};
const probe = new Arena(provisional);

const PLAYER = { radius: 0.42, height: 1.78 };
const DOWN = { x: 0, y: -1, z: 0 };

/** Is the player box at this surface clear, and properly supported underfoot? */
function standable(x, y, z) {
  const r = PLAYER.radius;
  const box = {
    min: { x: x - r, y: y + 0.02, z: z - r },
    max: { x: x + r, y: y + PLAYER.height, z: z + r },
  };
  if (probe.overlapsWorld(box)) return false;
  // Require support under the centre and all four corners, so nodes do not
  // perch on guard rails or hang off ledges.
  const offsets = [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r]];
  return offsets.every(([dx, dz]) => {
    const hit = probe.raycast({ x: x + dx, y: y + 0.25, z: z + dz }, DOWN, 0.6);
    return hit !== null;
  });
}

/** Every standable surface in the vertical column at (x, z), top down. */
function sampleColumn(x, z) {
  const found = [];
  let y = 38;
  for (let guard = 0; guard < 12; guard++) {
    const hit = probe.raycast({ x, y, z }, DOWN, y + 30);
    if (!hit) break;
    const surface = Math.round(hit.point.y * 1000) / 1000;
    if (standable(x, surface, z)) found.push(surface);
    y = surface - 0.3;
    if (y < -2) break;
  }
  return found;
}

const nodes = [];
const nodeKeys = new Set();
function node(x, y, z, tags = []) {
  const key = `${x.toFixed(1)}|${y.toFixed(1)}|${z.toFixed(1)}`;
  if (nodeKeys.has(key)) return null;
  nodeKeys.add(key);
  const entry = { id: `n${nodes.length}`, pos: [round(x), round(y), round(z)], tags };
  nodes.push(entry);
  return entry;
}

const STEP = 7.5;
for (let x = -30; x <= 30.001; x += STEP) {
  for (let z = -30; z <= 30.001; z += STEP) {
    for (const y of sampleColumn(x, z)) {
      node(x, y, z, y > 3 ? ['high'] : ['ground']);
    }
  }
}

// Dense samples up both stair runs; a 7.5 grid steps over them.
for (const s of [-1, 1]) {
  for (let i = 0; i <= 6; i++) {
    const z = s * (8.4 + i * 0.95);
    for (const y of sampleColumn(0, z)) node(0, y, z, ['stair']);
  }
}
// And on the centre platform, which the coarse grid only clips.
for (const [x, z] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]]) {
  for (const y of sampleColumn(x, z)) node(x, y, z, y > 3 ? ['center'] : ['ground']);
}

/** Nearest sampled node to a point, optionally restricted by height. */
function nearestNode(x, y, z, maxDy = 2.5) {
  let best = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    if (Math.abs(n.pos[1] - y) > maxDy) continue;
    const d = Math.hypot(n.pos[0] - x, n.pos[2] - z);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

const links = [];

// A jump pad is a one-way edge from the pad to wherever it throws you.
const GRAVITY = 22;
for (const pad of jumpPads) {
  const [px, , pz] = pad.pos;
  const from = nearestNode(px, 0, pz, 1.5);
  if (!from) continue;
  from.tags = [...new Set([...from.tags, 'pad'])];

  // Ballistic landing estimate: apex height, and horizontal drift to get there.
  // launch is stored as a [x, y, z] array in the document, not a vector.
  const [lx, ly, lz] = pad.launch;
  const apex = (ly * ly) / (2 * GRAVITY);
  const timeToApex = ly / GRAVITY;
  const landX = px + lx * timeToApex;
  const landZ = pz + lz * timeToApex;
  const to = nearestNode(landX, Math.min(apex, RING_TOP), landZ, 3.5);
  if (to && to !== from) {
    links.push({ from: from.id, to: to.id, kind: 'jumppad', oneWay: true, cost: 4 });
  }
}

// Dropping off any raised surface onto the floor below is always allowed.
for (const n of nodes) {
  if (n.pos[1] < 3) continue;
  const below = nearestNode(n.pos[0], 0, n.pos[2], 1.2);
  if (!below) continue;
  const reach = Math.hypot(below.pos[0] - n.pos[0], below.pos[2] - n.pos[2]);
  if (reach > 9) continue;
  links.push({ from: n.id, to: below.id, kind: 'drop', oneWay: true, cost: 3 });
}

const map = {
  schema: 1,
  id: 'blockout_arena',
  name: 'Blockout Arena',
  author: 'Frag Zone',
  gravity: -22,
  killZ: -25,
  bounds: { min: [-HALF, -25, -HALF], max: [HALF, 40, HALF] },
  environment: {
    sky: '#2a3a4d',
    // Fog far enough back that you can read a fight across the arena; the
    // diagonal is ~90m, so 180 only softens the far wall.
    fog: { color: '#2a3a4d', near: 70, far: 180 },
    ambient: { sky: '#bcd4f5', ground: '#6b6050', intensity: 2.1 },
    sun: { direction: [-0.45, -1, -0.3], color: '#fff4e2', intensity: 2.4 },
  },
  // Mid-grey surfaces: dark enough to read as concrete, light enough that the
  // saturated player colours pop against them at a distance.
  materials: {
    floor: { color: '#6f7887', grid: true },
    wall: { color: '#59616e' },
    platform: { color: '#7d8694' },
    stair: { color: '#8b94a2' },
    tower: { color: '#767f8d' },
    deck: { color: '#929ba9' },
    trim: { color: '#ffb347' },
    crate: { color: '#8a7a66' },
  },
  brushes,
  jumpPads: jumpPads.map((p) => ({ ...p, color: '#36e0ff' })),
  spawns,
  pickups: [],
  waypoints: {
    // maxStepUp sits just under the jump height, so links imply a traversal a
    // player (and therefore a bot) can actually make.
    autoLink: { maxDistance: 11, maxStepUp: 1.9, requireLineOfSight: true, eyeHeight: 0.9 },
    nodes,
    links,
  },
};

const out = 'public/data/maps/blockout_arena.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(map, null, 2) + '\n');
console.log(`wrote ${out}: ${brushes.length} brushes, ${nodes.length} nav nodes, ${spawns.length} spawns`);
