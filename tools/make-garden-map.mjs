/**
 * Builds "The Garden", a starter arena, and works out its bot navigation.
 *
 * An original layout in the spirit of the walled-garden maps from the early
 * Call of Duty days: a hedged centre you fight over, two solid buildings with
 * roofs worth holding, and lanes down the sides that let you get behind
 * someone. It is here to be opened in the editor and pulled apart, not to be
 * final — which is why it is a script rather than a hand-typed JSON: change a
 * number up here and the whole map, waypoints included, rebuilds.
 *
 *   node tools/make-garden-map.mjs [outfile]
 */
import { writeFileSync } from 'node:fs';
import { Arena } from '../src/engine/sim/Arena.js';
import { buildPrefab } from '../src/editor/prefabs.js';
import { generateWaypoints } from '../src/editor/waypoints.js';

const out = process.argv[2] ?? new URL('../public/data/maps/garden.json', import.meta.url).pathname;

const brushes = [];
const spawns = [];
const jumpPads = [];

const box = (pos, size, material) => brushes.push({ pos, size, material });
const prefab = (id, params, at, turns = 0) => brushes.push(...buildPrefab(id, params, at, turns));

/* ---------------- the ground and the outer wall ---------------- */
prefab('room', { width: 72, depth: 72, height: 14, thickness: 1 }, [0, 0, 0]);

/* ---------------- the walled garden itself ----------------
   A hedge ring with four gaps, so the centre is contested but never a
   death-trap: whichever way you are pushed, there is a way out. */
for (let turns = 0; turns < 4; turns++) {
  prefab('courtyard', { width: 22, depth: 22, height: 1.5, thickness: 0.8, gap: 5 }, [0, 0, 0], turns);
}
// A raised bed in the middle: cover you can shoot over, and stand on.
box([0, 0.6, 0], [8, 1.2, 8], 'hedge');
box([0, 1.4, 0], [5, 0.4, 5], 'deck');

/* ---------------- the manor, north-west ----------------
   Two storeys worth of height, a roof you reach by the outside stair, and
   windows you can shoot through on the courtyard side. */
prefab('building', { width: 16, depth: 13, height: 5, doorWidth: 2.2, doorHeight: 2.6 }, [-20, 0, -19]);
prefab('window', { length: 10, height: 4, openWidth: 2.6, sill: 1.2, openHeight: 1.4 }, [-20, 0, -12.2]);
prefab('stairs', { steps: 9, rise: 0.62, run: 0.9, width: 3 }, [-11, 0, -12.5], 1);
// Roof parapet, so the roof is cover rather than a shooting platform.
box([-20, 5.7, -25.6], [17, 0.9, 0.6], 'roof');
box([-28.3, 5.7, -19], [0.6, 0.9, 13.6], 'roof');
box([-11.7, 5.7, -19], [0.6, 0.9, 13.6], 'roof');

/* ---------------- the barn, south-east ---------------- */
prefab('building', { width: 14, depth: 11, height: 4.6, doorWidth: 3.2, doorHeight: 3.2 }, [19, 0, 18], 2);
prefab('stairs', { steps: 8, rise: 0.6, run: 0.9, width: 3 }, [10.5, 0, 18], 3);
box([19, 5.3, 23.5], [15, 0.9, 0.6], 'roof');
box([26, 5.3, 18], [0.6, 0.9, 11.6], 'roof');

/* ---------------- the greenhouse, north-east ----------------
   All windows: you can see and shoot through it from either side, which
   makes it a lane you cross quickly rather than a room you hold. */
for (const [at, turns] of [[[20, 0, -18], 0], [[20, 0, -24], 0], [[14.2, 0, -21], 1], [[25.8, 0, -21], 1]]) {
  prefab('window', { length: 12, height: 3.4, thickness: 0.4, openWidth: 3.2, sill: 0.9, openHeight: 1.5 }, at, turns);
}

/* ---------------- the potting sheds, south-west ---------------- */
prefab('doorway', { length: 10, height: 3.4, doorWidth: 1.8, doorHeight: 2.4 }, [-20, 0, 14]);
prefab('doorway', { length: 10, height: 3.4, doorWidth: 1.8, doorHeight: 2.4 }, [-20, 0, 22]);
box([-25.2, 1.7, 18], [0.5, 3.4, 8], 'brick');
box([-14.8, 1.7, 18], [0.5, 3.4, 8], 'brick');
box([-20, 3.6, 18], [11, 0.4, 8.6], 'roof');

/* ---------------- lanes, beds and cover ---------------- */
// Low garden beds that break the long sight lines down each side.
for (const z of [-6, 6]) {
  box([-31, 0.45, z], [7, 0.9, 4], 'hedge');
  box([31, 0.45, z], [7, 0.9, 4], 'hedge');
}
for (const x of [-6, 6]) {
  box([x, 0.45, -31], [4, 0.9, 7], 'hedge');
  box([x, 0.45, 31], [4, 0.9, 7], 'hedge');
}
// Crate stacks, in the corners the buildings do not cover.
prefab('crates', { size: 1.6, height: 2 }, [-28, 0, 28]);
prefab('crates', { size: 1.6, height: 2 }, [28, 0, -30]);
prefab('crates', { size: 1.6, height: 1 }, [2, 0, -14]);
prefab('crates', { size: 1.6, height: 1 }, [-3, 0, 14]);

/* ---------------- jump pads onto the roofs ---------------- */
jumpPads.push({ pos: [-13, 0.1, 2], size: [3, 0.2, 3], launch: [0, 16, 0], color: '#53e0ff' });
jumpPads.push({ pos: [13, 0.1, -2], size: [3, 0.2, 3], launch: [0, 16, 0], color: '#53e0ff' });

/* ---------------- spawns ----------------
   Ten, spread so no two are in sight of each other, each facing the middle. */
for (const [x, z] of [
  [-30, -30], [0, -32], [30, -30], [32, 0], [30, 30],
  [0, 32], [-30, 30], [-32, 0], [-26, 10], [26, -10],
]) {
  spawns.push({ pos: [x, 0.2, z], yaw: Math.round(Math.atan2(-x, -z) * 1000) / 1000 });
}

/* ---------------- the document ---------------- */
const doc = {
  format: 'fragzone-map/1',
  schema: 1,
  id: 'garden',
  name: 'The Garden',
  region: 'An original layout, not a conversion of anyone else\'s map.',
  author: 'tools/make-garden-map.mjs',
  license: 'CC0-1.0',
  gravity: -22,
  killZ: -25,
  bounds: { min: [-40, -25, -40], max: [40, 30, 40] },
  environment: {
    sky: '#2b3a42',
    fog: { color: '#2b3a42', near: 60, far: 200 },
    ambient: { sky: '#cfe3f5', ground: '#5a6048', intensity: 2.0 },
    sun: { direction: [-0.4, -1, -0.35], color: '#fff1d6', intensity: 2.3 },
  },
  materials: {
    floor: { color: '#6d7361', grid: true },
    wall: { color: '#59616e' },
    deck: { color: '#929ba9' },
    stair: { color: '#8b94a2' },
    tower: { color: '#767f8d' },
    trim: { color: '#ffb347' },
    crate: { color: '#8a7a66' },
    brick: { color: '#8d6a5b' },
    roof: { color: '#4a4f58' },
    hedge: { color: '#4f6b43' },
  },
  brushes,
  jumpPads,
  spawns,
  pickups: [],
  waypoints: { autoLink: { maxDistance: 11, maxStepUp: 1.9, requireLineOfSight: true, eyeHeight: 0.9 }, nodes: [], links: [] },
};

// Work out where the bots can walk, exactly as the editor's button does.
const arena = new Arena(doc);
const { nodes, links, skipped } = generateWaypoints(arena, doc, { spacing: 5 });
doc.waypoints.nodes = nodes;
doc.waypoints.links = links;

writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`${out}`);
console.log(`  ${brushes.length} brushes, ${spawns.length} spawns, ${jumpPads.length} jump pads`);
console.log(`  ${nodes.length} bot waypoints, ${links.length} explicit links (${skipped} columns had no headroom)`);
