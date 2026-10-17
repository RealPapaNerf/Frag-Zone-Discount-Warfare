import * as THREE from 'three';
import { buildBoxes, DIR } from './boxes.js';
import { makeCharacterTexture, loadFaceImage, FACE_UV, BLANK_UV } from './charTexture.js';

/**
 * Low-poly fighters, built as five rigid chunks: head, torso and four limbs.
 *
 * Each chunk is a pile of boxes merged into one geometry with its colours
 * baked into the vertices, so detail — cap, nose, hands, boots, belt — costs
 * triangles rather than draw calls. A fighter is five draw calls whatever is
 * stuck on them, which is fewer than the flat-coloured version this replaces
 * and leaves headroom for a full lobby on a Chromebook.
 *
 * The head is still a separate node whose scale follows the big-heads rule,
 * which keeps the model honest about the hitbox the simulation is using.
 */

/** Geometry depends only on appearance, so characters that look alike share it. */
const GEO_CACHE = new Map();

function geometryFor(look) {
  const key = JSON.stringify([look.body, look.head, look.accent, look.trousers, look.boots, look.hair]);
  if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);

  const skin = look.head ?? '#d9b48a';
  const shirt = look.body ?? '#4d6fa8';
  const accent = look.accent ?? '#ffd34d';
  const trousers = look.trousers ?? '#3b4252';
  const boots = look.boots ?? '#2b2f38';
  const hair = look.hair ?? '#2f2a26';

  const built = {
    // Head sits at its own origin so headPivot can scale and rotate it.
    head: buildBoxes([
      // The skull. Its front face is the only one that samples the face
      // square; every other face in the whole model shows flat colour.
      { pos: [0, 0, 0], size: [0.34, 0.34, 0.33], color: '#ffffff',
        uv: { dir: DIR.front, rect: FACE_UV } },
      // Cap, with a brim over the eyes.
      { pos: [0, 0.185, 0.01], size: [0.355, 0.05, 0.345], color: hair },
      { pos: [0, 0.155, -0.11], size: [0.355, 0.035, 0.12], color: hair },
      // A nose, so the profile is not a cube.
      { pos: [0, -0.015, -0.185], size: [0.055, 0.075, 0.05], color: skin },
      // Ears.
      { pos: [-0.182, -0.01, 0.02], size: [0.03, 0.08, 0.07], color: skin },
      { pos: [0.182, -0.01, 0.02], size: [0.03, 0.08, 0.07], color: skin },
    ], BLANK_UV),

    torso: buildBoxes([
      { pos: [0, 0, 0], size: [0.62, 0.52, 0.36], color: shirt },
      // Shoulder yoke, slightly wider than the chest.
      { pos: [0, 0.3, 0], size: [0.68, 0.14, 0.38], color: shirt },
      // Collar and belt in the accent colour, which is what you pick a
      // fighter out by at range.
      { pos: [0, 0.385, 0], size: [0.3, 0.06, 0.3], color: accent },
      { pos: [0, -0.3, 0], size: [0.64, 0.1, 0.38], color: accent },
      { pos: [0, -0.3, -0.19], size: [0.1, 0.08, 0.03], color: '#c9ced6' },
      // Hips, under the belt.
      { pos: [0, -0.4, 0], size: [0.6, 0.12, 0.36], color: trousers },
    ], BLANK_UV),

    // Limbs hang from their top, so rotation.x swings them from the joint.
    arm: buildBoxes([
      { pos: [0, -0.16, 0], size: [0.16, 0.34, 0.16], color: shirt },
      { pos: [0, -0.42, 0], size: [0.145, 0.2, 0.145], color: skin },
      { pos: [0, -0.56, 0], size: [0.16, 0.12, 0.18], color: skin },
    ], BLANK_UV),

    leg: buildBoxes([
      { pos: [0, -0.2, 0], size: [0.2, 0.4, 0.22], color: trousers },
      { pos: [0, -0.52, 0], size: [0.185, 0.26, 0.2], color: trousers },
      { pos: [0, -0.69, -0.02], size: [0.21, 0.1, 0.3], color: boots },
    ], BLANK_UV),
  };

  GEO_CACHE.set(key, built);
  return built;
}

export class ActorView {
  constructor(snapshot, character) {
    const look = character?.appearance ?? {};
    const geo = geometryFor(look);

    this.face = makeCharacterTexture(look);
    // One material for the entire fighter. vertexColors carries the per-box
    // colour; the map carries the face.
    this.material = new THREE.MeshLambertMaterial({
      map: this.face.texture,
      vertexColors: true,
    });
    loadFaceImage(look.faceTexture, (image) => this.face.setImage(image));

    this.group = new THREE.Group();
    this.group.name = `actor:${snapshot.id}`;

    // Yaw lives on an inner node so limb animation is independent of facing.
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.torso = new THREE.Mesh(geo.torso, this.material);
    this.torso.position.y = 1.16;
    this.body.add(this.torso);

    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 1.62;
    this.body.add(this.headPivot);
    this.head = new THREE.Mesh(geo.head, this.material);
    this.headPivot.add(this.head);

    this.armL = new THREE.Mesh(geo.arm, this.material);
    this.armR = new THREE.Mesh(geo.arm, this.material);
    this.armL.position.set(-0.39, 1.45, 0);
    this.armR.position.set(0.39, 1.45, 0);
    this.body.add(this.armL, this.armR);

    this.legL = new THREE.Mesh(geo.leg, this.material);
    this.legR = new THREE.Mesh(geo.leg, this.material);
    this.legL.position.set(-0.15, 0.78, 0);
    this.legR.position.set(0.15, 0.78, 0);
    this.body.add(this.legL, this.legR);

    this.phase = Math.random() * Math.PI * 2;
    this.hitFlash = 0;
    this.statusTint = null;
    this.statusIntensity = 0;
    this.seeThrough = false;
    this._tint = new THREE.Color();
    this.wasAlive = true;
    // The local player's own body is never drawn in first person. This has to
    // be a flag rather than setting group.visible once, because update() below
    // rewrites visibility from the snapshot every frame.
    this.hidden = false;
  }

  setHeadScale(scale) {
    this.head.scale.setScalar(scale);
  }

  flashHit() {
    this.hitFlash = 1;
    this.face.setExpression('hurt');
  }

  /**
   * Tint the fighter by whatever is wrong with them. The strongest effect
   * wins rather than blending, because two tints averaged together read as a
   * third colour that means nothing.
   *
   * `throughWalls` drops depth testing, which is exactly what the Bedazzler
   * is for: rhinestones you can see from the next room.
   */
  setStatus(effects, defs) {
    let tint = null;
    let strength = 0;
    let seeThrough = false;
    for (const effect of effects ?? []) {
      const visual = defs?.[effect.id]?.visual;
      if (!visual?.tint) continue;
      if (visual.throughWalls) seeThrough = true;
      const weight = (visual.intensity ?? 0.5) * Math.min(3, effect.stacks ?? 1);
      if (weight > strength) { strength = weight; tint = visual.tint; }
    }
    this.statusTint = tint;
    this.statusIntensity = Math.min(1, strength);

    if (seeThrough !== this.seeThrough) {
      this.seeThrough = seeThrough;
      this.material.depthTest = !seeThrough;
      // Drawn last so it lays over the world rather than fighting it.
      this.material.needsUpdate = true;
      this.group.renderOrder = seeThrough ? 10 : 0;
    }
  }

  /**
   * @param {object} snap actor snapshot
   * @param {object} pos interpolated position
   * @param {number} dt seconds since the last frame
   */
  update(snap, pos, dt) {
    // Death is worth a face even though the body stops being drawn: the
    // corpse is hidden, but the expression is what you see on respawn.
    if (snap.alive !== this.wasAlive) {
      this.face.setExpression(snap.alive ? 'idle' : 'dead');
      this.wasAlive = snap.alive;
    }

    this.group.visible = snap.alive && !this.hidden;
    if (!snap.alive || this.hidden) return;

    this.group.position.set(pos.x, pos.y, pos.z);
    this.body.rotation.y = snap.yaw;
    this.headPivot.rotation.x = -snap.pitch * 0.6;

    // Walk cycle driven by horizontal speed, so bots read as moving or not.
    const speed = Math.hypot(snap.vel.x, snap.vel.z);
    this.phase += dt * (1.2 + speed * 0.9);
    const swing = Math.min(speed / 8, 1) * 0.6;
    const airborne = !snap.grounded;
    this.legL.rotation.x = airborne ? -0.35 : Math.sin(this.phase) * swing;
    this.legR.rotation.x = airborne ? 0.2 : -Math.sin(this.phase) * swing;
    this.armL.rotation.x = airborne ? -0.8 : -Math.sin(this.phase) * swing * 0.7;
    this.armR.rotation.x = -0.9; // the weapon arm stays levelled

    // A fighter who has been running at you for a while looks like it.
    const flashing = this.hitFlash > 0;
    if (flashing) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    const f = this.hitFlash;

    if (this.statusTint) {
      // Pulsed so it reads as something happening to them rather than paint.
      const k = this.statusIntensity * (0.62 + Math.sin(this.phase * 6) * 0.18);
      this._tint.set(this.statusTint);
      this.material.emissive.setRGB(
        Math.max(this._tint.r * k, f * 0.9),
        Math.max(this._tint.g * k, f * 0.1),
        Math.max(this._tint.b * k, f * 0.1),
      );
    } else if (flashing) {
      this.material.emissive.setRGB(f * 0.9, f * 0.1, f * 0.1);
    }
    if (flashing && f === 0) this.face.setExpression(speed > 4 ? 'angry' : 'idle');
  }

  dispose() {
    this.material.dispose();
    this.face.dispose();
  }
}
