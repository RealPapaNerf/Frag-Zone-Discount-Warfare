import { v3 } from '../math/vec3.js';
import { rayAabb } from '../math/aabb.js';

/** Ray vs sphere; returns the near intersection distance or null. */
export function raySphere(origin, dir, center, radius, maxT = Infinity) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  let t = -b - sqrtDisc;
  if (t < 0) t = -b + sqrtDisc;
  if (t < 0 || t > maxT) return null;
  return t;
}

const bodyBox = { min: v3(), max: v3() };

/**
 * Nearest actor along a ray. The body is the collision box; the head is a
 * sphere on top, so the big-heads mutator genuinely enlarges the hitbox rather
 * than only the model.
 */
export function traceActors(actors, origin, dir, maxT, ignoreId) {
  let best = null;
  for (const actor of actors) {
    if (!actor.alive || actor.id === ignoreId) continue;

    actor.torsoBox(bodyBox);
    const body = rayAabb(origin, dir, bodyBox, best ? best.t : maxT);

    const head = actor.headCenter(v3());
    const tHead = raySphere(origin, dir, head, actor.headRadius, best ? best.t : maxT);

    let t = null;
    let headshot = false;
    if (body && tHead !== null) {
      headshot = tHead <= body.t;
      t = Math.min(tHead, body.t);
    } else if (body) {
      t = body.t;
    } else if (tHead !== null) {
      t = tHead;
      headshot = true;
    }
    if (t === null) continue;
    if (!best || t < best.t) {
      best = {
        t,
        actor,
        headshot,
        point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t },
      };
    }
  }
  return best;
}

/** Nearest deployable along a ray. They are spheres; nothing needs better. */
export function traceDeployables(items, origin, dir, maxT) {
  let best = null;
  for (const item of items ?? []) {
    if (item.spent) continue;
    const radius = item.def?.hitRadius ?? 0.45;
    const centre = { x: item.pos.x, y: item.pos.y + radius, z: item.pos.z };
    const t = raySphere(origin, dir, centre, radius, best ? best.t : maxT);
    if (t === null) continue;
    if (!best || t < best.t) {
      best = {
        t,
        item,
        point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t },
      };
    }
  }
  return best;
}

/**
 * Full shot trace: whichever comes first, a wall, a player or something
 * somebody left on the floor.
 * @returns {{kind:'world'|'actor'|'deployable'|'miss', point, normal?, actor?,
 *   item?, headshot?, t:number}}
 */
export function traceShot(arena, actors, origin, dir, maxT, ignoreId, deployables = null) {
  const world = arena.raycast(origin, dir, maxT);
  let limit = world ? world.t : maxT;
  const actorHit = traceActors(actors, origin, dir, limit, ignoreId);
  if (actorHit) limit = actorHit.t;
  // Checked last and against the tightest limit, so a player standing in
  // front of their own turret takes the shot rather than the turret.
  const itemHit = deployables ? traceDeployables(deployables, origin, dir, limit) : null;

  if (itemHit) {
    return { kind: 'deployable', t: itemHit.t, point: itemHit.point, item: itemHit.item };
  }
  if (actorHit) {
    return { kind: 'actor', t: actorHit.t, point: actorHit.point, actor: actorHit.actor, headshot: actorHit.headshot };
  }
  if (world) {
    return { kind: 'world', t: world.t, point: world.point, normal: world.normal, brush: world.brush };
  }
  return {
    kind: 'miss',
    t: maxT,
    point: { x: origin.x + dir.x * maxT, y: origin.y + dir.y * maxT, z: origin.z + dir.z * maxT },
  };
}
