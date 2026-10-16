import * as THREE from 'three';

/**
 * Blockout geometry. Every brush sharing a material is merged into one
 * BufferGeometry, so the whole arena draws in a handful of calls — which is
 * the difference between smooth and unplayable on integrated graphics.
 *
 * UVs are derived from world position rather than per-face 0..1, so a grid
 * texture tiles at a constant size whatever the brush dimensions.
 */

const FACES = [
  // normal, and the two world axes that span the face
  { n: [1, 0, 0], u: 'z', v: 'y', sign: 1, axis: 'x' },
  { n: [-1, 0, 0], u: 'z', v: 'y', sign: -1, axis: 'x' },
  { n: [0, 1, 0], u: 'x', v: 'z', sign: 1, axis: 'y' },
  { n: [0, -1, 0], u: 'x', v: 'z', sign: -1, axis: 'y' },
  { n: [0, 0, 1], u: 'x', v: 'y', sign: 1, axis: 'z' },
  { n: [0, 0, -1], u: 'x', v: 'y', sign: -1, axis: 'z' },
];

const AXES = ['x', 'y', 'z'];

/**
 * @param {{min:object,max:object}[]} boxes
 * @param {number} tile world units per texture tile
 */
export function mergeBoxes(boxes, tile = 2) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (const box of boxes) {
    for (const face of FACES) {
      const base = positions.length / 3;
      const fixed = face.sign > 0 ? box.max[face.axis] : box.min[face.axis];

      // Four corners of the face, in ring order around it.
      const corners = [
        [box.min[face.u], box.min[face.v]],
        [box.max[face.u], box.min[face.v]],
        [box.max[face.u], box.max[face.v]],
        [box.min[face.u], box.max[face.v]],
      ];
      const points = corners.map(([cu, cv]) => {
        const point = { [face.axis]: fixed, [face.u]: cu, [face.v]: cv };
        return AXES.map((axis) => point[axis]);
      });

      for (let c = 0; c < 4; c++) {
        positions.push(...points[c]);
        normals.push(...face.n);
        uvs.push(corners[c][0] / tile, corners[c][1] / tile);
      }

      // Derive the winding instead of hard-coding it per face: whether the
      // ring order above is clockwise depends on the handedness of each
      // (axis, u, v) triple, which is exactly the sort of thing that is
      // invisible in review and black on screen. Wind it counter-clockwise as
      // seen from outside, or three.js culls the face you meant to see and
      // leaves you looking at the unlit inside of the brush.
      const e1 = points[1].map((value, i) => value - points[0][i]);
      const e2 = points[2].map((value, i) => value - points[0][i]);
      const geometric = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const outward = geometric[0] * face.n[0] + geometric[1] * face.n[1] + geometric[2] * face.n[2];
      if (outward > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A grid texture drawn on a canvas — no asset to download, and it gives the
 * blockout its graph-paper read at basically zero cost.
 */
export function makeGridTexture(size = 128, lineAlpha = 0.16) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = `rgba(0, 0, 0, ${lineAlpha})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  ctx.strokeStyle = `rgba(0, 0, 0, ${lineAlpha * 0.4})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 1; // keep it cheap; the grid does not need sharpening
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
