import { test } from 'node:test';
import assert from 'node:assert/strict';
import { content } from './helpers.mjs';
import { acceptMap, ContentError } from '../src/data/Content.js';
import { libraryUrl, fetchArenas, DEFAULT_LIBRARY, MAX_ARENAS } from '../src/data/MapLibrary.js';

/** Pretend to be a page served over https, which is what the checks read. */
function withLocation(search, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location');
  const before = globalThis.location;
  globalThis.location = { protocol: 'https:', search };
  try { return run(); } finally {
    if (had) globalThis.location = before; else delete globalThis.location;
  }
}

const noStorage = { getItem() { throw new Error('site data is blocked'); } };

const arena = (id, extra = {}) => ({
  format: 'fragzone-map/1', schema: 1, id, name: id,
  gravity: -22, killZ: -25,
  bounds: { min: [-20, -10, -20], max: [20, 15, 20] },
  brushes: [{ pos: [0, -0.5, 0], size: [40, 1, 40], material: 'floor' }],
  spawns: [{ pos: [0, 0.1, 8], yaw: 0 }],
  ...extra,
});

/** A library served out of a plain object, so no network is involved. */
function serve(files) {
  return async (url) => {
    const key = Object.keys(files).find((k) => url.endsWith(k));
    if (!key) throw new Error('404 Not Found');
    const v = files[key];
    if (v instanceof Error) throw v;
    return JSON.parse(JSON.stringify(v));
  };
}

const index = (maps) => ({ format: 'flightline-maps/1', name: 'Test library', updated: '2026-10-18', maps });

/* ------------------------------------------------------------- the URL */

test('?library wins over everything, including turning it off', () => {
  withLocation('?library=https://example.test/maps/', () => {
    assert.equal(libraryUrl(), 'https://example.test/maps/');
  });
  for (const off of ['off', 'none', 'NO', '0', '']) {
    withLocation(`?library=${off}`, () => {
      assert.equal(libraryUrl(), null, `?library=${off} should turn the library off`);
    });
  }
});

test('with nothing asked for, the public library is the default', () => {
  withLocation('', () => assert.equal(libraryUrl(undefined, noStorage), DEFAULT_LIBRARY));
});

test('a saved library is used, and blocked site data is not fatal', () => {
  withLocation('', () => {
    assert.equal(libraryUrl(undefined, { getItem: () => 'https://saved.test/' }), 'https://saved.test/');
    // Private browsing throws on access rather than returning null.
    assert.equal(libraryUrl(undefined, noStorage), DEFAULT_LIBRARY);
  });
});

test('a build that cannot reach another server asks for no library at all', () => {
  const before = globalThis.location;
  globalThis.location = { protocol: 'blob:', search: '?library=https://example.test/' };
  try { assert.equal(libraryUrl(), null); } finally { globalThis.location = before; }
});

/* --------------------------------------------------------- the fetching */

test('only entries that say they are arenas are fetched', async () => {
  const fetchJson = serve({
    'index.json': index([
      { id: 'terrain-map', path: 'terrain-map/', kind: 'terrain' },
      { id: 'legacy-map', path: 'legacy-map/' }, // written before `kind` existed
      { id: 'an-arena', path: 'an-arena/', kind: 'arena' },
    ]),
    'an-arena/map.json': arena('an-arena'),
    'terrain-map/map.json': { format: 'flightline-map/1', id: 'terrain-map' },
    'legacy-map/map.json': { format: 'flightline-map/1', id: 'legacy-map' },
  });
  const lib = await fetchArenas('https://example.test/maps', { fetchJson });
  assert.deepEqual(lib.arenas.map((m) => m.id), ['an-arena']);
  assert.equal(lib.failures.length, 0);
});

test('a library that is not a version 1 index is refused outright', async () => {
  const fetchJson = serve({ 'index.json': { format: 'something-else/9', maps: [] } });
  await assert.rejects(() => fetchArenas('https://example.test/', { fetchJson }), /not a version 1 map library/);
});

test('one map that fails to arrive does not lose the others', async () => {
  const fetchJson = serve({
    'index.json': index([
      { id: 'good', path: 'good/', kind: 'arena' },
      { id: 'gone', path: 'gone/', kind: 'arena' },
    ]),
    'good/map.json': arena('good'),
  });
  const lib = await fetchArenas('https://example.test/', { fetchJson });
  assert.deepEqual(lib.arenas.map((m) => m.id), ['good']);
  assert.equal(lib.failures.length, 1);
  assert.equal(lib.failures[0].id, 'gone');
});

test('an index that disagrees with the document about the id is a failure, not a rename', async () => {
  const fetchJson = serve({
    'index.json': index([{ id: 'listed-as', path: 'listed-as/', kind: 'arena' }]),
    'listed-as/map.json': arena('actually-called'),
  });
  const lib = await fetchArenas('https://example.test/', { fetchJson });
  assert.equal(lib.arenas.length, 0);
  assert.match(lib.failures[0].error, /listed-as.*actually-called/);
});

test('eager loading is capped, and says how many it left', async () => {
  const many = Array.from({ length: MAX_ARENAS + 3 },
    (_, i) => ({ id: `a${i}`, path: `a${i}/`, kind: 'arena' }));
  const files = { 'index.json': index(many) };
  for (const m of many) files[`${m.id}/map.json`] = arena(m.id);
  const lib = await fetchArenas('https://example.test/', { fetchJson: serve(files) });
  assert.equal(lib.arenas.length, MAX_ARENAS);
  assert.equal(lib.skipped, 3);
});

/* ------------------------------------------------- what the game accepts */

test('a library arena goes through the same checks as a manifest one', () => {
  const into = { ...content, maps: { ...content.maps } };
  acceptMap(into, arena('from-a-library'));
  assert.ok(into.maps['from-a-library']);

  // The checks that matter are the ones that would otherwise surface in the
  // renderer or the bot navigator rather than at load.
  assert.throws(() => acceptMap(into, arena('no-brushes', { brushes: [] })), ContentError);
  assert.throws(() => acceptMap(into, arena('no-spawns', { spawns: [] })), ContentError);
  assert.throws(() => acceptMap(into, arena('bad-link', {
    waypoints: { nodes: [{ id: 'a', pos: [0, 0, 0] }], links: [{ from: 'a', to: 'nowhere' }] },
  })), ContentError);
  // The one cross-content rule a map takes part in: an empty plinth nobody
  // can collect, which can only be caught once the weapons are loaded.
  assert.throws(() => acceptMap(into, arena('bad-pickup', {
    pickups: [{ kind: 'weapon', weapon: 'no_such_weapon', pos: [0, 0, 0] }],
  })), /unknown weapon/);
});
