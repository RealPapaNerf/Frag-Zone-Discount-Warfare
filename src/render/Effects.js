import * as THREE from 'three';

/**
 * Shot tracers, impact sparks, explosions and rockets in flight.
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

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;

    this.#initTracers();
    this.#initSparks();
    this.#initBlasts();
    this.#initRockets();
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
      // A trail, thrown backwards out of the nozzle.
      if (Math.random() < 0.7) {
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
  }
}
