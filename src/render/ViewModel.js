import * as THREE from 'three';

/**
 * The weapon in your hands. It lives in its own scene with its own camera and
 * is drawn after the world with the depth buffer cleared, which is the cheap
 * and reliable way to stop the barrel poking through walls — far cheaper than
 * a stencil pass or a second render target.
 *
 * Shapes are assembled from the weapon JSON's `view` block, so the weapons
 * builder milestone can describe a new gun without touching this file.
 */
export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30302a, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.model = null;
    this.weaponId = null;
    this.materials = [];

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
    this.kick = 0.04;

    this.muzzle = new THREE.Object3D();
    this.flash = null;
    this.flashLife = 0;
  }

  /** Cache a one-off colour used by a weapon's parts list. */
  #namedMaterial(color) {
    this._named ??= new Map();
    if (!this._named.has(color)) {
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      this._named.set(color, mat);
      this.materials.push(mat);
    }
    return this._named.get(color);
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
    const body = new THREE.Color(view.color ?? '#9aa6b2');
    const accent = new THREE.Color(view.accent ?? '#36e0ff');
    const bodyMat = new THREE.MeshLambertMaterial({ color: body });
    const accentMat = new THREE.MeshLambertMaterial({ color: accent });
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.materials.push(bodyMat, accentMat, flashMat);

    this.model = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      this.model.add(mesh);
      return mesh;
    };

    // A weapon can describe its own shape as a parts list, which is what the
    // weapon workshop writes. The two named shapes below stay as defaults for
    // weapons that have not been rebuilt, and as something to start from.
    if (Array.isArray(view.parts) && view.parts.length) {
      for (const part of view.parts) {
        const mat = part.color === 'accent' ? accentMat
          : part.color && part.color !== 'body'
            ? this.#namedMaterial(part.color)
            : bodyMat;
        const [sx, sy, sz] = part.size ?? [0.1, 0.1, 0.1];
        const geo = part.shape === 'cylinder'
          ? new THREE.CylinderGeometry(sx / 2, (part.taper ?? sx) / 2, sz, 8).rotateX(Math.PI / 2)
          : new THREE.BoxGeometry(sx, sy, sz);
        const mesh = add(geo, mat, ...(part.pos ?? [0, 0, 0]));
        if (part.rot) mesh.rotation.set(...part.rot.map((d) => d * Math.PI / 180));
      }
    } else if (view.shape === 'launcher') {
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.62, 8).rotateX(Math.PI / 2), bodyMat, 0, 0, -0.26);
      add(new THREE.CylinderGeometry(0.095, 0.085, 0.1, 8).rotateX(Math.PI / 2), accentMat, 0, 0, -0.6);
      add(new THREE.BoxGeometry(0.07, 0.17, 0.12), bodyMat, 0, -0.13, 0.02);
      add(new THREE.BoxGeometry(0.05, 0.05, 0.2), accentMat, 0, 0.08, -0.16);
    } else {
      add(new THREE.BoxGeometry(0.09, 0.1, 0.56), bodyMat, 0, 0, -0.22);
      add(new THREE.BoxGeometry(0.045, 0.045, 0.26), bodyMat, 0, 0.005, -0.56);
      add(new THREE.BoxGeometry(0.06, 0.15, 0.11), bodyMat, 0, -0.12, 0.0);
      add(new THREE.BoxGeometry(0.035, 0.035, 0.16), accentMat, 0, 0.07, -0.18);
    }

    const muzzleOffset = view.muzzle ?? [0, 0.03, -0.62];
    this.muzzle.position.set(...muzzleOffset);
    this.model.add(this.muzzle);

    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), flashMat);
    this.flash.position.copy(this.muzzle.position);
    this.model.add(this.flash);

    const offset = view.offset ?? [0.26, -0.24, -0.5];
    this.basePosition.set(...offset);
    this.kick = view.kick ?? 0.04;
    this.aimRise = view.aim?.rise ?? 0.03;
    this.aimPull = view.aim?.pull ?? 0.07;
    this.root.add(this.model);
  }

  #clear() {
    if (!this.model) return;
    this.root.remove(this.model);
    this.model.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
    this.materials = [];
    // These point at materials just disposed; keeping them would hand the
    // next weapon a dead material for any colour it happens to reuse.
    this._named?.clear();
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
    this.model.rotation.x = recoilEase * 0.22 + swayY * 1.4 + reload * 0.5;
    this.model.rotation.y = swayX * 1.4 * (1 - aim);
    this.model.rotation.z = reload * 0.35;

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
