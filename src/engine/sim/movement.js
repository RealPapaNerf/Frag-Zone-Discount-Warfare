import { v3, set, dot, length, clamp } from '../math/vec3.js';
import { overlaps } from '../math/aabb.js';

/**
 * Quake-family movement: high ground friction, capped air acceleration, and a
 * step-up pass so stairs are walkable. Keeping the classic accelerate() means
 * strafe-jumping falls out for free, which is most of why UT movement feels
 * the way it does.
 */

export function playerBox(pos, hitbox, out = { min: v3(), max: v3() }) {
  const r = hitbox.radius;
  set(out.min, pos.x - r, pos.y, pos.z - r);
  set(out.max, pos.x + r, pos.y + hitbox.height, pos.z + r);
  return out;
}

function accelerate(vel, wishDir, wishSpeed, accel, dt) {
  const current = dot(vel, wishDir);
  const add = wishSpeed - current;
  if (add <= 0) return;
  const accelSpeed = Math.min(accel * wishSpeed * dt, add);
  vel.x += wishDir.x * accelSpeed;
  vel.y += wishDir.y * accelSpeed;
  vel.z += wishDir.z * accelSpeed;
}

function applyFriction(vel, friction, dt) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1e-4) { vel.x = 0; vel.z = 0; return; }
  // A stop speed keeps slow drift from lingering forever.
  const control = Math.max(speed, 4);
  const drop = control * friction * dt;
  const scale = Math.max(0, speed - drop) / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/**
 * Advance one actor by dt. `intent` carries a normalised wish direction in
 * world space plus jump/crouch flags; the caller decides whether that came
 * from a keyboard or from a bot.
 */
export function moveActor(actor, arena, intent, dt, rules) {
  const move = actor.moveParams;
  const vel = actor.velocity;
  const grounded = actor.grounded;

  // Down the sights you walk; crouching is still the slowest thing you can do.
  const crouching = intent.crouch && rules.canCrouch;
  const baseSpeed = crouching ? move.crouchSpeed
    : intent.aim ? (move.adsSpeed ?? move.maxSpeed * 0.45)
      : move.maxSpeed;
  const maxSpeed = baseSpeed * rules.moveSpeedScale;

  if (grounded) {
    applyFriction(vel, move.friction, dt);
    accelerate(vel, intent.wishDir, maxSpeed, move.groundAccel, dt);
    if (intent.jump && rules.canJump && actor.jumpCooldown <= 0) {
      vel.y = move.jumpVelocity * rules.jumpScale;
      actor.grounded = false;
      actor.jumpCooldown = 0.08;
      actor.events.push({ type: 'jump' });
    }
  } else {
    // Air control: accelerate toward the wish direction but only up to a small
    // speed, which is what makes air-strafing gain speed instead of capping.
    const airSpeed = Math.min(maxSpeed, move.airMaxSpeed * rules.airAccelScale);
    accelerate(vel, intent.wishDir, airSpeed, move.airAccel * rules.airAccelScale, dt);
  }

  vel.y += arena.gravity * rules.gravityScale * dt;
  const terminal = 90;
  if (vel.y < -terminal) vel.y = -terminal;

  actor.jumpCooldown = Math.max(0, actor.jumpCooldown - dt);
  integrate(actor, arena, dt);
  applyJumpPads(actor, arena);
}

const scratchBox = { min: v3(), max: v3() };
const probeBox = { min: v3(), max: v3() };

function collidesAt(arena, pos, hitbox) {
  playerBox(pos, hitbox, probeBox);
  for (const brush of arena.query(probeBox)) {
    if (overlaps(probeBox, brush.box)) return brush;
  }
  return null;
}

/**
 * Move along each axis separately and cancel velocity on whichever axis is
 * blocked. Y runs first so `grounded` is known before horizontal motion, which
 * is what lets the step-up pass work.
 */
function integrate(actor, arena, dt) {
  const { position: pos, velocity: vel, hitbox } = actor;
  const move = actor.moveParams;
  actor.groundedPrev = actor.grounded;
  actor.grounded = false;

  // --- vertical ---
  const dy = vel.y * dt;
  if (dy !== 0) {
    pos.y += dy;
    const hit = collidesAt(arena, pos, hitbox);
    if (hit) {
      if (dy < 0) {
        pos.y = hit.box.max.y;
        actor.grounded = true;
        actor.landingSpeed = -vel.y;
      } else {
        pos.y = hit.box.min.y - hitbox.height;
      }
      vel.y = 0;
    }
  }
  // A short ground probe keeps `grounded` true while walking over seams.
  if (!actor.grounded && vel.y <= 0) {
    const probe = { x: pos.x, y: pos.y - 0.06, z: pos.z };
    if (collidesAt(arena, probe, hitbox)) actor.grounded = true;
  }

  // --- horizontal, with a step-up retry ---
  for (const axis of ['x', 'z']) {
    const delta = vel[axis] * dt;
    if (delta === 0) continue;
    const before = pos[axis];
    pos[axis] += delta;
    if (!collidesAt(arena, pos, hitbox)) continue;

    const stepped = tryStepUp(arena, pos, hitbox, move.stepHeight, actor.grounded || actor.groundedPrev);
    if (!stepped) {
      pos[axis] = before;
      vel[axis] = 0;
    }
  }
}

/** Lift the actor by up to stepHeight to clear a stair riser, then settle. */
function tryStepUp(arena, pos, hitbox, stepHeight, grounded) {
  if (!grounded || stepHeight <= 0) return false;
  const originalY = pos.y;
  pos.y += stepHeight;
  if (collidesAt(arena, pos, hitbox)) {
    pos.y = originalY;
    return false;
  }
  // Settle back down onto whatever we just climbed onto.
  let drop = stepHeight;
  while (drop > 0.02) {
    pos.y -= drop;
    if (collidesAt(arena, pos, hitbox)) {
      pos.y += drop;
      drop *= 0.5;
    } else {
      break;
    }
  }
  return true;
}

function applyJumpPads(actor, arena) {
  playerBox(actor.position, actor.hitbox, scratchBox);
  const pad = arena.jumpPadAt(scratchBox);
  if (!pad) { actor.onPad = false; return; }
  if (actor.onPad) return; // only fire once per entry
  actor.onPad = true;
  actor.grounded = false;
  actor.velocity.x = pad.launch.x;
  actor.velocity.y = pad.launch.y;
  actor.velocity.z = pad.launch.z;
  actor.events.push({ type: 'jumppad', pad: pad.index });
}

/** Knockback from explosions and bullet impacts. */
export function applyImpulse(actor, impulse, scale = 1) {
  actor.velocity.x += impulse.x * scale;
  actor.velocity.y += impulse.y * scale;
  actor.velocity.z += impulse.z * scale;
  if (impulse.y > 0.1) actor.grounded = false;
}

export const horizontalSpeed = (vel) => Math.hypot(vel.x, vel.z);
export { clamp, length };
