import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBoxes } from '../src/render/geometry.js';

/**
 * Winding is invisible in code review and catastrophic on screen: get it
 * backwards and every surface you should see is culled, leaving you looking
 * at the unlit inside of the brush. So assert it arithmetically.
 */
test('every merged triangle winds outward, matching its vertex normal', () => {
  const boxes = [
    { min: { x: -2, y: -1, z: -3 }, max: { x: 2, y: 1, z: 3 } },
    { min: { x: 10, y: 0, z: 10 }, max: { x: 11, y: 5, z: 12 } },
  ];
  const geometry = mergeBoxes(boxes, 2);
  const pos = geometry.attributes.position.array;
  const nor = geometry.attributes.normal.array;
  const idx = geometry.index.array;

  assert.equal(idx.length, boxes.length * 6 * 6, 'expected 12 triangles per box');

  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const v = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const [ax, ay, az] = v(a);
    const [bx, by, bz] = v(b);
    const [cx, cy, cz] = v(c);

    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    const face = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const declared = [nor[a * 3], nor[a * 3 + 1], nor[a * 3 + 2]];
    const dot = face[0] * declared[0] + face[1] * declared[1] + face[2] * declared[2];

    assert.ok(dot > 0,
      `triangle ${t / 3} winds inward: face normal ${face} vs declared ${declared}`);
  }
});

test('UVs scale with world size so the grid tiles evenly', () => {
  const small = mergeBoxes([{ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }], 2);
  const large = mergeBoxes([{ min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 2, z: 8 } }], 2);

  const span = (geo, stride) => {
    const uv = geo.attributes.uv.array;
    let min = Infinity;
    let max = -Infinity;
    for (let i = stride; i < uv.length; i += 2) { min = Math.min(min, uv[i]); max = Math.max(max, uv[i]); }
    return max - min;
  };
  // A box four times as wide must cover four times as many tiles, not stretch
  // one tile across the whole face.
  assert.equal(span(large, 0) / span(small, 0), 4);
});
