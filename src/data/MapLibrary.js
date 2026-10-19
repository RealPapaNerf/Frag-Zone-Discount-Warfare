/**
 * Arenas fetched from a map library at boot.
 *
 * A map library is a static folder with an `index.json` listing one folder per
 * map — the same library Flightline reads its terrain out of, because the two
 * games share storage and an index, not a geometry model. Every entry carries
 * a `kind`; this file takes the ones that say `arena` and ignores the rest.
 * The format is written by `flmap index`, in the terrain-and-maps-builder
 * repo, and `flmap arena` is what puts an arena into one.
 *
 * Two deliberate decisions.
 *
 * **Every arena is fetched at boot, not when it is picked.** An arena is one
 * small JSON document (the two shipped maps are 31 and 63 KB), and fetching
 * them all up front means `content.maps` is complete before the lobby is
 * built. Everything downstream — the lobby list, the loader, LocalHost,
 * PeerHost, and a guest's RemoteHost rebuilding the arena from an id the host
 * sent — then needs no idea that a library exists. Lazy loading would buy a
 * little bandwidth and cost a code path in all five. `MAX_ARENAS` is the
 * guard if a library ever grows past the point where that trade holds.
 *
 * **A library can never stop the game booting.** It is someone else's server.
 * Every failure here is reported and swallowed: no index, a bad index, one
 * map that 404s, a document the content loader rejects. You get the bundled
 * maps and a note saying what did not arrive.
 */

/** Where the public library lives. Also Flightline's `DEFAULT_LIBRARY`. */
export const DEFAULT_LIBRARY = 'https://realpapanerf.github.io/maps-folder/';

/** Past this many arenas, eager loading stops paying — see the note above. */
export const MAX_ARENAS = 24;

const LIB_FORMAT = /^flightline-maps\/1(\b|$)/;
const STORAGE_KEY = 'fragzone.mapLibrary';

const join = (base, rel) =>
  (/^https?:\/\//i.test(rel) ? rel : base.replace(/\/*$/, '/') + rel.replace(/^\/+/, ''));

/**
 * Can this build reach another server at all? Checked by origin rather than
 * by fetching and waiting for a timeout, which would sit in front of the
 * lobby for the length of the timeout every single boot.
 */
function canFetchRemote() {
  if (typeof location === 'undefined') return false;
  return !['blob:', 'data:', 'file:'].includes(location.protocol);
}

/**
 * Which library to read, if any.
 *
 * `?library=URL` wins, so a link can point someone at a library for one
 * session without changing anything they have set. `?library=off` turns it
 * off the same way, which is the fast answer when a library is down or slow
 * and you want to play. Otherwise a URL saved in localStorage, otherwise the
 * public one.
 *
 * @param {string} [search] a location.search string, injectable for tests
 * @param {Storage} [storage]
 * @returns {string|null} the library base URL, or null for "do not use one"
 */
export function libraryUrl(search, storage) {
  if (!canFetchRemote()) return null;
  const params = new URLSearchParams(
    search ?? (typeof location === 'undefined' ? '' : location.search));

  const asked = params.get('library');
  if (asked !== null) {
    const v = asked.trim();
    if (v === '' || ['off', 'none', 'no', '0'].includes(v.toLowerCase())) return null;
    return v;
  }

  // Private browsing and blocked site data both throw on access, not on read.
  try {
    const saved = (storage ?? localStorage).getItem(STORAGE_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch { /* no stored preference available */ }

  return DEFAULT_LIBRARY;
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Fetch every arena a library lists.
 *
 * Resolves even when things go wrong: `arenas` is what arrived and `failures`
 * says what did not and why, so the caller can get on with booting and still
 * tell the player something useful.
 *
 * @param {string} base library base URL
 * @param {object} [opts] signal, fetchJson (injectable for tests)
 * @returns {Promise<{base: string, name: string, updated: string,
 *   arenas: object[], failures: {id: string, error: string}[], skipped: number}>}
 */
export async function fetchArenas(base, opts = {}) {
  const read = opts.fetchJson ?? ((url) => getJSON(url, opts.signal));
  const lib = base.replace(/\/*$/, '/');
  const failures = [];

  let index;
  try {
    index = await read(join(lib, 'index.json'));
  } catch (e) {
    throw new Error(`${join(lib, 'index.json')}: ${e.message}`);
  }
  if (!LIB_FORMAT.test(String(index?.format ?? ''))) {
    throw new Error(`${lib} is not a version 1 map library (format: ${index?.format ?? 'missing'})`);
  }

  // `kind` is what tells the two games apart. An index written before arenas
  // existed has no `kind` at all, and every map in it is terrain — so a
  // missing kind must read as terrain, never as "take it and hope".
  const listed = (index.maps ?? []).filter((m) => m && m.id && m.path && m.kind === 'arena');
  const entries = listed.slice(0, MAX_ARENAS);
  const skipped = listed.length - entries.length;

  const docs = await Promise.all(entries.map(async (entry) => {
    try {
      const doc = await read(join(join(lib, entry.path), 'map.json'));
      // The index is a summary the library wrote; the document is the map.
      // Where they disagree the document wins, because it is what gets
      // played — but an id mismatch means the index cannot be trusted to
      // find it again, so say so rather than quietly renaming it.
      if (doc?.id && entry.id !== doc.id) {
        failures.push({ id: entry.id, error: `the index calls it "${entry.id}" but the document says "${doc.id}"` });
        return null;
      }
      return doc;
    } catch (e) {
      failures.push({ id: entry.id, error: e.message });
      return null;
    }
  }));

  return {
    base: lib,
    name: index.name ?? 'Map library',
    updated: index.updated ?? '',
    arenas: docs.filter(Boolean),
    failures,
    skipped,
  };
}
