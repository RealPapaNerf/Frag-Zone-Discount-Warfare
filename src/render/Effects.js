import * as THREE from 'three';

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
   * Things sitting on the floor. One unit box per slot, scaled and coloured
   * from the deployable's own `view` block, so a new trap needs no code here.
   */
  #initDeployables() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.deployableGeometry = geometry;
    this.deployables = [];
    for (let i = 0; i < MAX_DEPLOYABLES; i++) {
      const material = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      this.scene.add(mesh);
      const lid = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true,
      }));
      lid.visible = false;
      this.scene.add(lid);
      this.deployables.push({ mesh, material, lid });
    }
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
        slot.mesh.visible = false;
        slot.lid.visible = false;
        continue;
      }
      const view = defs[item.defId]?.view ?? {};
      const [sx, sy, sz] = view.size ?? [0.5, 0.3, 0.5];

      slot.mesh.visible = true;
      slot.material.color.set(view.color ?? '#9aa6b2');
      // Still arming reads as not-yet-dangerous. A trap you cannot tell is
      // live is just an unfair floor.
      slot.material.opacity = item.armed ? 1 : 0.45;
      slot.mesh.scale.set(sx, sy, sz);
      slot.mesh.position.set(item.pos.x, item.pos.y + sy / 2, item.pos.z);
      slot.mesh.rotation.y = item.yaw ?? 0;

      // A thin accent slab on top, which is the whole visual language the
      // weapon view models already use.
      slot.lid.visible = true;
      slot.lid.material.color.set(view.accent ?? '#36e0ff');
      slot.lid.material.opacity = item.armed
        ? 0.55 + Math.sin(this.time * 5 + i) * 0.3
        : 0.18;
      slot.lid.scale.set(sx * 0.72, sy * 0.18, sz * 0.72);
      slot.lid.position.set(item.pos.x, item.pos.y + sy + 0.02, item.pos.z);
      slot.lid.rotation.y = item.yaw ?? 0;
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
    this.deployableGeometry.dispose();
    for (const d of this.deployables) { d.material.dispose(); d.lid.material.dispose(); }
  }
}
