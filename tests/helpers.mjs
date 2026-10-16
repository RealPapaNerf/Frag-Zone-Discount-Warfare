import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadContent } from '../src/data/Content.js';

const DATA_ROOT = new URL('../public/data/', import.meta.url).pathname;

export const nodeReader = async (path) =>
  JSON.parse(await readFile(join(DATA_ROOT, path), 'utf8'));

export const content = await loadContent(nodeReader);

export const BASE = {
  content,
  mapId: 'blockout_arena',
  modeId: 'deathmatch',
  seed: 42,
};

/** Drop an actor at a position with zero velocity, ready to simulate. */
export function placeActor(world, actor, x, y, z) {
  actor.position.x = x; actor.position.y = y; actor.position.z = z;
  actor.velocity.x = 0; actor.velocity.y = 0; actor.velocity.z = 0;
  actor.grounded = false;
  actor.onPad = false;
  return actor;
}

export function stepFor(world, seconds, dt = 1 / 60) {
  const ticks = Math.round(seconds / dt);
  for (let i = 0; i < ticks; i++) world.step(dt);
}
