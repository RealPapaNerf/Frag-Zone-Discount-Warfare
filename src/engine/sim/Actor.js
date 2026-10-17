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

    const scale = rules.bodyScale ?? 1;
    this.hitbox = {
      radius: character.hitbox.radius * scale,
      height: character.hitbox.height * scale,
      eyeHeight: character.hitbox.eyeHeight * scale,
      headHeight: character.hitbox.headHeight * scale,
      headScale: rules.headScale ?? 1,
    };
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
    this.weaponIndex = 0;
    this.ammo = Object.create(null);
    this.nextFireAt = Object.create(null);
    this.triggerHeld = false;

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

  setLook(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  switchWeapon(index) {
    if (index < 0 || index >= this.loadout.length || index === this.weaponIndex) return false;
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
      score: this.score,
      kills: this.kills,
      deaths: this.deaths,
      respawnAt: this.respawnAt,
    };
  }
}
