import { v3, set, normalize, distanceSq, clamp } from '../math/vec3.js';
import { EventBus } from '../core/EventBus.js';
import { Rng } from '../core/Rng.js';
import { Arena } from './Arena.js';
import { Actor } from './Actor.js';
import { Match } from './Match.js';
import { ProjectileSystem } from './projectiles.js';
import { moveActor } from './movement.js';
import {
  fireWeapon, canFire, clampClaimDamage, isReloading, magazineSize, resetAmmo,
  reloadStepSec, reloadStyle, startReload, stepReload, RELOAD_SINGLE,
  burstSpec, burstCount, burstIntervalSec, burstCooldownSec,
  chargeSpec, chargeLevel, hasRoundsFor,
} from './weapons.js';
import { applyDamage } from './damage.js';
import { buildRuleSet } from '../rules/RuleSet.js';
import { PatchNotes } from '../rules/PatchNotes.js';
import { WeaponOverlay } from '../rules/WeaponOverlay.js';
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

    // Weapons are read through here, never straight off `content`, so a patch
    // note can change one for this match without following you into the next.
    this.weapons = new WeaponOverlay(content.weapons);

    this.projectiles = new ProjectileSystem(this);
    this.match = new Match(this);

    // Patch Notes Mode. A mode opts in by naming a pool and an interval; any
    // other mode leaves this null and nothing below it ever runs.
    const notesSpec = mode.patchNotes ?? null;
    this.patchNotes = notesSpec
      ? new PatchNotes(
        (notesSpec.pool ?? Object.keys(content.notes ?? {}))
          .map((id) => content.notes?.[id])
          .filter(Boolean),
        this.rng, notesSpec,
      )
      : null;

    this.time = 0;
    this.tick = 0;
    this.spawnCursor = 0;
  }

  actorById(id) {
    return this.actorMap.get(id) ?? null;
  }

  /** The live document for a weapon, patch notes included. */
  weaponById(id) {
    return this.weapons.get(id);
  }

  addActor({ id, name, isBot = false, team = null, characterId, loadout }) {
    const character = this.content.characters[characterId];
    if (!character) throw new Error(`unknown character "${characterId}"`);

    const chosen = this.rules.forcedLoadout ?? loadout;
    const weapons = chosen.filter((w) => this.weaponById(w));
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

    resetAmmo(actor, actor.loadout.map((id) => this.weaponById(id)));
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
        // The renderer draws a beam as a beam and a swing as nothing at all.
        kind: claim.kind ?? 'hitscan',
        origin: claim.origin,
        point: claim.point,
        normal: claim.normal,
        hitActor: claim.target,
        surface: claim.surface,
      });
      if (claim.target == null) continue;

      const victim = this.actorById(claim.target);
      if (!victim || !victim.alive) continue;
      const weapon = this.weaponById(claim.weaponId);
      if (!weapon) continue;

      // "Only headshots count" is a host-side scale rather than something the
      // shooter computes, so a note that lands mid-flight still applies.
      //
      // It only touches weapons that have a head to shoot at. A wrench cannot
      // land a headshot, so scaling its body damage to zero would not make the
      // rule stricter, it would delete the weapon — and "only melee" stacked
      // with "only headshots" would leave nobody able to damage anybody.
      const canHeadshot = claim.kind !== 'melee' && (weapon.fire.headshotMultiplier ?? 1) > 1;
      const bodyScale = claim.headshot || !canHeadshot ? 1 : this.rules.bodyDamageScale;
      const damage = clampClaimDamage(claim, weapon, this.rules) * bodyScale;
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
        backstab: !!claim.backstab,
        point: claim.point,
        cause: claim.kind === 'melee' ? 'melee' : 'weapon',
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
      this.#stepReload(actor);
      if (command) this.#applyCommand(actor, command, dt);
      // Outside the command check: a burst finishes whether you keep sending
      // input or not, which is the whole point of a burst.
      this.#stepBurst(actor);
      this.#simulateActor(actor, command, dt);
    }

    this.projectiles.step(dt);
    this.#checkKillZ();
    this.#stepPatchNotes();
    this.match.step(dt);
    return this.events.queue.length;
  }

  #applyCommand(actor, cmd, dt) {
    if (typeof cmd.yaw === 'number') actor.setLook(cmd.yaw, cmd.pitch ?? actor.pitch);
    if (this.rules.canSwapWeapon) {
      if (typeof cmd.weaponSlot === 'number') actor.switchWeapon(cmd.weaponSlot);
      if (cmd.switchDelta) actor.cycleWeapon(cmd.switchDelta);
    }

    const weapon = this.weaponById(actor.weaponId);
    if (!weapon) return;

    const wantsFire = !!cmd.fire;

    // A shell-by-shell reload is abandoned the instant you pull the trigger,
    // so you fire whatever is already in the tube rather than standing there
    // finishing the job. Topping up between fights is the point of it.
    if (wantsFire && isReloading(actor, weapon) && reloadStyle(weapon) === RELOAD_SINGLE
      && (actor.mag[weapon.id] ?? 0) >= (weapon.ammo?.perShot ?? 1)) {
      actor.reload = null;
    }
    if (cmd.reload) this.#tryReload(actor, weapon);

    const semiBlocked = !weapon.fire.auto && actor.triggerHeld;
    const aim = cmd.aimDir ?? null;

    if (chargeSpec(weapon)) {
      // Charging passes `wantsFire` raw: holding the trigger is the mechanic,
      // so the semi-automatic gate applies only to *starting* a wind-up.
      this.#stepCharge(actor, weapon, wantsFire, semiBlocked, aim);
    } else if (burstSpec(weapon)) {
      // A fresh pull starts a burst; the payout is #stepBurst's job.
      if (wantsFire && !semiBlocked && !actor.burst
        && canFire(actor, weapon, this.time, this.rules)) {
        this.#fireOnce(actor, weapon, aim);
        const remaining = burstCount(weapon) - 1;
        if (remaining > 0) {
          actor.burst = {
            weaponId: weapon.id,
            remaining,
            nextAt: this.time + burstIntervalSec(weapon),
          };
        } else {
          actor.nextFireAt[weapon.id] = this.time + burstCooldownSec(weapon);
        }
      }
    } else if (wantsFire && !semiBlocked && canFire(actor, weapon, this.time, this.rules)) {
      this.#fireOnce(actor, weapon, aim);
    }

    actor.triggerHeld = wantsFire;
  }

  /**
   * One shot: resolve it, apply what it hit, and reload if that was the last
   * round. Every fire mode funnels through here so none of them can forget a
   * step.
   */
  #fireOnce(actor, weapon, aimDir = null, charge = 0) {
    const { claims, spawns } = fireWeapon(
      { arena: this.arena, actors: this.actors, rules: this.rules, rng: this.rng, time: this.time },
      actor, weapon, aimDir, { charge },
    );
    this.applyClaims(actor.id, claims);
    for (const spawn of spawns) this.projectiles.spawn(spawn);
    this.events.emit('fire', { shooter: actor.id, weapon: weapon.id, charge });

    // Firing dry starts the reload for you. Nobody enjoys discovering the
    // magazine was empty by pressing the trigger and hearing nothing.
    // The test is the magazine, not canFire: canFire is false for the whole
    // rate-limit interval after every shot, which would reload constantly.
    if ((weapon.ammo?.autoReload ?? true)
      && (actor.mag[weapon.id] ?? 0) < (weapon.ammo?.perShot ?? 1)) {
      this.#tryReload(actor, weapon);
    }
  }

  /**
   * Hold to charge, release to shoot. A release below `minSec` throws the
   * charge away without firing, which is what teaches you to hold it.
   */
  #stepCharge(actor, weapon, holding, semiBlocked, aimDir) {
    const spec = chargeSpec(weapon);

    if (holding) {
      if (actor.chargeSince == null) {
        // A semi-automatic charge weapon wants the trigger let go before it
        // will wind up again — otherwise one long hold would fire forever.
        if (semiBlocked) return;
        // Only start charging if the shot would be allowed to happen at all.
        if (!canFire(actor, weapon, this.time, this.rules)) return;
        actor.chargeSince = this.time;
        this.events.emit('chargeStart', { id: actor.id, weapon: weapon.id });
      }
      actor.charge = chargeLevel(weapon, this.time - actor.chargeSince);
      // An overcharging weapon lets go by itself rather than holding forever.
      if (spec.releaseAtFull && actor.charge >= 1) {
        this.#releaseCharge(actor, weapon, aimDir);
      }
      return;
    }

    if (actor.chargeSince == null) return;
    const held = this.time - actor.chargeSince;
    if (held >= (spec.minSec ?? 0)) this.#releaseCharge(actor, weapon, aimDir);
    else this.#abortCharge(actor, weapon);
  }

  #releaseCharge(actor, weapon, aimDir) {
    const charge = chargeLevel(weapon, this.time - actor.chargeSince);
    actor.chargeSince = null;
    actor.charge = 0;
    if (!canFire(actor, weapon, this.time, this.rules)) return;
    this.#fireOnce(actor, weapon, aimDir, charge);
  }

  #abortCharge(actor, weapon) {
    actor.chargeSince = null;
    actor.charge = 0;
    this.events.emit('chargeAbort', { id: actor.id, weapon: weapon.id });
  }

  /**
   * Pay out the rest of a burst. It deliberately ignores the rate limiter —
   * a burst fires faster than the weapon's own rpm — and reinstates it as a
   * cooldown once the last round is away.
   */
  #stepBurst(actor) {
    const burst = actor.burst;
    if (!burst) return;
    const weapon = this.weaponById(burst.weaponId);
    if (!weapon || !actor.alive || weapon.id !== actor.weaponId) {
      actor.burst = null;
      return;
    }

    while (actor.burst && this.time >= actor.burst.nextAt) {
      if (!hasRoundsFor(actor, weapon, this.rules)) {
        // Out of rounds mid-burst: stop, and let the auto-reload pick it up.
        actor.burst = null;
        this.#tryReload(actor, weapon);
        break;
      }
      this.#fireOnce(actor, weapon, null);
      actor.burst.remaining -= 1;
      if (actor.burst.remaining <= 0) {
        actor.nextFireAt[weapon.id] = this.time + burstCooldownSec(weapon);
        actor.burst = null;
      } else {
        actor.burst.nextAt = this.time + burstIntervalSec(weapon);
      }
    }
  }

  #tryReload(actor, weapon) {
    if (!this.rules.canReload) return false;
    if (!startReload(actor, weapon, this.time, this.rules)) return false;
    this.events.emit('reloadStart', {
      id: actor.id,
      weapon: weapon.id,
      style: reloadStyle(weapon),
      duration: reloadStepSec(weapon),
    });
    return true;
  }

  #stepReload(actor) {
    const pending = actor.reload;
    if (!pending) return;
    const weapon = this.weaponById(pending.weaponId);
    // The weapon went away underneath the reload — a forced loadout, say.
    if (!weapon) { actor.reload = null; return; }

    const loaded = stepReload(actor, weapon, this.time);
    if (loaded <= 0) return;
    this.events.emit('reloadEnd', {
      id: actor.id,
      weapon: weapon.id,
      loaded,
      mag: actor.mag[weapon.id] ?? 0,
      // `done` is false while a single-round reload keeps feeding.
      done: !isReloading(actor, weapon),
      full: (actor.mag[weapon.id] ?? 0) >= magazineSize(weapon),
    });
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
    // Aiming is held state rather than an event: the weapon reads it when it
    // fires, and movement reads it every tick.
    actor.aiming = !!cmd?.aim;
    const intent = {
      wishDir,
      jump: !!cmd?.jump,
      crouch: !!cmd?.crouch,
      aim: actor.aiming,
    };
    moveActor(actor, this.arena, intent, dt, this.rules);

    for (const e of actor.events) {
      this.events.emit(e.type === 'jump' ? 'jump' : e.type, { id: actor.id, ...e });
    }
  }

  // --- patch notes ---------------------------------------------------------

  #stepPatchNotes() {
    if (!this.patchNotes || this.match.state !== 'active') return;
    const note = this.patchNotes.due(this.time);
    if (note) this.applyPatchNote(note);
  }

  /**
   * Apply one note to the live match: patch the rules, re-derive what the
   * rules bake in, and announce it.
   *
   * Public because the scheduler is not the only thing that should be able to
   * land a note — a test, a debug command or a future "force next note"
   * button all need the same three steps, and doing them by hand is how one
   * of them gets forgotten.
   */
  applyPatchNote(note) {
    PatchNotes.apply(this.rules, note);
    if (note.weaponPatches?.length) {
      this.weapons.apply(note.weaponPatches, `note "${note.id}"`);
      this.#onWeaponsChanged();
    }
    // Record before announcing: the index in the message is "which patch is
    // this", and a forced note has to join the list the HUD and any connected
    // client read from.
    this.patchNotes?.record(note);
    this.#onRulesChanged();
    this.events.emit('patchNote', {
      id: note.id,
      headline: note.headline ?? note.name,
      description: note.description ?? '',
      tier: note.tier ?? 1,
      index: this.patchNotes?.applied.length ?? 1,
      remaining: this.patchNotes?.remaining ?? 0,
    });
    return note;
  }

  /**
   * Re-derive the rules that are read once rather than every tick.
   *
   * Most of the rule bag is consulted live — gravity, damage, the verbs — so
   * patching it mid-match is enough on its own. These three are not: hitbox
   * scale is baked into the actor when it is built, health is read on
   * respawn, and a forced loadout is read when an actor joins. Without this
   * pass, a note that changed any of them would appear to do nothing until
   * somebody died.
   */
  #onRulesChanged() {
    for (const actor of this.actors) {
      actor.applyRules(this.rules);
      if (actor.health > this.rules.maxHealth) actor.health = this.rules.maxHealth;
      const forced = this.rules.forcedLoadout;
      if (forced && forced.join() !== actor.loadout.join()) this.#setLoadout(actor, forced);
    }
  }

  /** Swap an actor onto a different set of weapons, mid-match, safely. */
  /**
   * A patched weapon may hold less than it did a moment ago. Nobody's
   * magazine should contain rounds the weapon can no longer fit, and a reload
   * aimed at the old magazine size would load into a gun that changed shape
   * underneath it.
   */
  #onWeaponsChanged() {
    for (const actor of this.actors) {
      for (const id of actor.loadout) {
        const weapon = this.weaponById(id);
        const size = weapon?.ammo?.magazine ?? 0;
        if (size > 0 && (actor.mag[id] ?? 0) > size) actor.mag[id] = size;
      }
      if (actor.reload && !this.weaponById(actor.reload.weaponId)) actor.reload = null;
      actor.burst = null;
      actor.chargeSince = null;
      actor.charge = 0;
    }
  }

  #setLoadout(actor, weaponIds) {
    const weapons = weaponIds.filter((id) => this.weaponById(id));
    if (weapons.length === 0) return;
    actor.loadout = [...weapons];
    actor.weaponIndex = 0;
    // Anything the old weapon had in flight belongs to a gun they no longer
    // hold.
    actor.reload = null;
    actor.burst = null;
    actor.chargeSince = null;
    actor.charge = 0;
    resetAmmo(actor, weapons.map((id) => this.weaponById(id)));
    actor.events.push({ type: 'weaponSwitch', weapon: actor.weaponId });
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
      patchNotes: this.patchNotes?.snapshot() ?? null,
    };
  }
}
