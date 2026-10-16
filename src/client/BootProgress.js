/**
 * Reports what start-up is actually doing, phase by phase, on the loading
 * screen. "Loading arena…" sitting there tells you nothing; a named step with
 * a ticking clock tells you exactly which one is slow.
 *
 * The important detail is `nextPaint()`. Most of these phases block the main
 * thread (parsing JSON, building a nav graph, uploading geometry), and the
 * browser will not repaint once a phase has begun. So each label is painted
 * *before* its work starts — which means the label you are staring at is the
 * step that is hung, not the one before it.
 */

/** Resolve after the browser has actually painted. */
export const nextPaint = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

const SLOW_MS = 3000;

export class BootProgress {
  /** A reporter that renders nothing, for callers with no loading screen. */
  static silent() {
    const noop = new BootProgress(null);
    return noop;
  }

  constructor(root) {
    this.root = root;
    this.steps = [];
    this.current = null;
    this.detailText = '';

    if (!root) return;
    root.hidden = false;
    root.innerHTML = `
      <div class="boot">
        <div class="boot-title">FRAG ZONE</div>
        <ul class="boot-steps" id="boot-steps"></ul>
        <div class="boot-now" id="boot-now"></div>
        <div class="boot-hint" id="boot-hint"></div>
      </div>`;
    this.stepsEl = root.querySelector('#boot-steps');
    this.nowEl = root.querySelector('#boot-now');
    this.hintEl = root.querySelector('#boot-hint');
    // Ticks the live counter so a wedged phase is visibly wedged — unless the
    // main thread is blocked, in which case the frozen clock says the same.
    this.timer = setInterval(() => this.#renderCurrent(), 100);
  }

  /** Record something that already happened, with a known duration. */
  note(label, ms) {
    this.steps.push({ label, ms: Math.round(ms) });
    this.#renderSteps();
  }

  /**
   * Run one phase, painting its label first and timing it.
   * @param {string} label shown while it runs
   * @param {(detail: (text: string) => void) => any} fn may be sync or async
   */
  async run(label, fn) {
    this.current = { label, start: performance.now() };
    this.detailText = '';
    this.#renderCurrent();
    await nextPaint();

    const started = performance.now();
    try {
      return await fn((text) => {
        this.detailText = text;
        this.#renderCurrent();
      });
    } finally {
      this.note(label, performance.now() - started);
      this.current = null;
      this.detailText = '';
      this.#renderCurrent();
    }
  }

  fail(error) {
    if (!this.root) throw error;
    clearInterval(this.timer);
    const failedAt = this.current?.label ?? this.steps.at(-1)?.label ?? 'start-up';
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="boot-error">
        <h2>Failed during: ${escapeHtml(failedAt)}</h2>
        <pre>${escapeHtml(String(error?.stack ?? error?.message ?? error))}</pre>
        <h3>Completed steps</h3>
        <pre>${escapeHtml(this.summary())}</pre>
      </div>`;
  }

  finish() {
    clearInterval(this.timer);
    if (this.root) this.root.hidden = true;
    // Leave the numbers somewhere a person can read them back to us.
    if (typeof window !== 'undefined') window.__boot = this.timings();
    return this.timings();
  }

  timings() {
    return {
      total: Math.round(this.steps.reduce((sum, s) => sum + s.ms, 0)),
      steps: this.steps.map((s) => ({ ...s })),
    };
  }

  summary() {
    const rows = this.steps.map((s) => `${String(s.ms).padStart(6)}ms  ${s.label}`);
    rows.push(`${String(this.timings().total).padStart(6)}ms  TOTAL`);
    return rows.join('\n');
  }

  #renderSteps() {
    if (!this.root) return;
    this.stepsEl.innerHTML = this.steps.map((s) =>
      `<li><span class="ok">✓</span> ${escapeHtml(s.label)} <b>${s.ms}ms</b></li>`).join('');
  }

  #renderCurrent() {
    if (!this.root) return;
    if (!this.current) { this.nowEl.textContent = ''; this.hintEl.textContent = ''; return; }
    const elapsed = performance.now() - this.current.start;
    const detail = this.detailText ? ` — ${this.detailText}` : '';
    this.nowEl.innerHTML =
      `<span class="spin"></span> ${escapeHtml(this.current.label)}${escapeHtml(detail)} `
      + `<b>${(elapsed / 1000).toFixed(1)}s</b>`;
    this.hintEl.textContent = elapsed > SLOW_MS
      ? 'This step is taking longer than expected — it is the one to report.'
      : '';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
