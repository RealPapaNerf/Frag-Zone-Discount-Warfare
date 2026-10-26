import * as THREE from 'three';
import { buildBoxes, DIR } from './boxes.js';
import { makeCharacterTexture, loadFaceImage, FACE_UV, BLANK_UV } from './charTexture.js';
import { instantiateCharacter, findBone } from './CharacterModel.js';
import { heldWeapon } from './heldWeapon.js';

/**
 * Fighters come in two builds. The normal one is the rigged soldier from
 * CharacterModel.js, animated by an AnimationMixer. If that model never
 * loaded — a failed download, or a page that did not preload it — the view
 * builds the box fighter below instead, with the same public interface.
 *
 * The box fighter is built as five rigid chunks: head, torso and four limbs.
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

/** Locomotion clips in the soldier GLB, blended by horizontal speed. */
const GAIT = ['Idle', 'Walk', 'Run'];
const WHITE = new THREE.Color(1, 1, 1);
/** Edge of the square a player's photo is pasted on, in metres. */
const FACE_SIZE = 0.3;
const _hand = new THREE.Vector3();
const _fingers = new THREE.Vector3();

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class ActorView {
  /**
   * @param {object} snapshot actor snapshot
   * @param {object} character content character
   * @param {{weapons?: Record<string, object>}} [opts] content weapons, so
   *   the fighter can be drawn holding whatever it has out
   */
  constructor(snapshot, character, { weapons = {} } = {}) {
    const look = character?.appearance ?? {};
    this.weapons = weapons;
    this.heldId = undefined;
    this.held = null;

    // The face texture is kept on both builds: Renderer.applyFaces() and the
    // expression changes below talk to it whichever body is wearing it.
    this.face = makeCharacterTexture(look);
    loadFaceImage(look.faceTexture, (image) => this.face.setImage(image));

    this.group = new THREE.Group();
    this.group.name = `actor:${snapshot.id}`;

    // Yaw lives on an inner node so limb animation is independent of facing.
    this.body = new THREE.Group();
    this.group.add(this.body);

    const model = instantiateCharacter();
    if (model) this.#buildSkinned(model, character, look);
    else this.#buildBoxes(look);

    this.headScale = 1;
    this.phase = Math.random() * Math.PI * 2;
    this.hitFlash = 0;
    this.statusTint = null;
    this.statusIntensity = 0;
    this.seeThrough = false;
    this.emissiveOn = false;
    this._tint = new THREE.Color();
    this.wasAlive = true;
    // The local player's own body is never drawn in first person. This has to
    // be a flag rather than setting group.visible once, because update() below
    // rewrites visibility from the snapshot every frame.
    this.hidden = false;
  }

  #buildBoxes(look) {
    const geo = geometryFor(look);

    // One material for the entire fighter. vertexColors carries the per-box
    // colour; the map carries the face.
    this.material = new THREE.MeshLambertMaterial({
      map: this.face.texture,
      vertexColors: true,
    });
    this.materials = [this.material];

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

    // At the hand, turned back by the arm's levelling so the weapon points
    // where the fighter faces.
    this.grip = new THREE.Group();
    this.grip.position.set(0, -0.56, -0.02);
    this.grip.rotation.x = 0.9;
    this.armR.add(this.grip);

    this.legL = new THREE.Mesh(geo.leg, this.material);
    this.legR = new THREE.Mesh(geo.leg, this.material);
    this.legL.position.set(-0.15, 0.78, 0);
    this.legR.position.set(0.15, 0.78, 0);
    this.body.add(this.legL, this.legR);
  }

  #buildSkinned(model, character, look) {
    this.skinned = true;
    this.materials = model.materials;

    // Everyone shares one texture, so pull the body toward the character's
    // accent colour; halfway to white keeps the texture readable under it.
    const hue = new THREE.Color(look.accent ?? look.body ?? '#ffffff').lerp(WHITE, 0.5);
    for (const m of this.materials) {
      if (m.name === 'VanguardBodyMat') m.color.multiply(hue);
    }

    // This GLB already faces -Z, the sim's forward, so it needs no turn. It
    // is scaled to the hitbox height and stood on its lowest point, on a
    // holder node so the GLB root keeps whatever transform it shipped with.
    const height = character?.hitbox?.height ?? 1.8;
    const scale = height / model.height;
    this.model = new THREE.Group();
    this.model.scale.setScalar(scale);
    this.model.position.y = -model.footY * scale;
    this.model.add(model.root);
    this.body.add(this.model);

    this.headBone = findBone(model.root, 'mixamorig:Head');
    // Placed while the skeleton is still in its bind pose, head upright.
    this.#attachFacePlane();

    this.mixer = new THREE.AnimationMixer(model.root);
    this.gait = GAIT.map((name) => {
      const clip = THREE.AnimationClip.findByName(model.animations, name);
      if (!clip) return null;
      const action = this.mixer.clipAction(clip);
      action.setEffectiveWeight(name === 'Idle' ? 1 : 0);
      action.play();
      return action;
    });
    this.gaitWeight = GAIT.map((name) => (name === 'Idle' ? 1 : 0));

    this.handBone = findBone(model.root, 'mixamorig:RightHand');
    this.fingerBone = findBone(model.root, 'mixamorig:RightHandMiddle1');
    // Follows the hand, but faces the way the body does: the run cycle
    // swings and twists the wrist far enough that a weapon fixed to it
    // spends half of every stride pointing backwards.
    if (this.handBone) {
      this.grip = new THREE.Group();
      this.body.add(this.grip);
    }

    // Out of step with each other, or a lobby of bots marches in unison.
    for (const action of this.gait) {
      if (action) action.time = Math.random() * action.getClip().duration;
    }
  }

  /**
   * A player's photo on a flat square stuck to the front of the helmet. It
   * does not follow the shape of the head and is not meant to: it is a
   * picture of your brother taped to a soldier. On the head bone, so it nods,
   * pitches and grows with big heads; shown only while a photo is set.
   */
  #attachFacePlane() {
    if (!this.headBone) return;
    this.group.updateMatrixWorld(true);
    const head = this.headBone.getWorldPosition(new THREE.Vector3());

    const geo = new THREE.PlaneGeometry(FACE_SIZE, FACE_SIZE);
    // Only the face square of the character canvas, not the whole sheet.
    const uv = geo.attributes.uv;
    const [u0, v0, u1, v1] = FACE_UV;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    const material = new THREE.MeshLambertMaterial({ map: this.face.texture });

    this.facePlane = new THREE.Mesh(geo, material);
    // The group is still at the origin facing -Z, so its space is the body's.
    this.facePlane.position.set(head.x, head.y + 0.1, head.z - 0.15);
    this.facePlane.rotation.y = Math.PI;
    this.facePlane.visible = false;
    this.headBone.attach(this.facePlane);
    // Joins the hit flash, the status tints and the see-through.
    this.materials.push(material);
  }

  #syncHeld(weaponId) {
    if (weaponId === this.heldId || !this.grip) return;
    this.heldId = weaponId;
    if (this.held) this.grip.remove(this.held);
    this.held = heldWeapon(this.weapons[weaponId]);
    if (this.held) this.grip.add(this.held);
  }

  setHeadScale(scale) {
    this.headScale = scale;
    if (this.head) this.head.scale.setScalar(scale);
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
      for (const m of this.materials) {
        m.depthTest = !seeThrough;
        m.needsUpdate = true;
      }
      // Drawn last so it lays over the world rather than fighting it.
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
    this.#syncHeld(snap.weapon);
    if (this.facePlane) this.facePlane.visible = this.face.hasPhoto;

    const speed = Math.hypot(snap.vel.x, snap.vel.z);
    this.phase += dt * (1.2 + speed * 0.9);
    if (this.skinned) this.#animateSkinned(snap, speed, dt);
    else this.#animateBoxes(snap, speed);

    // A fighter who has been running at you for a while looks like it.
    const flashing = this.hitFlash > 0;
    if (flashing) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    const f = this.hitFlash;

    if (this.statusTint) {
      // Pulsed so it reads as something happening to them rather than paint.
      const k = this.statusIntensity * (0.62 + Math.sin(this.phase * 6) * 0.18);
      this._tint.set(this.statusTint);
      this.#setEmissive(
        Math.max(this._tint.r * k, f * 0.9),
        Math.max(this._tint.g * k, f * 0.1),
        Math.max(this._tint.b * k, f * 0.1),
      );
    } else if (flashing) {
      this.#setEmissive(f * 0.9, f * 0.1, f * 0.1);
    } else if (this.emissiveOn) {
      // A status that wore off leaves its last pulse behind otherwise.
      this.#setEmissive(0, 0, 0);
    }
    if (flashing && f === 0) this.face.setExpression(speed > 4 ? 'angry' : 'idle');
  }

  #setEmissive(r, g, b) {
    for (const m of this.materials) m.emissive.setRGB(r, g, b);
    this.emissiveOn = r > 0 || g > 0 || b > 0;
  }

  #animateBoxes(snap, speed) {
    this.headPivot.rotation.x = -snap.pitch * 0.6;

    // Walk cycle driven by horizontal speed, so bots read as moving or not.
    const swing = Math.min(speed / 8, 1) * 0.6;
    const airborne = !snap.grounded;
    this.legL.rotation.x = airborne ? -0.35 : Math.sin(this.phase) * swing;
    this.legR.rotation.x = airborne ? 0.2 : -Math.sin(this.phase) * swing;
    this.armL.rotation.x = airborne ? -0.8 : -Math.sin(this.phase) * swing * 0.7;
    this.armR.rotation.x = -0.9; // the weapon arm stays levelled
  }

  #animateSkinned(snap, speed, dt) {
    // Standing, walking, running by speed; weights ease rather than snap, and
    // are renormalised so the blend never leaks the bind-pose T in.
    const moving = smoothstep(0.3, 1.8, speed);
    const running = smoothstep(3, 7, speed);
    const target = [1 - moving, moving * (1 - running), moving * running];
    const ease = Math.min(1, dt * 8);
    let total = 0;
    for (let i = 0; i < GAIT.length; i++) {
      if (!this.gait[i]) { this.gaitWeight[i] = 0; continue; }
      this.gaitWeight[i] += (target[i] - this.gaitWeight[i]) * ease;
      total += this.gaitWeight[i];
    }
    for (let i = 0; i < GAIT.length; i++) {
      this.gait[i]?.setEffectiveWeight(total > 0 ? this.gaitWeight[i] / total : 0);
    }
    // The sim's top speed is well past the clip's jog, so the legs speed up
    // with it rather than skating.
    this.gait[2]?.setEffectiveTimeScale(Math.min(1.6, Math.max(0.8, speed / 6)));

    // There is no jump clip: in the air the stride slows to a near-hold.
    this.mixer.update(snap.grounded ? dt : dt * 0.2);

    // Bone overrides go after the mixer, which rewrites every bone it animates.
    if (this.headBone) {
      this.headBone.rotateX(-snap.pitch * 0.6);
      this.headBone.scale.setScalar(this.headScale);
    }

    if (this.handBone) {
      // getWorldPosition brings the bone chain up to date first, so this is
      // where the hand is this frame rather than last.
      this.handBone.getWorldPosition(_hand);
      if (this.fingerBone) _hand.lerp(this.fingerBone.getWorldPosition(_fingers), 0.6);
      this.grip.position.copy(this.body.worldToLocal(_hand));
      this.grip.rotation.x = snap.pitch * 0.8;
    }
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    this.facePlane?.geometry.dispose();
    this.face.dispose();
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
    }
  }
}
