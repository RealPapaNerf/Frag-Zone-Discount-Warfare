import { Host } from '../engine/net/Host.js';
import { Arena } from '../engine/sim/Arena.js';
import { buildRuleSet } from '../engine/rules/RuleSet.js';
import * as P from '../net/protocol.js';

/**
 * A Host that owns no World: it forwards input to whoever is running the
 * match and draws whatever comes back.
 *
 * Both sides ship the same content files, so the host sends ids — map, mode,
 * mutators — and this side rebuilds the Arena and the RuleSet locally. That
 * keeps snapshots down to the state that actually changes, and it means the
 * renderer and the HUD get exactly the objects they get in a solo game.
 *
 * Snapshots arrive twenty times a second and the display runs at sixty, so
 * the two most recent are kept and blended. Game.js already interpolates an
 * actor from `prevPos` to `pos` using `host.alpha`; this synthesises exactly
 * that pair out of consecutive snapshots, so nothing above had to change to
 * cope with a network in the way.
 *
 * There is no client-side prediction. Your own movement is therefore as late
 * as your ping, while aiming stays instant because the camera reads the mouse
 * directly, and shooting stays honest because hit claims are resolved here
 * and trusted by the host. That is the right first trade: prediction without
 * reconciliation looks worse than latency, and reconciliation is a large,
 * subtle thing to add on top of a protocol nobody has played on yet.
 */
export class RemoteHost extends Host {
  constructor({ content, transport, playerName = 'Guest', characterId = 'grunt' }) {
    super();
    this.content = content;
    this.transport = transport;
    this.playerName = playerName;
    this.characterId = characterId;

    this.localId = null;
    this.settings = null;
    this.arena = null;
    this.rules = null;

    this.prev = null;   // the older of the two snapshots being blended
    this.curr = null;   // the newer
    this.alpha = 0;
    this.sinceSnapshot = 0;
    this.interval = 1 / P.SNAPSHOT_HZ; // measured, not assumed
    this.lastArrival = 0;

    this.events = [];
    this.pendingClaims = [];
    this.connected = false;
    this.closed = false;
    this.error = null;

    this.onReady = () => {};
    this.onClosed = () => {};

    transport.onMessage = (m) => this.#receive(m);
    transport.onClose = () => {
      this.closed = true;
      this.connected = false;
      this.onClosed(this.error);
    };
  }

  get isAuthority() { return false; }
  get localActorId() { return this.localId; }

  /**
   * Resolves once the host has said who we are, or rejects if it refuses.
   *
   * The hello goes out *after* the handlers are in place. A transport is
   * allowed to deliver synchronously — the in-process one used by the tests
   * does — and sending first would mean the welcome arrives, fires the
   * default no-op onReady, and is gone before this promise ever listens.
   */
  join(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.connected) { resolve(this); return; }
      const timer = setTimeout(() => reject(new Error('the host never answered')), timeoutMs);
      this.onReady = () => { clearTimeout(timer); resolve(this); };
      this.onClosed = (err) => { clearTimeout(timer); reject(err ?? new Error('the host closed the connection')); };
      this.transport.send(P.hello(this.playerName, this.characterId));
    });
  }

  #receive(message) {
    if (!message || typeof message !== 'object') return;

    if (message.t === P.T.welcome) {
      this.localId = message.actorId;
      this.settings = message.settings;

      // Rebuild the pieces the renderer and the HUD need, from our own copy
      // of the content. A map id is a few bytes; a map is half a megabyte.
      const mapDoc = this.content.maps[this.settings.mapId];
      if (!mapDoc) {
        this.error = new Error(`the host is playing "${this.settings.mapId}", which this build does not have`);
        this.transport.close();
        return;
      }
      this.arena = new Arena(mapDoc);
      this.rules = buildRuleSet(
        this.content.modes[this.settings.modeId],
        (this.settings.mutatorIds ?? []).map((id) => this.content.mutators[id]).filter(Boolean),
      );

      this.prev = message.snapshot;
      this.curr = message.snapshot;
      this.connected = true;
      this.onReady(this);
      return;
    }

    if (message.t === P.T.full) {
      this.error = new Error(message.reason ?? 'the host turned us away');
      this.transport.close();
      return;
    }

    if (message.t === P.T.snap) {
      this.#onSnapshot(message.s, message.ev);
      return;
    }

    if (message.t === P.T.bye) {
      this.error = new Error('the host ended the game');
      this.transport.close();
    }
  }

  #onSnapshot(snapshot, events) {
    if (!snapshot || !Array.isArray(snapshot.actors)) return;

    const now = performance.now?.() ?? Date.now();
    if (this.lastArrival) {
      // Track the real arrival rate so playback matches the sender rather
      // than a constant we hoped for. Clamped: one late packet should not
      // stretch interpolation to a crawl.
      const gap = (now - this.lastArrival) / 1000;
      this.interval = Math.max(0.02, Math.min(0.25, this.interval * 0.8 + gap * 0.2));
    }
    this.lastArrival = now;

    this.prev = this.curr ?? snapshot;
    this.curr = snapshot;
    this.sinceSnapshot = 0;

    if (Array.isArray(events) && events.length) {
      this.events.push(...events);
      if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
    }
  }

  sendCommand(command) {
    if (!this.connected) return;
    this.transport.send(P.cmd(command));
  }

  sendHitClaims(claims) {
    if (!this.connected || !claims?.length) return;
    this.transport.send(P.claims(claims));
  }

  update(dt) {
    this.sinceSnapshot += dt;
    // Allowed slightly past 1 so a late packet extrapolates for a frame or
    // two rather than freezing everyone mid-stride.
    this.alpha = Math.min(1.25, this.sinceSnapshot / this.interval);
    return 0;
  }

  /**
   * A snapshot shaped the way Game.js expects: positions from the newer
   * packet, `prevPos` from the older, so the existing interpolation does the
   * blending with `alpha`.
   */
  snapshot() {
    if (!this.curr) return { tick: 0, time: 0, actors: [], projectiles: [], match: null };
    if (!this.prev || this.prev === this.curr) return this.curr;

    const before = new Map(this.prev.actors.map((a) => [a.id, a]));
    return {
      ...this.curr,
      actors: this.curr.actors.map((actor) => {
        const old = before.get(actor.id);
        // Someone who just appeared has no previous position; starting them
        // at their current one makes them pop in rather than fly in from
        // wherever the last player to hold that id happened to be.
        return { ...actor, prevPos: old ? old.pos : actor.pos };
      }),
    };
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  close() {
    if (this.closed) return;
    try { this.transport.send(P.bye()); } catch { /* going anyway */ }
    this.transport.close();
  }

  /** Nothing to restart from here — the host owns the match. */
  restart() {}
}
