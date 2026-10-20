import { joinRoom } from 'trystero/nostr';
import { Transport } from './Transport.js';
export { normaliseRoom } from './roomName.js';

/**
 * Finding each other, without a server of ours.
 *
 * The game is static files on GitHub Pages, so there is nothing of ours
 * running anywhere to introduce two browsers. Trystero borrows someone
 * else's: peers announce themselves on public Nostr relays under a room
 * name, swap connection details there, and then talk directly. Only that
 * introduction touches the relay — every snapshot and command afterwards is
 * peer to peer, and Trystero encrypts the introduction itself.
 *
 * So joining is a room name, typed by both people. No codes, no pasting.
 *
 * On NAT: most home connections pair up directly using STUN, which Trystero
 * supplies. A minority — symmetric NAT, some mobile and workplace networks —
 * cannot, and need a TURN relay to forward the traffic. There is no free TURN
 * worth hardcoding (Open Relay now wants an API key), so it is a setting:
 * paste credentials in and they are used, leave it empty and you get STUN
 * only, which is the right default because it costs nothing and usually
 * works. If someone cannot connect while everyone else can, that is this.
 */

const APP_ID = 'frag-zone-discount-warfare';
const TURN_KEY = 'fragzone.turn';
const CHANNEL = 'fz';
const CLAIM = 'fzhost';

/** @returns {RTCConfiguration|undefined} */
export function turnConfig() {
  try {
    const raw = localStorage.getItem(TURN_KEY);
    if (!raw) return undefined;
    const t = JSON.parse(raw);
    if (!t?.urls) return undefined;
    return { iceServers: [{ urls: t.urls, username: t.username, credential: t.credential }] };
  } catch {
    return undefined;
  }
}

export function setTurn(config) {
  try {
    if (config?.urls) localStorage.setItem(TURN_KEY, JSON.stringify(config));
    else localStorage.removeItem(TURN_KEY);
  } catch { /* private mode: run without it */ }
}

/** One peer's end of a Trystero room, behind the Transport interface. */
class TrysteroTransport extends Transport {
  constructor(action, peerId) {
    super();
    this.action = action;
    this.peerId = peerId;
    this.isOpen = true;
  }

  get open() { return this.isOpen; }

  send(message) {
    if (!this.isOpen) return;
    try { this.action.send(message, { target: this.peerId }); }
    catch { /* the channel went while we were writing to it */ }
  }

  deliver(message) { this.onMessage(message); }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
}

function connect(roomName) {
  const room = joinRoom(
    { appId: APP_ID, ...(turnConfig() ? { rtcConfig: turnConfig() } : {}) },
    `fz-${roomName}`,
  );
  return { room, channel: room.makeAction(CHANNEL), claim: room.makeAction(CLAIM) };
}

/**
 * Open a room and hand every arrival to the host as a Transport.
 *
 * The host announces itself to each peer as it appears, which is how a
 * joiner knows which of the people in the room is running the match.
 */
export function hostRoom(roomName, peerHost, { onRoster = () => {} } = {}) {
  const { room, channel, claim } = connect(roomName);
  const transports = new Map();

  channel.onMessage = (data, { peerId }) => transports.get(peerId)?.deliver(data);

  room.onPeerJoin = (peerId) => {
    const transport = new TrysteroTransport(channel, peerId);
    transports.set(peerId, transport);
    peerHost.accept(transport);
    claim.send({ host: true }, { target: peerId });
    onRoster(peerHost.roster());
  };

  room.onPeerLeave = (peerId) => {
    transports.get(peerId)?.close();
    transports.delete(peerId);
    onRoster(peerHost.roster());
  };

  // Someone else in the same room also pressed Host. Both will serve their
  // own matches to whoever reached them first, which is confusing but not
  // broken — worth saying out loud rather than silently halving the game.
  claim.onMessage = (data, { peerId }) => {
    if (data?.host) console.warn(`[frag-zone] another host (${peerId}) is in room "${roomName}"`);
  };

  return {
    room,
    close() {
      for (const t of transports.values()) t.close();
      transports.clear();
      try { room.leave(); } catch { /* already gone */ }
    },
  };
}

/**
 * Join a room and wait for whoever is hosting to introduce themselves.
 * @returns {Promise<{transport: Transport, room: object, close: Function}>}
 */
export function joinHostedRoom(roomName, { timeoutMs = 25000 } = {}) {
  const { room, channel, claim } = connect(roomName);
  let transport = null;

  channel.onMessage = (data, { peerId }) => {
    if (transport && transport.peerId === peerId) transport.deliver(data);
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { room.leave(); } catch { /* nothing to leave */ }
      reject(new Error(`nobody is hosting "${roomName}" — check the name, and that they pressed Host first`));
    }, timeoutMs);

    claim.onMessage = (data, { peerId }) => {
      if (!data?.host || transport) return;
      clearTimeout(timer);
      transport = new TrysteroTransport(channel, peerId);
      room.onPeerLeave = (gone) => { if (gone === peerId) transport.close(); };
      resolve({
        transport,
        room,
        close() {
          transport.close();
          try { room.leave(); } catch { /* already gone */ }
        },
      });
    };
  });
}
