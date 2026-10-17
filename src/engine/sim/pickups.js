import { v3, clone, set } from '../math/vec3.js';

/**
 * Things lying on the floor that you collect by walking over them.
 *
 * Dropping and picking up are the same system seen from two ends: a dropped
 * weapon keeps the ammunition it had when it left your hands, so losing your
 * rifle and getting it back is a round trip rather than a reset. That is what
 * makes a wet floor sign a real setback and a scramble worth having.
 *
 * Collection is on touch rather than on a key. A pile of your own equipment
 * at your feet that you had to press a button four times to recover would be
 * tedious, and every arena shooter worth copying does it this way.
 */

const MAX_PICKUPS = 64;
const COLLECT_RADIUS = 1.15;
const COLLECT_HEIGHT = 2.2;

export class PickupSystem {
  constructor(world) {
    this.world = world;
    this.items = [];
    this.nextId = 1;
  }

  byId(id) {
    return this.items.find((p) => p.id === id) ?? null;
  }

  /**
   * Put an item on the floor.
   *
   * Two clocks, not one. `liveAfterSec` is the moment anybody can take it —
   * short, just long enough for it to land. `ownerDelaySec` is how much
   * longer the person who dropped it has to wait, and it is the one that
   * matters: without it a player who drops everything and stands still picks
   * it all straight back up, because the scatter is smaller than the radius
   * you collect from. Everyone else gets first refusal on your rifle.
   */
  spawn({
    kind, pos, weaponId = null, mag = 0, reserve = 0, amount = 0,
    owner = null, liveAfterSec = 0, ownerDelaySec = 0, lifetimeSec = 30, velocity = null,
  }) {
    if (this.items.length >= MAX_PICKUPS) return null;
    const now = this.world.time;
    const item = {
      id: this.nextId++,
      kind,
      weaponId,
      mag,
      reserve,
      amount,
      owner,
      pos: clone(pos),
      vel: velocity ? clone(velocity) : v3(),
      liveAt: now + liveAfterSec,
      ownerLiveAt: now + liveAfterSec + ownerDelaySec,
      dieAt: now + lifetimeSec,
      resting: false,
    };
    this.items.push(item);
    this.world.events.emit('pickupSpawned', {
      id: item.id, kind, weaponId, pos: clone(pos), owner,
    });
    return item;
  }

  /**
   * Everything they are carrying, onto the floor around them.
   *
   * Their magazines and pouches go with the weapons rather than being
   * forgotten, and are cleared from the actor so picking one back up is a
   * recovery and not a duplication.
   *
   * @returns {object[]} the items created
   */
  dropLoadout(actor, { liveAfterSec = 0.4, ownerDelaySec = 3, lifetimeSec = 45 } = {}) {
    const dropped = [];
    const rng = this.world.rng;

    for (const weaponId of [...actor.loadout]) {
      const weapon = this.world.weaponById(weaponId);
      if (!weapon) continue;
      // Scattered so a full loadout does not land in one stack you collect
      // with a single step.
      const angle = rng.range(0, Math.PI * 2);
      // Further than the collect radius, so each one is a separate walk.
      const dist = rng.range(1.6, 3.0);
      const item = this.spawn({
        kind: 'weapon',
        weaponId,
        mag: actor.mag[weaponId] ?? 0,
        reserve: actor.ammo[weaponId] ?? 0,
        owner: actor.id,
        liveAfterSec,
        ownerDelaySec,
        lifetimeSec,
        pos: v3(
          actor.position.x + Math.cos(angle) * dist,
          actor.position.y + 0.3,
          actor.position.z + Math.sin(angle) * dist,
        ),
      });
      if (item) dropped.push(item);
      delete actor.mag[weaponId];
      delete actor.ammo[weaponId];
    }

    actor.loadout = [];
    actor.weaponIndex = 0;
    actor.reload = null;
    actor.burst = null;
    actor.chargeSince = null;
    actor.charge = 0;
    actor.autoFireAt = 0;

    if (dropped.length) {
      this.world.events.emit('loadoutDropped', {
        id: actor.id, items: dropped.map((d) => d.id), count: dropped.length,
      });
    }
    return dropped;
  }

  step(dt) {
    const world = this.world;
    const survivors = [];

    for (const item of this.items) {
      if (world.time >= item.dieAt) {
        world.events.emit('pickupRemoved', { id: item.id, kind: item.kind, reason: 'expired' });
        continue;
      }
      if (!item.resting) this.#settle(item, dt);

      const taker = world.time >= item.liveAt ? this.#whoWants(item) : null;
      if (taker) {
        this.#collect(item, taker);
        continue;
      }
      survivors.push(item);
    }
    this.items = survivors;
  }

  /** Drop to the floor and stay there. Nothing here needs real physics. */
  #settle(item, dt) {
    const arena = this.world.arena;
    item.vel.y += arena.gravity * dt;
    const next = item.pos.y + item.vel.y * dt;
    const floor = arena.raycast(
      v3(item.pos.x, item.pos.y + 0.1, item.pos.z), v3(0, -1, 0), 6,
    );
    const rest = floor ? floor.point.y + 0.12 : null;

    if (rest !== null && next <= rest) {
      set(item.pos, item.pos.x, rest, item.pos.z);
      set(item.vel, 0, 0, 0);
      item.resting = true;
      return;
    }
    item.pos.y = next;
    if (item.pos.y < arena.killZ) item.dieAt = 0;
  }

  #whoWants(item) {
    for (const actor of this.world.actors) {
      if (!actor.alive) continue;
      // The person who dropped it waits longer than everyone else.
      if (actor.id === item.owner && this.world.time < item.ownerLiveAt) continue;
      const dy = actor.position.y - item.pos.y;
      if (dy > COLLECT_HEIGHT || dy < -COLLECT_HEIGHT) continue;
      const dx = actor.position.x - item.pos.x;
      const dz = actor.position.z - item.pos.z;
      if (dx * dx + dz * dz > COLLECT_RADIUS * COLLECT_RADIUS) continue;
      if (this.#wouldTake(item, actor)) return actor;
    }
    return null;
  }

  /** Whether this actor has any use for it. Walking over a full health pack
   *  on full health should leave it there for somebody who needs it. */
  #wouldTake(item, actor) {
    if (item.kind === 'health') return actor.health < actor.maxHealth;
    if (item.kind === 'ammo') {
      const id = item.weaponId ?? actor.weaponId;
      if (!id || !actor.loadout.includes(id)) return false;
      const weapon = this.world.weaponById(id);
      const carried = (actor.ammo[id] ?? 0) + (actor.mag[id] ?? 0);
      return carried < (weapon?.ammo?.max ?? Infinity);
    }
    if (item.kind === 'weapon') return true;
    return false;
  }

  #collect(item, actor) {
    const world = this.world;
    if (item.kind === 'health') {
      const healed = Math.min(actor.maxHealth - actor.health, item.amount);
      actor.health += healed;
      world.events.emit('pickupTaken', {
        id: item.id, kind: item.kind, by: actor.id, amount: healed,
      });
    } else if (item.kind === 'ammo') {
      const id = item.weaponId ?? actor.weaponId;
      this.#giveAmmo(actor, id, item.amount);
      world.events.emit('pickupTaken', {
        id: item.id, kind: item.kind, by: actor.id, weaponId: id, amount: item.amount,
      });
    } else if (item.kind === 'weapon') {
      this.#giveWeapon(actor, item);
    }
    world.events.emit('pickupRemoved', { id: item.id, kind: item.kind, reason: 'taken' });
  }

  /**
   * Top up a pouch, respecting the weapon's own carry limit.
   * @returns {number} how much was actually taken
   */
  #giveAmmo(actor, weaponId, amount) {
    const weapon = this.world.weaponById(weaponId);
    if (!weapon) return 0;
    const cap = weapon.ammo?.max ?? Infinity;
    const mag = actor.mag[weaponId] ?? 0;
    const reserve = actor.ammo[weaponId] ?? 0;
    const given = Math.max(0, Math.min(amount, cap - (mag + reserve)));
    actor.ammo[weaponId] = reserve + given;
    return given;
  }

  /**
   * Taking a weapon. Three cases, in order: you already carry it and this is
   * just ammunition; you have a free hand and it joins the loadout; or you
   * are full and it swaps for whatever you are holding, which lands where
   * this one was so the trade is visible and reversible.
   */
  #giveWeapon(actor, item) {
    const world = this.world;
    const weaponId = item.weaponId;
    if (!world.weaponById(weaponId)) return;

    if (actor.loadout.includes(weaponId)) {
      const given = this.#giveAmmo(actor, weaponId, item.mag + item.reserve);
      world.events.emit('pickupTaken', {
        id: item.id, kind: 'weapon', by: actor.id, weaponId, asAmmo: true, amount: given,
      });
      return;
    }

    const wasEmpty = actor.loadout.length === 0;
    const maxWeapons = Math.max(1, world.rules.maxWeapons ?? 3);
    let swappedFor = null;

    if (actor.loadout.length >= maxWeapons) {
      const held = actor.weaponId;
      swappedFor = held;
      if (held) {
        this.spawn({
          kind: 'weapon',
          weaponId: held,
          mag: actor.mag[held] ?? 0,
          reserve: actor.ammo[held] ?? 0,
          owner: actor.id,
          liveAfterSec: 0.8,
          pos: clone(item.pos),
        });
        delete actor.mag[held];
        delete actor.ammo[held];
      }
      actor.loadout[actor.weaponIndex] = weaponId;
    } else {
      actor.loadout.push(weaponId);
      // Switch to it only if there was nothing in your hands. Yanking someone
      // off the weapon they are shooting with because they walked over
      // something is the fastest way to make pickups annoying.
      if (wasEmpty) actor.weaponIndex = actor.loadout.length - 1;
    }

    actor.mag[weaponId] = item.mag;
    actor.ammo[weaponId] = item.reserve;
    actor.nextFireAt[weaponId] = 0;
    actor.weaponIndex = Math.min(actor.weaponIndex, Math.max(0, actor.loadout.length - 1));
    if (wasEmpty) {
      actor.reload = null;
      actor.burst = null;
    }

    world.events.emit('pickupTaken', {
      id: item.id, kind: 'weapon', by: actor.id, weaponId, swappedFor,
    });
    actor.events.push({ type: 'weaponSwitch', weapon: actor.weaponId });
  }

  snapshot() {
    return this.items.map((p) => ({
      id: p.id,
      kind: p.kind,
      weaponId: p.weaponId,
      pos: clone(p.pos),
      live: this.world.time >= p.liveAt,
      owner: p.owner,
    }));
  }
}
