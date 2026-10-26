import * as THREE from 'three';
import { ViewModel } from './ViewModel.js';
import { Effects } from './Effects.js';
import { ArenaView } from './ArenaView.js';
import { ActorView } from './ActorView.js';
import { loadFaceImage } from './charTexture.js';
import { withSkin } from '../data/skins.js';

/**
 * Owns the WebGL context and every three.js object. It reads snapshots and
 * events; it never writes to game state.
 *
 * The defaults target an integrated GPU: no shadow maps, no post-processing,
 * no dynamic lights, a capped pixel ratio, and fog tight enough to keep the
 * far half of the arena cheap.
 */
export class Renderer {
  constructor(canvas, { quality = 'medium' } = {}) {
    this.canvas = canvas;
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality === 'high',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x121820);
    this.renderer.autoClear = false;
    // Two render() calls per frame, so let the counters accumulate across both
    // and reset them ourselves; otherwise info only describes the last pass.
    this.renderer.info.autoReset = false;
    this.#applyQuality();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.08, 220);

    this.viewModel = new ViewModel();
    this.effects = new Effects(this.scene);

    this.arenaView = null;
    this.actorViews = new Map();
    this.content = null;

    this.shake = 0;
    this.shakeVector = new THREE.Vector3();
    this.tmp = new THREE.Vector3();

    this.onResize();
  }

  #applyQuality() {
    const cap = { low: 1, medium: 1.25, high: 2 }[this.quality] ?? 1.25;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.shadowMap.enabled = false; // never worth it here
  }

  setQuality(quality) {
    this.quality = quality;
    this.#applyQuality();
    this.onResize();
  }

  /** Build the scene for a map. Safe to call again on a map change. */
  loadArena(mapDoc, arena, content) {
    this.content = content;
    this.clearArena();

    const env = mapDoc.environment ?? {};
    this.scene.background = new THREE.Color(env.sky ?? '#121820');
    this._mapFog = env.fog
      ? new THREE.Fog(new THREE.Color(env.fog.color), env.fog.near, env.fog.far)
      : null;
    this.scene.fog = this._mapFog;
    // A new map starts from the map's own fog; a live rule reapplies next frame.
    this._fogDensity = 0;

    const ambient = env.ambient ?? {};
    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(ambient.sky ?? '#8fb6ff'),
      new THREE.Color(ambient.ground ?? '#3a3426'),
      ambient.intensity ?? 1.1,
    );
    this.scene.add(this.hemi);

    const sun = env.sun ?? {};
    this.sun = new THREE.DirectionalLight(new THREE.Color(sun.color ?? '#fff2d8'), sun.intensity ?? 1.5);
    const d = sun.direction ?? [-0.45, -1, -0.3];
    this.sun.position.set(-d[0], -d[1], -d[2]).multiplyScalar(50);
    this.scene.add(this.sun);

    this.arenaView = new ArenaView(mapDoc, arena);
    this.scene.add(this.arenaView.group);
  }

  clearArena() {
    if (this.arenaView) {
      this.scene.remove(this.arenaView.group);
      this.arenaView.dispose();
      this.arenaView = null;
    }
    for (const [, view] of this.actorViews) {
      this.scene.remove(view.group);
      view.dispose();
    }
    this.actorViews.clear();
    if (this.hemi) this.scene.remove(this.hemi);
    if (this.sun) this.scene.remove(this.sun);
  }

  /** Create/remove actor models to match the snapshot. */
  syncActors(snapshot, localId, headScale) {
    const seen = new Set();
    for (const actor of snapshot.actors) {
      seen.add(actor.id);
      if (this.actorViews.has(actor.id)) continue;
      const character = withSkin(this.content.characters[actor.characterId], actor.skinId);
      const view = new ActorView(actor, character);
      view.setHeadScale(headScale);
      this.actorViews.set(actor.id, view);
      this.scene.add(view.group);
    }
    for (const [id, view] of this.actorViews) {
      if (seen.has(id)) continue;
      this.scene.remove(view.group);
      view.dispose();
      this.actorViews.delete(id);
    }
    // You never see your own body in first person.
    for (const [id, view] of this.actorViews) view.hidden = id === localId;
  }

  /**
   * Put players' face pictures on their fighters. Called every frame with
   * whatever map the host currently has; a view remembers the URL it already
   * wears, so a frame where nothing changed costs a string compare per actor.
   */
  applyFaces(faces) {
    if (!faces) return;
    for (const [id, view] of this.actorViews) {
      const url = faces[id] ?? null;
      if (view.faceUrl === url) continue;
      view.faceUrl = url;
      if (!url) { view.face.clearImage(); continue; }
      loadFaceImage(url, (image) => {
        // Only wear it if it is still the face this actor should have —
        // the player may have left while the image decoded.
        if (view.faceUrl === url) view.face.setImage(image);
      });
    }
  }

  addShake(amount) {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /**
   * @param {object} view {position, yaw, pitch, fov} for the local camera
   */
  render(dt, view) {
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const s = this.shake * this.shake * 0.22;
    this.shakeVector.set(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s,
    );

    this.camera.position.set(
      view.position.x + this.shakeVector.x,
      view.position.y + this.shakeVector.y,
      view.position.z + this.shakeVector.z,
    );
    this.camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
    if (view.fov && Math.abs(this.camera.fov - view.fov) > 0.01) {
      this.camera.fov = view.fov;
      this.camera.updateProjectionMatrix();
    }

    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // Clear depth only: the weapon draws on top of the world but still
    // depth-sorts against itself.
    this.renderer.clearDepth();
    this.renderer.render(this.viewModel.scene, this.viewModel.camera);
  }

  /**
   * Fog from the rule bag, not the map. 0 leaves the map's own fog alone;
   * anything above it closes the world in, which is the whole content of
   * "Fixed an issue where players could see".
   */
  setFog(density) {
    if (density === this._fogDensity) return;
    this._fogDensity = density;
    if (!density) {
      this.scene.fog = this._mapFog ?? null;
      return;
    }
    // Squeeze the far plane toward the camera as density rises; 1 is arm's
    // length. Near trails far so it stays a fog and not a grey screen.
    const far = 90 * (1 - density) + 4;
    const colour = this._mapFog?.color ?? this.scene.background ?? new THREE.Color('#121820');
    this.scene.fog = new THREE.Fog(colour, far * 0.25, far);
  }

  onResize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewModel.setAspect(width / height);
  }

  dispose() {
    this.clearArena();
    this.effects.dispose();
    this.viewModel.dispose();
    this.renderer.dispose();
  }
}
