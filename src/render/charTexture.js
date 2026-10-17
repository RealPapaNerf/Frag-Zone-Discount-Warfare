import * as THREE from 'three';

/**
 * One small canvas per character, holding the face in its top-left quadrant
 * and a flat white patch everywhere else. Body boxes point their UVs at the
 * white patch and show their vertex colour; the head's front face points at
 * the face square. So a whole fighter — body, limbs, face and all — is one
 * material and one draw call per limb.
 *
 * The face is drawn, not authored, so an expression is a redraw rather than
 * an asset. Hand it an image instead and it wraps that onto the head, which
 * is the entire point: your brother's face, at 128 pixels, looking betrayed.
 */

const SIZE = 256;
const FACE_PX = 128;
/** uv rect of the face square. Textures load flipped, so v runs 1 → 0.5. */
export const FACE_UV = [0, 0.5, 0.5, 1];
/** The single white texel every other face samples. */
export const BLANK_UV = [0.75, 0.25];

export const EXPRESSIONS = ['idle', 'angry', 'hurt', 'dead'];

function drawFace(ctx, look, expression) {
  const s = FACE_PX;
  const skin = look.head ?? '#d9b48a';

  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, s, s);

  // A touch of shading down the sides so the flat square reads as a face.
  const shade = ctx.createLinearGradient(0, 0, s, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.18)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, s, s);

  const eyeY = s * 0.42;
  const eyeDX = s * 0.21;
  const dead = expression === 'dead';
  const hurt = expression === 'hurt';
  const angry = expression === 'angry';

  // Eyes: whites, then pupils. The dead face gets crosses instead.
  for (const side of [-1, 1]) {
    const cx = s / 2 + side * eyeDX;
    if (dead) {
      ctx.strokeStyle = '#2b2b2b';
      ctx.lineWidth = s * 0.045;
      ctx.lineCap = 'round';
      const r = s * 0.075;
      ctx.beginPath();
      ctx.moveTo(cx - r, eyeY - r); ctx.lineTo(cx + r, eyeY + r);
      ctx.moveTo(cx + r, eyeY - r); ctx.lineTo(cx - r, eyeY + r);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath();
    ctx.ellipse(cx, eyeY, s * 0.085, s * (hurt ? 0.1 : 0.072), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#23303d';
    const look_ = hurt ? -s * 0.02 : 0;
    ctx.beginPath();
    ctx.ellipse(cx + look_, eyeY + (hurt ? s * 0.012 : 0), s * 0.038, s * 0.042, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Brows do most of the acting.
  if (!dead) {
    ctx.strokeStyle = look.brow ?? '#3a2a1e';
    ctx.lineWidth = s * 0.055;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const cx = s / 2 + side * eyeDX;
      const tilt = angry ? side * -s * 0.045 : hurt ? side * s * 0.05 : 0;
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.09, eyeY - s * 0.14 - tilt);
      ctx.lineTo(cx + s * 0.09, eyeY - s * 0.14 + tilt);
      ctx.stroke();
    }
  }

  // Nose: a shadow under the geometry nose that sticks out of the head.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.moveTo(s / 2, eyeY + s * 0.04);
  ctx.lineTo(s / 2 + s * 0.07, eyeY + s * 0.2);
  ctx.lineTo(s / 2 - s * 0.07, eyeY + s * 0.2);
  ctx.closePath();
  ctx.fill();

  // Mouth.
  const mouthY = s * 0.72;
  ctx.strokeStyle = '#4a2f2a';
  ctx.fillStyle = '#4a2f2a';
  ctx.lineWidth = s * 0.04;
  ctx.beginPath();
  if (dead) {
    ctx.ellipse(s / 2, mouthY, s * 0.07, s * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (hurt) {
    ctx.ellipse(s / 2, mouthY, s * 0.1, s * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (angry) {
    ctx.moveTo(s / 2 - s * 0.13, mouthY + s * 0.05);
    ctx.lineTo(s / 2 + s * 0.13, mouthY + s * 0.05);
    ctx.stroke();
    ctx.fillStyle = '#fdfdfd';
    ctx.fillRect(s / 2 - s * 0.1, mouthY - s * 0.02, s * 0.2, s * 0.05);
  } else {
    ctx.arc(s / 2, mouthY - s * 0.05, s * 0.13, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }
}

/**
 * @param {object} look the character's `appearance` block
 * @returns {{texture: THREE.CanvasTexture, setExpression: Function,
 *   setImage: Function, dispose: Function}}
 */
export function makeCharacterTexture(look = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Everything outside the face square is the flat white the body samples.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  let photo = null; // once a picture is wrapped on, expressions stop redrawing
  let current = null;

  function setExpression(expression) {
    if (photo || current === expression) return;
    current = expression;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, FACE_PX, FACE_PX);
    ctx.clip();
    drawFace(ctx, look, expression);
    ctx.restore();
    texture.needsUpdate = true;
  }

  /**
   * Wrap a picture onto the face. Cover-fits it into the square so a phone
   * photo is cropped rather than squashed, and leaves the drawn face in
   * place if the image never arrives.
   */
  function setImage(image) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    if (!iw || !ih) return;
    const scale = Math.max(FACE_PX / iw, FACE_PX / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, FACE_PX, FACE_PX);
    ctx.clip();
    ctx.drawImage(image, (FACE_PX - w) / 2, (FACE_PX - h) / 2, w, h);
    ctx.restore();
    photo = true;
    texture.needsUpdate = true;
  }

  setExpression('idle');

  return {
    texture,
    setExpression,
    setImage,
    get hasPhoto() { return !!photo; },
    dispose() { texture.dispose(); },
  };
}

/**
 * Load `appearance.faceTexture` and wrap it on when it arrives. Failure is
 * not an error worth stopping for — the drawn face is already on the head,
 * so a missing or blocked image just means it stays.
 */
export function loadFaceImage(url, onReady) {
  if (!url) return;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => onReady(image);
  image.onerror = () => console.warn(`face image did not load: ${url}`);
  image.src = url;
}
