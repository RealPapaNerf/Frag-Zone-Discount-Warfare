/**
 * A message pipe between two peers, and nothing more.
 *
 * Everything above this file — PeerHost, RemoteHost, the protocol — only ever
 * sees `send(object)`, `onMessage`, `onOpen`, `onClose`. That is deliberate:
 * WebRTC cannot be exercised in Node, so the netcode is written against this
 * interface and the tests drive it through LoopbackTransport instead. If the
 * protocol is wrong, a unit test says so without opening a browser.
 */
export class Transport {
  constructor() {
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
  }

  get open() { return false; }

  send(_message) { throw new Error('not implemented'); }

  close() {}
}

/**
 * Two transports wired to each other in one process, with an optional delay
 * so tests can reproduce what latency does to the protocol.
 */
export class LoopbackTransport extends Transport {
  /** @returns {[LoopbackTransport, LoopbackTransport]} a connected pair. */
  static pair({ latencyMs = 0 } = {}) {
    const a = new LoopbackTransport(latencyMs);
    const b = new LoopbackTransport(latencyMs);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  constructor(latencyMs = 0) {
    super();
    this.peer = null;
    this.latencyMs = latencyMs;
    this.isOpen = true;
    this.queue = [];
  }

  get open() { return this.isOpen; }

  send(message) {
    if (!this.isOpen || !this.peer?.isOpen) return;
    // Structured-clone the way a real channel would, so a test cannot pass by
    // accidentally sharing an object reference with the other side.
    const copy = JSON.parse(JSON.stringify(message));
    if (this.latencyMs > 0) this.peer.queue.push({ at: Date.now() + this.latencyMs, copy });
    else this.peer.onMessage(copy);
  }

  /** Deliver anything whose delay has elapsed. Tests call this directly. */
  pump(now = Date.now()) {
    const ready = this.queue.filter((m) => m.at <= now);
    this.queue = this.queue.filter((m) => m.at > now);
    for (const m of ready) this.onMessage(m.copy);
    return ready.length;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
    if (this.peer?.isOpen) this.peer.close();
  }
}

/**
 * A real WebRTC data channel.
 *
 * Unreliable and unordered: snapshots and commands are state, not a
 * conversation, and a late one is worth less than the next one. Re-sending a
 * dropped snapshot would make the stall longer, not shorter.
 */
export class RTCTransport extends Transport {
  /**
   * @param {RTCPeerConnection} pc
   * @param {RTCDataChannel} channel
   */
  constructor(pc, channel) {
    super();
    this.pc = pc;
    this.channel = channel;
    channel.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); }
      catch { /* a truncated datagram is not worth tearing the game down for */ }
    };
    channel.onopen = () => this.onOpen();
    channel.onclose = () => this.onClose();
    channel.onerror = () => this.onClose();
  }

  get open() { return this.channel.readyState === 'open'; }

  send(message) {
    if (!this.open) return;
    try { this.channel.send(JSON.stringify(message)); }
    catch { /* buffer full: drop it, the next snapshot supersedes it anyway */ }
  }

  close() {
    try { this.channel.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }
}
