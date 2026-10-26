/**
 * Skins are recolours of a character's outfit — vertex colours only, no new
 * geometry or texture, so they ride the character pipeline that already
 * exists for `characterId` with no engine changes: pick a skin, it overrides
 * `appearance` before the renderer builds geometry, and ActorView's own
 * cache key (derived from those same colour fields) gives each skin its own
 * geometry automatically.
 *
 * Not character content, so these are not loaded from public/data/characters
 * — unlike maps, modes and weapons, a skin has no gameplay effect to review,
 * and keeping the list here means it ships with the client bundle rather
 * than a fetch the lobby would have to wait on.
 */

export const SKINS = [
  { id: 'classic', name: 'Classic' }, // no overrides: whatever the character ships with
  {
    id: 'desert', name: 'Desert',
    colors: { body: '#c2a878', trousers: '#8a7149', boots: '#4a3f2e', accent: '#d94f2b', hair: '#5a4632' },
  },
  {
    id: 'nightops', name: 'Night Ops',
    colors: { body: '#2b2f38', trousers: '#1c1f26', boots: '#0e0f12', accent: '#4fd1ff', hair: '#141414' },
  },
  {
    id: 'hazard', name: 'Hazard',
    colors: { body: '#f2b705', trousers: '#2b2f38', boots: '#1c1f26', accent: '#d92b2b', hair: '#2f2a26' },
  },
];

const BY_ID = new Map(SKINS.map((s) => [s.id, s]));

export const DEFAULT_SKIN = 'classic';

export function skinById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * A representative colour for a swatch button. Classic has no overrides of
 * its own, so it borrows the character's own body colour — the picker should
 * show what you already look like, not a blank.
 */
export function swatchColor(skin, character) {
  return skin.colors?.body ?? character?.appearance?.body ?? '#4d6fa8';
}

/**
 * Overlay a skin's colours onto a character's appearance. An unknown or
 * colourless skin (Classic) returns the character unchanged — this is also
 * what happens to a skin id a newer build invented that this one has never
 * heard of, which is why the net side only has to check the id is a safe
 * shape, not that it means something.
 */
export function withSkin(character, skinId) {
  const skin = skinById(skinId);
  if (!character || !skin?.colors) return character;
  return { ...character, appearance: { ...character.appearance, ...skin.colors } };
}
