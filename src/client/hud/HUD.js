/**
 * The HUD is plain DOM over the canvas. Text stays crisp at any resolution
 * and costs no GPU time, which matters more than it sounds on a Chromebook.
 *
 * Everything it shows comes from snapshots and events, so it works unchanged
 * whether the host is this tab or a peer.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.killFeed = [];
    this.lastHealth = 100;
    this.lastScoreline = null;
    this.el = {};
    this.#build();
  }

  #build() {
    this.root.innerHTML = `
      <div class="hud-layer" id="hud-layer">
        <div class="crosshair" id="crosshair"><span></span><span></span><span></span><span></span></div>
        <div class="hitmarker" id="hitmarker"></div>
        <div class="damage-flash" id="damage-flash"></div>

        <div class="hud-top">
          <div class="match-clock" id="match-clock">--:--</div>
          <div class="match-score" id="match-score"></div>
        </div>

        <div class="kill-feed" id="kill-feed"></div>

        <div class="hud-bottom">
          <div class="vitals">
            <div class="stat health"><span class="label">HEALTH</span><span class="value" id="health">100</span></div>
          </div>
          <div class="ammo-block">
            <div class="weapon-name" id="weapon-name">—</div>
            <div class="stat ammo">
              <span class="value" id="ammo">0</span>
              <span class="reserve" id="ammo-reserve"></span>
              <span class="label" id="ammo-label">AMMO</span>
            </div>
            <div class="reload-bar" id="reload-bar"><i></i></div>
          </div>
        </div>

        <div class="center-message" id="center-message"></div>
        <div class="scoreboard" id="scoreboard"></div>
      </div>
    `;
    for (const id of ['crosshair', 'hitmarker', 'damage-flash', 'match-clock', 'match-score',
      'kill-feed', 'health', 'weapon-name', 'ammo', 'ammo-reserve', 'ammo-label',
      'reload-bar', 'center-message', 'scoreboard']) {
      this.el[id] = this.root.querySelector(`#${id}`);
    }
  }

  showHitMarker(killed = false) {
    const marker = this.el.hitmarker;
    marker.classList.remove('show', 'kill');
    void marker.offsetWidth; // restart the CSS animation
    marker.classList.add('show');
    if (killed) marker.classList.add('kill');
  }

  flashDamage() {
    const flash = this.el['damage-flash'];
    flash.classList.remove('show');
    void flash.offsetWidth;
    flash.classList.add('show');
  }

  addKill(entry, localId) {
    const attacker = entry.attackerName ?? '';
    const self = entry.attacker === null || entry.attacker === entry.victim;
    const verb = entry.cause === 'fall' ? 'fell' : self ? 'blew up' : (entry.headshot ? '🎯' : '→');

    this.killFeed.unshift({
      html: self
        ? `<span class="victim">${escapeHtml(entry.victimName ?? '?')}</span> <span class="verb">${verb}</span>`
        : `<span class="${entry.attacker === localId ? 'you' : 'killer'}">${escapeHtml(attacker)}</span>`
          + ` <span class="verb">${verb}</span> `
          + `<span class="${entry.victim === localId ? 'you' : 'victim'}">${escapeHtml(entry.victimName ?? '?')}</span>`,
      until: performance.now() + 5500,
    });
    if (this.killFeed.length > 6) this.killFeed.length = 6;
    this.#renderKillFeed();
  }

  #renderKillFeed() {
    this.el['kill-feed'].innerHTML = this.killFeed.map((k) => `<div class="kill-row">${k.html}</div>`).join('');
  }

  setMessage(text, kind = '') {
    const el = this.el['center-message'];
    el.className = `center-message ${kind}`;
    el.innerHTML = text ?? '';
  }

  /**
   * A magazine weapon reads "12 / 148": what is in the gun, then what is left
   * to put in it. A weapon without a magazine keeps the single running total
   * it always had, so nothing about the rifle's HUD changes until it grows a
   * magazine of its own.
   */
  #updateAmmo(me, weapon, time) {
    const size = weapon?.ammo?.magazine ?? 0;
    const loaded = size > 0 ? me.mag ?? 0 : me.ammo;
    this.el.ammo.textContent = loaded;
    this.el['ammo-reserve'].textContent = size > 0 ? `/ ${me.ammo}` : '';
    this.el.ammo.classList.toggle('empty', size > 0 && loaded <= 0);
    this.el['ammo-label'].textContent = me.reloading ? 'RELOADING' : 'AMMO';

    const bar = this.el['reload-bar'];
    const span = (me.reloadEndsAt ?? 0) - (me.reloadFrom ?? 0);
    // The bar tracks one step, which for a shell-by-shell reload means it
    // fills once per shell rather than once per magazine.
    const progress = me.reloading && span > 0
      ? Math.max(0, Math.min(1, (time - me.reloadFrom) / span))
      : 0;
    bar.classList.toggle('show', !!me.reloading);
    bar.firstElementChild.style.transform = `scaleX(${progress.toFixed(3)})`;
  }

  /** Called every frame with the latest snapshot. */
  update(snapshot, localId, weapon, now) {
    const me = snapshot.actors.find((a) => a.id === localId);
    if (me) {
      if (me.health < this.lastHealth && me.alive) this.flashDamage();
      this.lastHealth = me.health;
      this.el.health.textContent = Math.max(0, Math.round(me.health));
      this.el.health.className = `value ${me.health <= 30 ? 'critical' : me.health <= 60 ? 'low' : ''}`;
      this.#updateAmmo(me, weapon, snapshot.time);
      this.el['weapon-name'].textContent = weapon?.name ?? '—';
      this.el.crosshair.classList.toggle('dead', !me.alive);
    }

    const match = snapshot.match;
    this.el['match-clock'].textContent = formatClock(match.timeRemaining);
    const top = match.standings.slice(0, 3)
      .map((s) => `<span class="${s.id === localId ? 'you' : ''}">${escapeHtml(s.name)} ${s.score}</span>`)
      .join('<i>·</i>');
    const scoreline = `${top}<i>·</i><span class="limit">to ${match.scoreLimit}</span>`;
    // Reparsing this every frame is pure garbage on a slow machine.
    if (scoreline !== this.lastScoreline) {
      this.lastScoreline = scoreline;
      this.el['match-score'].innerHTML = scoreline;
    }

    const expired = this.killFeed.filter((k) => k.until > now);
    if (expired.length !== this.killFeed.length) {
      this.killFeed = expired;
      this.#renderKillFeed();
    }
  }

  setScoreboardVisible(visible, snapshot, localId) {
    this.el.scoreboard.classList.toggle('show', visible);
    if (!visible || !snapshot) return;
    const rows = snapshot.match.standings.map((s, i) => `
      <tr class="${s.id === localId ? 'you' : ''}">
        <td class="rank">${i + 1}</td>
        <td class="name">${escapeHtml(s.name)}${s.isBot ? '<em>bot</em>' : ''}</td>
        <td class="num">${s.score}</td>
        <td class="num">${s.kills}</td>
        <td class="num">${s.deaths}</td>
      </tr>`).join('');
    this.el.scoreboard.innerHTML = `
      <table>
        <thead><tr><th></th><th>Player</th><th>Score</th><th>K</th><th>D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '∞';
  const total = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
