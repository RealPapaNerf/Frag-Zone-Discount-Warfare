/**
 * Composite pieces, each returning a list of plain brushes.
 *
 * A map like Carentan is buildings, doorways and courtyards, and placing that
 * one box at a time is the reason people give up on map editors. A building
 * shell is nine brushes; a doorway is a wall cut into three. Prefabs are how
 * the brush format — which the engine can collide with cheaply — still gets
 * you something that reads as architecture.
 *
 * Everything here stays axis-aligned, because that is what Arena's collision
 * grid indexes. Rotation is in 90-degree steps, which for a box is just
 * swapping width and depth, so it costs the engine nothing.
 */

const b = (pos, size, material) => ({ pos: [...pos], size: [...size], material });

/** Swap X and Z extents for a quarter turn. */
function turn(brushes, quarterTurns, origin = [0, 0, 0]) {
  let out = brushes;
  for (let n = 0; n < ((quarterTurns % 4) + 4) % 4; n++) {
    out = out.map((br) => {
      const dx = br.pos[0] - origin[0];
      const dz = br.pos[2] - origin[2];
      return {
        ...br,
        // (x, z) -> (z, -x) about the origin.
        pos: [origin[0] + dz, br.pos[1], origin[2] - dx],
        size: [br.size[2], br.size[1], br.size[0]],
      };
    });
  }
  return out;
}

export const PREFABS = [
  {
    id: 'wall',
    name: 'Wall',
    hint: 'A plain wall segment, 8 m by 4 m.',
    params: { length: 8, height: 4, thickness: 0.5 },
    build({ length, height, thickness }, at) {
      return [b([at[0], at[1] + height / 2, at[2]], [length, height, thickness], 'wall')];
    },
  },
  {
    id: 'doorway',
    name: 'Wall + doorway',
    hint: 'A wall with a 1.6 m gap you can run through.',
    params: { length: 8, height: 4, thickness: 0.5, doorWidth: 1.6, doorHeight: 2.4 },
    build({ length, height, thickness, doorWidth, doorHeight }, at) {
      const side = (length - doorWidth) / 2;
      const lintel = height - doorHeight;
      return [
        b([at[0] - (doorWidth / 2 + side / 2), at[1] + height / 2, at[2]], [side, height, thickness], 'wall'),
        b([at[0] + (doorWidth / 2 + side / 2), at[1] + height / 2, at[2]], [side, height, thickness], 'wall'),
        b([at[0], at[1] + doorHeight + lintel / 2, at[2]], [doorWidth, lintel, thickness], 'wall'),
      ];
    },
  },
  {
    id: 'window',
    name: 'Wall + window',
    hint: 'A wall you can shoot through but not walk through.',
    params: { length: 8, height: 4, thickness: 0.5, openWidth: 2.4, sill: 1.1, openHeight: 1.3 },
    build({ length, height, thickness, openWidth, sill, openHeight }, at) {
      const side = (length - openWidth) / 2;
      const head = height - sill - openHeight;
      return [
        b([at[0] - (openWidth / 2 + side / 2), at[1] + height / 2, at[2]], [side, height, thickness], 'brick'),
        b([at[0] + (openWidth / 2 + side / 2), at[1] + height / 2, at[2]], [side, height, thickness], 'brick'),
        b([at[0], at[1] + sill / 2, at[2]], [openWidth, sill, thickness], 'brick'),
        b([at[0], at[1] + sill + openHeight + head / 2, at[2]], [openWidth, head, thickness], 'brick'),
      ];
    },
  },
  {
    id: 'building',
    name: 'Building shell',
    hint: 'Four walls with a doorway, a floor and a roof you can stand on.',
    params: { width: 12, depth: 10, height: 4, thickness: 0.5, doorWidth: 1.8, doorHeight: 2.4 },
    build(p, at) {
      const { width, depth, height, thickness, doorWidth, doorHeight } = p;
      const out = [];
      const y = at[1];
      // Floor and roof.
      out.push(b([at[0], y + 0.05, at[2]], [width, 0.3, depth], 'floor'));
      out.push(b([at[0], y + height + 0.15, at[2]], [width + 0.6, 0.3, depth + 0.6], 'roof'));
      // Back and two sides, solid.
      out.push(b([at[0], y + height / 2, at[2] - depth / 2], [width, height, thickness], 'brick'));
      out.push(b([at[0] - width / 2, y + height / 2, at[2]], [thickness, height, depth], 'brick'));
      out.push(b([at[0] + width / 2, y + height / 2, at[2]], [thickness, height, depth], 'brick'));
      // Front, with a doorway in it.
      const side = (width - doorWidth) / 2;
      const lintel = height - doorHeight;
      out.push(b([at[0] - (doorWidth / 2 + side / 2), y + height / 2, at[2] + depth / 2], [side, height, thickness], 'brick'));
      out.push(b([at[0] + (doorWidth / 2 + side / 2), y + height / 2, at[2] + depth / 2], [side, height, thickness], 'brick'));
      out.push(b([at[0], y + doorHeight + lintel / 2, at[2] + depth / 2], [doorWidth, lintel, thickness], 'brick'));
      return out;
    },
  },
  {
    id: 'stairs',
    name: 'Stairs',
    hint: 'A run of steps the engine can walk up, one step at a time.',
    params: { steps: 6, rise: 0.6, run: 0.8, width: 3 },
    build({ steps, rise, run, width }, at) {
      const out = [];
      for (let i = 0; i < steps; i++) {
        const h = (i + 1) * rise;
        out.push(b([at[0], at[1] + h / 2, at[2] - i * run], [width, h, run], 'stair'));
      }
      return out;
    },
  },
  {
    id: 'courtyard',
    name: 'Courtyard wall',
    hint: 'A low wall ring you can vault sight lines over.',
    params: { width: 16, depth: 16, height: 1.4, thickness: 0.6, gap: 3 },
    build({ width, depth, height, thickness, gap }, at) {
      const out = [];
      const sideLen = (width - gap) / 2;
      const y = at[1] + height / 2;
      out.push(b([at[0], y, at[2] - depth / 2], [width, height, thickness], 'hedge'));
      out.push(b([at[0] - width / 2, y, at[2]], [thickness, height, depth], 'hedge'));
      out.push(b([at[0] + width / 2, y, at[2]], [thickness, height, depth], 'hedge'));
      out.push(b([at[0] - (gap / 2 + sideLen / 2), y, at[2] + depth / 2], [sideLen, height, thickness], 'hedge'));
      out.push(b([at[0] + (gap / 2 + sideLen / 2), y, at[2] + depth / 2], [sideLen, height, thickness], 'hedge'));
      return out;
    },
  },
  {
    id: 'crates',
    name: 'Crate stack',
    hint: 'Cover you can climb.',
    params: { size: 1.6, height: 2 },
    build({ size, height }, at) {
      const out = [];
      out.push(b([at[0], at[1] + size / 2, at[2]], [size, size, size], 'crate'));
      out.push(b([at[0] + size * 0.9, at[1] + size / 2, at[2] + size * 0.2], [size, size, size], 'crate'));
      if (height > 1) out.push(b([at[0] + size * 0.2, at[1] + size * 1.5, at[2]], [size, size, size], 'crate'));
      return out;
    },
  },
  {
    id: 'room',
    name: 'Arena shell',
    hint: 'Floor and four walls — the box every map starts in.',
    params: { width: 64, depth: 64, height: 12, thickness: 1 },
    build({ width, depth, height, thickness }, at) {
      const y = at[1];
      return [
        b([at[0], y - 0.5, at[2]], [width, 1, depth], 'floor'),
        b([at[0], y + height / 2, at[2] - depth / 2 - thickness / 2], [width + thickness * 2, height, thickness], 'wall'),
        b([at[0], y + height / 2, at[2] + depth / 2 + thickness / 2], [width + thickness * 2, height, thickness], 'wall'),
        b([at[0] - width / 2 - thickness / 2, y + height / 2, at[2]], [thickness, height, depth + thickness * 2], 'wall'),
        b([at[0] + width / 2 + thickness / 2, y + height / 2, at[2]], [thickness, height, depth + thickness * 2], 'wall'),
      ];
    },
  },
];

export function buildPrefab(id, params, at, quarterTurns = 0) {
  const prefab = PREFABS.find((p) => p.id === id);
  if (!prefab) return [];
  const brushes = prefab.build({ ...prefab.params, ...params }, [0, 0, 0]);
  const turned = turn(brushes, quarterTurns);
  return turned.map((br) => ({
    ...br,
    pos: [br.pos[0] + at[0], br.pos[1] + at[1], br.pos[2] + at[2]],
  }));
}
