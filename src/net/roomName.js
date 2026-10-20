/**
 * Room names are shared out loud, so be forgiving about how they are typed.
 *
 * In its own file because the lobby needs it at boot (to build invite links
 * and read ?join=), and importing rooms.js there would drag trystero into the
 * boot bundle for everyone who only ever plays solo.
 */
export function normaliseRoom(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}
