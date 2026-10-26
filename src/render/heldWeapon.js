import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildParts } from './parts.js';

/**
 * The weapon a fighter is seen carrying: the same parts list the first-person
 * view model is built from, at the same real-world scale.
 *
 * Built parts are one mesh per part, and every mesh is a draw call. A lobby
 * of fighters each holding a fifteen-part rotisserie would cost more than the
 * arena, so the parts are merged into one mesh per material, and the result
 * is built once per weapon and shared by everyone holding it.
 */

/** Weapon id → a template group; geometry and materials live forever. */
const CACHE = new Map();

function template(weapon) {
  const view = weapon.view ?? {};
  const built = buildParts(view.parts ?? [], { body: view.color, accent: view.accent });
  built.group.updateMatrixWorld(true);

  const out = new THREE.Group();
  const byMaterial = new Map();
  const kept = new Set();
  for (const mesh of built.group.children) {
    // Decals each carry their own texture, so there is nothing to merge
    // them with; they stay meshes of their own.
    if (mesh.material.map) {
      out.add(mesh.clone());
      kept.add(mesh.geometry);
      continue;
    }
    // Shapes disagree on which attributes they carry and whether they are
    // indexed; normalising to position and normal is what lets them merge.
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.applyMatrix4(mesh.matrixWorld);
    if (!byMaterial.has(mesh.material)) byMaterial.set(mesh.material, []);
    byMaterial.get(mesh.material).push(geo);
  }
  for (const [material, geos] of byMaterial) {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (merged) out.add(new THREE.Mesh(merged, material));
  }
  for (const g of built.geometries) if (!kept.has(g)) g.dispose();
  return out;
}

/** A group to hang in a fighter's hand, or null for a weapon with no parts. */
export function heldWeapon(weapon) {
  if (!weapon?.view?.parts?.length) return null;
  if (!CACHE.has(weapon.id)) CACHE.set(weapon.id, template(weapon));
  // Clones share the template's geometry and materials.
  return CACHE.get(weapon.id).clone();
}
