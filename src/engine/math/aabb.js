import { clamp } from './vec3.js';

/** Axis-aligned box stored as min/max corners. */
export function aabbFromCenterSize(pos, size) {
  const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
  return {
    min: { x: pos[0] - hx, y: pos[1] - hy, z: pos[2] - hz },
    max: { x: pos[0] + hx, y: pos[1] + hy, z: pos[2] + hz },
  };
}

export const overlaps = (a, b) =>
  a.min.x < b.max.x && a.max.x > b.min.x &&
  a.min.y < b.max.y && a.max.y > b.min.y &&
  a.min.z < b.max.z && a.max.z > b.min.z;

export const containsPoint = (box, p) =>
  p.x >= box.min.x && p.x <= box.max.x &&
  p.y >= box.min.y && p.y <= box.max.y &&
  p.z >= box.min.z && p.z <= box.max.z;

/** Closest point on the box to p, used for splash distance and overlap pushes. */
export const closestPoint = (box, p) => ({
  x: clamp(p.x, box.min.x, box.max.x),
  y: clamp(p.y, box.min.y, box.max.y),
  z: clamp(p.z, box.min.z, box.max.z),
});

/**
 * Slab test. Returns the entry distance along `dir` (which need not be unit
 * length) within [0, maxT], or null. `dir` components of zero are handled.
 */
export function rayAabb(origin, dir, box, maxT = Infinity) {
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sign = 0;

  for (const k of ['x', 'y', 'z']) {
    const d = dir[k];
    if (Math.abs(d) < 1e-9) {
      if (origin[k] < box.min[k] || origin[k] > box.max[k]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[k] - origin[k]) * inv;
    let t2 = (box.max[k] - origin[k]) * inv;
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = k; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis === -1) return null; // origin already inside the box
  return { t: tmin, axis, normal: normalFor(axis, sign) };
}

function normalFor(axis, sign) {
  return {
    x: axis === 'x' ? sign : 0,
    y: axis === 'y' ? sign : 0,
    z: axis === 'z' ? sign : 0,
  };
}

/** Expand a box by a half-extent, turning swept-box tests into ray tests. */
export const expand = (box, h) => ({
  min: { x: box.min.x - h.x, y: box.min.y - h.y, z: box.min.z - h.z },
  max: { x: box.max.x + h.x, y: box.max.y + h.y, z: box.max.z + h.z },
});
