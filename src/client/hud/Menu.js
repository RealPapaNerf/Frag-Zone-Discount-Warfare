/**
 * The lobby. Every control here is generated from the loaded content, not
 * hard-coded: drop a new mutator JSON into public/data and it appears as a
 * toggle without touching this file. That is the whole point of the
 * data-driven rule system, so the menu is the first place to prove it.
 */
import { weaponsForMode, weaponIdsForMode } from '../../engine/rules/weaponPool.js';
import { loadIdentity, saveIdentity, faceFromFile, NAME_MAX } from '../identity.js';
import { normaliseRoom } from '../../net/roomName.js';
import { SKINS, swatchColor } from '../../data/skins.js';

export class Menu {
  constructor(root, content) {
    this.root = root;
    this.content = content;
    this.onStart = () => {};
    this.onResume = () => {};
    this.onQuit = () => {};

    const defaults = content.manifest.defaults;
    const identity = loadIdentity();
    this.state = {
      name: identity.name,
      face: identity.face,
      skinId: identity.skinId,
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

  /**
   * The weapons the chosen mode allows, grouped by category so the arena set
   * and the themed shelves read as separate things rather than one list of
   * twenty-eight.
   */
  #weaponGroups() {
    const mode = this.content.modes[this.state.modeId];
    const labels = this.content.manifest.weaponCategories ?? {};
    const groups = new Map();
    for (const weapon of weaponsForMode(this.content, mode)) {
      const key = weapon.category ?? 'arena';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(weapon);
    }
    // In the order the manifest declares them, not the order weapons happen
    // to load in, so the arena set is always first.
    const order = Object.keys(labels);
    return [...groups]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([key, list]) => ({ key, label: labels[key] ?? key, weapons: list }));
  }

  /** The loadout list, rebuilt whenever the mode changes under it. */
  #loadoutHtml() {
    const groups = this.#weaponGroups();
    const single = groups.length <= 1;
    return groups.map((group) => `
      ${single ? '' : `<div class="loadout-group">${escapeAttr(group.label)}</div>`}
      ${group.weapons.map((w) => `
        <label class="toggle" title="${escapeAttr(w.description ?? '')}">
          <input type="checkbox" value="${w.id}"${this.state.loadout.includes(w.id) ? ' checked' : ''}>
          <span>${w.name}</span>
        </label>`).join('')}`).join('');
  }

  /**
   * Drop anything the new mode will not allow, and make sure you still spawn
   * holding something. Changing mode with an illegal weapon ticked would
   * otherwise start a match with a gun the mode has no record of.
   */
  #reconcileLoadout() {
    const mode = this.content.modes[this.state.modeId];
    const allowed = weaponIdsForMode(this.content, mode);
    this.state.loadout = this.state.loadout.filter((id) => allowed.includes(id));
    if (this.state.loadout.length === 0 && allowed.length) {
      // A themed mode names its own opening loadout; the manifest's is
      // arena weapons, which it would filter down to nothing.
      const fallback = (mode?.defaultLoadout ?? this.content.manifest.defaults?.loadout ?? [])
        .filter((id) => allowed.includes(id));
      this.state.loadout = fallback.length ? fallback : [allowed[0]];
    }
  }

  #build() {
    const maps = Object.values(this.content.maps);
    const modes = Object.values(this.content.modes);
    const mutators = Object.values(this.content.mutators);
    const profiles = Object.values(this.content.bots);
    const characters = Object.values(this.content.characters);
    const myCharacter = this.content.characters[this.state.characterId];

    this.root.innerHTML = `
      <div class="menu-card">
        <h1>FRAG&nbsp;ZONE<em>Discount Warfare</em></h1>
        <div id="m-note" class="menu-note" hidden></div>

        <div class="identity">
          <button id="m-face-pick" class="face-chip" title="Put a picture on your fighter's face. Everyone in the match sees it.">
            <img id="m-face-img" alt="your face" hidden>
            <span id="m-face-plus">+<br>FACE</span>
          </button>
          <label class="field id-name">
            <span>Name</span>
            <input type="text" id="m-name" maxlength="${NAME_MAX}" placeholder="You"
              value="${escapeAttr(this.state.name)}" autocomplete="off" spellcheck="false">
          </label>
          <button id="m-face-clear" class="face-clear" hidden title="Back to the drawn face">&times;</button>
          <input type="file" id="m-face-file" accept="image/*" hidden>
        </div>

        <div class="identity-row2">
          <label class="field id-character">
            <span>Character</span>
            <select id="m-character">${characters.map((c) => `<option value="${c.id}">${c.name ?? c.id}</option>`).join('')}</select>
          </label>
          <div class="skin-picker">
            <span>Skin</span>
            <div class="skin-swatches" id="m-skins">
              ${SKINS.map((s) => `
                <button type="button" class="skin-swatch${s.id === this.state.skinId ? ' on' : ''}"
                  data-skin="${s.id}" title="${escapeAttr(s.name)}"
                  style="--sw:${swatchColor(s, myCharacter)}"></button>`).join('')}
            </div>
          </div>
        </div>

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
                `<option value="${p.id}"${p.id === this.state.botProfileId ? ' selected' : ''}>${p.name ?? p.id}</option>`).join('')}</select>
            </label>
          </div>

          <div class="menu-col">
            <span class="group-label">Loadout <i>what you spawn with</i></span>
            <div class="mutators" id="m-loadout">${this.#loadoutHtml()}</div>

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
          <div id="m-invite" class="mp-invite" hidden>
            <span>Send them this link and they land in your room:</span>
            <code id="m-invite-url"></code>
            <button id="m-invite-copy">COPY</button>
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
          Hold the trigger on the Sniper Rifle to wind it up. The Pump Shotgun reloads a shell at a time —
          pulling the trigger stops it feeding.</small>
        </div>
      </div>
    `;

    const $ = (id) => this.root.querySelector(id);
    if (this.note) this.setNote(this.note);
    $('#m-map').value = this.state.mapId;
    $('#m-mode').value = this.state.modeId;

    // Who you are. Saved as it changes, so it survives into every session.
    $('#m-name').oninput = (e) => {
      this.state.name = e.target.value;
      saveIdentity(this.state);
    };
    $('#m-face-pick').onclick = () => $('#m-face-file').click();
    $('#m-face-file').onchange = async (e) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // picking the same file twice should work twice
      if (!file) return;
      try {
        this.state.face = await faceFromFile(file);
        saveIdentity(this.state);
        this.#syncFace();
      } catch (error) {
        this.setNetStatus(error.message, 'bad');
      }
    };
    $('#m-face-clear').onclick = () => {
      this.state.face = null;
      saveIdentity(this.state);
      this.#syncFace();
    };
    this.#syncFace();

    $('#m-character').value = this.state.characterId;
    $('#m-character').onchange = (e) => { this.state.characterId = e.target.value; };
    for (const swatch of this.root.querySelectorAll('#m-skins .skin-swatch')) {
      swatch.onclick = () => {
        this.state.skinId = swatch.dataset.skin;
        saveIdentity(this.state);
        this.#syncSkins();
      };
    }

    $('#m-map').onchange = (e) => { this.state.mapId = e.target.value; };
    $('#m-mode').onchange = (e) => {
      this.state.modeId = e.target.value;
      // Different modes offer different shelves, so the list is rebuilt and
      // anything the new mode disallows is unticked rather than silently kept.
      this.#reconcileLoadout();
      $('#m-loadout').innerHTML = this.#loadoutHtml();
      this.#bindLoadout();
    };
    $('#m-skill').onchange = (e) => { this.state.botProfileId = e.target.value; };
    $('#m-botcount').oninput = (e) => {
      this.state.botCount = Number(e.target.value);
      $('#m-botcount-out').textContent = e.target.value;
    };
    // Loadout order follows the content order, not click order, so slot 1 is
    // always the same weapon for a given set of ticks.
    this.#bindLoadout();

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
        this.#syncInvite();
      };
    }
    $('#m-room').value = this.state.room ?? '';
    $('#m-room').oninput = (e) => { this.state.room = e.target.value; this.#syncInvite(); };
    this.#syncStartLabel();

    $('#m-invite-copy').onclick = async () => {
      const url = $('#m-invite-url').textContent;
      const button = $('#m-invite-copy');
      try {
        await navigator.clipboard.writeText(url);
        button.textContent = 'COPIED ✓';
      } catch {
        // No clipboard permission: select it so Ctrl+C is one keystroke away.
        const range = document.createRange();
        range.selectNodeContents($('#m-invite-url'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'PRESS CTRL+C';
      }
      setTimeout(() => { button.textContent = 'COPY'; }, 1800);
    };

    $('#m-start').onclick = () => this.onStart(this.settings());
    $('#m-resume').onclick = () => this.onResume();
    $('#m-quit').onclick = () => this.onQuit();
    this.startButton = $('#m-start');
    this.resumeButton = $('#m-resume');
    this.quitButton = $('#m-quit');
  }

  /** The face button shows the picture when there is one, the prompt when not. */
  #syncFace() {
    const img = this.root.querySelector('#m-face-img');
    const plus = this.root.querySelector('#m-face-plus');
    const clear = this.root.querySelector('#m-face-clear');
    const face = this.state.face;
    if (face) img.src = face;
    img.hidden = !face;
    plus.hidden = !!face;
    clear.hidden = !face;
  }

  /** Highlights whichever skin swatch is currently picked. */
  #syncSkins() {
    for (const swatch of this.root.querySelectorAll('#m-skins .skin-swatch')) {
      swatch.classList.toggle('on', swatch.dataset.skin === this.state.skinId);
    }
  }

  /**
   * Hosting with a room name typed earns an invite link: the other player
   * opens it and lands in the lobby with Join and the room already set, so
   * there is no name to mistype on the other end.
   */
  #syncInvite() {
    const row = this.root.querySelector('#m-invite');
    const room = normaliseRoom(this.state.room);
    const show = this.state.net === 'host' && !!room;
    row.hidden = !show;
    if (show) {
      this.root.querySelector('#m-invite-url').textContent =
        `${location.origin}${location.pathname}?join=${room}`;
    }
  }

  /**
   * Arrived through an invite link: preselect Join and the room, and say why.
   * The player still presses the button — they may want a different loadout
   * first, and a game should not race off with the mouse uncaptured.
   */
  presetJoin(room) {
    this.state.net = 'join';
    this.state.room = room;
    for (const b of this.root.querySelectorAll('#m-mode-seg button')) {
      b.classList.toggle('on', b.dataset.net === 'join');
    }
    const input = this.root.querySelector('#m-room');
    input.hidden = false;
    input.value = room;
    this.#syncStartLabel();
    this.setNetStatus(`You were invited to "${room}" — press JOIN THE FIGHT once they are hosting.`, 'good');
  }

  settings() {
    return {
      playerName: this.state.name.trim().slice(0, NAME_MAX) || 'You',
      face: this.state.face,
      skinId: this.state.skinId,
      mapId: this.state.mapId,
      modeId: this.state.modeId,
      characterId: this.state.characterId,
      botProfileId: this.state.botProfileId,
      botCount: this.state.botCount,
      mutatorIds: [...this.state.mutatorIds],
      loadout: this.state.loadout,
      net: this.state.net,
      room: this.state.room,
      seed: (Math.random() * 0xffff) | 0,
    };
  }

  /** Wire the loadout checkboxes. Re-run whenever the list is rebuilt. */
  #bindLoadout() {
    const boxes = [...this.root.querySelectorAll('#m-loadout input')];
    for (const box of boxes) {
      box.onchange = () => {
        // You have to spawn holding something.
        if (!boxes.some((b) => b.checked)) { box.checked = true; return; }
        this.state.loadout = boxes.filter((b) => b.checked).map((b) => b.value);
      };
    }
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
