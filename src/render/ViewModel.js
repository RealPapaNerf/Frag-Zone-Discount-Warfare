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
    this.bobPhase = 0;
    this.sway = new THREE.Vector2();
    this.swayTarget = new THREE.Vector2();
    this.basePosition = new THREE.Vector3();
    this.kick = 0.04;

    this.muzzle = new THREE.Object3D();
    this.flash = null;
    this.flashLife = 0;
  }

  /** Rebuild only when the weapon actually changes. */
  setWeapon(weapon) {
    if (!weapon || weapon.id === this.weaponId) return;
    this.weaponId = weapon.id;
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

    if (view.shape === 'launcher') {
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
    this.root.add(this.model);
  }

  #clear() {
    if (!this.model) return;
    this.root.remove(this.model);
    this.model.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.model = null;
  }

  onFire() {
    this.recoil = 1;
    this.flashLife = 0.05;
  }

  /**
   * @param {number} speed horizontal speed, drives the walk bob
   * @param {{x:number,y:number}} lookDelta this frame's mouse movement, drives sway
   */
  update(dt, speed, lookDelta, grounded) {
    if (!this.model) return;

    this.bobPhase += dt * (2 + speed * 1.1);
    const bobAmount = grounded ? Math.min(speed / 10, 1) * 0.016 : 0.004;
    const bobX = Math.cos(this.bobPhase) * bobAmount;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmount;

    // Sway lags the mouse so the weapon feels like it has mass.
    this.swayTarget.set(
      THREE.MathUtils.clamp(-lookDelta.x * 0.6, -0.05, 0.05),
      THREE.MathUtils.clamp(-lookDelta.y * 0.6, -0.05, 0.05),
    );
    this.sway.lerp(this.swayTarget, Math.min(1, dt * 9));

    this.recoil = Math.max(0, this.recoil - dt * 7);
    const recoilEase = this.recoil * this.recoil;

    this.model.position.set(
      this.basePosition.x + bobX + this.sway.x,
      this.basePosition.y + bobY + this.sway.y - recoilEase * 0.02,
      this.basePosition.z + recoilEase * this.kick,
    );
    this.model.rotation.x = recoilEase * 0.22 + this.sway.y * 1.4;
    this.model.rotation.y = this.sway.x * 1.4;

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
