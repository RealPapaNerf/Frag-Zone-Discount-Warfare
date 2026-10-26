import * as THREE from 'three';
import { buildWeaponView } from './WeaponModels.js';

/**
 * The weapon in your hands. It lives in its own scene with its own camera and
 * is drawn after the world with the depth buffer cleared, which is the cheap
 * and reliable way to stop the barrel poking through walls — far cheaper than
 * a stencil pass or a second render target.
 *
 * Shapes are assembled from the weapon JSON's `view` block, so the weapons
 * builder milestone can describe a new gun without touching this file.
 */
/**
 * What a weapon looks like when its JSON has no `parts` list: the original
 * two hand-built shapes, rewritten in the parts vocabulary so there is only
 * one code path that draws a weapon.
 */
const FALLBACK = {
  launcher: [
    { shape: 'cylinder', size: [0.15, 0.15, 0.62], pos: [0, 0, -0.26] },
    { shape: 'cylinder', size: [0.19, 0.19, 0.1], taper: 0.17, pos: [0, 0, -0.6], color: 'accent' },
    { shape: 'box', size: [0.07, 0.17, 0.12], pos: [0, -0.13, 0.02] },
    { shape: 'box', size: [0.05, 0.05, 0.2], pos: [0, 0.08, -0.16], color: 'accent' },
  ],
  rifle: [
    { shape: 'box', size: [0.09, 0.1, 0.56], pos: [0, 0, -0.22] },
    { shape: 'box', size: [0.045, 0.045, 0.26], pos: [0, 0.005, -0.56] },
    { shape: 'box', size: [0.06, 0.15, 0.11], pos: [0, -0.12, 0] },
    { shape: 'box', size: [0.035, 0.035, 0.16], pos: [0, 0.07, -0.18], color: 'accent' },
  ],
};

export class ViewModel {
  #box;
  #sphere;

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
    // Three lights, because the item in your hands is the one thing on
    // screen you are meant to be able to identify. A single key from the
    // left left the whole player-facing flank of every weapon in shadow,
    // which is half of why they all read as the same dark lump.
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x46433a, 1.7));
    const key = new THREE.DirectionalLight(0xfff4e2, 1.5);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);
    // Fill from the player's side of the item: the view model is held to
    // the right of the camera, so its left flank is the face you look at.
    const fill = new THREE.DirectionalLight(0xdfe9ff, 0.85);
    fill.position.set(-1, 0.25, 0.55);
    this.scene.add(fill);
    // A low bounce so undersides are not black.
    const bounce = new THREE.DirectionalLight(0xfff0d8, 0.35);
    bounce.position.set(0.4, -1, 0.3);
    this.scene.add(bounce);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.model = null;
    this.weaponId = null;
    this.#box = new THREE.Box3();
    this.#sphere = new THREE.Sphere();
    this.materials = [];
    this.geometries = [];

    this.recoil = 0;
    this.aimBlend = 0;
    this.reloadBlend = 0;
    this.chargeLevel = 0;
    // How far the sight pose lifts and pulls back from the hip pose. A
    // weapon's `view.aim` overrides both when it needs its own alignment.
    this.aimRise = 0.03;
    this.aimPull = 0.07;
    this.bobPhase = 0;
    this.sway = new THREE.Vector2();
    this.swayTarget = new THREE.Vector2();
    this.basePosition = new THREE.Vector3();
    this.baseRotation = [0, 0, 0];
    this.kick = 0.04;

    this.muzzle = new THREE.Object3D();
    this.flash = null;
    this.flashLife = 0;
  }

  /** Rebuild only when the weapon actually changes. */
  setWeapon(weapon) {
    // Keyed on the revision as well as the id: a patch note can change the
    // weapon behind an id mid-match, and rebuilding only on an id change
    // would leave you holding the old shape.
    const key = `${weapon?.id}#${weapon?.rev ?? 0}`;
    if (!weapon || key === this.weaponId) return;
    this.weaponId = key;
    this.#clear();

    const view = weapon.view ?? {};
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.materials.push(flashMat);

    this.model = new THREE.Group();

    // A weapon describes its own shape as a parts list, which is what the
    // weapon workshop writes and what `src/render/parts.js` knows how to
    // build, or names a model file to draw instead. The two fallbacks below
    // are for a weapon that has neither yet.
    const built = buildWeaponView(weapon, FALLBACK[view.shape] ?? FALLBACK.rifle);
    this.model.add(built.group);
    this.materials.push(...built.materials);
    this.geometries = built.geometries;

    const muzzleOffset = view.muzzle ?? [0, 0.03, -0.62];
    this.muzzle.position.set(...muzzleOffset);
    this.model.add(this.muzzle);

    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), flashMat);
    this.flash.position.copy(this.muzzle.position);
    this.model.add(this.flash);

    const offset = view.offset ?? [0.26, -0.24, -0.5];
    this.basePosition.set(...offset);
    // An item whose joke is on its front — a doorbell's button, a
    // rotisserie's window — is turned to show it. Held square on, all the
    // player ever sees is the back of a grey box.
    this.baseRotation = view.rot
      ? view.rot.map((d) => (d * Math.PI) / 180)
      : [0, 0, 0];
    this.#fitToFrame(view);
    this.kick = view.kick ?? 0.04;
    this.aimRise = view.aim?.rise ?? 0.03;
    this.aimPull = view.aim?.pull ?? 0.07;
    this.root.add(this.model);
  }

  /**
   * Hold a big item further away so all of it is on screen.
   *
   * The weapons in this game are household objects, and a rotisserie oven is
   * four times the size of a paring knife. Held at one fixed distance the
   * big ones fill the viewport with an anonymous grey wall — which is how a
   * George Foreman Grill ends up unrecognisable in your own hands.
   *
   * This only ever pushes an item further away, never closer, so a weapon
   * whose authored offset already fits keeps exactly the pose it was given
   * and the rifles feel the way they always did. It also means a weapon the
   * workshop invents tomorrow is framed sanely without anyone tuning it.
   */
  #fitToFrame(view) {
    if (view.fit === false) return;
    this.#box.setFromObject(this.model);
    if (this.#box.isEmpty()) return;
    this.#box.getBoundingSphere(this.#sphere);

    // Half the frustum height one metre out, from the view model's own FOV.
    const slope = Math.tan((this.camera.fov * Math.PI) / 360);
    // Assume a squarish window rather than the widescreen the author was
    // probably looking at: the item has to survive the narrowest viewport
    // anyone plays in, not the most flattering one.
    const slopeX = slope * 1.25;
    // How much of the frame the item may take up. Under 1 leaves a margin.
    const budget = view.fit ?? 0.92;

    // Fitting has to use the item's corners, not its radius. The view model
    // is held off in the bottom corner of the screen, so what runs off the
    // edge is one side of a wide item, long before a centred item of the
    // same size would touch anything.
    let push = 0;
    for (const sx of [this.#box.min.x, this.#box.max.x]) {
      for (const sy of [this.#box.min.y, this.#box.max.y]) {
        for (const sz of [this.#box.min.z, this.#box.max.z]) {
          const x = Math.abs(this.basePosition.x + sx);
          // The bottom of an item is allowed off the bottom of the screen —
          // that is what holding something looks like — but the top is not.
          const y = this.basePosition.y + sy;
          const depth = Math.abs(this.basePosition.z + sz);
          push = Math.max(push, x / (budget * slopeX) - depth);
          if (y > 0) push = Math.max(push, y / (budget * slope) - depth);
        }
      }
    }
    if (push > 0) this.basePosition.z -= push;
  }

  #clear() {
    if (!this.model) return;
    this.root.remove(this.model);
    this.model.traverse((o) => { if (!o.userData.sharedGeometry) o.geometry?.dispose(); });
    // buildParts shares one geometry across no meshes and one material
    // across many, so the traverse above misses nothing but the materials
    // and the parts list's own geometries have to be released by hand.
    for (const g of this.geometries ?? []) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    this.model = null;
  }

  onFire(charge = 0) {
    // A full charge kicks half again as hard as a tap.
    this.recoil = 1 + charge * 0.5;
    this.flashLife = 0.05 + charge * 0.05;
  }

  /** How wound up a charge weapon is, 0..1. Read straight, not eased: the
   *  simulation is already ramping it smoothly. */
  setCharge(charge) {
    this.chargeLevel = Math.max(0, Math.min(1, charge));
  }

  /** The magazine seating: a small settle, no muzzle flash. */
  onReloadDone() {
    this.recoil = Math.max(this.recoil, 0.45);
  }

  /**
   * @param {number} speed horizontal speed, drives the walk bob
   * @param {{x:number,y:number}} lookDelta this frame's mouse movement, drives sway
   */
  /**
   * Ease the weapon between the hip and the sights. Held as a 0..1 blend
   * rather than a flag so the pose, the bob and the sway all settle together.
   */
  setAim(aiming, dt) {
    const target = aiming ? 1 : 0;
    this.aimBlend += (target - this.aimBlend) * Math.min(1, dt * 14);
    if (Math.abs(target - this.aimBlend) < 0.001) this.aimBlend = target;
  }

  /**
   * Reloading drops the weapon out of the firing line and rolls it over, which
   * is the honest reading of the state: while this pose is up, the trigger
   * does nothing. Eased rather than switched so a cancelled reload recovers
   * smoothly instead of snapping back.
   */
  setReload(reloading, dt) {
    const target = reloading ? 1 : 0;
    this.reloadBlend += (target - this.reloadBlend) * Math.min(1, dt * 11);
    if (Math.abs(target - this.reloadBlend) < 0.001) this.reloadBlend = target;
  }

  update(dt, speed, lookDelta, grounded) {
    if (!this.model) return;

    const aim = this.aimBlend;
    this.bobPhase += dt * (2 + speed * 1.1);
    // Down the sights the weapon steadies: most of the bob and sway go away,
    // which is half of why aiming feels like it helps.
    const steady = 1 - aim * 0.85;
    const bobAmount = (grounded ? Math.min(speed / 10, 1) * 0.016 : 0.004) * steady;
    const bobX = Math.cos(this.bobPhase) * bobAmount;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmount;

    // Sway lags the mouse so the weapon feels like it has mass.
    this.swayTarget.set(
      THREE.MathUtils.clamp(-lookDelta.x * 0.6, -0.05, 0.05),
      THREE.MathUtils.clamp(-lookDelta.y * 0.6, -0.05, 0.05),
    );
    this.sway.lerp(this.swayTarget, Math.min(1, dt * 9));
    const swayX = this.sway.x * steady;
    const swayY = this.sway.y * steady;

    this.recoil = Math.max(0, this.recoil - dt * 7);
    const recoilEase = this.recoil * this.recoil;

    // The hip pose, then the sight pose: centred, a little higher, and drawn
    // back toward the eye. `aim` slides between them.
    const hipX = this.basePosition.x + bobX + swayX;
    const hipY = this.basePosition.y + bobY + swayY - recoilEase * 0.02;
    const hipZ = this.basePosition.z + recoilEase * this.kick;
    const sightX = bobX * 0.3 + swayX;
    const sightY = this.basePosition.y + this.aimRise + bobY * 0.3 + swayY - recoilEase * 0.02;
    const sightZ = this.basePosition.z + this.aimPull + recoilEase * this.kick;

    this.model.position.set(
      hipX + (sightX - hipX) * aim,
      hipY + (sightY - hipY) * aim,
      hipZ + (sightZ - hipZ) * aim,
    );
    // Winding up draws the weapon back toward the eye and shivers it, so a
    // charge you cannot see on the HUD is still visible in your hands.
    const charge = this.chargeLevel;
    if (charge > 0) {
      const shiver = Math.sin(this.bobPhase * 9) * 0.0035 * charge;
      this.model.position.z += charge * 0.045;
      this.model.position.y += shiver;
    }

    // The reload pose is laid over whatever the hip/sight blend produced.
    const reload = this.reloadBlend;
    if (reload > 0) {
      this.model.position.y -= reload * 0.12;
      this.model.position.z += reload * 0.05;
    }
    const [rx, ry, rz] = this.baseRotation;
    this.model.rotation.x = rx + recoilEase * 0.22 + swayY * 1.4 + reload * 0.5;
    // Down the sights the cant unwinds, so aiming still lines the item up.
    this.model.rotation.y = ry * (1 - aim) + swayX * 1.4 * (1 - aim);
    this.model.rotation.z = rz + reload * 0.35;

    if (this.flash) {
      this.flashLife = Math.max(0, this.flashLife - dt);
      this.flash.material.opacity = this.flashLife > 0 ? 1 : 0;
      this.flash.scale.setScalar(0.8 + Math.random() * 0.6);
    }
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.#clear();
  }
}
