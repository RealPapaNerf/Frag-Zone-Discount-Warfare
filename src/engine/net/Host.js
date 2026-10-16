/**
 * The seam multiplayer will slot into.
 *
 * The client never touches World directly: it pushes commands at a Host and
 * pulls snapshots and events back. LocalHost (milestone 1) owns a World in
 * this tab. PeerHost (milestone 2) will own a World and broadcast over
 * WebRTC, and RemoteHost will forward commands to whoever is hosting and
 * surface the snapshots that come back. All three satisfy this interface, so
 * nothing above it needs to know which one it has.
 */
export class Host {
  /** @returns {boolean} true when this process owns the authoritative World. */
  get isAuthority() { return false; }

  /** Latest authoritative state for rendering and HUD. */
  snapshot() { throw new Error('not implemented'); }

  /** Events produced since the last drain (kills, shots, explosions, ...). */
  drainEvents() { throw new Error('not implemented'); }

  /** Queue the local player's input for the next simulated tick. */
  sendCommand(_command) { throw new Error('not implemented'); }

  /**
   * Report hits the local client resolved itself. The host trusts these —
   * "favour the shooter" — and only clamps the damage to the weapon's data.
   */
  sendHitClaims(_claims) { throw new Error('not implemented'); }

  /** Advance time. An authority simulates; a remote host interpolates. */
  update(_dtSeconds) { throw new Error('not implemented'); }

  /** The actor id this client controls. */
  get localActorId() { return null; }
}
