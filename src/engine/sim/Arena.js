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

    /**
     * Doors are kept out of the static grid and appended to every query
     * instead. The grid is built once from fixed boxes; a door moves, so
     * indexing it would mean rebuilding buckets every time one opened. There
     * are only ever a handful, and `query` is the single place both collision
     * and ray casting go through, so appending them there makes doors solid
     * for movement and for bullets without touching either.
     */
    this.doors = (mapDoc.doors ?? []).map((d, index) => {
      const offset = d.openOffset ?? [0, d.size[1], 0];
      const open = [d.pos[0] + offset[0], d.pos[1] + offset[1], d.pos[2] + offset[2]];
      const t = d.startsOpen ? 1 : 0;
      const door = {
        index: 1e6 + index,
        id: d.id ?? `door${index}`,
        material: d.material ?? 'door',
        isDoor: true,
        closedBox: aabbFromCenterSize(d.pos, d.size),
        openBox: aabbFromCenterSize(open, d.size),
        size: [...d.size],
        t,
        target: t,
        speed: 1 / Math.max(0.05, d.openSec ?? 0.7),
        box: { min: v3(), max: v3() },
      };
      poseDoor(door);
      return door;
    });

    /**
     * Map-placed pickups. These are spawners rather than items: they come
     * back after they are taken, which is what makes going to the health in
     * the corner a decision you make repeatedly rather than once.
     */
    this.pickupSpawners = (mapDoc.pickups ?? []).map((p, index) => ({
      index,
      kind: p.kind ?? 'health',
      weaponId: p.weapon ?? null,
      amount: p.amount ?? 0,
      respawnSec: p.respawnSec ?? 20,
      pos: { x: p.pos[0], y: p.pos[1], z: p.pos[2] },
    }));

    /** Points on the map you can walk up to and use. A hook, not a feature. */
    this.fixtures = (mapDoc.fixtures ?? []).map((f, index) => ({
      index,
      id: f.id ?? `fixture${index}`,
      kind: f.kind ?? 'socket',
      label: f.label ?? 'Use',
      radius: f.radius ?? 1.6,
      pos: { x: f.pos[0], y: f.pos[1], z: f.pos[2] },
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
    // A door that is not fully open is still something to walk into.
    for (const door of this.doors) {
      if (door.t < 0.999) out.push(door);
    }
    return out;
  }

  doorById(id) {
    return this.doors.find((d) => d.id === id) ?? null;
  }

  /**
   * Slide doors toward whatever they were last told to do.
   *
   * `blockers` are boxes that stop one closing. A door that shuts on somebody
   * would either push them through a wall or trap them inside itself, and
   * neither is a door — it is a bug with hinges.
   */
  stepDoors(dt, blockers = []) {
    for (const door of this.doors) {
      if (door.t === door.target) continue;
      const closing = door.target < door.t;
      if (closing && blockers.some((b) => overlaps(b, door.closedBox))) continue;
      const step = door.speed * dt;
      door.t = door.target > door.t
        ? Math.min(door.target, door.t + step)
        : Math.max(door.target, door.t - step);
      poseDoor(door);
    }
  }

  /** @returns {boolean} the door's new open state */
  toggleDoor(door) {
    door.target = door.target > 0.5 ? 0 : 1;
    return door.target > 0.5;
  }

  /**
   * The nearest door you could reach and are roughly facing.
   *
   * Measured against the doorway — the closed box — and not against where
   * the door currently is, because an open door is deliberately absent from
   * `query` and so cannot be hit by a ray. Looking for it that way meant you
   * could open a door and then never close it again.
   *
   * @param {object} point eye position
   * @param {object} dir   view direction
   */
  doorNear(point, dir, range) {
    let best = null;
    let bestDist = Infinity;
    for (const door of this.doors) {
      const near = closestPoint(door.closedBox, point);
      const dist = distance(point, near);
      if (dist > range || dist >= bestDist) continue;
      // Facing it, measured to the doorway's middle so standing at the edge
      // of a wide door still counts.
      const toward = sub(v3(),
        {
          x: (door.closedBox.min.x + door.closedBox.max.x) / 2,
          y: (door.closedBox.min.y + door.closedBox.max.y) / 2,
          z: (door.closedBox.min.z + door.closedBox.max.z) / 2,
        }, point);
      // Only ask which way you are looking if you are not already in it.
      // Stood in the doorway the door's middle is at your feet, so the test
      // compares your view against a straight-down vector and refuses every
      // time — you could open a door, walk into it, and never shut it again.
      if (dist > 0.75 && length(toward) > 1e-6) {
        normalize(toward, toward);
        if (toward.x * dir.x + toward.y * dir.y + toward.z * dir.z < 0.3) continue;
      }
      best = door;
      bestDist = dist;
    }
    return best;
  }

  /** The nearest fixture an actor is close enough to use. */
  fixtureNear(point, maxExtra = 0) {
    let best = null;
    let bestDist = Infinity;
    for (const fixture of this.fixtures) {
      const dist = distance(point, fixture.pos);
      if (dist > fixture.radius + maxExtra || dist >= bestDist) continue;
      best = fixture;
      bestDist = dist;
    }
    return best;
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

/** Put a door's box where its open fraction says it should be. */
function poseDoor(door) {
  const a = door.closedBox;
  const b = door.openBox;
  const t = door.t;
  door.box.min.x = a.min.x + (b.min.x - a.min.x) * t;
  door.box.min.y = a.min.y + (b.min.y - a.min.y) * t;
  door.box.min.z = a.min.z + (b.min.z - a.min.z) * t;
  door.box.max.x = a.max.x + (b.max.x - a.max.x) * t;
  door.box.max.y = a.max.y + (b.max.y - a.max.y) * t;
  door.box.max.z = a.max.z + (b.max.z - a.max.z) * t;
}

function boxAlongRay(origin, dir, maxT, pad) {
  const t = Number.isFinite(maxT) ? maxT : 1e4;
  const end = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
  return {
    min: { x: Math.min(origin.x, end.x) - pad, y: Math.min(origin.y, end.y) - pad, z: Math.min(origin.z, end.z) - pad },
    max: { x: Math.max(origin.x, end.x) + pad, y: Math.max(origin.y, end.y) + pad, z: Math.max(origin.z, end.z) + pad },
  };
}
