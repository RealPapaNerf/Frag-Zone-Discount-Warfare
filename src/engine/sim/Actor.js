import { v3, clone, dirFromAngles, clamp } from '../math/vec3.js';
import { playerBox } from './movement.js';

/**
 * One fighter — human or bot. Everything the renderer needs to draw a player,
 * and everything the host needs to authorise a hit, lives here as plain data.
 */
export class Actor {
  constructor({ id, name, character, loadout, isBot = false, team = null, rules }) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.team = team;
    this.characterId = character.id;
    this.character = character;

    this.hitbox = null;
    this.applyRules(rules);
    this.moveParams = { ...character.move };

    this.position = v3();
    this.velocity = v3();
    this.prevPosition = v3();
    this.yaw = 0;
    this.pitch = 0;

    this.maxHealth = rules.maxHealth;
    this.health = rules.startHealth;
    this.armor = character.armor ?? 0;
    this.alive = true;
    this.respawnAt = 0;
    this.spawnProtectUntil = 0;

    this.grounded = false;
    this.groundedPrev = false;
    this.aiming = false;
    this.onPad = false;
    this.jumpCooldown = 0;
    this.landingSpeed = 0;

    this.loadout = [...loadout];
    // What a respawn restores. Now that weapons can be dropped, the live
    // loadout is not a reliable record of what this fighter is meant to
    // carry — without this, slipping and then dying leaves you unarmed for
    // the rest of the match.
    this.spawnLoadout = [...loadout];
    this.weaponIndex = 0;
    // `ammo` is the pouch and `mag` is what is loaded. For a weapon with no
    // magazine `mag` goes unused and the pouch is the whole supply.
    this.ammo = Object.create(null);
    this.mag = Object.create(null);
    this.nextFireAt = Object.create(null);
    this.triggerHeld = false;
    /** @type {{weaponId: string, style: string, startedAt: number, endsAt: number}|null} */
    this.reload = null;
    /** A burst keeps paying out after the trigger is released. */
    this.burst = null;
    // When the trigger went down on a charge weapon, and how far it has got.
    this.chargeSince = null;
    this.charge = 0;
    // Next shot a weapon is going to take on its own, whatever you wanted.
    this.autoFireAt = 0;

    /**
     * Status effects, by id. Each holds its own definition so an actor can
     * total up what it is suffering without reaching for the content bundle.
     * @type {Map<string, {def: object, stacks: number, until: number,
     *   source: string|null, data: object|null}>}
     */
    this.effects = new Map();
    this.mods = noMods();
    // Damage over time arrives in fractions of a point per tick. applyDamage
    // rounds, so without somewhere to keep the remainder every tick rounds to
    // zero and nothing ever burns to death.
    this.damageDebt = 0;

    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.lastAttacker = null;
    this.lastDamageAt = -Infinity;

    this.events = [];
  }

  get weaponId() {
    return this.loadout[this.weaponIndex];
  }

  /** Eye position — the origin of every shot and line-of-sight check. */
  eye(out = v3()) {
    out.x = this.position.x;
    out.y = this.position.y + this.hitbox.eyeHeight;
    out.z = this.position.z;
    return out;
  }

  /** Centre of mass, what bots aim at and what splash measures against. */
  center(out = v3()) {
    out.x = this.position.x;
    out.y = this.position.y + this.hitbox.height * 0.5;
    out.z = this.position.z;
    return out;
  }

  headCenter(out = v3()) {
    out.x = this.position.x;
    out.y = this.position.y + this.hitbox.height - this.hitbox.headHeight * 0.5;
    out.z = this.position.z;
    return out;
  }

  /** Head radius grows with the big-heads mutator so the hitbox matches. */
  get headRadius() {
    return this.hitbox.headHeight * 0.5 * this.hitbox.headScale;
  }

  viewDir(out = v3()) {
    return dirFromAngles(out, this.yaw, this.pitch);
  }

  box(out) {
    return playerBox(this.position, this.hitbox, out);
  }

  /**
   * The body box used for shot tracing. It stops below the head so the head
   * sphere owns that region outright — otherwise a ray at head height hits
   * the full-height box first and a headshot registers as a body shot.
   */
  torsoBox(out) {
    const r = this.hitbox.radius;
    out.min.x = this.position.x - r;
    out.min.y = this.position.y;
    out.min.z = this.position.z - r;
    out.max.x = this.position.x + r;
    out.max.y = this.position.y + this.hitbox.height - this.hitbox.headHeight;
    out.max.z = this.position.z + r;
    return out;
  }

  /**
   * Total up what the current effects do.
   *
   * The stacking rule, in one place: scales compound once per stack, rates
   * add up once per stack, and flags are flags — three stacks of a 0.93 slow
   * is 0.93 cubed, three stacks of 7 damage a second is 21, and being pinned
   * twice is just being pinned.
   */
  recomputeMods() {
    const mods = noMods();
    for (const effect of this.effects.values()) {
      const mod = effect.def.modifiers ?? {};
      const stacks = Math.max(1, effect.stacks);
      if (typeof mod.moveSpeedScale === 'number') {
        mods.moveSpeedScale *= mod.moveSpeedScale ** stacks;
      }
      if (typeof mod.damagePerSec === 'number') {
        mods.damagePerSec += mod.damagePerSec * stacks;
      }
      if (typeof mod.jumpScale === 'number') mods.jumpScale *= mod.jumpScale ** stacks;
      if (mod.canMove === false) mods.canMove = false;
      if (mod.canAim === false) mods.canAim = false;
      if (mod.canFire === false) mods.canFire = false;
    }
    this.mods = mods;
    return mods;
  }

  hasEffect(id) {
    return this.effects.has(id);
  }

  effectStacks(id) {
    return this.effects.get(id)?.stacks ?? 0;
  }

  /**
   * Re-derive everything the rule bag bakes into an actor rather than reading
   * live. Called once when the actor is built, and again whenever a patch
   * note changes the rules underneath a match in progress.
   */
  applyRules(rules) {
    const scale = rules.bodyScale ?? 1;
    const h = this.character.hitbox;
    this.hitbox = {
      radius: h.radius * scale,
      height: h.height * scale,
      eyeHeight: h.eyeHeight * scale,
      headHeight: h.headHeight * scale,
      headScale: rules.headScale ?? 1,
    };
    this.maxHealth = rules.maxHealth;
  }

  setLook(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  switchWeapon(index) {
    if (index < 0 || index >= this.loadout.length || index === this.weaponIndex) return false;
    // Putting the gun away abandons the reload. Rounds already seated stay
    // seated, which is the whole trick behind cancel-reloading a shotgun.
    this.reload = null;
    // A burst, a charge and a self-firing timer all belong to the weapon
    // that started them.
    this.burst = null;
    this.chargeSince = null;
    this.charge = 0;
    this.autoFireAt = 0;
    this.weaponIndex = index;
    this.events.push({ type: 'weaponSwitch', weapon: this.weaponId });
    return true;
  }

  cycleWeapon(delta) {
    const n = this.loadout.length;
    if (n < 2) return false;
    return this.switchWeapon((this.weaponIndex + delta + n * 2) % n);
  }

  /** Snapshot for the renderer, the scoreboard and (later) the wire. */
  toSnapshot() {
    return {
      id: this.id,
      name: this.name,
      isBot: this.isBot,
      team: this.team,
      characterId: this.characterId,
      pos: clone(this.position),
      // The previous tick's position lets the renderer interpolate between
      // fixed sim ticks — and lets a client smooth 20Hz host snapshots later.
      prevPos: clone(this.prevPosition),
      vel: clone(this.velocity),
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      maxHealth: this.maxHealth,
      armor: this.armor,
      alive: this.alive,
      grounded: this.grounded,
      aiming: this.aiming,
      weapon: this.weaponId,
      ammo: this.ammo[this.weaponId] ?? 0,
      mag: this.mag[this.weaponId] ?? 0,
      // Tested against the reload itself rather than optional-chaining to
      // its id: an actor holding nothing has `weaponId === undefined`, and
      // `undefined === undefined` reported a reload in progress and then
      // dereferenced the null it had just agreed was null.
      reloading: !!this.reload && this.reload.weaponId === this.weaponId,
      // Both ends of the current step, so the HUD can draw a progress bar
      // without having to know how long a reload is supposed to take.
      reloadFrom: this.reload && this.reload.weaponId === this.weaponId ? this.reload.startedAt : 0,
      reloadEndsAt: this.reload && this.reload.weaponId === this.weaponId ? this.reload.endsAt : 0,
      charge: this.charge,
      bursting: !!this.burst && this.burst.weaponId === this.weaponId,
      // Compact on purpose: this rides every snapshot at 20Hz, and the
      // renderer only needs to know what to draw and how strongly.
      effects: [...this.effects.values()].map((e) => ({
        id: e.id, stacks: e.stacks, until: e.until,
      })),
      score: this.score,
      kills: this.kills,
      deaths: this.deaths,
      respawnAt: this.respawnAt,
    };
  }
}

/** What an actor with no status effects is subject to. */
function noMods() {
  return {
    moveSpeedScale: 1,
    jumpScale: 1,
    damagePerSec: 0,
    canMove: true,
    canAim: true,
    canFire: true,
  };
}
