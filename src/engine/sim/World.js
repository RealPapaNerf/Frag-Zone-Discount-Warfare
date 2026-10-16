import { v3, set, normalize, distanceSq, clamp } from '../math/vec3.js';
import { EventBus } from '../core/EventBus.js';
import { Rng } from '../core/Rng.js';
import { Arena } from './Arena.js';
import { Actor } from './Actor.js';
import { Match } from './Match.js';
import { ProjectileSystem } from './projectiles.js';
import { moveActor } from './movement.js';
import { fireWeapon, canFire, clampClaimDamage } from './weapons.js';
import { applyDamage } from './damage.js';
import { buildRuleSet } from '../rules/RuleSet.js';
import { NavGraph } from '../ai/NavGraph.js';

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/**
 * The authoritative game state. It owns every actor, runs at a fixed timestep,
 * takes commands in and emits events out — and it imports nothing from the
 * renderer. In milestone 2 the host peer runs exactly this object and ships
 * snapshot()/events to clients; nothing here has to change for that.
 */
export class World {
  constructor({ content, mapId, modeId, mutatorIds = [], seed = 1337 }) {
    this.content = content;
    this.rng = new Rng(seed);
    this.events = new EventBus();

    const mode = content.modes[modeId];
    if (!mode) throw new Error(`unknown mode "${modeId}"`);
    const mutators = mutatorIds.map((id) => {
      const m = content.mutators[id];
      if (!m) throw new Error(`unknown mutator "${id}"`);
      return m;
    });

    this.mode = mode;
    this.mutatorIds = [...mutatorIds];
    this.rules = buildRuleSet(mode, mutators);

    const mapDoc = content.maps[mapId];
    if (!mapDoc) throw new Error(`unknown map "${mapId}"`);
    this.arena = new Arena(mapDoc);
    this.nav = new NavGraph(mapDoc.waypoints, this.arena);

    this.actors = [];
    this.actorMap = new Map();
    this.controllers = new Map(); // actorId -> bot controller
    this.commands = new Map();    // actorId -> latest command

    this.projectiles = new ProjectileSystem(this);
    this.match = new Match(this);

    this.time = 0;
    this.tick = 0;
    this.spawnCursor = 0;
  }

  actorById(id) {
    return this.actorMap.get(id) ?? null;
  }

  addActor({ id, name, isBot = false, team = null, characterId, loadout }) {
    const character = this.content.characters[characterId];
    if (!character) throw new Error(`unknown character "${characterId}"`);

    const chosen = this.rules.forcedLoadout ?? loadout;
    const weapons = chosen.filter((w) => this.content.weapons[w]);
    if (weapons.length === 0) throw new Error(`actor "${id}" has no valid weapons`);

    const actor = new Actor({ id, name, character, loadout: weapons, isBot, team, rules: this.rules });
    this.actors.push(actor);
    this.actorMap.set(id, actor);
    this.respawn(actor, true);
    this.events.emit('actorJoin', { id, name, isBot, team });
    return actor;
  }

  removeActor(id) {
    const index = this.actors.findIndex((a) => a.id === id);
    if (index < 0) return;
    this.actors.splice(index, 1);
    this.actorMap.delete(id);
    this.controllers.delete(id);
    this.commands.delete(id);
    this.events.emit('actorLeave', { id });
  }

  attachController(id, controller) {
    this.controllers.set(id, controller);
  }

  setCommand(id, command) {
    this.commands.set(id, command);
  }

  // --- spawning ------------------------------------------------------------

  /** Pick the spawn furthest from any living enemy, with a little jitter. */
  pickSpawn(actor) {
    const spawns = this.arena.spawns;
    if (spawns.length === 0) return { pos: v3(0, 1, 0), yaw: 0 };

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const spawn = spawns[(i + this.spawnCursor) % spawns.length];
      let score = this.rng.range(0, 12);
      for (const other of this.actors) {
        if (other === actor || !other.alive) continue;
        score += Math.min(distanceSq(spawn.pos, other.position), 900);
      }
      if (score > bestScore) { bestScore = score; best = spawn; }
    }
    this.spawnCursor = (this.spawnCursor + 1) % spawns.length;
    return best;
  }

  respawn(actor, initial = false) {
    const spawn = this.pickSpawn(actor);
    set(actor.position, spawn.pos.x, spawn.pos.y, spawn.pos.z);
    set(actor.prevPosition, spawn.pos.x, spawn.pos.y, spawn.pos.z);
    set(actor.velocity, 0, 0, 0);
    actor.yaw = spawn.yaw;
    actor.pitch = 0;
    actor.alive = true;
    actor.health = this.rules.startHealth;
    actor.armor = actor.character.armor ?? 0;
    actor.grounded = false;
    actor.onPad = false;
    actor.lastAttacker = null;
    actor.weaponIndex = 0;
    actor.spawnProtectUntil = this.time + (initial ? 0 : 0.6);

    for (const weaponId of actor.loadout) {
      const weapon = this.content.weapons[weaponId];
      actor.ammo[weaponId] = weapon.ammo?.start ?? 0;
      actor.nextFireAt[weaponId] = 0;
    }
    this.events.emit('spawn', { id: actor.id, pos: { ...spawn.pos }, yaw: spawn.yaw });
  }

  killActor(actor, meta) {
    if (!actor.alive) return;
    actor.alive = false;
    actor.health = 0;
    actor.respawnAt = this.time + this.rules.respawnDelaySec;

    const entry = this.match.recordKill({
      attacker: meta.attacker,
      victim: actor.id,
      weapon: meta.weapon,
      cause: meta.cause,
      headshot: meta.headshot,
    });
    this.events.emit('kill', { ...entry, pos: { ...actor.position } });
  }

  // --- hit claims ----------------------------------------------------------

  /**
   * Apply hitscan claims produced by a shooter. The host trusts the claim's
   * target and headshot flag (favour the shooter) and only re-derives the
   * damage ceiling from the weapon JSON.
   */
  applyClaims(shooterId, claims) {
    for (const claim of claims) {
      this.events.emit('shot', {
        shooter: shooterId,
        weapon: claim.weaponId,
        origin: claim.origin,
        point: claim.point,
        normal: claim.normal,
        hitActor: claim.target,
        surface: claim.surface,
      });
      if (claim.target == null) continue;

      const victim = this.actorById(claim.target);
      if (!victim || !victim.alive) continue;
      const weapon = this.content.weapons[claim.weaponId];
      if (!weapon) continue;

      const damage = clampClaimDamage(claim, weapon, this.rules);
      const knockback = (weapon.fire.knockback ?? 0) * this.rules.knockbackScale;
      if (knockback) {
        const dir = normalize(v3(), claim.dir);
        victim.velocity.x += dir.x * knockback;
        victim.velocity.y += dir.y * knockback * 0.5;
        victim.velocity.z += dir.z * knockback;
      }
      applyDamage(this, victim, damage, {
        attacker: shooterId,
        weapon: claim.weaponId,
        headshot: claim.headshot,
        point: claim.point,
        cause: 'weapon',
      });
    }
  }

  // --- simulation ----------------------------------------------------------

  step(dt = TICK_DT) {
    this.time += dt;
    this.tick += 1;

    for (const actor of this.actors) {
      actor.prevPosition.x = actor.position.x;
      actor.prevPosition.y = actor.position.y;
      actor.prevPosition.z = actor.position.z;
      actor.events.length = 0;
    }

    // Bots write their commands through the same channel a human would.
    for (const [id, controller] of this.controllers) {
      const actor = this.actorById(id);
      if (!actor) continue;
      this.commands.set(id, controller.think(this, actor, dt));
    }

    for (const actor of this.actors) {
      const command = this.commands.get(actor.id);
      if (!actor.alive) {
        if (this.match.state === 'active' && this.time >= actor.respawnAt) this.respawn(actor);
        continue;
      }
      if (command) this.#applyCommand(actor, command, dt);
      this.#simulateActor(actor, command, dt);
    }

    this.projectiles.step(dt);
    this.#checkKillZ();
    this.match.step(dt);
    return this.events.queue.length;
  }

  #applyCommand(actor, cmd, dt) {
    if (typeof cmd.yaw === 'number') actor.setLook(cmd.yaw, cmd.pitch ?? actor.pitch);
    if (typeof cmd.weaponSlot === 'number') actor.switchWeapon(cmd.weaponSlot);
    if (cmd.switchDelta) actor.cycleWeapon(cmd.switchDelta);

    const weapon = this.content.weapons[actor.weaponId];
    if (!weapon) return;

    const wantsFire = !!cmd.fire;
    const semiBlocked = !weapon.fire.auto && actor.triggerHeld;
    if (wantsFire && !semiBlocked && canFire(actor, weapon, this.time, this.rules)) {
      const aim = cmd.aimDir ?? null;
      const { claims, spawns } = fireWeapon(
        { arena: this.arena, actors: this.actors, rules: this.rules, rng: this.rng, time: this.time },
        actor, weapon, aim,
      );
      this.applyClaims(actor.id, claims);
      for (const spawn of spawns) this.projectiles.spawn(spawn);
      this.events.emit('fire', { shooter: actor.id, weapon: weapon.id });
    }
    actor.triggerHeld = wantsFire;
  }

  #simulateActor(actor, cmd, dt) {
    const wishDir = v3();
    if (cmd) {
      const forward = clamp(cmd.forward ?? 0, -1, 1);
      const strafe = clamp(cmd.strafe ?? 0, -1, 1);
      if (forward !== 0 || strafe !== 0) {
        // Yaw 0 looks down -Z; right is +X rotated by yaw.
        const sin = Math.sin(actor.yaw);
        const cos = Math.cos(actor.yaw);
        wishDir.x = -sin * forward + cos * strafe;
        wishDir.z = -cos * forward - sin * strafe;
        normalize(wishDir, wishDir);
      }
    }
    const intent = {
      wishDir,
      jump: !!cmd?.jump,
      crouch: !!cmd?.crouch,
    };
    moveActor(actor, this.arena, intent, dt, this.rules);

    for (const e of actor.events) {
      this.events.emit(e.type === 'jump' ? 'jump' : e.type, { id: actor.id, ...e });
    }
  }

  #checkKillZ() {
    for (const actor of this.actors) {
      if (!actor.alive) continue;
      if (actor.position.y < this.arena.killZ) {
        applyDamage(this, actor, 9999, {
          attacker: actor.lastAttacker ?? actor.id,
          weapon: null,
          cause: 'fall',
        });
      }
    }
  }

  // --- output --------------------------------------------------------------

  /** Everything a presentation layer (or a remote peer) needs for one frame. */
  snapshot() {
    return {
      tick: this.tick,
      time: this.time,
      actors: this.actors.map((a) => a.toSnapshot()),
      projectiles: this.projectiles.snapshot(),
      match: this.match.snapshot(),
    };
  }
}
