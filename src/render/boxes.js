import * as THREE from 'three';

/**
 * Builds one BufferGeometry out of a pile of axis-aligned boxes, with the
 * colour baked into vertex colours and every face's UVs pointing at a region
 * of the character atlas.
 *
 * The point is draw calls. A fighter made of separately-coloured meshes costs
 * one draw call per mesh per actor, and a full lobby of eight puts the frame
 * well past what a Chromebook enjoys. Baking colour into the vertices lets a
 * whole limb — bone, hand, sleeve, shoe — share a single material, so the
 * model gets more detailed while the renderer does less work.
 *
 * Faces are wound counter-clockwise seen from outside, so backface culling
 * behaves and the existing geometry test's winding rule still holds.
 */

// Six faces as (normal, u axis, v axis). Each triple is right-handed —
// cross(u, v) === n — which is what makes the winding below come out correct.
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** The index into FACES that a part means by `faceDir: 'front'` and friends. */
export const DIR = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, back: 4, nz: 5, front: 5 };

const dot = (a, b) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);

/**
 * @param {Array<{pos:number[], size:number[], color:string|number,
 *   uv?:{dir:number, rect:number[]}}>} parts
 *   `uv` paints one face of that box with an atlas rect [u0,v0,u1,v1];
 *   every other face gets `blank`, a single flat texel.
 * @param {number[]} blank the [u,v] texel that means "just show the colour"
 */
export function buildBoxes(parts, blank = [0.75, 0.25]) {
  const position = [];
  const normal = [];
  const uv = [];
  const color = [];
  const index = [];
  const c = new THREE.Color();

  for (const part of parts) {
    const [cx, cy, cz] = part.pos;
    const [sx, sy, sz] = part.size;
    c.set(part.color);

    for (let f = 0; f < FACES.length; f++) {
      const { n, u, v } = FACES[f];
      // How wide the box is along this face's own u and v axes.
      const su = dot(u, [sx, sy, sz]);
      const sv = dot(v, [sx, sy, sz]);
      const base = position.length / 3;
      // Half the box's depth along this face's normal: how far out it sits.
      const half = dot(n, [sx, sy, sz]) / 2;

      const paint = part.uv && part.uv.dir === f ? part.uv.rect : null;
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];

      for (const [uu, vv] of corners) {
        position.push(
          cx + u[0] * (uu - 0.5) * su + v[0] * (vv - 0.5) * sv + n[0] * half,
          cy + u[1] * (uu - 0.5) * su + v[1] * (vv - 0.5) * sv + n[1] * half,
          cz + u[2] * (uu - 0.5) * su + v[2] * (vv - 0.5) * sv + n[2] * half,
        );
        normal.push(n[0], n[1], n[2]);
        if (paint) uv.push(paint[0] + (paint[2] - paint[0]) * uu, paint[1] + (paint[3] - paint[1]) * vv);
        else uv.push(blank[0], blank[1]);
        color.push(c.r, c.g, c.b);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}
