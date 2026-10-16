import { aabbFromCenterSize, overlaps, rayAabb, expand, closestPoint } from '../math/aabb.js';
import { v3, sub, normalize, length, distance } from '../math/vec3.js';

/**
 * The collision and spatial-query view of a map document. Rendering builds its
 * own meshes from the same JSON; nothing here knows what a mesh is.
 *
 * Brushes are axis-aligned boxes. A uniform grid indexes them so hitscan and
 * splash queries stay cheap on a Chromebook with a few hundred brushes.
 */
export class Arena {
  constructor(mapDoc) {
    this.doc = mapDoc;
    this.id = mapDoc.id;
    this.gravity = mapDoc.gravity ?? -22;
    this.killZ = mapDoc.killZ ?? -50;
    this.spawns = (mapDoc.spawns ?? []).map((s) => ({
      pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
      yaw: s.yaw ?? 0,
    }));

    this.brushes = (mapDoc.brushes ?? []).map((b, index) => ({
      index,
      material: b.material ?? 'default',
      box: aabbFromCenterSize(b.pos, b.size),
    }));

    this.jumpPads = (mapDoc.jumpPads ?? []).map((p, index) => ({
      index,
      box: aabbFromCenterSize(p.pos, p.size),
      launch: { x: p.launch[0], y: p.launch[1], z: p.launch[2] },
      color: p.color,
    }));

    this.#buildGrid();
  }

  #buildGrid() {
    const bounds = this.doc.bounds ?? { min: [-64, -64, -64], max: [64, 64, 64] };
    this.gridMin = { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] };
    this.cell = 8;
    this.gridDim = {
      x: Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / this.cell)),
      z: Math.max(1, Math.ceil((bounds.max[2] - bounds.min[2]) / this.cell)),
    };
    this.grid = new Map();
    for (const brush of this.brushes) {
      for (const key of this.#cellKeys(brush.box)) {
        let bucket = this.grid.get(key);
        if (!bucket) this.grid.set(key, (bucket = []));
        bucket.push(brush);
      }
    }
  }

  #cellKeys(box) {
    const x0 = Math.floor((box.min.x - this.gridMin.x) / this.cell);
    const x1 = Math.floor((box.max.x - this.gridMin.x) / this.cell);
    const z0 = Math.floor((box.min.z - this.gridMin.z) / this.cell);
    const z1 = Math.floor((box.max.z - this.gridMin.z) / this.cell);
    const keys = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) keys.push(x * 73856093 ^ z * 19349663);
    return keys;
  }

  /** Brushes whose cells intersect `box`. May contain duplicates-free results. */
  query(box) {
    const seen = new Set();
    const out = [];
    for (const key of this.#cellKeys(box)) {
      const bucket = this.grid.get(key);
      if (!bucket) continue;
      for (const brush of bucket) {
        if (seen.has(brush.index)) continue;
        seen.add(brush.index);
        out.push(brush);
      }
    }
    return out;
  }

  overlapsWorld(box) {
    for (const brush of this.query(box)) if (overlaps(box, brush.box)) return brush;
    return null;
  }

  /**
   * Cast a ray against world geometry.
   * @returns {{t:number, point:object, normal:object, brush:object}|null}
   */
  raycast(origin, dir, maxT = Infinity, radius = 0) {
    // Sweeping a sphere of `radius` is a ray test against boxes grown by it.
    const half = { x: radius, y: radius, z: radius };
    const sweep = boxAlongRay(origin, dir, maxT, radius);
    let best = null;
    for (const brush of this.query(sweep)) {
      const box = radius > 0 ? expand(brush.box, half) : brush.box;
      const hit = rayAabb(origin, dir, box, best ? best.t : maxT);
      if (hit && (!best || hit.t < best.t)) {
        best = { t: hit.t, normal: hit.normal, brush, point: null };
      }
    }
    if (best) {
      best.point = {
        x: origin.x + dir.x * best.t,
        y: origin.y + dir.y * best.t,
        z: origin.z + dir.z * best.t,
      };
    }
    return best;
  }

  /** True when nothing solid sits between two points. */
  lineOfSight(from, to) {
    const dir = sub(v3(), to, from);
    const dist = length(dir);
    if (dist < 1e-6) return true;
    normalize(dir, dir);
    const hit = this.raycast(from, dir, dist - 1e-3);
    return hit === null;
  }

  /** Shortest distance from a point to any solid surface, for splash occlusion. */
  nearestSurfaceDistance(point, searchRadius) {
    const box = {
      min: { x: point.x - searchRadius, y: point.y - searchRadius, z: point.z - searchRadius },
      max: { x: point.x + searchRadius, y: point.y + searchRadius, z: point.z + searchRadius },
    };
    let best = Infinity;
    for (const brush of this.query(box)) {
      best = Math.min(best, distance(point, closestPoint(brush.box, point)));
    }
    return best;
  }

  jumpPadAt(box) {
    for (const pad of this.jumpPads) if (overlaps(box, pad.box)) return pad;
    return null;
  }
}

function boxAlongRay(origin, dir, maxT, pad) {
  const t = Number.isFinite(maxT) ? maxT : 1e4;
  const end = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
  return {
    min: { x: Math.min(origin.x, end.x) - pad, y: Math.min(origin.y, end.y) - pad, z: Math.min(origin.z, end.z) - pad },
    max: { x: Math.max(origin.x, end.x) + pad, y: Math.max(origin.y, end.y) + pad, z: Math.max(origin.z, end.z) + pad },
  };
}
