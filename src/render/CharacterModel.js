import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/**
 * The rigged fighter: one GLB loaded once, then cloned per actor.
 *
 * Relative URL on purpose: the build uses `base: './'` so the site works from
 * a GitHub Pages subpath, and public/ is served next to index.html.
 */
const MODEL_URL = 'models/soldier.glb';

let loading = null;
let loaded = null;

/**
 * Load the shared model. Resolves to `{ scene, animations, height }`, or null
 * if it could not be loaded — callers then draw box fighters instead, so a
 * flaky connection still gets a match.
 */
export function preloadCharacterModel() {
  loading ??= new GLTFLoader().loadAsync(MODEL_URL).then(
    (gltf) => {
      const scene = gltf.scene;
      // Measured in bind pose, which for a Mixamo rig is a T-pose: arms
      // sideways, so the vertical extent is the standing height.
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const height = box.max.y - box.min.y;
      if (!(height > 0)) throw new Error(`${MODEL_URL} has no measurable height`);
      loaded = { scene, animations: gltf.animations, height, footY: box.min.y };
      return loaded;
    },
  ).catch((err) => {
    console.warn(`fighter model unavailable, using box fighters: ${err?.message ?? err}`);
    return null;
  });
  return loading;
}

/**
 * A fresh, independently animatable copy of the model, or null if it has not
 * loaded. Skinned meshes must go through SkeletonUtils.clone — a plain
 * .clone() leaves every copy bound to the original's bones.
 *
 * Materials are cloned per instance so hit flashes and status tints stay on
 * the fighter they belong to. Geometry and textures stay shared.
 */
export function instantiateCharacter() {
  if (!loaded) return null;
  const root = cloneSkinned(loaded.scene);
  const materials = [];
  const swapped = new Map();
  root.traverse((node) => {
    if (!node.isMesh) return;
    // Animated skins move out of their static bounds, which makes them pop
    // out of view at the edge of the screen.
    node.frustumCulled = false;
    const list = Array.isArray(node.material) ? node.material : [node.material];
    const cloned = list.map((m) => {
      if (!swapped.has(m)) {
        const copy = m.clone();
        swapped.set(m, copy);
        materials.push(copy);
      }
      return swapped.get(m);
    });
    node.material = Array.isArray(node.material) ? cloned : cloned[0];
  });
  return {
    root,
    materials,
    animations: loaded.animations,
    height: loaded.height,
    footY: loaded.footY,
  };
}

/**
 * GLTFLoader strips characters three.js reserves for property paths, so the
 * file's `mixamorig:Head` arrives as `mixamorigHead`. Accept either spelling.
 */
export function findBone(root, name) {
  return root.getObjectByName(name)
    ?? root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name))
    ?? null;
}
