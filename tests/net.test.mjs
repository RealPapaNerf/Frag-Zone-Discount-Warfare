import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, content, placeActor } from './helpers.mjs';
import { LoopbackTransport } from '../src/net/Transport.js';
import { PeerHost } from '../src/client/PeerHost.js';
import { RemoteHost } from '../src/client/RemoteHost.js';
import * as P from '../src/net/protocol.js';

/**
 * The netcode is written against a transport interface precisely so it can be
 * exercised here: a wrong protocol should fail in a second in Node, not after
 * two people have opened browsers and pasted codes at each other.
 */

function makeHost(extra = {}) {
  return new PeerHost({
    content,
    mapId: BASE.mapId,
    modeId: BASE.modeId,
    mutatorIds: [],
    seed: 99,
    characterId: 'grunt',
    loadout: ['rifle', 'rocket_launcher'],
    botCount: 0,
    ...extra,
  });
}

/** Connect a client and run both ends until it has been welcomed. */
async function connect(host, name = 'Brother') {
  const [hostSide, clientSide] = LoopbackTransport.pair();
  host.accept(hostSide);
  const client = new RemoteHost({ content, transport: clientSide, playerName: name });
  const joined = client.join(2000);
  await joined;
  return { client, hostSide, clientSide };
}

test('a client that says hello gets an actor, a map and a name on the roster', async () => {
  const host = makeHost();
  const { client } = await connect(host, 'Nugget');

  assert.equal(host.playerCount, 2, 'host plus one guest');
  assert.ok(client.localActorId, 'the client was told which actor it is');
  assert.equal(client.settings.mapId, BASE.mapId);
  assert.ok(client.arena, 'the client rebuilt the arena from the map id');
  assert.ok(client.rules, 'and the rules from the mode id');

  const actor = host.world.actorById(client.localActorId);
  assert.ok(actor, 'the host made an actor for them');
  assert.equal(actor.name, 'Nugget');
  assert.equal(host.roster().some((r) => r.name === 'Nugget'), true);
});

test('a client pressing forward moves its own actor and nobody else', async () => {
  const host = makeHost();
  const { client } = await connect(host);
  const them = host.world.actorById(client.localActorId);
  const us = host.world.actorById(host.localActorId);
  placeActor(host.world, them, -8, 0.1, 10);
  placeActor(host.world, us, 8, 0.1, 10);

  client.sendCommand({ forward: 1, strafe: 0, yaw: 0, pitch: 0, jump: false, fire: false });
  for (let i = 0; i < 90; i++) host.update(1 / 60);

  assert.ok(them.position.z < 9, `the guest should have moved, z=${them.position.z.toFixed(2)}`);
  assert.ok(Math.abs(us.position.z - 10) < 0.2, 'the host should not have moved');
});

test('snapshots reach the client, and it reports the host\'s state as its own', async () => {
  const host = makeHost();
  const { client } = await connect(host);
  const them = host.world.actorById(client.localActorId);
  placeActor(host.world, them, 4, 0.1, -6);

  for (let i = 0; i < 30; i++) host.update(1 / 60); // past one broadcast interval

  const snap = client.snapshot();
  const mine = snap.actors.find((a) => a.id === client.localActorId);
  assert.ok(mine, 'the client can see itself in the snapshot');
  assert.ok(Math.abs(mine.pos.x - 4) < 0.5, `expected x≈4, got ${mine.pos.x}`);
  assert.equal(snap.actors.length, host.world.actors.length);
});

test('the client blends between the last two snapshots rather than jumping', async () => {
  const host = makeHost();
  const { client, hostSide } = await connect(host);

  // Fed by hand rather than by playing: what matters is that consecutive
  // packets become the pos/prevPos pair Game.js interpolates, and driving
  // that through the arena makes the test depend on where the walls are.
  const at = (tick, z) => ({
    tick,
    time: tick / 60,
    actors: [{ id: client.localActorId, pos: { x: 0, y: 0, z }, prevPos: { x: 0, y: 0, z }, vel: { x: 0, y: 0, z: -1 }, alive: true }],
    projectiles: [],
    match: { state: 'active' },
  });

  hostSide.send(P.snap(at(10, 20), []));
  hostSide.send(P.snap(at(13, 17), []));

  const blended = client.snapshot();
  const me = blended.actors.find((a) => a.id === client.localActorId);
  assert.equal(me.pos.z, 17, 'position comes from the newer packet');
  assert.equal(me.prevPos.z, 20, 'and prevPos from the older one, which is what alpha blends between');
  assert.equal(blended.tick, 13);

  // Someone who has only ever appeared once must not fly in from wherever
  // the last holder of that id stood.
  hostSide.send(P.snap({
    ...at(16, 14),
    actors: [...at(16, 14).actors, { id: 'peer9', pos: { x: 5, y: 0, z: 5 }, prevPos: { x: 5, y: 0, z: 5 }, vel: { x: 0, y: 0, z: 0 }, alive: true }],
  }, []));
  const fresh = client.snapshot().actors.find((a) => a.id === 'peer9');
  assert.deepEqual(fresh.prevPos, fresh.pos, 'a newcomer starts where they are, not where someone else was');
});

test('alpha advances between packets and never runs away', async () => {
  const host = makeHost();
  const { client } = await connect(host);

  client.update(1 / 60);
  assert.ok(client.alpha > 0, 'time since the last packet should show up as alpha');

  // A host that goes quiet must not drive alpha to infinity.
  for (let i = 0; i < 600; i++) client.update(1 / 60);
  assert.ok(client.alpha <= 1.25, `alpha ran away to ${client.alpha}`);
});

test('a hit claimed by the client damages the victim on the host', async () => {
  const host = makeHost();
  const { client } = await connect(host);
  const shooter = host.world.actorById(client.localActorId);
  const victim = host.world.actorById(host.localActorId);
  placeActor(host.world, shooter, -8, 0, -6);
  placeActor(host.world, victim, -8, 0, 6);
  victim.spawnProtectUntil = -1;

  const before = victim.health;
  client.sendHitClaims([{
    kind: 'hitscan',
    shooter: client.localActorId,
    weaponId: 'rifle',
    target: host.localActorId,
    headshot: false,
    damage: 17,
    origin: { x: -8, y: 1.6, z: -6 },
    dir: { x: 0, y: 0, z: 1 },
    point: { x: -8, y: 1.2, z: 6 },
    normal: null,
  }]);
  host.update(1 / 60);

  assert.ok(victim.health < before, `expected damage, health stayed at ${victim.health}`);
});

test('a claim cannot invent its own damage', async () => {
  const host = makeHost();
  const { client } = await connect(host);
  const victim = host.world.actorById(host.localActorId);
  placeActor(host.world, victim, -8, 0, 6);
  victim.spawnProtectUntil = -1;

  // The wire format has no damage field, but a hostile client could add one.
  client.transport.send(P.claims([{
    kind: 'hitscan', shooter: client.localActorId, weaponId: 'rifle',
    target: host.localActorId, headshot: false, damage: 100000,
    origin: { x: -8, y: 1.6, z: -6 }, dir: { x: 0, y: 0, z: 1 }, point: { x: -8, y: 1.2, z: 6 },
  }]));
  host.update(1 / 60);

  // The ceiling is the weapon's own maximum: damage x headshot multiplier.
  // A six-figure claim therefore costs them one very good rifle shot.
  assert.ok(victim.health > 0, 'one rifle shot should not delete them');
  assert.ok(victim.health >= 100 - 40, `expected roughly one rifle hit, health=${victim.health}`);
  assert.ok(victim.health < 100, 'but it should still have hurt');
});

test('a malformed command cannot reach the simulation', async () => {
  const host = makeHost();
  const { client } = await connect(host);
  const them = host.world.actorById(client.localActorId);
  placeActor(host.world, them, 0, 0.1, 0);

  client.transport.send(P.cmd({ forward: '1e9', strafe: { nope: true }, yaw: NaN, pitch: 'down', jump: 'yes' }));
  for (let i = 0; i < 30; i++) host.update(1 / 60);

  assert.ok(Number.isFinite(them.position.x) && Number.isFinite(them.position.z),
    'position went non-finite, so something unchecked got through');
  assert.ok(Math.hypot(them.position.x, them.position.z) < 50, 'nobody should be launched into the void');
});

test('a dropped connection takes its fighter out of the match', async () => {
  const host = makeHost();
  const { client, clientSide } = await connect(host);
  const id = client.localActorId;
  assert.ok(host.world.actorById(id));

  clientSide.close();
  assert.equal(host.playerCount, 1, 'back to just the host');
  assert.equal(host.world.actorById(id), null, 'and their fighter is gone');
});

test('the host refuses a client speaking a different protocol version', async () => {
  const host = makeHost();
  const [hostSide, clientSide] = LoopbackTransport.pair();
  host.accept(hostSide);

  let refusal = null;
  clientSide.onMessage = (m) => { if (m.t === P.T.full) refusal = m.reason; };
  clientSide.send({ t: P.T.hello, v: P.PROTOCOL_VERSION + 1, name: 'Future' });

  assert.ok(refusal, 'expected to be turned away');
  assert.match(refusal, /protocol/);
  assert.equal(host.playerCount, 1);
});

test('the host turns players away once it is full', async () => {
  const host = makeHost({ maxPlayers: 2 });
  await connect(host, 'First');

  const [hostSide, clientSide] = LoopbackTransport.pair();
  host.accept(hostSide);
  let refusal = null;
  clientSide.onMessage = (m) => { if (m.t === P.T.full) refusal = m.reason; };
  clientSide.send(P.hello('Second', 'grunt'));

  assert.match(refusal ?? '', /full/);
  assert.equal(host.playerCount, 2);
});

test('nothing but hello is listened to before hello', async () => {
  const host = makeHost();
  const [hostSide, clientSide] = LoopbackTransport.pair();
  host.accept(hostSide);

  clientSide.send(P.cmd({ forward: 1 }));
  clientSide.send(P.claims([{ kind: 'hitscan', weaponId: 'rifle', target: host.localActorId }]));
  host.update(1 / 60);

  assert.equal(host.playerCount, 1, 'no actor should exist for a client that never introduced itself');
  assert.equal(host.world.actorById(host.localActorId).health, 100);
});

test('two clients get their own fighters and their own commands', async () => {
  const host = makeHost();
  const a = await connect(host, 'Shovel');
  const b = await connect(host, 'Biscuit');

  assert.equal(host.playerCount, 3);
  assert.notEqual(a.client.localActorId, b.client.localActorId);

  const actorA = host.world.actorById(a.client.localActorId);
  const actorB = host.world.actorById(b.client.localActorId);
  placeActor(host.world, actorA, -8, 0.1, 10);
  placeActor(host.world, actorB, 8, 0.1, 10);

  a.client.sendCommand({ forward: 1, strafe: 0, yaw: 0, pitch: 0 });
  b.client.sendCommand({ forward: 0, strafe: 0, yaw: 0, pitch: 0 });
  for (let i = 0; i < 90; i++) host.update(1 / 60);

  assert.ok(actorA.position.z < 9, 'Shovel moved');
  assert.ok(Math.abs(actorB.position.z - 10) < 0.3, 'Biscuit did not');

  // And each client sees both of them.
  assert.equal(a.client.snapshot().actors.length, 3);
  assert.equal(b.client.snapshot().actors.length, 3);
});
