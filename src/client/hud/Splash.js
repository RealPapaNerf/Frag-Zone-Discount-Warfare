/**
 * The title screen. Not a loading step — content is already in and the
 * lobby already exists underneath this — just a cheap, loud, early-2000s
 * bargain-bin-shooter title card that plays once before the lobby shows
 * itself. The whole point is that it looks like it was budgeted in hours,
 * on purpose.
 *
 * Pure CSS: the "animation" is keyframes cycling forever (chrome hue, a
 * scanline flicker, a VHS roll-bar) under a one-shot bounce-in for the two
 * lines of text. Nothing here needs WebGL or a render loop.
 */

/** Long enough to read both lines and catch the loop; short enough that
 *  nobody who has seen it twice is stuck waiting for a third playthrough. */
const AUTO_ADVANCE_MS = 6000;
/** Matches the CSS fade-out transition below, so onDone fires after it. */
const FADE_MS = 450;

export class Splash {
  #dismissed = false;
  #timer = null;
  #onKey = null;
  #onClick = null;

  constructor(root) {
    this.root = root;
    this.onDone = () => {};
    this.#build();
  }

  #build() {
    this.root.innerHTML = `
      <div class="splash-stage">
        <div class="splash-scanlines"></div>
        <div class="splash-roll"></div>
        <div class="splash-vignette"></div>
        <div class="splash-content">
          <h1 class="splash-title">
            <span class="st-line st-main">FRAG ZONE</span>
            <span class="st-line st-sub">DISCOUNT WARFARE</span>
          </h1>
          <div class="splash-tag">
            <span class="tag-main">MEGA BLAST WAR SIMULATOR 2007</span>
            <span class="tag-sub">Released in 2026</span>
          </div>
          <div class="splash-press">PRESS ANY KEY</div>
        </div>
      </div>
    `;
  }

  show() {
    this.root.hidden = false;
    this.root.classList.remove('splash-out');
    this.#dismissed = false;

    const finish = () => this.#finish();
    this.#onKey = finish;
    this.#onClick = finish;
    window.addEventListener('keydown', this.#onKey, { once: true });
    this.root.addEventListener('click', this.#onClick, { once: true });
    this.#timer = setTimeout(finish, AUTO_ADVANCE_MS);
  }

  #finish() {
    if (this.#dismissed) return;
    this.#dismissed = true;
    clearTimeout(this.#timer);
    window.removeEventListener('keydown', this.#onKey);
    this.root.removeEventListener('click', this.#onClick);

    this.root.classList.add('splash-out');
    setTimeout(() => {
      this.root.hidden = true;
      this.root.classList.remove('splash-out');
      this.onDone();
    }, FADE_MS);
  }
}
