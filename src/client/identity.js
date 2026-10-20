/**
 * Who you are, across matches: a name and, if you add one, a face.
 *
 * The face is stored as a small square JPEG data URL rather than a file
 * handle or a blob URL, because it has to go three places unchanged — into
 * localStorage, onto your own character's texture, and across the wire to
 * everyone else in the room. One string does all three.
 */

const KEY = 'fragzone.identity';

/** Matches the face square in charTexture.js: more pixels would never be seen. */
export const FACE_SIZE = 128;

/** Longest name the host will keep; the input and the clamp agree. */
export const NAME_MAX = 18;

export function loadIdentity() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, NAME_MAX) : '',
      face: typeof raw.face === 'string' && raw.face.startsWith('data:image/') ? raw.face : null,
    };
  } catch {
    return { name: '', face: null };
  }
}

export function saveIdentity({ name = '', face = null }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ name: name.slice(0, NAME_MAX), face }));
  } catch { /* private mode: identity lasts the session and no longer */ }
}

/**
 * Turn whatever file the picker handed over into the face string: cover-fit
 * onto a FACE_SIZE square (a phone photo is cropped, never squashed) and
 * compressed until it is small enough to send to strangers mid-match.
 *
 * @param {File} file
 * @returns {Promise<string>} a JPEG data URL
 */
export function faceFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const iw = image.naturalWidth;
      const ih = image.naturalHeight;
      if (!iw || !ih) { reject(new Error('that image has no pixels')); return; }

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = FACE_SIZE;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(FACE_SIZE / iw, FACE_SIZE / ih);
      const w = iw * scale;
      const h = ih * scale;
      ctx.drawImage(image, (FACE_SIZE - w) / 2, (FACE_SIZE - h) / 2, w, h);

      // 128px of face does not need much quality; drop it further only if a
      // pathological image (noise, confetti) refuses to compress.
      let out = canvas.toDataURL('image/jpeg', 0.82);
      if (out.length > 40000) out = canvas.toDataURL('image/jpeg', 0.5);
      resolve(out);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('that file could not be read as an image'));
    };
    image.src = url;
  });
}
