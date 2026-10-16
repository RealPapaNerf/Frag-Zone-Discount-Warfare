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
      loadout: defaults.loadout,
    };
    this.mode = 'lobby'; // 'lobby' | 'paused' | 'hidden'
    this.#build();
  }

  #build() {
    const maps = Object.values(this.content.maps);
    const modes = Object.values(this.content.modes);
    const mutators = Object.values(this.content.mutators);
    const profiles = Object.values(this.content.bots);

    this.root.innerHTML = `
      <div class="menu-card">
        <h1>FRAG&nbsp;ZONE<em>Discount Warfare</em></h1>

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

        <div class="menu-actions">
          <button id="m-start" class="primary">FIGHT</button>
          <button id="m-resume" class="ghost" hidden>RESUME</button>
          <button id="m-quit" class="ghost" hidden>LEAVE MATCH</button>
        </div>

        <div class="controls-hint">
          <b>WASD</b> move · <b>Space</b> jump · <b>Mouse</b> look · <b>Click</b> fire
          · <b>1/2</b> or <b>wheel</b> weapons · <b>Tab</b> scores · <b>R</b> rematch · <b>Esc</b> pause
          <br><small>Rocket jump: look at your feet and fire. It hurts less than it should.</small>
        </div>
      </div>
    `;

    const $ = (id) => this.root.querySelector(id);
    $('#m-map').value = this.state.mapId;
    $('#m-mode').value = this.state.modeId;

    $('#m-map').onchange = (e) => { this.state.mapId = e.target.value; };
    $('#m-mode').onchange = (e) => { this.state.modeId = e.target.value; };
    $('#m-skill').onchange = (e) => { this.state.botProfileId = e.target.value; };
    $('#m-botcount').oninput = (e) => {
      this.state.botCount = Number(e.target.value);
      $('#m-botcount-out').textContent = e.target.value;
    };
    for (const box of this.root.querySelectorAll('#m-mutators input')) {
      box.onchange = () => {
        if (box.checked) this.state.mutatorIds.add(box.value);
        else this.state.mutatorIds.delete(box.value);
      };
    }

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
