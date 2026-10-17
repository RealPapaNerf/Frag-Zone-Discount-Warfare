/**
 * The same rules `src/data/Content.js` enforces when the game loads a map,
 * checked here so the editor tells you before the game refuses.
 *
 * Deliberately a separate, duplicated list rather than an import: Content.js
 * throws on the first problem because a game that cannot load its map has
 * nothing to do, whereas an editor wants every problem at once and must never
 * throw while you are typing in a number field.
 */
export function validateMapDoc(doc) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };

  if (!doc || typeof doc !== 'object') return ['not a map document'];

  check(doc.schema === 1, `schema is ${doc.schema}, the game expects 1`);
  check(typeof doc.id === 'string' && /^[a-z0-9_-]+$/i.test(doc.id ?? ''),
    'id must be set, and letters, numbers, dash or underscore only');
  check(typeof doc.name === 'string' && doc.name.length > 0, 'name must be set');

  check(Array.isArray(doc.brushes) && doc.brushes.length > 0, 'needs at least one brush');
  (doc.brushes ?? []).forEach((b, i) => {
    if (b.pos?.length !== 3 || b.size?.length !== 3) problems.push(`brush ${i}: needs pos[3] and size[3]`);
    else if (!b.size.every((s) => s > 0)) problems.push(`brush ${i}: has a zero or negative size`);
    else if (![...b.pos, ...b.size].every(Number.isFinite)) problems.push(`brush ${i}: has a non-numeric value`);
  });

  check(Array.isArray(doc.spawns) && doc.spawns.length > 0, 'needs at least one spawn');
  (doc.spawns ?? []).forEach((s, i) => {
    if (s.pos?.length !== 3 || !s.pos.every(Number.isFinite)) problems.push(`spawn ${i}: needs a numeric pos[3]`);
  });

  (doc.jumpPads ?? []).forEach((p, i) => {
    if (p.pos?.length !== 3 || p.size?.length !== 3 || p.launch?.length !== 3) {
      problems.push(`jump pad ${i}: needs pos[3], size[3] and launch[3]`);
    }
  });

  const ids = new Set();
  for (const node of doc.waypoints?.nodes ?? []) {
    if (node.pos?.length !== 3) problems.push(`waypoint "${node.id}": needs pos[3]`);
    if (ids.has(node.id)) problems.push(`duplicate waypoint id "${node.id}"`);
    ids.add(node.id);
  }
  for (const link of doc.waypoints?.links ?? []) {
    if (!ids.has(link.from) || !ids.has(link.to)) {
      problems.push(`waypoint link ${link.from} -> ${link.to} points at a node that is not there`);
    }
  }

  // Not fatal to the loader, but fatal to the match.
  const bounds = doc.bounds;
  if (bounds?.min && bounds?.max) {
    for (const [i, s] of (doc.spawns ?? []).entries()) {
      if (!s.pos) continue;
      const inside = s.pos[0] > bounds.min[0] && s.pos[0] < bounds.max[0]
        && s.pos[2] > bounds.min[2] && s.pos[2] < bounds.max[2];
      if (!inside) problems.push(`spawn ${i} sits outside the map bounds`);
      if (s.pos[1] < (doc.killZ ?? -25)) problems.push(`spawn ${i} is below the kill plane`);
    }
  }

  return problems;
}
