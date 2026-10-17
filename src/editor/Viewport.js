import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Arena } from '../engine/sim/Arena.js';
import { ArenaView } from '../render/ArenaView.js';

/**
 * The 3D view. Draws the map with the game's own ArenaView, so what you build
 * is literally what you play — there is no separate "editor look" that can
 * drift from the real thing.
 *
 * It rebuilds the whole arena on every change. That sounds wasteful and is
 * not: a map is a few hundred boxes merged by material, which is a handful of
 * milliseconds, and it removes an entire category of bug where the view and
 * the document disagree.
 */
export class Viewport {
  constructor(canvas, mapDoc) {
    this.canvas = canvas;
    this.mapDoc = mapDoc;
    this.onPick = () => {};
    this.onPlace = () => {};
    this.tool = 'select';
    this.gridStep = 1;
    this.ghostSize = [2, 2, 2];

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#161c24');

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(44, 38, 52);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495; // never go under the floor
    // Left mouse is for building; orbit lives on the right button and middle.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    this.scene.add(new THREE.HemisphereLight(0xbcd4f5, 0x6b6050, 2.0));
    const sun = new THREE.DirectionalLight(0xfff4e2, 2.2);
    sun.position.set(40, 80, 30);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(160, 160, 0x4a5666, 0x2b333d);
    this.scene.add(this.grid);

    this.arenaGroup = new THREE.Group();
    this.scene.add(this.arenaGroup);

    this.markers = new THREE.Group();
    this.scene.add(this.markers);

    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd34d);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x53e0ff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.#bind();
    this.rebuild();
    this.onResize();
  }

  // --- building -------------------------------------------------------------

  rebuild() {
    const doc = this.mapDoc.doc;
    this.arena = new Arena(doc);

    this.arenaGroup.clear();
    this.arenaView?.dispose?.();
    this.arenaView = new ArenaView(doc, this.arena);
    this.arenaGroup.add(this.arenaView.group);

    this.#buildMarkers(doc);
    this.#updateSelection();
  }

  #buildMarkers(doc) {
    this.markers.clear();
    const spawnGeo = new THREE.ConeGeometry(0.5, 1.6, 6);
    const spawnMat = new THREE.MeshBasicMaterial({ color: 0x74e08a, transparent: true, opacity: 0.85 });
    doc.spawns?.forEach((s, i) => {
      const m = new THREE.Mesh(spawnGeo, spawnMat);
      m.position.set(s.pos[0], s.pos[1] + 0.9, s.pos[2]);
      m.rotation.y = s.yaw ?? 0;
      m.userData = { kind: 'spawn', index: i };
      this.markers.add(m);
    });

    const padMat = new THREE.MeshBasicMaterial({ color: 0x53e0ff, transparent: true, opacity: 0.6 });
    doc.jumpPads?.forEach((p, i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...p.size), padMat);
      m.position.set(...p.pos);
      m.userData = { kind: 'pad', index: i };
      this.markers.add(m);
    });

    // Waypoints, so you can see whether the bots have anywhere to go.
    const nodes = doc.waypoints?.nodes ?? [];
    if (nodes.length) {
      const dots = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.22, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.7 }),
        nodes.length,
      );
      const m = new THREE.Matrix4();
      nodes.forEach((n, i) => dots.setMatrixAt(i, m.setPosition(n.pos[0], n.pos[1] + 0.3, n.pos[2])));
      dots.userData = { kind: 'waypoints' };
      this.markers.add(dots);
    }
  }

  #updateSelection() {
    const sel = this.mapDoc.selection;
    const item = this.mapDoc.selected;
    if (!sel || !item) { this.selectionBox.visible = false; return; }

    const size = sel.kind === 'spawn' ? [1, 1.8, 1] : item.size ?? [1, 1, 1];
    const pos = item.pos;
    const half = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
    const centre = new THREE.Vector3(pos[0], sel.kind === 'spawn' ? pos[1] + 0.9 : pos[1], pos[2]);
    this.selectionBox.box.setFromCenterAndSize(centre, half.clone().multiplyScalar(2));
    this.selectionBox.visible = true;
  }

  // --- input ----------------------------------------------------------------

  #bind() {
    const setPointer = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };

    this.canvas.addEventListener('pointermove', (e) => {
      setPointer(e);
      if (this.tool === 'select') { this.ghost.visible = false; return; }
      const at = this.pickGround();
      if (!at) { this.ghost.visible = false; return; }
      this.ghost.visible = true;
      this.ghost.position.set(at.x, at.y + this.ghostSize[1] / 2, at.z);
      this.ghost.scale.set(...this.ghostSize);
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      setPointer(e);
      if (this.tool === 'select') {
        this.onPick(this.pickObject());
      } else {
        const at = this.pickGround();
        if (at) this.onPlace(at);
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('resize', () => this.onResize());
  }

  /** Snap a world coordinate to the current grid. */
  snap(v, step) {
    return Math.round(v / step) * step;
  }

  /**
   * Where a new piece would go: the top of whatever is under the cursor, or
   * the ground plane, snapped to the grid.
   */
  pickGround() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    const origin = { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z };
    const dir = { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z };

    const hit = this.arena?.raycast(origin, dir, 1000);
    let point;
    if (hit) {
      point = hit.point;
      // Landing on a top face means stacking on it; a side face means the
      // floor beside it, which is what you meant.
      if (hit.normal.y < 0.5) point = { ...point, y: Math.max(0, Math.round(point.y)) };
    } else {
      const p = new THREE.Vector3();
      if (!ray.intersectPlane(this.groundPlane, p)) return null;
      point = { x: p.x, y: 0, z: p.z };
    }

    const step = this.gridStep ?? 1;
    return {
      x: this.snap(point.x, step),
      y: Math.round(point.y * 100) / 100,
      z: this.snap(point.z, step),
    };
  }

  /** What the cursor is over: a brush index, a spawn, a pad, or nothing. */
  pickObject() {
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const markerHits = this.raycaster.intersectObjects(this.markers.children, false);
    const marker = markerHits.find((h) => h.object.userData?.kind && h.object.userData.kind !== 'waypoints');
    if (marker) return { ...marker.object.userData };

    const ray = this.raycaster.ray;
    const hit = this.arena?.raycast(
      { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z },
      { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z },
      1000,
    );
    if (hit) return { kind: 'brush', index: hit.brush.index };
    return null;
  }

  setTool(tool, ghostSize = [2, 2, 2]) {
    this.tool = tool;
    this.ghostSize = ghostSize;
    this.ghost.visible = false;
  }

  frameAll() {
    const b = this.mapDoc.doc.bounds ?? { min: [-32, 0, -32], max: [32, 10, 32] };
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + span * 0.7, span * 0.6, cz + span * 0.8);
  }

  onResize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
