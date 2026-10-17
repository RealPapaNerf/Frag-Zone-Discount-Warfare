/**
 * Generate bot waypoints by walking the map rather than by hand.
 *
 * blockout_arena carries 101 hand-placed nodes. Nobody is going to do that for
 * every map they build, and a map without them is a map where the bots stand
 * still — so the editor works it out: drop a probe down a grid of columns,
 * keep the standable surfaces, and let NavGraph's auto-linker join them up.
 *
 * Explicit links are only produced for the moves the auto-linker cannot infer:
 * a drop off a ledge is one-way and taller than any step-up allowance.
 */

const DOWN = { x: 0, y: -1, z: 0 };

/**
 * @param {import('../engine/sim/Arena.js').Arena} arena
 * @param {object} doc the map document
 * @param {object} opts
 * @returns {{nodes: object[], links: object[], skipped: number}}
 */
export function generateWaypoints(arena, doc, opts = {}) {
  const {
    spacing = 6,          // metres between probe columns
    standHeight = 1.8,    // the fighter's height; needs this much clear
    radius = 0.42,        // and this much room around them
    maxStepUp = 1.9,
    probeTop = null,
  } = opts;

  const bounds = doc.bounds ?? { min: [-32, -25, -32], max: [32, 30, 32] };
  const top = probeTop ?? bounds.max[1];
  const nodes = [];
  const links = [];
  let skipped = 0;

  const surfaces = [];
  for (let x = bounds.min[0] + spacing / 2; x < bounds.max[0]; x += spacing) {
    for (let z = bounds.min[2] + spacing / 2; z < bounds.max[2]; z += spacing) {
      // Walk down the column, collecting every standable surface — so a floor
      // under a walkway and the walkway itself both get a node.
      let from = top;
      let guard = 0;
      while (from > bounds.min[1] && guard++ < 24) {
        const hit = arena.raycast({ x, y: from, z }, DOWN, from - bounds.min[1]);
        if (!hit) break;
        const y = hit.point.y;
        if (standable(arena, x, y, z, standHeight, radius)) {
          surfaces.push({ x, y, z });
        } else {
          skipped++;
        }
        from = y - 0.6; // continue below this surface
      }
    }
  }

  surfaces.sort((a, bb) => (a.z - bb.z) || (a.x - bb.x) || (a.y - bb.y));
  surfaces.forEach((s, i) => {
    nodes.push({
      id: `n${i}`,
      pos: [round(s.x), round(s.y), round(s.z)],
      tags: [s.y > (bounds.min[1] + 2) && s.y > 2 ? 'high' : 'ground'],
    });
  });

  // One-way drops: a node with another node below and nearby, too far down to
  // be climbed back up, is a ledge. The auto-linker will not connect those.
  for (const a of nodes) {
    for (const bNode of nodes) {
      if (a === bNode) continue;
      const dy = a.pos[1] - bNode.pos[1];
      if (dy <= maxStepUp) continue;
      const dist = Math.hypot(a.pos[0] - bNode.pos[0], a.pos[2] - bNode.pos[2]);
      if (dist > spacing * 1.2) continue;
      links.push({ from: a.id, to: bNode.id, kind: 'drop', oneWay: true, cost: 3 });
    }
  }

  // Jump pads launch you somewhere; tell the bots where.
  for (const pad of doc.jumpPads ?? []) {
    const under = nearest(nodes, pad.pos[0], pad.pos[2], 4);
    if (!under) continue;
    const rise = (pad.launch?.[1] ?? 0) ** 2 / (2 * Math.abs(doc.gravity ?? -22));
    const target = nodes
      .filter((n) => n.pos[1] > under.pos[1] + 1 && n.pos[1] <= under.pos[1] + rise + 1)
      .sort((p, q) => dist2(p, pad.pos) - dist2(q, pad.pos))[0];
    if (target) links.push({ from: under.id, to: target.id, kind: 'jumppad', oneWay: true, cost: 4 });
    if (!under.tags.includes('pad')) under.tags.push('pad');
  }

  return { nodes, links, skipped };
}

/** Is there room for a fighter standing on this surface? */
function standable(arena, x, y, z, height, radius) {
  const box = {
    min: { x: x - radius, y: y + 0.08, z: z - radius },
    max: { x: x + radius, y: y + height, z: z + radius },
  };
  return !arena.overlapsWorld(box);
}

function nearest(nodes, x, z, within) {
  let best = null;
  let bestD = within * within;
  for (const n of nodes) {
    const d = (n.pos[0] - x) ** 2 + (n.pos[2] - z) ** 2;
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

const dist2 = (n, pos) => (n.pos[0] - pos[0]) ** 2 + (n.pos[2] - pos[2]) ** 2;
const round = (v) => Math.round(v * 100) / 100;
