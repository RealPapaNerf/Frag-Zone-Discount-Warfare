/**
 * The lobby. Every control here is generated from the loaded content, not
 * hard-coded: drop a new mutator JSON into public/data and it appears as a
 * toggle without touching this file. That is the whole point of the
 * data-driven rule system, so the menu is the first place to prove it.
 */
export class Menu {
  constructor(root, content) {
    this.root = root;
    this.content = content;
    this.onStart = () => {};
    this.onResume = () => {};
    this.onQuit = () => {};

    const defaults = content.manifest.defaults;
    this.state = {
      mapId: defaults.map,
      modeId: defaults.mode,
      characterId: defaults.character,
      botProfileId: defaults.botProfile,
      botCount: defaults.botCount,
      mutatorIds: new Set(defaults.mutators ?? []),
      // A copy: the lobby edits this, and the manifest's own array must not
      // pick up the edits.
      loadout: [...defaults.loadout],
      net: 'solo',
      room: '',
    };
    this.mode = 'lobby'; // 'lobby' | 'paused' | 'hidden'
    this.#build();
  }

  #syncStartLabel() {
    const button = this.root.querySelector('#m-start');
    if (!button) return;
    button.textContent = this.state.net === 'host' ? 'HOST THE FIGHT'
      : this.state.net === 'join' ? 'JOIN THE FIGHT'
        : 'FIGHT';
  }

  /** Progress and failures from connecting, shown where the room name is. */
  setNetStatus(message, kind = 'info') {
    const el = this.root.querySelector('#m-net-status');
    if (!el) return;
    el.textContent = message ?? '';
    el.hidden = !message;
    el.className = `mp-status ${kind}`;
  }

  /** A line above the lobby, used when the editor sent us a map to playtest. */
  setNote(html) {
    this.note = html;
    const el = this.root.querySelector('#m-note');
    if (el) { el.innerHTML = html; el.hidden = !html; }
  }

  #build() {
    const maps = Object.values(this.content.maps);
    // `hidden` weapons are ammunition for something else — a turret's
    // chickens are not a thing you walk around holding.
    const weapons = Object.values(this.content.weapons).filter((w) => !w.hidden);
    const modes = Object.values(this.content.modes);
    const mutators = Object.values(this.content.mutators);
    const profiles = Object.values(this.content.bots);

    this.root.innerHTML = `
      <div class="menu-card">
        <h1>FRAG&nbsp;ZONE<em>Discount Warfare</em></h1>
        <div id="m-note" class="menu-note" hidden></div>

        <div class="menu-body">
          <div class="menu-col">
            <label class="field">
              <span>Arena</span>
              <select id="m-map">${maps.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
            </label>
            <label class="field">
              <span>Mode</span>
              <select id="m-mode">${modes.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
            </label>
            <label class="field">
              <span>Bots</span>
              <input type="range" id="m-botcount" min="0" max="7" value="${this.state.botCount}">
              <output id="m-botcount-out">${this.state.botCount}</output>
            </label>
            <label class="field">
              <span>Skill</span>
              <select id="m-skill">${profiles.map((p) =>
                `<option value="${p.id}"${p.id === this.state.botProfileId ? ' selected' : ''}>${p.id}</option>`).join('')}</select>
            </label>
          </div>

          <div class="menu-col">
            <span class="group-label">Loadout <i>what you spawn with</i></span>
            <div class="mutators" id="m-loadout">
              ${weapons.map((w) => `
                <label class="toggle" title="${escapeAttr(w.description ?? '')}">
                  <input type="checkbox" value="${w.id}"${this.state.loadout.includes(w.id) ? ' checked' : ''}>
                  <span>${w.name}</span>
                </label>`).join('')}
            </div>

            <span class="group-label">Mutators <i>stackable</i></span>
            <div class="mutators" id="m-mutators">
              ${mutators.map((m) => `
                <label class="toggle" title="${escapeAttr(m.description ?? '')}">
                  <input type="checkbox" value="${m.id}"${this.state.mutatorIds.has(m.id) ? ' checked' : ''}>
                  <span>${m.name}</span>
                </label>`).join('')}
            </div>
          </div>
        </div>

        <div class="multiplayer">
          <div class="mp-row">
            <div class="seg" id="m-mode-seg">
              <button data-net="solo" class="on">Solo</button>
              <button data-net="host">Host</button>
              <button data-net="join">Join</button>
            </div>
            <input type="text" id="m-room" placeholder="room name, e.g. garden-night" maxlength="40" hidden>
          </div>
          <div id="m-net-status" class="mp-status" hidden></div>
        </div>

        <div class="menu-actions">
          <button id="m-start" class="primary">FIGHT</button>
          <button id="m-resume" class="ghost" hidden>RESUME</button>
          <button id="m-quit" class="ghost" hidden>LEAVE MATCH</button>
        </div>

        <div class="controls-hint">
          <b>WASD</b> move · <b>Space</b> jump · <b>Mouse</b> look · <b>Click</b> fire · <b>Right-click</b> aim
          · <b>1-9</b> or <b>wheel</b> weapons · <b>R</b> reload · <b>Tab</b> scores · <b>Esc</b> pause
          <br><small>Rocket jump: look at your feet and fire. It hurts less than it should.
          Hold the trigger on the Telescope to wind it up. The Doorbell reloads a shell at a time —
          pulling the trigger stops it feeding.</small>
        </div>
      </div>
    `;

    const $ = (id) => this.root.querySelector(id);
    if (this.note) this.setNote(this.note);
    $('#m-map').value = this.state.mapId;
    $('#m-mode').value = this.state.modeId;

    $('#m-map').onchange = (e) => { this.state.mapId = e.target.value; };
    $('#m-mode').onchange = (e) => { this.state.modeId = e.target.value; };
    $('#m-skill').onchange = (e) => { this.state.botProfileId = e.target.value; };
    $('#m-botcount').oninput = (e) => {
      this.state.botCount = Number(e.target.value);
      $('#m-botcount-out').textContent = e.target.value;
    };
    // Loadout order follows the content order, not click order, so slot 1 is
    // always the same weapon for a given set of ticks.
    const loadoutBoxes = [...this.root.querySelectorAll('#m-loadout input')];
    for (const box of loadoutBoxes) {
      box.onchange = () => {
        const checked = loadoutBoxes.filter((b) => b.checked);
        // You have to spawn holding something.
        if (!checked.length) { box.checked = true; return; }
        this.state.loadout = loadoutBoxes.filter((b) => b.checked).map((b) => b.value);
      };
    }

    for (const box of this.root.querySelectorAll('#m-mutators input')) {
      box.onchange = () => {
        if (box.checked) this.state.mutatorIds.add(box.value);
        else this.state.mutatorIds.delete(box.value);
      };
    }

    // Solo / Host / Join. The room field only matters for the latter two,
    // and the primary button says what pressing it will actually do.
    for (const b of this.root.querySelectorAll('#m-mode-seg button')) {
      b.onclick = () => {
        this.state.net = b.dataset.net;
        for (const other of this.root.querySelectorAll('#m-mode-seg button')) {
          other.classList.toggle('on', other === b);
        }
        $('#m-room').hidden = this.state.net === 'solo';
        this.#syncStartLabel();
      };
    }
    $('#m-room').value = this.state.room ?? '';
    $('#m-room').oninput = (e) => { this.state.room = e.target.value; };
    this.#syncStartLabel();

    $('#m-start').onclick = () => this.onStart(this.settings());
    $('#m-resume').onclick = () => this.onResume();
    $('#m-quit').onclick = () => this.onQuit();
    this.startButton = $('#m-start');
    this.resumeButton = $('#m-resume');
    this.quitButton = $('#m-quit');
  }

  settings() {
    return {
      mapId: this.state.mapId,
      modeId: this.state.modeId,
      characterId: this.state.characterId,
      botProfileId: this.state.botProfileId,
      botCount: this.state.botCount,
      mutatorIds: [...this.state.mutatorIds],
      loadout: this.state.loadout,
      net: this.state.net,
      room: this.state.room,
      playerName: 'You',
      seed: (Math.random() * 0xffff) | 0,
    };
  }

  show(mode) {
    this.mode = mode;
    this.root.hidden = false;
    this.root.classList.toggle('paused', mode === 'paused');
    this.startButton.hidden = mode === 'paused';
    this.resumeButton.hidden = mode !== 'paused';
    this.quitButton.hidden = mode !== 'paused';
  }

  hide() {
    this.mode = 'hidden';
    this.root.hidden = true;
  }
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
