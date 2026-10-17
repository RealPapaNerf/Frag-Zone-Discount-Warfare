import { MapDoc, blankMap } from './MapDoc.js';
import { Viewport } from './Viewport.js';
import { PREFABS, buildPrefab } from './prefabs.js';
import { generateWaypoints } from './waypoints.js';
import { validateMapDoc } from './validate.js';

/**
 * The arena editor.
 *
 * Everything it produces is the map JSON the game already loads, and it draws
 * that JSON with the game's own ArenaView — so there is no export step that
 * can lose something, and no editor-only appearance that can lie to you.
 *
 * Playtest hands the document to the game through sessionStorage. That keeps
 * the whole thing static: no server, no save format, nothing to deploy beyond
 * the two HTML files already on Pages.
 */

const PLAYTEST_KEY = 'fragzone.playtest.map';

const $ = (sel) => document.querySelector(sel);
const doc = new MapDoc(loadLast() ?? blankMap());
const viewport = new Viewport($('#view'), doc);

let tool = 'select';
let material = 'wall';
let brushSize = [4, 4, 4];

// --- toolbar ----------------------------------------------------------------

const TOOLS = [
  { id: 'select', label: 'Select / move' },
  { id: 'box', label: 'Place box' },
  { id: 'spawn', label: 'Place spawn' },
  { id: 'pad', label: 'Place jump pad' },
];

function setTool(next, ghost) {
  tool = next;
  viewport.setTool(next === 'select' ? 'select' : 'place', ghost ?? brushSize);
  for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('on', b.dataset.tool === next);
  for (const b of document.querySelectorAll('#prefabs button')) b.classList.toggle('on', `prefab:${b.dataset.prefab}` === next);
}

$('#tools').innerHTML = TOOLS.map((t) => `<button data-tool="${t.id}">${t.label}</button>`).join('');
for (const b of document.querySelectorAll('#tools button')) {
  b.onclick = () => setTool(b.dataset.tool);
}

$('#prefabs').innerHTML = PREFABS.map((p) =>
  `<button data-prefab="${p.id}">${p.name}<small>${p.hint}</small></button>`).join('');
for (const b of document.querySelectorAll('#prefabs button')) {
  b.onclick = () => setTool(`prefab:${b.dataset.prefab}`, [4, 3, 4]);
}

$('#grid-step').onchange = (e) => { viewport.gridStep = Number(e.target.value); };
$('#show-grid').onchange = (e) => { viewport.grid.visible = e.target.checked; };
$('#prefab-turn').onchange = () => {};

// --- materials --------------------------------------------------------------

function renderMaterials() {
  const mats = doc.doc.materials ?? {};
  $('#materials').innerHTML = Object.entries(mats).map(([name, def]) =>
    `<div class="swatch${name === material ? ' on' : ''}" data-mat="${name}">
       <i style="background:${def.color}"></i>${name}
     </div>`).join('');
  for (const el of document.querySelectorAll('.swatch')) {
    el.onclick = () => {
      material = el.dataset.mat;
      // Retexture the selection rather than making you delete and replace it.
      if (doc.selection?.kind === 'brush') doc.updateSelected({ material });
      renderMaterials();
    };
  }
}

// --- placing ----------------------------------------------------------------

viewport.onPlace = (at) => {
  if (tool === 'box') {
    doc.addBrush([at.x, at.y + brushSize[1] / 2, at.z], brushSize, material);
  } else if (tool === 'spawn') {
    doc.addSpawn([at.x, at.y + 0.1, at.z], 0);
  } else if (tool === 'pad') {
    doc.addJumpPad([at.x, at.y + 0.1, at.z]);
  } else if (tool.startsWith('prefab:')) {
    const id = tool.slice(7);
    const turns = Number($('#prefab-turn').value) || 0;
    const brushes = buildPrefab(id, {}, [at.x, at.y, at.z], turns);
    doc.addBrushes(brushes, `place ${id}`);
  }
};

viewport.onPick = (hit) => {
  if (!hit) doc.select(null);
  else doc.select(hit.kind, hit.index);
};

// --- keyboard ---------------------------------------------------------------

addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (typing) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doc.redo(); else doc.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault(); doc.duplicateSelected([viewport.gridStep, 0, 0]); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doc.deleteSelected(); return; }
  if (e.key === 'Escape') { setTool('select'); doc.select(null); return; }

  const item = doc.selected;
  if (!item) return;
  const step = viewport.gridStep;
  const move = { ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, 0, -step], ArrowDown: [0, 0, step], PageUp: [0, step, 0], PageDown: [0, -step, 0] }[e.key];
  if (!move) return;
  e.preventDefault();
  doc.updateSelected({ pos: [item.pos[0] + move[0], item.pos[1] + move[1], item.pos[2] + move[2]] });
});

// --- property panel ---------------------------------------------------------

function numberRow(label, values, onChange, step = 0.5) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const inputs = [...document.querySelectorAll(`[data-grp="${id}"]`)];
    for (const input of inputs) {
      input.onchange = () => onChange(inputs.map((i) => Number(i.value)));
    }
  });
  return `<div class="field"><span>${label}</span><div class="triple">${
    values.map((v) => `<input type="number" step="${step}" value="${v}" data-grp="${id}">`).join('')
  }</div></div>`;
}

function renderProps() {
  const sel = doc.selection;
  const item = doc.selected;
  const host = $('#props');
  if (!sel || !item) {
    host.innerHTML = '<p class="muted">Nothing selected. Click a brush, spawn or pad.</p>';
    return;
  }

  let html = `<p class="muted">${sel.kind} #${sel.index}</p>`;
  html += numberRow('position', item.pos.map((v) => round(v)), (v) => doc.updateSelected({ pos: v }));
  if (item.size) html += numberRow('size', item.size.map((v) => round(v)), (v) => doc.updateSelected({ size: v.map((n) => Math.max(0.1, n)) }));
  if (sel.kind === 'pad') html += numberRow('launch', item.launch.map((v) => round(v)), (v) => doc.updateSelected({ launch: v }));
  if (sel.kind === 'spawn') {
    html += `<div class="field"><span>yaw°</span><input type="number" step="15" id="p-yaw" value="${round((item.yaw ?? 0) * 180 / Math.PI)}"></div>`;
  }
  if (sel.kind === 'brush') {
    html += `<div class="field"><span>material</span><select id="p-mat">${
      Object.keys(doc.doc.materials ?? {}).map((m) => `<option${m === item.material ? ' selected' : ''}>${m}</option>`).join('')
    }</select></div>`;
  }
  html += '<div class="row"><button id="p-dup">Duplicate</button><button id="p-del">Delete</button></div>';
  host.innerHTML = html;

  const yaw = $('#p-yaw');
  if (yaw) yaw.onchange = () => doc.updateSelected({ yaw: Number(yaw.value) * Math.PI / 180 });
  const mat = $('#p-mat');
  if (mat) mat.onchange = () => doc.updateSelected({ material: mat.value });
  $('#p-dup').onclick = () => doc.duplicateSelected([viewport.gridStep, 0, 0]);
  $('#p-del').onclick = () => doc.deleteSelected();
}

function renderMeta() {
  const d = doc.doc;
  $('#meta').innerHTML = `
    <div class="field"><span>id</span><input type="text" id="m-id" value="${esc(d.id)}"></div>
    <div class="field"><span>name</span><input type="text" id="m-name" value="${esc(d.name)}"></div>
    <div class="field"><span>author</span><input type="text" id="m-author" value="${esc(d.author ?? '')}"></div>
    <div class="field"><span>gravity</span><input type="number" step="1" id="m-grav" value="${d.gravity}"></div>
    ${numberRow('min', d.bounds.min, (v) => doc.setMeta({ bounds: { ...d.bounds, min: v } }), 1)}
    ${numberRow('max', d.bounds.max, (v) => doc.setMeta({ bounds: { ...d.bounds, max: v } }), 1)}
  `;
  $('#m-id').onchange = (e) => doc.setMeta({ id: e.target.value.trim().replace(/\s+/g, '_') });
  $('#m-name').onchange = (e) => doc.setMeta({ name: e.target.value });
  $('#m-author').onchange = (e) => doc.setMeta({ author: e.target.value });
  $('#m-grav').onchange = (e) => doc.setMeta({ gravity: Number(e.target.value) });
}

function renderCounts() {
  const d = doc.doc;
  const nodes = d.waypoints?.nodes?.length ?? 0;
  $('#counts').innerHTML = `
    <b>brushes</b><span>${d.brushes.length}</span>
    <b>spawns</b><span class="${d.spawns.length < 4 ? 'warn' : ''}">${d.spawns.length}</span>
    <b>jump pads</b><span>${d.jumpPads?.length ?? 0}</span>
    <b>bot nodes</b><span class="${nodes ? '' : 'warn'}">${nodes || 'none'}</span>
  `;
}

// --- top bar actions --------------------------------------------------------

$('#b-new').onclick = () => {
  if (doc.dirty && !confirm('Start a new map? Unsaved changes are lost.')) return;
  doc.doc = blankMap();
  doc.undoStack.length = 0;
  doc.selection = null;
  doc.dirty = false;
  refresh();
  viewport.frameAll();
};

$('#b-open').onclick = () => $('#b-file').click();
$('#b-file').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const problems = validateMapDoc(parsed);
    if (problems.length) { toast(`That file has problems: ${problems[0]}`, true); return; }
    doc.doc = parsed;
    doc.undoStack.length = 0;
    doc.selection = null;
    refresh();
    viewport.frameAll();
    toast(`Loaded ${parsed.name ?? parsed.id}`);
  } catch (err) {
    toast(`Could not read that file: ${err.message}`, true);
  }
  e.target.value = '';
};

$('#b-save').onclick = () => {
  const blob = new Blob([doc.toJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${doc.doc.id || 'arena'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  doc.dirty = false;
  toast(`Saved ${a.download}`);
};

$('#b-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(doc.toJSON()); toast('Map JSON copied'); }
  catch { toast('Clipboard refused; use Save JSON instead', true); }
};

$('#b-waypoints').onclick = () => {
  const { nodes, links } = generateWaypoints(viewport.arena, doc.doc);
  doc.setWaypoints(nodes, links);
  toast(nodes.length
    ? `${nodes.length} bot waypoints, ${links.length} drops and pad links`
    : 'No standable ground found — is there a floor?', !nodes.length);
};

$('#b-validate').onclick = () => {
  const problems = validateMapDoc(doc.doc);
  toast(problems.length ? `${problems.length} problem(s): ${problems[0]}` : 'Valid — the game will load this.',
    problems.length > 0);
};

$('#b-play').onclick = () => {
  const problems = validateMapDoc(doc.doc);
  if (problems.length) { toast(`Fix this first: ${problems[0]}`, true); return; }
  if (!doc.doc.waypoints?.nodes?.length) {
    const { nodes, links } = generateWaypoints(viewport.arena, doc.doc);
    doc.setWaypoints(nodes, links);
  }
  sessionStorage.setItem(PLAYTEST_KEY, doc.toJSON());
  location.href = `./index.html?playtest=1`;
};

// --- plumbing ---------------------------------------------------------------

function refresh() {
  viewport.rebuild();
  renderMaterials();
  renderProps();
  renderMeta();
  renderCounts();
  saveLast();
}

doc.onChange((what) => {
  if (what === 'selection') { viewport.rebuild(); renderProps(); return; }
  refresh();
});

let toastTimer = null;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** Keep the work-in-progress across an accidental reload. */
function saveLast() {
  try { localStorage.setItem('fragzone.editor.map', doc.toJSON()); } catch { /* private mode */ }
}
function loadLast() {
  try {
    const raw = localStorage.getItem('fragzone.editor.map');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
const round = (v) => Math.round(v * 100) / 100;

refresh();
viewport.frameAll();
setTool('select');

(function loop() {
  viewport.render();
  requestAnimationFrame(loop);
})();
