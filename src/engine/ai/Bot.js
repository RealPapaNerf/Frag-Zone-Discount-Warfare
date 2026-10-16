import { v3, set, sub, normalize, cross, dot, length, distance, anglesFromDir, clamp } from '../math/vec3.js';

const DEG = Math.PI / 180;

/**
 * A bot is a command source, nothing more. It produces the same command object
 * a keyboard produces, so the simulation cannot tell the difference — which is
 * also what lets the host run bots for a networked match later.
 *
 * Beatability comes from three deliberate handicaps, all read from the profile
 * JSON: a reaction delay before a freshly spotted target may be shot at, an
 * aim error cone that drifts rather than snapping, and a finite turn rate.
 */
export class Bot {
  constructor({ profile, rng, name }) {
    this.profile = profile;
    this.rng = rng;
    this.name = name;

    this.aimDir = v3(0, 0, -1);
    this.desiredDir = v3(0, 0, -1);
    this.aimSynced = false;
    this.targetId = null;
    this.targetFirstSeenAt = 0;
    this.targetLastSeenAt = -Infinity;
    this.lastKnownPos = null;
    this.reactionReadyAt = Infinity;
    this.aimErrorDeg = 0;
    this.errorAngle = rng.next() * Math.PI * 2;
    this.driftPhase = rng.next() * Math.PI * 2;

    this.path = null;
    this.pathIndex = 0;
    this.repathAt = 0;
    this.goalNodeId = null;

    this.triggerDown = false;
    this.strafeSign = rng.chance(0.5) ? 1 : -1;
    this.strafeUntil = 0;
    this.nextPerceptionAt = 0;
    this.stuckTimer = 0;
    this.lastPos = v3();
  }

  think(world, self, dt) {
    if (!self.alive) {
      this.targetId = null;
      this.path = null;
      this.aimSynced = false; // re-sync to wherever we respawn facing
      return { forward: 0, strafe: 0, jump: false, fire: false, yaw: self.yaw, pitch: self.pitch };
    }

    if (!this.aimSynced) {
      self.viewDir(this.aimDir);
      this.desiredDir = { ...this.aimDir };
      this.aimSynced = true;
    }

    const now = world.time;
    if (now >= this.nextPerceptionAt) {
      this.nextPerceptionAt = now + this.profile.perceptionIntervalSec;
      this.#perceive(world, self);
    }

    const target = this.targetId != null ? world.actorById(this.targetId) : null;
    const engaged = target && target.alive && (now - this.targetLastSeenAt) < this.profile.forgetTargetSec;
    if (!engaged) this.targetId = null;

    const weaponSlot = this.#chooseWeapon(world, self, engaged ? target : null);
    const desiredAim = this.#desiredAim(world, self, engaged ? target : null);
    this.desiredDir = desiredAim;
    this.#steerAim(desiredAim, dt);

    const { yaw, pitch } = anglesFromDir(this.aimDir);
    const movement = this.#move(world, self, engaged ? target : null, yaw, dt, now);
    const wantsFire = this.#shouldFire(world, self, engaged ? target : null, now);
    // A semi-automatic weapon needs the trigger released between shots, so the
    // bot pulses it the way a player taps the mouse.
    const weapon = world.content.weapons[self.loadout[weaponSlot]];
    const fire = weapon?.fire.auto === false
      ? wantsFire && !this.triggerDown
      : wantsFire;
    this.triggerDown = fire;

    return {
      forward: movement.forward,
      strafe: movement.strafe,
      jump: movement.jump,
      crouch: false,
      yaw,
      pitch,
      fire,
      weaponSlot,
    };
  }

  // --- perception ----------------------------------------------------------

  #perceive(world, self) {
    const profile = this.profile;
    const eye = self.eye(v3());
    const forward = self.viewDir(v3());
    const halfFov = Math.cos((profile.fovDeg * 0.5) * DEG);

    let best = null;
    let bestScore = Infinity;

    for (const other of world.actors) {
      if (other === self || !other.alive) continue;
      if (world.rules.teams && other.team === self.team) continue;

      const center = other.center(v3());
      const toTarget = sub(v3(), center, eye);
      const dist = length(toTarget);
      if (dist > profile.viewRange) continue;
      normalize(toTarget, toTarget);
      if (dot(toTarget, forward) < halfFov) continue;
      if (!world.arena.lineOfSight(eye, center)) continue;

      // Prefer whoever is closest, but stay sticky on the current target.
      const score = dist * (other.id === this.targetId ? 0.6 : 1);
      if (score < bestScore) { bestScore = score; best = other; }
    }

    if (best) {
      if (best.id !== this.targetId) {
        this.targetId = best.id;
        this.targetFirstSeenAt = world.time;
        this.reactionReadyAt = world.time + this.rng.range(profile.reactionTimeSec);
        this.aimErrorDeg = this.rng.range(profile.aimErrorDeg);
        this.errorAngle = this.rng.next() * Math.PI * 2;
      }
      this.targetLastSeenAt = world.time;
      this.lastKnownPos = best.center(v3());
    }
  }

  // --- aiming --------------------------------------------------------------

  #desiredAim(world, self, target) {
    const eye = self.eye(v3());
    if (!target) {
      // No target: look where we are going, with a slight downward bias.
      const node = this.path?.[this.pathIndex];
      if (node) {
        const dir = normalize(v3(), sub(v3(), node.pos, eye));
        dir.y *= 0.4;
        return normalize(dir, dir);
      }
      return self.viewDir(v3());
    }

    const weapon = world.content.weapons[self.weaponId];
    const aimPoint = target.center(v3());

    if (weapon?.fire.type === 'projectile') {
      // Lead the target, scaled by skill so weak bots consistently miss behind.
      const travel = distance(eye, aimPoint) / (weapon.projectile.speed || 40);
      const lead = this.profile.rocketLeadSkill;
      aimPoint.x += target.velocity.x * travel * lead;
      aimPoint.y += target.velocity.y * travel * lead * 0.5;
      aimPoint.z += target.velocity.z * travel * lead;
      // Aim at the feet of a grounded target so splash still connects.
      if (target.grounded) aimPoint.y = target.position.y + 0.25;
    }

    const dir = normalize(v3(), sub(v3(), aimPoint, eye));
    return this.#applyAimError(dir);
  }

  /**
   * Offset the aim by a persistent error that slowly rotates around the target
   * rather than oscillating through it. If the offset passed through dead
   * centre every cycle, even a very wide cone would land plenty of shots on a
   * standing target and the difficulty profiles would all play the same.
   */
  #applyAimError(dir) {
    if (this.aimErrorDeg <= 0) return dir;
    const up = Math.abs(dir.y) > 0.99 ? v3(0, 0, 1) : v3(0, 1, 0);
    const right = normalize(v3(), cross(v3(), dir, up));
    const trueUp = cross(v3(), right, dir);
    const spread = Math.tan(this.aimErrorDeg * DEG);
    // Magnitude breathes between 60% and 100% of the cone; it never collapses.
    const wobble = 0.8 + 0.2 * Math.sin(this.driftPhase * 1.7);
    const angle = this.errorAngle + this.driftPhase * 0.45;
    const ox = Math.cos(angle) * spread * wobble;
    const oy = Math.sin(angle) * spread * wobble;
    return normalize(v3(), {
      x: dir.x + right.x * ox + trueUp.x * oy,
      y: dir.y + right.y * ox + trueUp.y * oy,
      z: dir.z + right.z * ox + trueUp.z * oy,
    });
  }

  #steerAim(desired, dt) {
    this.driftPhase += dt * this.profile.aimDriftHz * Math.PI * 2;
    const rate = clamp(this.profile.aimTrackSpeed * dt, 0, 1);
    this.aimDir.x += (desired.x - this.aimDir.x) * rate;
    this.aimDir.y += (desired.y - this.aimDir.y) * rate;
    this.aimDir.z += (desired.z - this.aimDir.z) * rate;
    normalize(this.aimDir, this.aimDir);
  }

  // --- weapon choice -------------------------------------------------------

  #chooseWeapon(world, self, target) {
    let bestSlot = self.weaponIndex;
    let bestScore = -Infinity;
    const dist = target ? distance(self.position, target.position) : 20;

    for (let i = 0; i < self.loadout.length; i++) {
      const weapon = world.content.weapons[self.loadout[i]];
      if (!weapon) continue;
      const ammo = self.ammo[weapon.id] ?? 0;
      if (!world.rules.infiniteAmmo && ammo <= 0) continue;

      // Rockets own the mid range: suicidal in your face, and too slow to
      // lead at long range, where the hitscan rifle is simply better.
      const ROCKET_BAND = 38;
      let score;
      if (weapon.splash) {
        if (dist < this.profile.rocketMinRange) score = -1;
        else score = dist < ROCKET_BAND ? 2.3 : 1.1;
      } else {
        score = 2.0;
      }
      if (score > bestScore) { bestScore = score; bestSlot = i; }
    }
    return bestSlot;
  }

  // --- movement ------------------------------------------------------------

  #move(world, self, target, yaw, dt, now) {
    let wish = v3();
    let jump = false;

    if (target) {
      wish = this.#combatMove(world, self, target, now);
    } else {
      wish = this.#patrolMove(world, self, now);
    }

    // Unstick: if we have barely moved while wanting to, hop and re-path.
    const moved = distance(self.position, this.lastPos);
    set(this.lastPos, self.position.x, self.position.y, self.position.z);
    if (length(wish) > 0.1 && moved < 0.02 * 60 * dt) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.5) {
        jump = true;
        this.repathAt = 0;
        this.stuckTimer = 0;
        this.strafeSign *= -1;
      }
    } else {
      this.stuckTimer = 0;
    }

    if (self.grounded && this.rng.chance(this.profile.jumpChance * dt)) jump = true;

    // Project the world-space wish direction into the command's local axes.
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const forward = wish.x * -sin + wish.z * -cos;
    const strafe = wish.x * cos + wish.z * -sin;
    return { forward: clamp(forward, -1, 1), strafe: clamp(strafe, -1, 1), jump };
  }

  #combatMove(world, self, target, now) {
    const [minRange, maxRange] = this.profile.preferredRange;
    const toTarget = sub(v3(), target.position, self.position);
    toTarget.y = 0;
    const dist = length(toTarget);
    normalize(toTarget, toTarget);

    const wish = v3();
    if (dist < minRange) {
      wish.x -= toTarget.x; wish.z -= toTarget.z;
    } else if (dist > maxRange) {
      wish.x += toTarget.x; wish.z += toTarget.z;
    }

    if (now >= this.strafeUntil) {
      this.strafeUntil = now + this.rng.range(this.profile.strafeSwitchSec);
      if (this.rng.chance(0.5)) this.strafeSign *= -1;
    }
    if (this.rng.chance(this.profile.strafeChance)) {
      // Perpendicular on the horizontal plane.
      wish.x += -toTarget.z * this.strafeSign;
      wish.z += toTarget.x * this.strafeSign;
    }
    return length(wish) > 1e-3 ? normalize(wish, wish) : wish;
  }

  #patrolMove(world, self, now) {
    if (!this.path || this.pathIndex >= this.path.length || now >= this.repathAt) {
      this.#repath(world, self, now);
    }
    const node = this.path?.[this.pathIndex];
    if (!node) return v3();

    const flat = sub(v3(), node.pos, self.position);
    const vertical = flat.y;
    flat.y = 0;
    if (length(flat) < 1.6 && Math.abs(vertical) < 2.2) {
      this.pathIndex += 1;
      if (this.pathIndex >= this.path.length) this.path = null;
      return this.#patrolMove(world, self, now);
    }
    return normalize(flat, flat);
  }

  #repath(world, self, now) {
    this.repathAt = now + this.profile.repathSec;
    const nav = world.nav;
    if (nav.size === 0) { this.path = null; return; }

    const from = nav.nearest(self.position);
    // Head for the last place we saw someone, otherwise wander.
    const goalPos = this.lastKnownPos && (now - this.targetLastSeenAt) < 8 ? this.lastKnownPos : null;
    const goal = goalPos ? nav.nearest(goalPos) : nav.randomNode(this.rng);
    if (!from || !goal) { this.path = null; return; }

    const path = nav.findPath(from.id, goal.id);
    this.path = path && path.length > 1 ? path : (from === goal ? null : [goal]);
    this.pathIndex = this.path && this.path[0] === from ? 1 : 0;
  }

  // --- shooting ------------------------------------------------------------

  #shouldFire(world, self, target, now) {
    if (!target) return false;
    if (now < this.reactionReadyAt) return false;

    const weapon = world.content.weapons[self.weaponId];
    if (!weapon) return false;

    const eye = self.eye(v3());
    const center = target.center(v3());
    const dist = distance(eye, center);

    // Do not rocket your own feet when the enemy is in your face.
    if (weapon.splash && dist < this.profile.rocketMinRange) return false;
    if (!world.arena.lineOfSight(eye, center)) return false;

    // Gate on how close the aim has settled to where the bot *means* to point,
    // not to the target itself. The aim error is the handicap; if firing also
    // required true accuracy the two would cancel out and the bot would either
    // never shoot or never miss.
    const cone = Math.cos(this.profile.fireConeDeg * DEG);
    if (dot(this.aimDir, this.desiredDir) < cone) return false;

    // Still refuse shots that are nowhere near the target at all, so a bot
    // mid-turn does not spray across the room.
    const toTarget = normalize(v3(), sub(v3(), center, eye));
    if (dot(this.aimDir, toTarget) < Math.cos(35 * DEG)) return false;

    // Never fire into a wall that is closer than the target.
    const blocked = world.arena.raycast(eye, this.aimDir, dist - 0.5);
    if (blocked) return false;

    return true;
  }
}
