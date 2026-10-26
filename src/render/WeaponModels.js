import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildParts } from './parts.js';

/**
 * Modelled weapons: a weapon whose `view.model.url` names a GLB is drawn
 * from that file instead of its parts list.
 *
 * The arena guns come from one low-poly pack whose models all colour
 * themselves from a single palette atlas, so the atlas is loaded once and
 * every model shares one material. A model that fails to load — or an atlas
 * that does — leaves the weapon on its parts list, the same way a fighter
 * whose model never arrived is built from boxes.
 *
 * URLs are relative, for the `base: './'` build, like the fighter model.
 */
const ATLAS_URL = 'models/weapons/atlas.png';
const DEG = Math.PI / 180;

/** url → loaded scene, for the models that arrived. */
const templates = new Map();
let loading = null;

/**
 * Load every model the content names. Resolves to how many loaded; never
 * rejects, because a weapon without its model still works.
 *
 * @param {Record<string, object>} weapons content weapons
 * @param {{base?: string}} [opts] prefix for the relative URLs, for a page
 *   that is not served from the site root
 */
export function preloadWeaponModels(weapons, { base = '' } = {}) {
  const urls = [...new Set(Object.values(weapons ?? {})
    .map((w) => w.view?.model?.url)
    .filter(Boolean))];
  if (urls.length === 0) return Promise.resolve(0);

  loading ??= (async () => {
    let atlas;
    try {
      atlas = await new THREE.TextureLoader().loadAsync(base + ATLAS_URL);
    } catch {
      console.warn('weapon atlas unavailable, using built weapons');
      return 0;
    }
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.magFilter = THREE.NearestFilter;
    const material = new THREE.MeshLambertMaterial({ map: atlas });
    material.userData.baseOpacity = 1;
    material.userData.wasTransparent = false;

    const loader = new GLTFLoader();
    await Promise.all(urls.map(async (url) => {
      try {
        const gltf = await loader.loadAsync(base + url);
        gltf.scene.traverse((node) => {
          if (!node.isMesh) return;
          node.material = material;
          // Shared by every copy; whoever holds a copy must not free it.
          node.userData.sharedGeometry = true;
        });
        templates.set(url, gltf.scene);
      } catch (err) {
        console.warn(`weapon model unavailable, using built weapon: ${url} (${err?.message ?? err})`);
      }
    }));
    return templates.size;
  })();
  return loading;
}

/**
 * The weapon's shape, ready to add to a scene, with whatever the caller now
 * owns listed for disposal.
 *
 * @param {object} weapon content weapon
 * @param {object[]} [fallbackParts] parts to build if the weapon has neither
 *   a loaded model nor parts of its own
 * @returns {{group: THREE.Group, materials: THREE.Material[],
 *   geometries: THREE.BufferGeometry[], modelled: boolean}}
 */
export function buildWeaponView(weapon, fallbackParts = []) {
  const view = weapon?.view ?? {};
  const template = view.model?.url ? templates.get(view.model.url) : null;
  if (template) {
    const group = new THREE.Group();
    const model = template.clone();
    const spec = view.model;
    if (spec.pos) model.position.set(...spec.pos);
    if (spec.rot) model.rotation.set(spec.rot[0] * DEG, spec.rot[1] * DEG, spec.rot[2] * DEG);
    if (spec.scale) model.scale.setScalar(spec.scale);
    // Each holder gets its own material, because pickups fade theirs while
    // they settle and that must not fade the gun in your hands. The atlas
    // texture itself stays shared.
    const materials = [];
    model.traverse((node) => {
      if (!node.isMesh) return;
      node.material = node.material.clone();
      materials.push(node.material);
    });
    group.add(model);
    return { group, materials, geometries: [], modelled: true };
  }
  const parts = view.parts?.length ? view.parts : fallbackParts;
  const built = buildParts(parts, { body: view.color, accent: view.accent });
  return { ...built, modelled: false };
}
