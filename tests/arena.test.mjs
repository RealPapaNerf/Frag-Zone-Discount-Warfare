import { test } from 'node:test';
import assert from 'node:assert/strict';
import { content } from './helpers.mjs';
import { Arena } from '../src/engine/sim/Arena.js';
import { NavGraph } from '../src/engine/ai/NavGraph.js';

const arena = new Arena(content.maps.blockout_arena);

test('a downward ray from mid air finds the floor', () => {
  // (-5, -12) is open floor: clear of the centre block, stairs, crates and the
  // ring walkway overhead.
  const hit = arena.raycast({ x: -5, y: 10, z: -12 }, { x: 0, y: -1, z: 0 }, 50);
  assert.ok(hit, 'expected to hit the floor');
  assert.equal(hit.brush.material, 'floor');
  assert.ok(Math.abs(hit.point.y) < 1e-6, `floor should be at y=0, got ${hit.point.y}`);
});

test('the centre platform blocks line of sight across the arena', () => {
  const west = { x: -20, y: 1.6, z: 0 };
  const east = { x: 20, y: 1.6, z: 0 };
  assert.equal(arena.lineOfSight(west, east), false);
  // Over the top of it, the same pair can see each other.
  assert.equal(arena.lineOfSight({ ...west, y: 12 }, { ...east, y: 12 }), true);
});

test('jump pads are found by overlap', () => {
  const box = { min: { x: 13.5, y: 0, z: 13.5 }, max: { x: 14.5, y: 1.8, z: 14.5 } };
  const pad = arena.jumpPadAt(box);
  assert.ok(pad, 'expected the south-east diagonal pad');
  assert.ok(pad.launch.y > 15);
});

test('no jump pad blocks the stair approach', () => {
  // Running at the stairs must not launch you onto the ring instead.
  for (const z of [-19, -17, -15, -14, 15, 17, 19]) {
    const box = { min: { x: -1, y: 0, z: z - 0.5 }, max: { x: 1, y: 1.8, z: z + 0.5 } };
    assert.equal(arena.jumpPadAt(box), null, `a pad sits in the stair run at z=${z}`);
  }
});

test('every spawn point stands on solid ground and is not inside a wall', () => {
  for (const spawn of arena.spawns) {
    const below = arena.raycast({ ...spawn.pos, y: spawn.pos.y + 0.5 }, { x: 0, y: -1, z: 0 }, 4);
    assert.ok(below, `spawn at ${JSON.stringify(spawn.pos)} has no floor under it`);
    const box = {
      min: { x: spawn.pos.x - 0.42, y: spawn.pos.y + 0.05, z: spawn.pos.z - 0.42 },
      max: { x: spawn.pos.x + 0.42, y: spawn.pos.y + 1.78, z: spawn.pos.z + 0.42 },
    };
    assert.equal(arena.overlapsWorld(box), null,
      `spawn at ${JSON.stringify(spawn.pos)} is embedded in geometry`);
  }
});

test('the nav graph is fully connected, with no stranded nodes', () => {
  const nav = new NavGraph(content.maps.blockout_arena.waypoints, arena);
  assert.ok(nav.size > 20, `expected a real graph, got ${nav.size} nodes`);
  assert.deepEqual(nav.findIsolatedNodes(), []);

  // Reachability from one ground node to everything else.
  const start = nav.nodes[0];
  const unreachable = nav.nodes
    .filter((n) => n !== start && !nav.findPath(start.id, n.id))
    .map((n) => n.id);
  assert.deepEqual(unreachable, [], 'bots must be able to reach the whole map');
});

test('the only route onto the ring walkway is a jump pad', () => {
  const nav = new NavGraph(content.maps.blockout_arena.waypoints, arena);
  const ground = nav.nearest({ x: -27, y: 0, z: -27 });
  const deck = nav.nearest({ x: 22, y: 8, z: 0 });
  assert.equal(deck.pos.y, 8, 'expected a node on the east deck');

  const path = nav.findPath(ground.id, deck.id);
  assert.ok(path, 'no route to the east deck');
  assert.ok(path.some((n) => n.tags.includes('pad')), 'route should use a jump pad');
});

test('raised nodes can always drop back to the floor', () => {
  const nav = new NavGraph(content.maps.blockout_arena.waypoints, arena);
  const high = nav.nodes.filter((n) => n.pos.y >= 5);
  assert.ok(high.length > 4, 'expected sampled nodes up on the ring and platform');
  const ground = nav.nearest({ x: 0, y: 0, z: -28 });
  for (const node of high) {
    assert.ok(nav.findPath(node.id, ground.id), `no way down from ${node.id}`);
  }
});
