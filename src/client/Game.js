import { Renderer } from '../render/Renderer.js';
import { Input } from './Input.js';
import { HUD } from './hud/HUD.js';
import { LocalHost } from './LocalHost.js';
import { BootProgress } from './BootProgress.js';

/**
 * Glue: run the loop, feed input to the host, draw whatever the host reports.
 *
 * This file talks to a Host interface, never to World. Swapping LocalHost for
 * a PeerHost is the whole of what milestone 2 has to change here.
 */
export class Game {
  constructor({ canvas, hudRoot, content }) {
    this.content = content;
    this.canvas = canvas;
    this.renderer = new Renderer(canvas, { quality: 'medium' });
    this.hud = new HUD(hudRoot);
    // The HUD names status effects, so it needs their definitions.
    this.hud.effects = content.effects ?? {};
    this.hudRoot = hudRoot;
    // Nothing to report until a match exists; the empty HUD showing through
    // the lobby backdrop just looks like a bug.
    hudRoot.hidden = true;
    this.input = new Input(canvas);
    this.input.onPause = () => this.#onPointerLost();

    this.host = null;
    this.running = false;
    this.lastFrame = 0;
    this.snapshot = null;
    this.paused = false;
    this.onPauseChange = () => {};

    this._onResize = () => this.renderer.onResize();
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Starting a match does real work — building the world also builds the nav
   * graph, which is the most expensive thing that happens anywhere — so it is
   * reported step by step like boot is.
   */
  /**
   * @param {object} settings lobby settings
   * @param {BootProgress} progress
   * @param {Host} [host] an already-built host. Hosting and joining need to
   *   make the connection before a match exists, so main.js builds those and
   *   hands them in; solo still builds its own LocalHost here.
   */
  async start(settings, progress = BootProgress.silent(), host = null) {
    this.settings = settings;

    this.host = host ?? await progress.run('Building world and nav graph', () =>
      new LocalHost({ content: this.content, ...settings }));

    // A client plays the host's map, which is not necessarily the one its own
    // lobby had selected.
    const mapId = this.host.settings?.mapId ?? settings.mapId;
    const mapDoc = this.content.maps[mapId];

    await progress.run('Building arena geometry', () =>
      this.renderer.loadArena(mapDoc, this.host.arena, this.content));

    this.headScale = this.host.rules.headScale;

    this.snapshot = this.host.snapshot();
    // Face the way we were spawned. Read off the snapshot rather than out of
    // the World, because a client that joined someone else's game has no
    // World to read — only whatever the host has told it so far.
    const me = this.snapshot.actors.find((a) => a.id === this.host.localActorId);
    if (me) this.input.setLook(me.yaw, 0);
    await progress.run('Spawning fighters', () =>
      this.renderer.syncActors(this.snapshot, this.host.localActorId, this.headScale));

    this.hud.setMessage('');
    this.hudRoot.hidden = false;

    this.running = true;
    this.paused = false;
    this.lastFrame = performance.now();
    this.input.requestLock();
    requestAnimationFrame(this.#frame);
  }

  stop() {
    this.running = false;
    this.hudRoot.hidden = true;
    this.input.releaseLock();
    this.renderer.clearArena();
    this.host = null;
  }

  #onPointerLost() {
    if (!this.running) return;
    this.paused = true;
    this.onPauseChange(true);
  }

  resume() {
    this.paused = false;
    this.onPauseChange(false);
    this.lastFrame = performance.now();
    this.input.requestLock();
  }

  #frame = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this.#frame);

    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    if (this.paused) return;

    const command = this.input.takeCommand();
    this.host.sendCommand(command);
    this.host.update(dt);

    this.snapshot = this.host.snapshot();
    this.#consumeEvents(this.host.drainEvents());

    this.renderer.syncActors(this.snapshot, this.host.localActorId, this.headScale);
    this.#updateViews(dt);
    this.#drawFrame(dt, now);
  };

  #updateViews(dt) {
    const alpha = this.host.alpha;
    for (const actor of this.snapshot.actors) {
      const view = this.renderer.actorViews.get(actor.id);
      if (!view) continue;
      // Interpolate between the last two sim ticks so motion stays smooth
      // even though the simulation only moves 60 times a second.
      const pos = {
        x: actor.prevPos.x + (actor.pos.x - actor.prevPos.x) * alpha,
        y: actor.prevPos.y + (actor.pos.y - actor.prevPos.y) * alpha,
        z: actor.prevPos.z + (actor.pos.z - actor.prevPos.z) * alpha,
      };
      view.setStatus?.(actor.effects, this.content.effects);
      view.update(actor, pos, dt);
    }
    this.renderer.effects.syncRockets(this.snapshot.projectiles);
    this.renderer.effects.update(dt);
    this.renderer.arenaView?.update(this.snapshot.time);
  }

  #drawFrame(dt, now) {
    const me = this.snapshot.actors.find((a) => a.id === this.host.localActorId);
    // Through the host, so a patched weapon draws and reads as the patched
    // one — the view model and the ammo panel both key off this.
    const weapon = me ? this.host.weaponById?.(me.weapon) ?? this.content.weapons[me.weapon] : null;
    this.renderer.viewModel.setWeapon(weapon);
    // No floating gun while you wait to respawn.
    this.renderer.viewModel.root.visible = me?.alive ?? false;

    const character = this.content.characters[me?.characterId ?? this.settings.characterId];
    const eyeHeight = character.hitbox.eyeHeight;
    const alpha = this.host.alpha;
    const speed = me ? Math.hypot(me.vel.x, me.vel.z) : 0;

    const pos = me
      ? {
        x: me.prevPos.x + (me.pos.x - me.prevPos.x) * alpha,
        y: me.prevPos.y + (me.pos.y - me.prevPos.y) * alpha + eyeHeight,
        z: me.prevPos.z + (me.pos.z - me.prevPos.z) * alpha,
      }
      : { x: 0, y: 2, z: 0 };

    // A touch of FOV with speed, the classic sense-of-pace trick. Aiming
    // pulls it in hard, and the ease is what sells the movement — snapping
    // the FOV reads as a glitch rather than a rifle coming up.
    const aiming = !!this.input.aim && this.input.locked;
    // A weapon may bring its own sight picture; a scope zooms harder than
    // the generic 52 ever should.
    const adsFov = weapon?.view?.adsFov ?? 52;
    const targetFov = aiming ? adsFov : 95 + Math.min(speed / 10, 1.4) * 6;
    this.adsFov = this.adsFov ?? targetFov;
    this.adsFov += (targetFov - this.adsFov) * Math.min(1, dt * 14);
    const fov = this.adsFov;

    this.renderer.viewModel.setAim?.(aiming, dt);
    this.renderer.viewModel.setReload?.(!!me?.reloading, dt);
    this.renderer.viewModel.setCharge?.(me?.charge ?? 0);
    this.renderer.viewModel.update(dt, speed, this.input.takeLookDelta(), me?.grounded ?? true);
    // "Fixed an issue where players could see" is a rule, so the fog follows
    // the rule bag rather than the map.
    this.renderer.setFog?.(this.host.rules?.fogDensity ?? 0);
    this.renderer.render(dt, { position: pos, yaw: this.input.yaw, pitch: this.input.pitch, fov });

    this.hud.update(this.snapshot, this.host.localActorId, weapon, now);
    this.hud.setScoreboardVisible(
      this.input.scoreboardHeld || this.snapshot.match.state === 'over',
      this.snapshot, this.host.localActorId,
    );

    if (this.snapshot.match.state === 'over') {
      const winner = this.snapshot.match.standings[0];
      this.hud.setMessage(
        `<strong>${winner?.id === this.host.localActorId ? 'YOU WIN' : `${winner?.name ?? '—'} WINS`}</strong>`
        + '<small>press R for a rematch</small>', 'big');
    } else if (me && !me.alive) {
      const wait = Math.max(0, me.respawnAt - this.snapshot.time);
      this.hud.setMessage(`<strong>RESPAWNING</strong><small>${wait.toFixed(1)}s</small>`);
    } else {
      this.hud.setMessage('');
    }
  }

  /** Translate simulation events into sound, sparks and HUD reactions. */
  #consumeEvents(events) {
    const localId = this.host.localActorId;
    for (const event of events) {
      switch (event.type) {
        case 'shot': {
          const weapon = this.host.weaponById?.(event.weapon) ?? this.content.weapons[event.weapon];
          const tracer = weapon?.tracer;
          if (event.kind === 'beam') {
            // A beam refreshes one lasting shape per shooter rather than
            // leaving a tracer behind every tick.
            if (event.point) {
              this.renderer.effects.addBeam(
                event.shooter, event.origin, event.point,
                tracer?.color ?? '#9fe9ff',
                Math.max(0.06, (weapon?.fire?.tickSec ?? 0.05) * 2.2),
                tracer?.width ?? 0.035,
              );
            }
            if (event.point && !event.hitActor && Math.random() < 0.35) {
              this.renderer.effects.addImpact(event.point, event.normal, { count: 2 });
            }
            break;
          }
          // A swing has no tracer and no muzzle flash; the view model's kick
          // is the whole tell.
          if (event.kind === 'melee') break;
          if (tracer && event.point) {
            this.renderer.effects.addTracer(event.origin, event.point, tracer.color, tracer.life);
          }
          if (event.point && !event.hitActor) {
            this.renderer.effects.addImpact(event.point, event.normal, { count: 5 });
          }
          if (event.shooter === localId) this.renderer.viewModel.onFire();
          break;
        }
        case 'fire':
          // A charged shot kicks harder, so the recoil reads the wind-up back.
          if (event.shooter === localId) this.renderer.viewModel.onFire(event.charge ?? 0);
          break;
        case 'reloadEnd':
          // Only the last shell of a single-round reload gets the thunk.
          if (event.id === localId && event.done) this.renderer.viewModel.onReloadDone?.();
          break;
        case 'patchNote':
          this.hud.showPatchNote(event);
          break;
        case 'heal': {
          // Explosions heal: the same flash the victim gets, in a kinder colour.
          const view = this.renderer.actorViews.get(event.actor);
          view?.flashHit();
          break;
        }
        case 'explosion':
          this.renderer.effects.addExplosion(event.point, event.radius);
          this.#shakeFrom(event.point, event.radius);
          break;
        case 'damage': {
          const view = this.renderer.actorViews.get(event.victim);
          view?.flashHit();
          if (event.attacker === localId && event.victim !== localId) this.hud.showHitMarker(false);
          if (event.victim === localId) this.hud.flashDamage();
          break;
        }
        case 'kill':
          this.hud.addKill(event, localId);
          if (event.attacker === localId && event.victim !== localId) this.hud.showHitMarker(true);
          break;
        case 'projectileEnd':
          if (event.hit === 'world' && event.pos) {
            this.renderer.effects.addImpact(event.pos, event.normal, { count: 3 });
          }
          break;
        default:
          break;
      }
    }
  }

  #shakeFrom(point, radius) {
    const me = this.snapshot.actors.find((a) => a.id === this.host.localActorId);
    if (!me) return;
    const dist = Math.hypot(me.pos.x - point.x, me.pos.y - point.y, me.pos.z - point.z);
    const falloff = Math.max(0, 1 - dist / (radius * 3));
    if (falloff > 0) this.renderer.addShake(falloff * 1.1);
  }

  restart() {
    this.host?.restart();
    this.hud.killFeed.length = 0;
  }

  dispose() {
    this.running = false;
    window.removeEventListener('resize', this._onResize);
    this.input.dispose();
    this.renderer.dispose();
  }
}
