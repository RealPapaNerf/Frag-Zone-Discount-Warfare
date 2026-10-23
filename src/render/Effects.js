import * as THREE from 'three';
import { buildParts } from './parts.js';

/**
 * Shot tracers, beams, impact sparks, explosions and rockets in flight.
 *
 * Everything is pooled and shares as few draw calls as possible: all tracers
 * live in one LineSegments, all sparks in one Points cloud. Nothing allocates
 * during a match, and nothing here uses a light — dynamic lights are the
 * fastest way to ruin the frame rate on an integrated GPU.
 */

const MAX_TRACERS = 48;
const MAX_SPARKS = 320;
const MAX_BLASTS = 10;
const MAX_ROCKETS = 24;
const MAX_BEAMS = 6;
const MAX_DEPLOYABLES = 24;
const MAX_PICKUPS = 32;

// Scratch objects for recentring a dropped item; allocated once because
// nothing in here may allocate during a match.
const PICKUP_BOX = new THREE.Box3();
const PICKUP_MID = new THREE.Vector3();
const PICKUP_SIZE = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    this.#initTracers();
    this.#initSparks();
    this.#initBlasts();
    this.#initRockets();
    this.#initBeams();
    this.#initDeployables();
    this.#initPickups();
  }

  // --- tracers -------------------------------------------------------------

  #initTracers() {
    const positions = new Float32Array(MAX_TRACERS * 2 * 3);
    const colors = new Float32Array(MAX_TRACERS * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Additive blending means a faded-to-black segment is simply invisible,
    // so fading and pooling are the same operation.
    this.tracerMaterial = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.tracerMesh = new THREE.LineSegments(geometry, this.tracerMaterial);
    this.tracerMesh.frustumCulled = false;
    this.scene.add(this.tracerMesh);

    this.tracers = Array.from({ length: MAX_TRACERS }, () => ({ life: 0, maxLife: 1, color: new THREE.Color() }));
    this.tracerCursor = 0;
  }

  addTracer(from, to, colorHex = '#9fe9ff', life = 0.07) {
    const slot = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % MAX_TRACERS;
    slot.life = life;
    slot.maxLife = life;
    slot.color.set(colorHex);

    const i = this.tracers.indexOf(slot) * 6;
    const p = this.tracerMesh.geometry.attributes.position.array;
    p[i] = from.x; p[i + 1] = from.y; p[i + 2] = from.z;
    p[i + 3] = to.x; p[i + 4] = to.y; p[i + 5] = to.z;
    this.tracerMesh.geometry.attributes.position.needsUpdate = true;
  }

  // --- sparks --------------------------------------------------------------

  #initSparks() {
    const positions = new Float32Array(MAX_SPARKS * 3);
    const colors = new Float32Array(MAX_SPARKS * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.sparkMaterial = new THREE.PointsMaterial({
      size: 0.12, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.sparkMesh = new THREE.Points(geometry, this.sparkMaterial);
    this.sparkMesh.frustumCulled = false;
    this.scene.add(this.sparkMesh);

    this.sparks = Array.from({ length: MAX_SPARKS }, () => ({
      life: 0, maxLife: 1, vel: new THREE.Vector3(), pos: new THREE.Vector3(), color: new THREE.Color(),
    }));
    this.sparkCursor = 0;
  }

  addImpact(point, normal, { count = 7, color = '#ffd9a0', speed = 4, life = 0.35 } = {}) {
    const n = normal ?? { x: 0, y: 1, z: 0 };
    for (let i = 0; i < count; i++) {
      const spark = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;
      spark.life = life * (0.6 + Math.random() * 0.6);
      spark.maxLife = spark.life;
      spark.pos.set(point.x, point.y, point.z);
      spark.color.set(color);
      spark.vel.set(
        n.x * speed + (Math.random() - 0.5) * speed,
        n.y * speed + (Math.random() - 0.5) * speed + 1.5,
        n.z * speed + (Math.random() - 0.5) * speed,
      );
    }
  }

  // --- explosions ----------------------------------------------------------

  #initBlasts() {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    this.blasts = [];
    for (let i = 0; i < MAX_BLASTS; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xff8a3c, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      this.scene.add(mesh);
      this.blasts.push({ mesh, life: 0, maxLife: 0.45, radius: 1 });
    }
    this.blastCursor = 0;
  }

  addExplosion(point, radius) {
    const blast = this.blasts[this.blastCursor];
    this.blastCursor = (this.blastCursor + 1) % MAX_BLASTS;
    blast.life = blast.maxLife;
    blast.radius = radius;
    blast.mesh.position.set(point.x, point.y, point.z);
    blast.mesh.visible = true;
    this.addImpact(point, { x: 0, y: 1, z: 0 }, { count: 16, color: '#ffb066', speed: 9, life: 0.6 });
  }

  // --- beams ---------------------------------------------------------------

  /**
   * A beam is a stretched cylinder rather than a line, because WebGL ignores
   * line width and a one-pixel "beam" reads as a bug. Each beam tick refreshes
   * a short life, so a held trigger looks continuous and a released one fades
   * instead of vanishing between ticks.
   */
  #initBeams() {
    // Unit length along -Z so the same lookAt trick as the rockets works.
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, -0.5);
    this.beams = [];
    for (let i = 0; i < MAX_BEAMS; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.beams.push({ mesh, material, life: 0, maxLife: 0.1, owner: null });
    }
    this.beamGeometry = geometry;
    this.beamTarget = new THREE.Vector3();
  }

  /**
   * @param {string|number} owner one beam per shooter, so a held trigger
   *   refreshes its own beam instead of filling the pool.
   */
  addBeam(owner, from, to, color = '#9fe9ff', life = 0.1, radius = 0.035) {
    let slot = this.beams.find((b) => b.owner === owner && b.life > 0)
      ?? this.beams.find((b) => b.life <= 0)
      ?? this.beams[0];
    slot.owner = owner;
    slot.life = life;
    slot.maxLife = life;
    slot.material.color.set(color);

    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    slot.mesh.position.set(from.x, from.y, from.z);
    this.beamTarget.set(to.x, to.y, to.z);
    slot.mesh.lookAt(this.beamTarget);
    slot.mesh.scale.set(radius, radius, Math.max(0.01, len));
    slot.mesh.visible = true;
  }

  // --- deployables ---------------------------------------------------------

  /**
   * Things sitting on the floor: a grill, a wet floor sign, a rotisserie.
   *
   * Each one is built from the same `view.parts` list the weapons use, so a
   * trap looks in the world like the thing it is called, and a new trap
   * still needs no code here. Before this they were all a coloured box with
   * a glowing slab on top, which made a George Foreman Grill and a Wet
   * Floor Sign the same object with the hue changed.
   *
   * One prototype is built per definition and cloned into the slots, so
   * eight grills on the floor cost one set of geometry.
   */
  #initDeployables() {
    this.deployableProtos = new Map();
    this.deployables = [];
    for (let i = 0; i < MAX_DEPLOYABLES; i++) {
      const group = new THREE.Group();
      group.visible = false;
      this.scene.add(group);
      this.deployables.push({ group, defId: null, materials: [] });
    }
  }

  /**
   * The built form of one deployable definition, made once and cloned.
   *
   * Clones share geometry but need their own materials, because an unarmed
   * trap is drawn faded and two traps are rarely at the same stage.
   */
  #deployableProto(defId, def) {
    if (this.deployableProtos.has(defId)) return this.deployableProtos.get(defId);
    const view = def?.view ?? {};
    let parts = view.parts;
    if (!Array.isArray(parts) || !parts.length) {
      // No parts list: fall back to the old box-and-lid so a definition
      // that has not been modelled yet still appears on the floor.
      const [sx, sy, sz] = view.size ?? [0.5, 0.3, 0.5];
      parts = [
        { shape: 'box', size: [sx, sy, sz], pos: [0, sy / 2, 0] },
        { shape: 'box', size: [sx * 0.72, sy * 0.18, sz * 0.72], pos: [0, sy + 0.02, 0], color: 'accent' },
      ];
    }
    const proto = { parts, palette: { body: view.color, accent: view.accent } };
    this.deployableProtos.set(defId, proto);
    return proto;
  }

  /**
   * @param {object[]} items from the snapshot
   * @param {Record<string, object>} defs content.deployables
   */
  syncDeployables(items = [], defs = {}) {
    for (let i = 0; i < this.deployables.length; i++) {
      const slot = this.deployables[i];
      const item = items[i];
      if (!item) {
        slot.group.visible = false;
        continue;
      }

      // Rebuild only when this slot changes to a different kind of trap.
      if (slot.defId !== item.defId) {
        this.#disposeSlot(slot);
        const proto = this.#deployableProto(item.defId, defs[item.defId]);
        const built = buildParts(proto.parts, proto.palette);
        slot.group.add(built.group);
        slot.materials = built.materials;
        slot.geometries = built.geometries;
        slot.defId = item.defId;
      }

      slot.group.visible = true;
      slot.group.position.set(item.pos.x, item.pos.y, item.pos.z);
      slot.group.rotation.y = item.yaw ?? 0;

      // Still arming reads as not-yet-dangerous. A trap you cannot tell is
      // live is just an unfair floor. Armed, it breathes instead of sitting
      // dead still, which is what catches your eye across a room.
      const armed = item.armed;
      const opacity = armed ? 1 : 0.45;
      for (const m of slot.materials) {
        m.transparent = opacity < 1 || m.userData.wasTransparent === true;
        m.opacity = m.userData.baseOpacity == null
          ? opacity
          : m.userData.baseOpacity * opacity;
      }
      const pulse = armed ? 1 + Math.sin(this.time * 5 + i) * 0.02 : 1;
      slot.group.scale.setScalar(pulse);
    }
  }

  #disposeSlot(slot) {
    (slot.pivot ?? slot.group).clear();
    slot.key = null;
    for (const m of slot.materials ?? []) m.dispose();
    for (const g of slot.geometries ?? []) g.dispose();
    slot.materials = [];
    slot.geometries = [];
  }

  // --- pickups -------------------------------------------------------------

  /**
   * Dropped equipment, bobbing and turning so it reads as collectable rather
   * than as scenery. Coloured from the weapon it is, so you can tell your
   * rifle from your rocket launcher across a room.
   */
  #initPickups() {
    this.pickups = [];
    for (let i = 0; i < MAX_PICKUPS; i++) {
      // An inner node carries the model's recentring, so the outer group is
      // free to bob and spin about the drop point.
      const group = new THREE.Group();
      const pivot = new THREE.Group();
      group.add(pivot);
      group.visible = false;
      this.scene.add(group);
      this.pickups.push({ group, pivot, key: null, materials: [], geometries: [] });
    }
  }

  /**
   * What a dropped thing looks like on the floor.
   *
   * A dropped weapon is drawn as that weapon, shrunk to fit a crate-sized
   * box, because "there is a rocket launcher over there" is information you
   * act on and a coloured cube is not. Health and ammo are not content, so
   * their shapes live here.
   */
  #pickupParts(item, weapons) {
    if (item.kind === 'health') {
      return [
        { shape: 'box', size: [0.3, 0.16, 0.22], pos: [0, 0, 0], color: '#f2f5f8', finish: 'plastic' },
        { shape: 'box', size: [0.31, 0.04, 0.23], pos: [0, 0.06, 0], color: '#d8dee5', finish: 'plastic' },
        { shape: 'box', size: [0.12, 0.035, 0.035], pos: [0, 0.085, 0], color: '#e0342c' },
        { shape: 'box', size: [0.035, 0.035, 0.12], pos: [0, 0.085, 0], color: '#e0342c' },
        { shape: 'decal', size: [0.22, 0.1], pos: [0, 0, -0.112], facing: 'nz',
          lines: ['+ HEALTH'], color: '#e0342c' },
      ];
    }
    if (item.kind === 'ammo') {
      return [
        { shape: 'box', size: [0.3, 0.17, 0.2], pos: [0, 0, 0], color: '#5c6340', finish: 'plastic' },
        { shape: 'box', size: [0.31, 0.035, 0.21], pos: [0, 0.075, 0], color: '#4a5134', finish: 'plastic' },
        { shape: 'cylinder', axis: 'x', size: [0.12, 0.05, 0.05], pos: [0, 0.1, 0], color: '#3a3f28' },
        { shape: 'decal', size: [0.22, 0.08], pos: [0, -0.01, -0.102], facing: 'nz',
          text: 'AMMO', color: '#d6dcc0' },
      ];
    }
    return weapons[item.weaponId]?.view?.parts ?? null;
  }

  /**
   * @param {object[]} items from the snapshot
   * @param {Record<string, object>} weapons content weapons, for colour
   */
  syncPickups(items = [], weapons = {}) {
    for (let i = 0; i < this.pickups.length; i++) {
      const slot = this.pickups[i];
      const item = items[i];
      if (!item) { slot.group.visible = false; continue; }

      const key = item.kind === 'weapon' ? `w:${item.weaponId}` : `k:${item.kind}`;
      if (slot.key !== key) {
        this.#disposeSlot(slot);
        const view = weapons[item.weaponId]?.view ?? {};
        let parts = this.#pickupParts(item, weapons);
        if (!parts?.length) {
          parts = [{ shape: 'box', size: [0.3, 0.16, 0.3], pos: [0, 0, 0], color: 'accent' }];
        }
        const built = buildParts(parts, { body: view.color, accent: view.accent });
        slot.pivot.add(built.group);
        slot.materials = built.materials;
        slot.geometries = built.geometries;
        slot.key = key;

        // Weapons are modelled around the hand that holds them, so their
        // parts sit off to one side of the origin and run a long way
        // forward. Recentre and shrink so every drop is a crate-sized
        // thing turning on the spot, whatever it is.
        PICKUP_BOX.setFromObject(slot.pivot);
        PICKUP_BOX.getCenter(PICKUP_MID);
        PICKUP_BOX.getSize(PICKUP_SIZE);
        const longest = Math.max(PICKUP_SIZE.x, PICKUP_SIZE.y, PICKUP_SIZE.z);
        const scale = longest > 0.0001 ? Math.min(1, 0.52 / longest) : 1;
        slot.pivot.scale.setScalar(scale);
        slot.pivot.position.set(
          -PICKUP_MID.x * scale, -PICKUP_MID.y * scale, -PICKUP_MID.z * scale,
        );
      }

      slot.group.visible = true;
      // Dimmed until anybody can take it, so a fresh drop reads as settling.
      const opacity = item.live ? 1 : 0.4;
      for (const m of slot.materials) {
        m.transparent = opacity < 1 || m.userData.wasTransparent === true;
        m.opacity = (m.userData.baseOpacity ?? 1) * opacity;
      }
      slot.group.position.set(
        item.pos.x,
        item.pos.y + 0.3 + Math.sin(this.time * 2.4 + i) * 0.06,
        item.pos.z,
      );
      slot.group.rotation.y = this.time * 1.1 + i;
      // Tipped forward a little: a weapon seen edge-on from above is a line.
      slot.group.rotation.x = 0.26;
    }
  }

  // --- rockets in flight ---------------------------------------------------

  #initRockets() {
    const geometry = new THREE.CylinderGeometry(0.09, 0.13, 0.5, 6);
    geometry.rotateX(Math.PI / 2); // point down -Z so lookAt orients it
    this.rocketPool = [];
    for (let i = 0; i < MAX_ROCKETS; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xff7a2f });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      this.scene.add(mesh);
      this.rocketPool.push(mesh);
    }
    this.rocketTarget = new THREE.Vector3();
  }

  /** Drive rocket meshes straight from the snapshot; the host owns the truth. */
  syncRockets(projectiles) {
    for (let i = 0; i < this.rocketPool.length; i++) {
      const mesh = this.rocketPool[i];
      const p = projectiles[i];
      if (!p) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      this.rocketTarget.set(p.pos.x + p.dir.x, p.pos.y + p.dir.y, p.pos.z + p.dir.z);
      mesh.lookAt(this.rocketTarget);
      // A trail, thrown backwards out of the nozzle. Nothing lying on the
      // floor waiting for its fuse has a nozzle.
      if (!p.resting && Math.random() < 0.7) {
        this.addImpact(
          { x: p.pos.x - p.dir.x * 0.3, y: p.pos.y - p.dir.y * 0.3, z: p.pos.z - p.dir.z * 0.3 },
          { x: -p.dir.x, y: -p.dir.y, z: -p.dir.z },
          { count: 1, color: '#ff8c3a', speed: 1.5, life: 0.25 },
        );
      }
    }
  }

  // --- per-frame -----------------------------------------------------------

  update(dt) {
    this.time += dt;

    const tracerColors = this.tracerMesh.geometry.attributes.color.array;
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (t.life > 0) t.life = Math.max(0, t.life - dt);
      const k = t.life / t.maxLife;
      const base = i * 6;
      for (let v = 0; v < 2; v++) {
        tracerColors[base + v * 3] = t.color.r * k;
        tracerColors[base + v * 3 + 1] = t.color.g * k;
        tracerColors[base + v * 3 + 2] = t.color.b * k;
      }
    }
    this.tracerMesh.geometry.attributes.color.needsUpdate = true;

    const sparkPositions = this.sparkMesh.geometry.attributes.position.array;
    const sparkColors = this.sparkMesh.geometry.attributes.color.array;
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      const base = i * 3;
      if (s.life <= 0) {
        sparkColors[base] = sparkColors[base + 1] = sparkColors[base + 2] = 0;
        continue;
      }
      s.life = Math.max(0, s.life - dt);
      s.vel.y -= 14 * dt;
      s.pos.addScaledVector(s.vel, dt);
      const k = s.life / s.maxLife;
      sparkPositions[base] = s.pos.x;
      sparkPositions[base + 1] = s.pos.y;
      sparkPositions[base + 2] = s.pos.z;
      sparkColors[base] = s.color.r * k;
      sparkColors[base + 1] = s.color.g * k;
      sparkColors[base + 2] = s.color.b * k;
    }
    this.sparkMesh.geometry.attributes.position.needsUpdate = true;
    this.sparkMesh.geometry.attributes.color.needsUpdate = true;

    for (const beam of this.beams) {
      if (beam.life <= 0) {
        if (beam.mesh.visible) { beam.mesh.visible = false; beam.owner = null; }
        continue;
      }
      beam.life = Math.max(0, beam.life - dt);
      const k = beam.life / beam.maxLife;
      // Flicker a little so it reads as energy rather than a painted stick.
      beam.material.opacity = k * (0.65 + Math.random() * 0.35);
    }

    for (const blast of this.blasts) {
      if (blast.life <= 0) { blast.mesh.visible = false; continue; }
      blast.life = Math.max(0, blast.life - dt);
      const k = 1 - blast.life / blast.maxLife; // 0 -> 1 over the lifetime
      blast.mesh.scale.setScalar(blast.radius * (0.3 + k * 0.95));
      blast.mesh.material.opacity = (1 - k) * 0.8;
    }
  }

  dispose() {
    this.tracerMesh.geometry.dispose();
    this.tracerMaterial.dispose();
    this.sparkMesh.geometry.dispose();
    this.sparkMaterial.dispose();
    for (const b of this.blasts) b.mesh.material.dispose();
    for (const m of this.rocketPool) m.material.dispose();
    this.beamGeometry.dispose();
    for (const b of this.beams) b.material.dispose();
    for (const slot of this.deployables) this.#disposeSlot(slot);
    for (const slot of this.pickups) this.#disposeSlot(slot);
  }
}
