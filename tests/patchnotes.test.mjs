import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, placeActor, nodeReader } from './helpers.mjs';
import { World } from '../src/engine/sim/World.js';
import { loadContent } from '../src/data/Content.js';
import { PatchNotes } from '../src/engine/rules/PatchNotes.js';
import { Rng } from '../src/engine/core/Rng.js';

/**
 * Patch Notes Mode is the mutator system with a clock in front of it, so the
 * tests split the same way: when a note lands, and what happens to a match
 * already in progress when it does.
 */

const hold = (extra = {}) => ({ forward: 0, strafe: 0, jump: false, fire: false, ...extra });
const run = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(1 / 60); };

function match(opts = {}) {
  const world = new World({ ...BASE, modeId: 'patch_notes', seed: opts.seed ?? 2026 });
  const a = world.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle'] });
  const b = world.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(world, a, -19, 0, -6);
  placeActor(world, b, -19, 0, 6);
  a.spawnProtectUntil = -1;
  b.spawnProtectUntil = -1;
  a.setLook(Math.PI, Math.atan2(0.9 - 1.6, 12));
  b.setLook(0, 0);
  return { world, a, b };
}

/** Force a specific note to land right now, bypassing only the schedule. */
function land(world, noteId) {
  const note = world.content.notes[noteId];
  assert.ok(note, `no such note "${noteId}"`);
  return world.applyPatchNote(note);
}

// --- the schedule ----------------------------------------------------------

test('notes arrive on the schedule the mode asks for', () => {
  const { world } = match();
  const spec = world.content.modes.patch_notes.patchNotes;
  const at = [];
  world.events.on('patchNote', () => at.push(world.time));

  run(world, Math.ceil((spec.firstDelaySec + spec.intervalSec * 2.2) * 60));
  assert.equal(at.length, 3, `expected 3 notes, got ${at.length}`);
  assert.ok(Math.abs(at[0] - spec.firstDelaySec) < 0.1, `first note at ${at[0]}`);
  assert.ok(Math.abs((at[1] - at[0]) - spec.intervalSec) < 0.1);
  assert.ok(Math.abs((at[2] - at[1]) - spec.intervalSec) < 0.1);
});

test('a note is never dealt twice', () => {
  const { world } = match();
  const seen = [];
  world.events.on('patchNote', (e) => seen.push(e.id));
  // The mode's own time limit ends the match before the pool empties, which
  // is the point of having more notes than one match can show.
  run(world, 60 * 700);
  assert.ok(seen.length >= 5, `expected a handful of notes, got ${seen.length}`);
  assert.equal(new Set(seen).size, seen.length, 'a note was dealt twice');
});

test('the pool empties without repeating, given enough match', () => {
  const notes = Object.values(BASE.content.notes);
  // 5 s is the scheduler's floor — a mode cannot ask for a note every frame.
  const STEP = 5;
  const sched = new PatchNotes(notes, new Rng(3), { intervalSec: STEP, firstDelaySec: 0 });
  assert.equal(sched.intervalSec, STEP);
  const seen = [];
  for (let t = 0; t <= (notes.length + 2) * STEP; t += STEP) {
    const note = sched.due(t);
    if (note) seen.push(note.id);
  }
  assert.equal(seen.length, notes.length, 'every note should be dealt exactly once');
  assert.equal(new Set(seen).size, notes.length);
  assert.equal(sched.exhausted, true);
});

test('the same seed deals the same notes in the same order', () => {
  const order = (seed) => {
    const { world } = match({ seed });
    const seen = [];
    world.events.on('patchNote', (e) => seen.push(e.id));
    run(world, 60 * 400);
    return seen;
  };
  assert.deepEqual(order(99), order(99), 'a replay must deal the same hand');
  assert.notDeepEqual(order(99), order(4242), 'a different seed should differ');
});

test('notes stop once the match is over', () => {
  const { world } = match();
  let count = 0;
  world.events.on('patchNote', () => { count += 1; });
  run(world, 60 * 50);
  const during = count;
  assert.ok(during >= 1, 'at least one should have landed while playing');

  world.match.state = 'over';
  run(world, 60 * 300);
  assert.equal(count, during, 'nothing should change after the whistle');
});

test('the scheduler honours maxNotes', () => {
  const notes = Object.values(BASE.content.notes);
  const sched = new PatchNotes(notes, new Rng(7), { intervalSec: 10, firstDelaySec: 0, maxNotes: 2 });
  assert.ok(sched.due(0));
  assert.ok(sched.due(10));
  assert.equal(sched.due(20), null, 'it should stop at the cap');
  assert.equal(sched.exhausted, true);
});

test('notes stack rather than replacing each other', () => {
  const { world } = match();
  land(world, 'removed_jumping');
  land(world, 'gravity_rebalance');
  assert.equal(world.rules.canJump, false, 'the earlier note must still hold');
  assert.ok(Math.abs(world.rules.gravityScale - 1.5) < 1e-9);
});

// --- what a live note does to a match in progress --------------------------

test('"Removed jumping" takes effect without waiting for a respawn', () => {
  const { world, a } = match();
  run(world, 30); // settle on the floor
  assert.equal(a.grounded, true);

  world.setCommand('a', hold({ jump: true, yaw: a.yaw, pitch: 0 }));
  world.step(1 / 60);
  assert.ok(a.velocity.y > 1, 'sanity: jumping works before the note');

  // Let go of jump before settling, or the held command keeps them bouncing.
  world.setCommand('a', hold({ yaw: a.yaw, pitch: 0 }));
  run(world, 120);
  assert.equal(a.grounded, true, 'sanity: back on the floor');
  land(world, 'removed_jumping');
  world.setCommand('a', hold({ jump: true, yaw: a.yaw, pitch: 0 }));
  run(world, 10);
  assert.ok(a.grounded, 'the floor should have kept them');
  assert.ok(a.velocity.y <= 0.01, `expected no jump, got vy ${a.velocity.y}`);
});

test('"Removed reloading" blocks the reload but dying still refills you', () => {
  const { world, a } = match();
  land(world, 'removed_reloading');
  a.mag.rifle = 0;
  world.setCommand('a', hold({ reload: true, yaw: a.yaw, pitch: 0 }));
  run(world, 30);
  assert.equal(a.reload, null, 'no reload should have started');
  assert.equal(a.mag.rifle, 0);

  world.respawn(a);
  assert.equal(a.mag.rifle, world.content.weapons.rifle.ammo.magazine,
    'respawning is the documented workaround');
});

test('"Removed weapon swapping" pins you to what you are holding', () => {
  const world = new World({ ...BASE, modeId: 'patch_notes' });
  const a = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['rifle', 'shotgun'],
  });
  placeActor(world, a, -19, 0, 0);
  land(world, 'removed_weapon_swap');

  world.setCommand('a', hold({ weaponSlot: 1, yaw: 0, pitch: 0 }));
  run(world, 5);
  assert.equal(a.weaponId, 'rifle');

  world.setCommand('a', hold({ switchDelta: 1, yaw: 0, pitch: 0 }));
  run(world, 5);
  assert.equal(a.weaponId, 'rifle', 'the wheel should be dead too');
});

test('a forced loadout swaps weapons mid-match and hands over live ammo', () => {
  const { world, a } = match();
  assert.deepEqual(a.loadout, ['rifle']);
  land(world, 'only_melee');

  assert.deepEqual(a.loadout, ['wrench'], 'everyone should be holding the wrench');
  assert.equal(a.weaponId, 'wrench');
  assert.equal(a.reload, null);
  assert.ok('wrench' in a.mag, 'the new weapon needs its ammo set up');
});

test('a rule baked into the actor is re-derived, not left stale', () => {
  // headScale is read when the actor is built and never again, so this is the
  // case that would silently do nothing without the re-derive pass.
  const { world, a } = match();
  const before = a.headRadius;
  world.content = {
    ...world.content,
    notes: {
      ...world.content.notes,
      big_heads_note: {
        schema: 1, id: 'big_heads_note', headline: 'Head size increased', tier: 1,
        patches: [{ path: 'headScale', op: 'set', value: 3 }],
      },
    },
  };
  land(world, 'big_heads_note');
  assert.ok(a.headRadius > before * 2.5,
    `hitbox should have grown: ${before} -> ${a.headRadius}`);
});

test('"Only headshots count" zeroes body shots but spares weapons with no head to hit', () => {
  const { world, a, b } = match();
  land(world, 'only_headshots');

  // A body shot with the rifle now does nothing.
  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 4);
  assert.equal(b.health, 100, 'a body shot should be worth nothing');

  // The wrench cannot land a headshot, so it must keep working — otherwise
  // "only melee" stacked on this would leave nobody able to hurt anybody.
  const melee = new World({ ...BASE, modeId: 'patch_notes' });
  const m1 = melee.addActor({ id: 'a', name: 'A', characterId: 'grunt', loadout: ['wrench'] });
  const m2 = melee.addActor({ id: 'b', name: 'B', characterId: 'grunt', loadout: ['rifle'] });
  placeActor(melee, m1, -19, 0, -1);
  placeActor(melee, m2, -19, 0, 1);
  m1.spawnProtectUntil = -1;
  m2.spawnProtectUntil = -1;
  m1.setLook(Math.PI, 0);
  land(melee, 'only_headshots');
  melee.setCommand('a', hold({ fire: true, yaw: Math.PI, pitch: 0 }));
  run(melee, 4);
  assert.ok(m2.health < 100, 'a wrench should still hurt under "only headshots"');
});

test('"Only last place can deal damage" silences the leader but never you', () => {
  const { world, a, b } = match();
  land(world, 'last_place_only');
  a.score = 5; // A is winning, B is last
  b.score = 0;

  world.setCommand('a', hold({ fire: true, yaw: a.yaw, pitch: a.pitch }));
  run(world, 4);
  assert.equal(b.health, 100, 'the leader should not be able to damage anyone');

  b.setLook(0, Math.atan2(0.9 - 1.6, 12));
  world.setCommand('a', hold({ yaw: a.yaw, pitch: a.pitch }));
  world.setCommand('b', hold({ fire: true, yaw: b.yaw, pitch: b.pitch }));
  run(world, 4);
  assert.ok(a.health < 100, 'last place should still be armed');
});

test('"Explosions now heal" tops you up and keeps the shove', () => {
  const world = new World({ ...BASE, modeId: 'patch_notes' });
  const a = world.addActor({
    id: 'a', name: 'A', characterId: 'grunt', loadout: ['rocket_launcher'],
  });
  placeActor(world, a, -19, 0, 0);
  a.spawnProtectUntil = -1;
  a.health = 40;
  land(world, 'explosions_heal');

  let healed = 0;
  world.events.on('heal', (e) => { healed += e.amount; });
  // Rocket jump: look down, fire, get healed and launched.
  a.setLook(0, -Math.PI / 2);
  world.setCommand('a', hold({ fire: true, yaw: 0, pitch: -Math.PI / 2 }));
  run(world, 20);

  assert.ok(healed > 0, 'the blast should have healed rather than hurt');
  assert.ok(a.health > 40, `expected healing, health is ${a.health}`);
  assert.ok(a.health <= a.maxHealth, 'healing must not overfill');
  assert.ok(a.velocity.y > 1, 'the knockback should survive the change');
});

// --- authoring safety ------------------------------------------------------

test('a note aimed at a rule that does not exist is rejected at load', async () => {
  const bad = {
    schema: 1, id: 'typo_note', name: 'Typo', headline: 'Typo', tier: 1,
    patches: [{ path: 'canJmup', op: 'set', value: false }],
  };
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'notes/typo_note.json') return bad;
    if (path === 'manifest.json') {
      const real = await nodeReader('manifest.json');
      return { ...real, content: { ...real.content, notes: ['typo_note'] } };
    }
    return nodeReader(path);
  }), /unknown rule "canJmup"/);
});

test('a note forcing a weapon that does not exist is rejected at load', async () => {
  const bad = {
    schema: 1, id: 'ghost_note', name: 'Ghost', headline: 'Ghost', tier: 1,
    patches: [{ path: 'forcedLoadout', op: 'set', value: ['trebuchet'] }],
  };
  await assert.rejects(() => loadContent(async (path) => {
    if (path === 'notes/ghost_note.json') return bad;
    if (path === 'manifest.json') {
      const real = await nodeReader('manifest.json');
      return { ...real, content: { ...real.content, notes: ['ghost_note'] } };
    }
    return nodeReader(path);
  }), /forces unknown weapon "trebuchet"/);
});

test('every shipped note names rules and weapons that exist', () => {
  // The load above already enforces this; this test says so out loud, because
  // it is the thing most likely to break when a rule is renamed.
  assert.ok(Object.keys(BASE.content.notes).length >= 12);
  for (const note of Object.values(BASE.content.notes)) {
    assert.ok(note.headline, `${note.id} needs a headline`);
    assert.ok(note.patches.length > 0, `${note.id} changes nothing`);
  }
});

test('a note forced outside the schedule still joins the changelog', () => {
  // applyPatchNote is public so a debug command or a test can land one. If it
  // skipped the applied list, the HUD changelog and any connected client —
  // which replays that list to rebuild its own rules — would never see it.
  const { world } = match();
  const before = world.patchNotes.remaining;
  land(world, 'removed_jumping');

  const snap = world.snapshot().patchNotes;
  assert.deepEqual(snap.applied.map((n) => n.id), ['removed_jumping']);
  assert.equal(snap.remaining, before - 1, 'it should leave the pool, not duplicate later');

  // And the scheduler must not deal it again.
  const seen = [];
  world.events.on('patchNote', (e) => seen.push(e.id));
  run(world, 60 * 700);
  assert.ok(!seen.includes('removed_jumping'), 'a forced note must not come round again');
});

test('deathmatch is untouched: no notes, no scheduler', () => {
  const world = new World({ ...BASE, modeId: 'deathmatch' });
  assert.equal(world.patchNotes, null);
  assert.equal(world.snapshot().patchNotes, null);
  let fired = 0;
  world.events.on('patchNote', () => { fired += 1; });
  run(world, 60 * 200);
  assert.equal(fired, 0);
});
