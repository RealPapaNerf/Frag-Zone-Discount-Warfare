/**
 * Every message that crosses between peers, in one file.
 *
 * The shape of this protocol follows from one decision: the host simulates,
 * and clients send intent rather than outcome. A client says "I am holding
 * forward and the trigger"; it does not say "I moved to here". The one
 * exception is hit claims, which the client resolves itself and the host
 * trusts after clamping — "favour the shooter", which is what makes shooting
 * feel right on a connection with any latency at all.
 */

// 2 added the reload request to commands and the magazine to snapshots.
// 3 added the use verb, for doors and wall fixtures.
// (Face pictures were added without a bump: every change was a new optional
// field or a new message type, and both sides ignore what they do not know.)
export const PROTOCOL_VERSION = 3;

/** Snapshots per second. 60 would be four times the bandwidth for no gain. */
export const SNAPSHOT_HZ = 20;

export const T = {
  hello: 'hello',       // client -> host, first thing after the channel opens
  welcome: 'welcome',   // host -> client, you are this actor in this match
  full: 'full',         // host -> client, no room / wrong version
  cmd: 'cmd',           // client -> host, one input frame
  claims: 'claims',     // client -> host, hits it resolved itself
  snap: 'snap',         // host -> client, authoritative state + events
  faces: 'faces',       // host -> client, {actorId: dataUrl|null} face changes
  bye: 'bye',           // either way, a clean goodbye
};

export const hello = (name, character, face = null) => ({
  t: T.hello, v: PROTOCOL_VERSION, name, character, ...(face ? { face } : {}),
});

export const welcome = (actorId, settings, snapshot, faces = undefined) => ({
  t: T.welcome, v: PROTOCOL_VERSION, actorId, settings, snapshot,
  ...(faces && Object.keys(faces).length ? { faces } : {}),
});

export const faces = (map) => ({ t: T.faces, faces: map });

/**
 * A face picture arrives from the network as a data URL that will be handed
 * to an <img> and painted onto a texture every player downloads. The only
 * shapes allowed through are raster image data URLs of modest size — no
 * SVG (scriptable), no URLs to someone's server (tracking pixel), nothing
 * big enough to hurt the data channel.
 */
export const MAX_FACE_CHARS = 65536;

export function sanitizeFace(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_FACE_CHARS) return null;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : null;
}

export const full = (reason) => ({ t: T.full, reason });
export const cmd = (c) => ({ t: T.cmd, c });
export const claims = (list) => ({ t: T.claims, claims: list });
export const snap = (s, ev) => ({ t: T.snap, s, ev });
export const bye = () => ({ t: T.bye });

/**
 * Commands arrive from the network, so they are not trusted to be the shape
 * the simulation expects. Strip them to known fields with known types: a
 * `forward` of `"1e9"` or an object where a number belongs should not reach
 * World.setCommand.
 */
export function sanitizeCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
  };
  return {
    forward: num(raw.forward, -1, 1),
    strafe: num(raw.strafe, -1, 1),
    jump: !!raw.jump,
    crouch: !!raw.crouch,
    fire: !!raw.fire,
    aim: !!raw.aim,
    reload: !!raw.reload,
    use: !!raw.use,
    yaw: num(raw.yaw, -1e4, 1e4),
    pitch: num(raw.pitch, -Math.PI, Math.PI),
    weaponSlot: Number.isInteger(raw.weaponSlot) ? Math.max(0, Math.min(8, raw.weaponSlot)) : null,
    switchDelta: num(raw.switchDelta, -8, 8),
  };
}

/**
 * Hit claims are trusted for *whether* they happened, never for how much they
 * hurt.
 *
 * `damage` is carried through deliberately. The shooter computes it — that is
 * what "favour the shooter" means, and it is why hitting feels right on a
 * laggy connection — and World.applyClaims runs it through
 * clampClaimDamage, which ceilings it at the weapon's own maximum. Stripping
 * the field here would not be safer, it would just mean every shot did
 * nothing; the clamp is the boundary, not the deletion.
 *
 * This pass only guarantees the fields exist and are the right kind of thing,
 * so nothing unchecked reaches the simulation.
 */
/** The claim kinds a client is allowed to assert. */
const CLAIM_KINDS = ['hitscan', 'beam', 'melee'];

export function sanitizeClaims(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 32).filter((c) => c && typeof c === 'object' && typeof c.weaponId === 'string')
    .map((c) => ({
      // An unrecognised kind is read as a plain hitscan rather than refused,
      // so a newer client cannot invent a resolve path on this host.
      kind: CLAIM_KINDS.includes(c.kind) ? c.kind : 'hitscan',
      backstab: !!c.backstab,
      shooter: String(c.shooter ?? ''),
      weaponId: String(c.weaponId),
      target: c.target == null ? null : String(c.target),
      deployable: Number.isInteger(c.deployable) ? c.deployable : null,
      headshot: !!c.headshot,
      damage: Number.isFinite(Number(c.damage)) ? Math.max(0, Number(c.damage)) : 0,
      surface: typeof c.surface === 'string' ? c.surface.slice(0, 32) : undefined,
      point: vec(c.point),
      dir: vec(c.dir),
      origin: vec(c.origin),
      normal: c.normal ? vec(c.normal) : null,
    }));
}

function vec(v) {
  if (!v || typeof v !== 'object') return { x: 0, y: 0, z: 0 };
  const n = (k) => (Number.isFinite(Number(v[k])) ? Number(v[k]) : 0);
  return { x: n('x'), y: n('y'), z: n('z') };
}
