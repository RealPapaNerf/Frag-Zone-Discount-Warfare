import { Host } from '../engine/net/Host.js';
import { World, TICK_DT } from '../engine/sim/World.js';
import { Bot } from '../engine/ai/Bot.js';
import { pickBotLoadout } from '../engine/ai/loadout.js';
import { Rng } from '../engine/core/Rng.js';

const BOT_NAMES = [
  'Mittens', 'Dumpster', 'Chadwick', 'Gravy', 'Shovel', 'Bandit',
  'Nugget', 'Trash Panda', 'Wingnut', 'Biscuit', 'Mothman', 'Clive',
];

/**
 * Milestone 1's Host: the authoritative World, running in this tab.
 *
 * It exists so nothing above it talks to World directly. When the P2P host
 * lands it implements the same five methods, and Game.js does not change.
 */
export class LocalHost extends Host {
  constructor({ content, mapId, modeId, mutatorIds = [], seed = Date.now() & 0xffff,
                playerName = 'You', characterId, loadout, botCount = 3, botProfileId = 'normal',
                face = null }) {
    super();
    this.content = content;
    this.world = new World({ content, mapId, modeId, mutatorIds, seed });

    this.localId = 'player';
    // Face pictures by actor id. Solo this is only ever your own, which you
    // never see from first person — it exists so hosting shows your face to
    // everyone else without a special case.
    this.faces = face ? { [this.localId]: face } : {};
    this.world.addActor({
      id: this.localId, name: playerName, characterId, loadout, isBot: false,
    });

    const rng = new Rng(seed ^ 0x9e37);
    const names = [...BOT_NAMES];
    for (let i = 0; i < botCount; i++) {
      const id = `bot${i}`;
      const nameIndex = rng.int(names.length);
      const name = names.splice(nameIndex, 1)[0] ?? `Bot ${i + 1}`;
      // Bots carry their own loadout, not the player's: see ai/loadout.js.
      this.world.addActor({
        id, name, characterId, isBot: true,
        loadout: pickBotLoadout(content, rng, content.modes[modeId]),
      });
      this.world.attachController(id, new Bot({
        profile: content.bots[botProfileId], rng: new Rng(seed + i * 7919), name,
      }));
    }

    this.accumulator = 0;
    this.alpha = 0;
    this.pendingCommand = null;
  }

  get isAuthority() { return true; }
  get localActorId() { return this.localId; }
  get rules() { return this.world.rules; }
  weaponById(id) { return this.world.weaponById(id); }
  get arena() { return this.world.arena; }

  sendCommand(command) {
    this.pendingCommand = command;
  }

  sendHitClaims(claims) {
    // Already the authority: apply them straight away. A remote host would
    // serialise these instead, and the receiving side would call the same
    // World.applyClaims.
    this.world.applyClaims(this.localId, claims);
  }

  /**
   * Hand this tick's inputs to the World. Split out of update() so a host
   * serving peers can feed their commands in through the same door, on the
   * same tick, rather than reimplementing the timestep loop.
   *
   * Held keys repeat across catch-up ticks, but one-shot intents must not: a
   * single wheel click on a slow frame would otherwise cycle the weapon once
   * per tick.
   */
  applyPendingCommands() {
    if (!this.pendingCommand) return;
    this.world.setCommand(this.localId, this.pendingCommand);
    this.pendingCommand.weaponSlot = null;
    this.pendingCommand.switchDelta = 0;
  }

  /**
   * Fixed-timestep catch-up. Rendering runs at whatever rate the display
   * manages; the simulation always advances in 1/60 steps so physics and bot
   * behaviour do not change with frame rate.
   */
  update(dt) {
    this.accumulator += Math.min(dt, 0.25); // never spiral after a tab stall
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 8) {
      this.applyPendingCommands();
      this.world.step(TICK_DT);
      this.accumulator -= TICK_DT;
      steps++;
    }
    this.alpha = this.accumulator / TICK_DT;
    return steps;
  }

  snapshot() {
    return this.world.snapshot();
  }

  drainEvents() {
    return this.world.events.drain();
  }

  restart() {
    // Cheap for now: a fresh World with the same settings would lose the
    // controllers, so just reset scores and respawn everyone.
    for (const actor of this.world.actors) {
      actor.score = 0;
      actor.kills = 0;
      actor.deaths = 0;
      this.world.respawn(actor, true);
    }
    this.world.match.state = 'active';
    this.world.match.elapsed = 0;
    this.world.match.winnerId = null;
    this.world.match.killFeed.length = 0;
  }
}
