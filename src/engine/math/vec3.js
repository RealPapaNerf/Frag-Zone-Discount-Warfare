// Plain {x,y,z} vectors. The engine deliberately avoids THREE.Vector3 so the
// simulation can run in Node (tests) and, later, headless on a host peer.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const clone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const set = (out, x, y, z) => { out.x = x; out.y = y; out.z = z; return out; };
export const copy = (out, a) => set(out, a.x, a.y, a.z);
export const add = (out, a, b) => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (out, a, b) => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (out, a, s) => set(out, a.x * s, a.y * s, a.z * s);
export const addScaled = (out, a, b, s) => set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSq = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a) => Math.sqrt(lengthSq(a));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distanceSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export function normalize(out, a) {
  const len = length(a);
  return len > 1e-9 ? scale(out, a, 1 / len) : set(out, 0, 0, 0);
}

export function cross(out, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return set(out, x, y, z);
}

export function lerp(out, a, b, t) {
  return set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

/** Forward unit vector for a yaw/pitch pair (yaw 0 looks down -Z, Three.js style). */
export function dirFromAngles(out, yaw, pitch) {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Yaw/pitch for a direction; inverse of dirFromAngles. */
export function anglesFromDir(dir) {
  const horizontal = Math.hypot(dir.x, dir.z);
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.atan2(dir.y, horizontal) };
}

export const toArray = (a) => [a.x, a.y, a.z];
export const fromArray = (arr) => ({ x: arr[0] || 0, y: arr[1] || 0, z: arr[2] || 0 });
export const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);
