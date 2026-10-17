import * as THREE from 'three';
import { mergeBoxes, makeGridTexture } from './geometry.js';

/**
 * Builds the visible arena from the same map document the Arena collision
 * world reads. Rendering and physics agree because they share the source, not
 * because anyone keeps them in sync by hand.
 */
export class ArenaView {
  constructor(mapDoc, arena) {
    this.group = new THREE.Group();
    this.group.name = 'arena';
    this.materials = [];
    this.gridTexture = makeGridTexture();
    this.padMeshes = [];

    this.arena = arena;
    this.doorMeshes = [];
    this.#buildBrushes(mapDoc, arena);
    this.#buildJumpPads(arena);
    this.#buildDoors(mapDoc, arena);
  }

  /**
   * Doors get a mesh each rather than joining the merged brush batch,
   * because they move. One extra draw call per door is the price of a door
   * that opens.
   */
  #buildDoors(mapDoc, arena) {
    for (const door of arena.doors) {
      const def = mapDoc.materials?.[door.material] ?? { color: '#7d6b57' };
      const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(def.color),
        map: this.gridTexture,
      });
      this.materials.push(material);
      const [sx, sy, sz] = door.size;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
      mesh.name = `door:${door.id}`;
      this.group.add(mesh);
      this.doorMeshes.push({ mesh, door });
    }
  }

  #buildBrushes(mapDoc, arena) {
    // Group brushes by material so each becomes exactly one draw call.
    const byMaterial = new Map();
    for (const brush of arena.brushes) {
      if (!byMaterial.has(brush.material)) byMaterial.set(brush.material, []);
      byMaterial.get(brush.material).push(brush.box);
    }

    for (const [name, boxes] of byMaterial) {
      const def = mapDoc.materials?.[name] ?? { color: '#808080' };
      const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(def.color),
        map: this.gridTexture,
      });
      this.materials.push(material);
      const mesh = new THREE.Mesh(mergeBoxes(boxes), material);
      mesh.name = `brushes:${name}`;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
  }

  #buildJumpPads(arena) {
    for (const pad of arena.jumpPads) {
      const size = {
        x: pad.box.max.x - pad.box.min.x,
        z: pad.box.max.z - pad.box.min.z,
      };
      const geometry = new THREE.CylinderGeometry(Math.min(size.x, size.z) * 0.5, Math.min(size.x, size.z) * 0.55, 0.22, 12);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(pad.color ?? '#36e0ff'),
        transparent: true,
        opacity: 0.85,
      });
      this.materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(
        (pad.box.min.x + pad.box.max.x) / 2,
        pad.box.max.y + 0.02,
        (pad.box.min.z + pad.box.max.z) / 2,
      );
      this.group.add(mesh);
      this.padMeshes.push(mesh);
    }
  }

  /** Pads pulse so they read as interactive from across the arena. */
  update(time) {
    // Doors are driven straight from the simulation's own boxes, so what you
    // can see is exactly what you would walk into.
    for (const { mesh, door } of this.doorMeshes) {
      mesh.position.set(
        (door.box.min.x + door.box.max.x) / 2,
        (door.box.min.y + door.box.max.y) / 2,
        (door.box.min.z + door.box.max.z) / 2,
      );
      mesh.visible = door.t < 0.999;
    }

    for (let i = 0; i < this.padMeshes.length; i++) {
      const pulse = 0.65 + 0.35 * Math.sin(time * 4 + i);
      this.padMeshes[i].material.opacity = pulse;
      this.padMeshes[i].scale.setScalar(0.95 + 0.08 * Math.sin(time * 4 + i));
    }
  }

  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
    this.gridTexture.dispose();
  }
}
