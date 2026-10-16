import * as THREE from 'three';

/**
 * Low-poly fighters built from boxes. Geometry is shared across every actor;
 * only materials differ, so a full lobby costs very little.
 *
 * The head is a separate node whose scale follows the big-heads rule, which
 * keeps the model honest about the hitbox the simulation is using.
 */

const GEO = {
  torso: new THREE.BoxGeometry(0.62, 0.72, 0.36),
  head: new THREE.BoxGeometry(0.34, 0.34, 0.34),
  arm: new THREE.BoxGeometry(0.16, 0.56, 0.16),
  leg: new THREE.BoxGeometry(0.2, 0.74, 0.22),
  muzzleTag: new THREE.BoxGeometry(0.1, 0.1, 0.5),
};

export class ActorView {
  constructor(snapshot, character) {
    const look = character?.appearance ?? {};
    this.bodyMaterial = new THREE.MeshLambertMaterial({ color: new THREE.Color(look.body ?? '#4d6fa8') });
    this.headMaterial = new THREE.MeshLambertMaterial({ color: new THREE.Color(look.head ?? '#d9b48a') });
    this.accentMaterial = new THREE.MeshLambertMaterial({ color: new THREE.Color(look.accent ?? '#ffd34d') });

    this.group = new THREE.Group();
    this.group.name = `actor:${snapshot.id}`;

    // Yaw lives on an inner node so limb animation is independent of facing.
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.torso = new THREE.Mesh(GEO.torso, this.bodyMaterial);
    this.torso.position.y = 1.16;
    this.body.add(this.torso);

    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 1.62;
    this.body.add(this.headPivot);
    this.head = new THREE.Mesh(GEO.head, this.headMaterial);
    this.headPivot.add(this.head);
    // A nub on the front of the head so you can read which way a bot faces.
    const visor = new THREE.Mesh(GEO.muzzleTag, this.accentMaterial);
    visor.scale.set(1.6, 0.4, 0.3);
    visor.position.set(0, 0.02, -0.18);
    this.headPivot.add(visor);

    this.armL = new THREE.Mesh(GEO.arm, this.accentMaterial);
    this.armR = new THREE.Mesh(GEO.arm, this.accentMaterial);
    this.armL.position.set(-0.4, 1.18, 0);
    this.armR.position.set(0.4, 1.18, 0);
    this.body.add(this.armL, this.armR);

    this.legL = new THREE.Mesh(GEO.leg, this.bodyMaterial);
    this.legR = new THREE.Mesh(GEO.leg, this.bodyMaterial);
    this.legL.position.set(-0.17, 0.4, 0);
    this.legR.position.set(0.17, 0.4, 0);
    this.body.add(this.legL, this.legR);

    this.phase = Math.random() * Math.PI * 2;
    this.hitFlash = 0;
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
  }

  /**
   * @param {object} snap actor snapshot
   * @param {object} prev previous snapshot position for interpolation
   * @param {number} alpha 0..1 between prev and snap
   */
  update(snap, pos, dt) {
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

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
      const f = this.hitFlash;
      this.bodyMaterial.emissive.setRGB(f * 0.9, f * 0.1, f * 0.1);
      this.headMaterial.emissive.setRGB(f * 0.9, f * 0.1, f * 0.1);
    }
  }

  dispose() {
    this.bodyMaterial.dispose();
    this.headMaterial.dispose();
    this.accentMaterial.dispose();
  }
}
