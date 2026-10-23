import * as THREE from 'three';

/**
 * The shape vocabulary every item in the game is drawn with.
 *
 * A weapon, a deployable and a dropped pickup are all "a parts list" — an
 * array of primitives in the item's own JSON — so one builder serves all
 * three and a new item needs no code. This file is that builder.
 *
 * It exists because the old vocabulary was two shapes (box, z-cylinder) with
 * no labels, and under it every weapon in the game came out as the same
 * L-shaped stack of three boxes in a different colour. A Ped Egg, a Ginsu
 * knife and a pulse rifle were pixel-identical in silhouette. The jokes are
 * the content of this game and they were all landing face down, so the fix
 * is a vocabulary wide enough to make a silhouette, plus text on the side of
 * the thing for the ones a silhouette cannot carry.
 *
 * Authoring rule, and the reason this is usable from JSON by hand: **every
 * shape is specified by its bounding box**. `size: [x, y, z]` always means
 * the same thing, whatever `shape` is. A sphere of size [0.2, 0.1, 0.2] is
 * an ellipsoid 20cm across and 10cm tall. You never compute a radius.
 *
 * Weapons face −Z, the way the camera does.
 */

/** Round shapes are deliberately coarse: the game's look is chunky, and a
 *  32-segment cylinder in the corner of the screen costs more and reads the
 *  same as a 10-segment one. */
const SEGMENTS = 10;

const DEG = Math.PI / 180;

/** Orient a geometry built along +Y so its long axis points down `axis`. */
function orient(geo, axis) {
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  else if (axis === 'x') geo.rotateZ(-Math.PI / 2);
  return geo;
}

/** The long axis length, and the two cross-section diameters, of a bounding box. */
function spans(size, axis) {
  const [sx, sy, sz] = size;
  if (axis === 'x') return { length: sx, cross: [sy, sz] };
  if (axis === 'y') return { length: sy, cross: [sx, sz] };
  return { length: sz, cross: [sx, sy] };
}

/**
 * A triangular prism: full width at −Y, tapering to a sharp edge at +Y,
 * extruded along Z. That is a knife blade — spine at the bottom, edge at the
 * top — and, rolled over with `rot`, a roof, a ramp or a sign's A-frame.
 */
function wedgeGeometry(sx, sy, sz) {
  const x = sx / 2;
  const y = sy / 2;
  const z = sz / 2;
  // Two triangular end caps and three quads, written out rather than
  // extruded so the normals are flat and the thing shades like a facet.
  const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  const tri = (a, b, c) => [...a, ...b, ...c];
  const A = [-x, -y, z], B = [x, -y, z], C = [0, y, z];
  const D = [-x, -y, -z], E = [x, -y, -z], F = [0, y, -z];

  const position = [
    ...tri(A, B, C),           // front cap
    ...tri(E, D, F),           // back cap
    ...quad(D, E, B, A),       // base
    ...quad(B, E, F, C),       // +X slope
    ...quad(D, A, C, F),       // −X slope
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Geometry for one part, sized to its bounding box.
 *
 * `taper` is carried over from the old two-shape vocabulary unchanged: it is
 * the *diameter of the far end* (−Z, the muzzle end on a weapon), so the
 * weapons written against the old builder still come out the same shape.
 */
export function partGeometry(part) {
  const size = part.size ?? [0.1, 0.1, 0.1];
  const [sx, sy, sz] = size;
  const axis = part.axis ?? 'z';
  const shape = part.shape ?? 'box';
  const seg = part.segments ?? SEGMENTS;

  switch (shape) {
    case 'cylinder':
    case 'cone':
    case 'disc': {
      const { length, cross } = spans(size, axis);
      const far = shape === 'cone' ? 0 : part.taper != null ? part.taper / cross[0] : 1;
      // `arc` opens the shape up into a part-cylinder: a saw's blade guard,
      // a half pipe, a scoop. Measured in degrees from the +X side.
      const arc = ((part.arc ?? 360) * Math.PI) / 180;
      const start = ((part.arcStart ?? 0) * Math.PI) / 180;
      // Top is the +axis end (the rear of a weapon); bottom is the far end.
      const geo = new THREE.CylinderGeometry(
        0.5, 0.5 * far, 1, seg, 1, part.open ?? false, start, arc,
      );
      geo.scale(cross[0], length, cross[1]);
      return orient(geo, axis);
    }
    case 'sphere': {
      const geo = new THREE.SphereGeometry(0.5, seg, Math.max(4, Math.round(seg / 2)));
      geo.scale(sx, sy, sz);
      return geo;
    }
    case 'capsule': {
      const { length, cross } = spans(size, axis);
      const radius = Math.min(cross[0], cross[1]) / 2;
      const body = Math.max(0.0001, length - radius * 2);
      const geo = new THREE.CapsuleGeometry(radius, body, 2, seg);
      // Keep the cross-section honest when the bounding box is not round.
      if (axis === 'x') geo.scale(1, 1, cross[1] / cross[0]);
      else geo.scale(1, 1, cross[1] / cross[0]);
      return orient(geo, axis);
    }
    case 'torus': {
      // Built at its true size rather than at unit size and scaled: scaling
      // a torus squashes the tube along with the ring, which turns a spring
      // coil into a flat washer.
      const { cross } = spans(size, axis);
      const outer = Math.max(cross[0], cross[1]);
      const tube = (part.tube ?? outer * 0.26) / 2;
      const ring = Math.max(0.001, outer / 2 - tube);
      const geo = new THREE.TorusGeometry(ring, tube, 6, seg);
      // An oval ring is the ring stretched, with the tube left round.
      if (cross[1] !== cross[0]) geo.scale(cross[0] / outer, cross[1] / outer, 1);
      // TorusGeometry already lies in XY with its axis down Z.
      if (axis === 'y') geo.rotateX(Math.PI / 2);
      else if (axis === 'x') geo.rotateY(Math.PI / 2);
      return geo;
    }
    case 'wedge':
      return wedgeGeometry(sx, sy, sz);
    case 'plane':
    case 'decal':
      return new THREE.PlaneGeometry(sx, sy);
    case 'box':
    default:
      return new THREE.BoxGeometry(sx, sy, sz);
  }
}

const TILT = new THREE.Euler();
const TILT_Q = new THREE.Quaternion();

/** `facing` is sugar for the `rot` that points a flat part's +Z outward. */
const FACING = {
  pz: [0, 0, 0], nz: [0, 180, 0],
  px: [0, 90, 0], nx: [0, -90, 0],
  py: [-90, 0, 0], ny: [90, 0, 0],
};

// --- decals -----------------------------------------------------------------

/**
 * Text and packaging-art on the side of an item, drawn to a canvas.
 *
 * This is where most of the comedy actually lands. A silhouette can say
 * "handheld kitchen gadget"; only the word GINSU on the blade says which
 * one, and only a starburst reading AS SEEN ON TV says why it is funny that
 * you are holding it in a deathmatch.
 */
const DECAL_CACHE = new Map();

const FONTS = {
  sans: '900 <px>px Helvetica, Arial, sans-serif',
  condensed: '900 <px>px "Arial Narrow", Impact, sans-serif',
  serif: '700 <px>px Georgia, "Times New Roman", serif',
  script: 'italic 700 <px>px "Brush Script MT", "Segoe Script", cursive',
};

/** A spiky retail starburst — the "AS SEEN ON TV" badge, essentially. */
function drawBurst(ctx, w, h, color, points = 14) {
  const cx = w / 2;
  const cy = h / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const t = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 0.5 : 0.38;
    const x = cx + Math.cos(t) * w * r;
    const y = cy + Math.sin(t) * h * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** Evenly spaced holes — a cheese grater, a speaker grille, a Ped Egg. */
function drawHoles(ctx, w, h, color, cols = 7) {
  ctx.fillStyle = color;
  const rows = Math.max(2, Math.round((cols * h) / w));
  const r = Math.min(w / cols, h / rows) * 0.22;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ox = ((x + 0.5) / cols) * w + (y % 2 ? w / cols / 2 : 0);
      const oy = ((y + 0.5) / rows) * h;
      if (ox > w - r) continue;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Parallel bars — grill grates, vents, a radiator. */
function drawRibs(ctx, w, h, color, count = 6) {
  ctx.fillStyle = color;
  const gap = h / (count * 2 - 1);
  for (let i = 0; i < count; i++) ctx.fillRect(0, i * gap * 2, w, gap);
}

/**
 * The falling figure off a wet floor sign. Drawn rather than described,
 * because "CAUTION" in three languages is not the joke — the little man
 * going over backwards is.
 */
function drawSlip(ctx, w, h, color) {
  const u = Math.min(w, h) / 100;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.42);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = 9 * u;
  // Head, body, the leg shooting out from under him, the flailing arms.
  ctx.beginPath();
  ctx.arc(0, -30 * u, 9 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -20 * u); ctx.lineTo(2 * u, 8 * u);
  ctx.moveTo(2 * u, 8 * u); ctx.lineTo(30 * u, 26 * u);
  ctx.moveTo(2 * u, 8 * u); ctx.lineTo(-16 * u, 34 * u);
  ctx.moveTo(0, -14 * u); ctx.lineTo(-24 * u, -26 * u);
  ctx.moveTo(0, -10 * u); ctx.lineTo(26 * u, -22 * u);
  ctx.stroke();
  ctx.restore();
  // The floor he is going down on, and the splash under it.
  ctx.lineWidth = 6 * u;
  ctx.beginPath();
  ctx.moveTo(w * 0.12, h * 0.84); ctx.lineTo(w * 0.88, h * 0.84);
  ctx.stroke();
  ctx.lineWidth = 4 * u;
  for (let i = 0; i < 3; i++) {
    const x = w * (0.3 + i * 0.2);
    ctx.beginPath();
    ctx.moveTo(x, h * 0.9); ctx.lineTo(x + 8 * u, h * 0.95);
    ctx.stroke();
  }
}

/**
 * @param {object} spec `{ text, color, bg, font, style, lines, pad }`
 * @returns {THREE.CanvasTexture}
 */
export function decalTexture(spec) {
  const key = JSON.stringify(spec);
  if (DECAL_CACHE.has(key)) return DECAL_CACHE.get(key);

  const w = spec.width ?? 256;
  const h = spec.height ?? 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (spec.bg) {
    ctx.fillStyle = spec.bg;
    ctx.fillRect(0, 0, w, h);
  }
  if (spec.style === 'burst') drawBurst(ctx, w, h, spec.burstColor ?? '#ff3b2f', spec.points);
  if (spec.style === 'holes') drawHoles(ctx, w, h, spec.markColor ?? 'rgba(0,0,0,0.75)', spec.count);
  if (spec.style === 'ribs') drawRibs(ctx, w, h, spec.markColor ?? 'rgba(0,0,0,0.6)', spec.count);
  if (spec.style === 'slip') drawSlip(ctx, w, h, spec.markColor ?? '#1b1b1b');

  if (spec.border) {
    ctx.strokeStyle = spec.border;
    ctx.lineWidth = Math.max(2, h * 0.05);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }

  const lines = spec.lines ?? (spec.text ? [spec.text] : []);
  if (lines.length) {
    const family = FONTS[spec.font ?? 'condensed'] ?? FONTS.condensed;
    const pad = (spec.pad ?? 0.1) * w;
    const lineH = h / lines.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      // Fit each line to the plate rather than trusting a font size: the
      // label has to stay legible whatever the author types.
      let px = lineH * 0.82;
      ctx.font = family.replace('<px>', String(Math.round(px)));
      const over = ctx.measureText(lines[i]).width / (w - pad * 2);
      if (over > 1) {
        px /= over;
        ctx.font = family.replace('<px>', String(Math.round(px)));
      }
      const y = lineH * (i + 0.5);
      if (spec.outline) {
        ctx.lineWidth = px * 0.16;
        ctx.strokeStyle = spec.outline;
        ctx.lineJoin = 'round';
        ctx.strokeText(lines[i], w / 2, y);
      }
      ctx.fillStyle = spec.color ?? '#101418';
      ctx.fillText(lines[i], w / 2, y);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  DECAL_CACHE.set(key, texture);
  return texture;
}

// --- materials ---------------------------------------------------------------

/**
 * `finish` is how a part catches the light, and it does real work for
 * readability: a chrome blade and a plastic handle made of the same grey are
 * two different objects as soon as one of them has a highlight on it.
 *
 * Phong rather than Standard because a metal in Standard needs an
 * environment map to be anything but black, and this game ships no assets.
 */
function materialFor(finish, color, opts = {}) {
  const base = { color: new THREE.Color(color), ...opts };
  switch (finish) {
    case 'metal':
      return new THREE.MeshPhongMaterial({ ...base, shininess: 110, specular: 0xb9c6d4 });
    case 'plastic':
      return new THREE.MeshPhongMaterial({ ...base, shininess: 34, specular: 0x4a5058 });
    case 'glow':
      return new THREE.MeshLambertMaterial({ ...base, emissive: new THREE.Color(color), emissiveIntensity: 0.8 });
    case 'matte':
    default:
      return new THREE.MeshLambertMaterial(base);
  }
}

/**
 * Builds a parts list into a group, with every material and geometry it
 * created listed for disposal.
 *
 * @param {object[]} parts the item's `view.parts`
 * @param {{body?:string, accent?:string}} palette the item's two named colours
 * @returns {{group:THREE.Group, materials:THREE.Material[], geometries:THREE.BufferGeometry[]}}
 */
export function buildParts(parts, palette = {}) {
  const body = palette.body ?? '#9aa6b2';
  const accent = palette.accent ?? '#36e0ff';
  const group = new THREE.Group();
  const materials = [];
  const geometries = [];
  // One material per (colour, finish) pair across the whole item, so a
  // fifteen-part model is still only a handful of draw calls.
  const cache = new Map();

  const resolve = (name) => (name === 'accent' ? accent : !name || name === 'body' ? body : name);

  const material = (part) => {
    const color = resolve(part.color);
    const finish = part.finish ?? 'matte';
    const key = `${color}|${finish}|${part.opacity ?? 1}`;
    if (!cache.has(key)) {
      const opts = part.opacity != null && part.opacity < 1
        ? { transparent: true, opacity: part.opacity }
        : {};
      const mat = materialFor(finish, color, opts);
      // Remembered so a caller that fades the whole item — a deployable
      // still arming, say — can scale each part's opacity without losing
      // the part's own.
      mat.userData.baseOpacity = part.opacity ?? 1;
      mat.userData.wasTransparent = part.opacity != null && part.opacity < 1;
      cache.set(key, mat);
      materials.push(mat);
    }
    return cache.get(key);
  };

  for (const part of parts ?? []) {
    let mesh;
    if (part.shape === 'decal') {
      const [sx, sy] = part.size ?? [0.1, 0.1];
      const geo = new THREE.PlaneGeometry(sx, sy);
      geometries.push(geo);
      const mat = new THREE.MeshLambertMaterial({
        map: decalTexture(part),
        transparent: part.bg == null,
        side: THREE.DoubleSide,
        // The label sits on the surface of the part under it; without the
        // offset the two planes fight and the text strobes as you move.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      mat.userData.baseOpacity = 1;
      mat.userData.wasTransparent = part.bg == null;
      materials.push(mat);
      mesh = new THREE.Mesh(geo, mat);
    } else {
      const geo = partGeometry(part);
      geometries.push(geo);
      mesh = new THREE.Mesh(geo, material(part));
    }

    mesh.position.set(...(part.pos ?? [0, 0, 0]));
    // `facing` aims a flat part at one of the six directions; `rot` then
    // tilts it from there, about world axes. They compose rather than
    // override, because a label on a leaning sign needs both and the two
    // folded into one Euler is how you end up with mirrored text.
    if (part.facing && FACING[part.facing]) {
      const f = FACING[part.facing];
      mesh.rotation.set(f[0] * DEG, f[1] * DEG, f[2] * DEG);
      if (part.rot) {
        TILT.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);
        TILT_Q.setFromEuler(TILT);
        mesh.quaternion.premultiply(TILT_Q);
      }
    } else if (part.rot) {
      mesh.rotation.set(part.rot[0] * DEG, part.rot[1] * DEG, part.rot[2] * DEG);
    }
    if (part.scale) mesh.scale.set(...(Array.isArray(part.scale) ? part.scale : [part.scale, part.scale, part.scale]));
    if (part.name) mesh.name = part.name;
    group.add(mesh);
  }

  return { group, materials, geometries };
}
