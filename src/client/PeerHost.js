import { LocalHost } from './LocalHost.js';
import * as P from '../net/protocol.js';

/**
 * The authoritative host, serving other players.
 *
 * It is a LocalHost that also has guests: the same World, the same fixed
 * timestep, the same bots. A peer is an actor whose commands arrive over a
 * wire instead of off a keyboard, which is the whole reason the Host seam was
 * drawn where it was.
 *
 * Deliberately not lockstep and not rollback. The host simulates, says what
 * happened twenty times a second, and trusts clients about their own hits
 * after clamping the damage. For brothers on home wifi that is the right
 * trade: shooting feels immediate because the shooter decides, and nobody
 * else's game stutters when one player's connection does.
 */
export class PeerHost extends LocalHost {
  constructor(options) {
    super(options);
    this.peers = new Map();       // actorId -> {transport, name, pending, claims}
    this.maxPlayers = options.maxPlayers ?? 8;
    this.onRosterChange = () => {};
    this.sinceBroadcast = 0;
    this.broadcastInterval = 1 / P.SNAPSHOT_HZ;
    this.characterId = options.characterId;
    this.loadout = options.loadout;
    this.settings = {
      mapId: options.mapId,
      modeId: options.modeId,
      mutatorIds: options.mutatorIds ?? [],
      characterId: options.characterId,
    };
  }

  get isAuthority() { return true; }

  /** Number of humans, including the host. */
  get playerCount() { return 1 + this.peers.size; }

  /**
   * Take on a connected transport. The actor is not created until the client
   * says hello, because until then we do not know their name and they might
   * be a half-open channel that never speaks.
   */
  accept(transport) {
    let actorId = null;

    transport.onMessage = (message) => {
      if (!message || typeof message !== 'object') return;

      if (message.t === P.T.hello) {
        if (actorId) return; // already said hello; ignore repeats
        if (message.v !== P.PROTOCOL_VERSION) {
          transport.send(P.full(`this game speaks protocol ${P.PROTOCOL_VERSION}, you speak ${message.v}`));
          transport.close();
          return;
        }
        if (this.playerCount >= this.maxPlayers) {
          transport.send(P.full('the game is full'));
          transport.close();
          return;
        }
        actorId = this.#addPlayer(transport, message);
        return;
      }

      if (!actorId) return; // nothing else is allowed before hello

      const peer = this.peers.get(actorId);
      if (!peer) return;

      if (message.t === P.T.cmd) {
        const command = P.sanitizeCommand(message.c);
        if (command) peer.pending = command;
      } else if (message.t === P.T.claims) {
        peer.claims.push(...P.sanitizeClaims(message.claims));
      } else if (message.t === P.T.bye) {
        this.#drop(actorId);
      }
    };

    transport.onClose = () => { if (actorId) this.#drop(actorId); };
  }

  #addPlayer(transport, message) {
    const actorId = this.#freeId();
    const name = String(message.name ?? 'Guest').slice(0, 18) || 'Guest';

    this.world.addActor({
      id: actorId,
      name,
      characterId: this.characterId,
      loadout: this.loadout,
      isBot: false,
    });

    this.peers.set(actorId, { transport, name, pending: null, claims: [] });
    // The newcomer gets every face in their welcome; everyone already here
    // gets just the new one, and only if it survived the sanitiser.
    const face = P.sanitizeFace(message.face);
    if (face) this.faces[actorId] = face;
    transport.send(P.welcome(actorId, this.settings, this.world.snapshot(), this.faces));
    if (face) this.#broadcastFaces({ [actorId]: face }, actorId);
    this.onRosterChange(this.roster());
    return actorId;
  }

  /** Tell every peer but `except` about a face change (null means gone). */
  #broadcastFaces(map, except = null) {
    const message = P.faces(map);
    for (const [id, peer] of this.peers) {
      if (id !== except) peer.transport.send(message);
    }
  }

  /** Reuse the lowest free slot so leaving and rejoining does not grow ids. */
  #freeId() {
    for (let i = 1; i <= this.maxPlayers; i++) {
      const id = `peer${i}`;
      if (!this.peers.has(id) && !this.world.actorById(id)) return id;
    }
    return `peer${Date.now().toString(36)}`;
  }

  #drop(actorId) {
    const peer = this.peers.get(actorId);
    if (!peer) return;
    this.peers.delete(actorId);
    this.world.removeActor(actorId);
    // Ids are reused (see #freeId), so a face left behind would end up on
    // the next stranger to take the slot. Everyone is told it is gone.
    if (this.faces[actorId]) {
      delete this.faces[actorId];
      this.#broadcastFaces({ [actorId]: null });
    }
    try { peer.transport.close(); } catch { /* already gone */ }
    this.onRosterChange(this.roster());
  }

  roster() {
    return [
      { id: this.localId, name: this.world.actorById(this.localId)?.name ?? 'You', local: true },
      ...[...this.peers].map(([id, p]) => ({ id, name: p.name, local: false })),
    ];
  }

  /** The local player's input, plus everyone else's, on the same tick. */
  applyPendingCommands() {
    super.applyPendingCommands();
    for (const [actorId, peer] of this.peers) {
      if (!peer.pending) continue;
      this.world.setCommand(actorId, peer.pending);
      peer.pending.weaponSlot = null;
      peer.pending.switchDelta = 0;
    }
  }

  update(dt) {
    // Claims are applied before the step, so a hit reported this frame lands
    // on the same tick the shooter saw it on, not one later.
    for (const [actorId, peer] of this.peers) {
      if (!peer.claims.length) continue;
      this.world.applyClaims(actorId, peer.claims);
      peer.claims.length = 0;
    }

    const steps = super.update(dt);

    this.sinceBroadcast += dt;
    if (this.sinceBroadcast >= this.broadcastInterval && this.peers.size) {
      this.sinceBroadcast = 0;
      this.#broadcast();
    }
    return steps;
  }

  #broadcast() {
    // One serialisation for everyone: the snapshot is identical per peer, and
    // JSON.stringify of eight actors is not free.
    const message = P.snap(this.world.snapshot(), this.pendingEvents ?? []);
    this.pendingEvents = [];
    for (const peer of this.peers.values()) peer.transport.send(message);
  }

  /**
   * Events are drained once per frame by the local client, so the broadcast
   * has to keep its own copy or peers would see whichever ones happened to be
   * queued at broadcast time.
   */
  drainEvents() {
    const events = super.drainEvents();
    if (this.peers.size && events.length) {
      (this.pendingEvents ??= []).push(...events);
      // Do not let a stalled broadcast grow without bound.
      if (this.pendingEvents.length > 256) this.pendingEvents.splice(0, this.pendingEvents.length - 256);
    }
    return events;
  }

  close() {
    for (const [id, peer] of this.peers) {
      try { peer.transport.send(P.bye()); peer.transport.close(); } catch { /* going anyway */ }
      this.world.removeActor(id);
    }
    this.peers.clear();
  }
}
