// Application shell: global state, command registry, ribbon, menus, feature tree, selection routing.
import { Document, FEATURE_LABELS, emptySketch, resolvePlane, featureRefs } from './doc.js';
import { Viewport } from './view/viewport.js';
import { Sketcher } from './sketch/sketcher.js';
import * as K from './kernel.js';
import { V, BASE_PLANES, planeFromNormal, fmt } from './geom.js';
import { icon, featureIcon } from './ui/icons.js';
import { $, el, esc, toast, setHint, popup, closeMenu, modal, openPM, closePM, pmActive, showLeft, promptDlg, confirmDlg } from './ui/ui.js';

export const app = {
  doc: null, vp: null, mode: 'model', sketcher: null, sketchEdit: null, tab: 'Features',
  selection: [], commands: {}, treeSel: null, drawing: null,
};
const AUTOSAVE = 'soqua-autosave-v1';

export function register(name, fn) {
  app.commands[name] = fn;
}
export function run(name, ...args) {
  const fn = app.commands[name];
  if (!fn) return toast(`"${name}" is not available yet.`, true);
  try {
    const r = fn(...args);
    if (r && r.catch) r.catch((e) => fail(e));
    return r;
  } catch (e) {
    fail(e);
  }
}
function fail(e) {
  console.error(e);
  toast(e && e.message && !/WebAssembly/.test(e.message) ? e.message : 'That operation failed in the geometry kernel.', true);
}

// ---------------------------------------------------------------- ribbon definition
// [command, label, icon, when] ; '|' = separator
const RIBBON = {
  Features: [
    ['sketch', 'Sketch', 'sketch'], '|',
    ['extrude', 'Extruded Boss/Base', 'extrude'], ['revolve', 'Revolved Boss/Base', 'revolve'], ['sweep', 'Swept Boss/Base', 'sweep'], ['loft', 'Lofted Boss/Base', 'loft'], '|',
    ['extrudeCut', 'Extruded Cut', 'cut'], ['revolveCut', 'Revolved Cut', 'revolvecut'], ['sweepCut', 'Swept Cut', 'sweep'], ['loftCut', 'Lofted Cut', 'loft'], ['hole', 'Hole Wizard', 'hole'], '|',
    ['fillet', 'Fillet', 'fillet'], ['chamfer', 'Chamfer', 'chamfer'], ['shell', 'Shell', 'shell'], ['draft', 'Draft', 'draft'], '|',
    ['linearPattern', 'Linear Pattern', 'lpattern'], ['circularPattern', 'Circular Pattern', 'cpattern'], ['mirror', 'Mirror', 'mirror3d'], '|',
    ['plane', 'Reference Plane', 'plane'], ['sketch3d', '3D Sketch', 'sketch3d'], ['scale', 'Scale', 'scale'], ['moveBody', 'Move/Copy Body', 'move'], ['primitive', 'Primitive', 'primitive'],
  ],
  Sketch: [
    ['sketch', 'Sketch', 'sketch'], ['exitSketch', 'Exit Sketch', 'exit'], '|',
    ['sk:select', 'Select', 'select'], ['sk:dimension', 'Smart Dimension', 'dimension'], '|',
    ['sk:line', 'Line', 'line'], ['sk:centerline', 'Centerline', 'centerline'], ['sk:rect', 'Corner Rectangle', 'rect'], ['sk:crect', 'Center Rectangle', 'crect'],
    ['sk:circle', 'Circle', 'circle'], ['sk:arc3', '3 Point Arc', 'arc3'], ['sk:arcc', 'Centerpoint Arc', 'arcc'], ['sk:polygon', 'Polygon', 'polygon'], ['sk:slot', 'Straight Slot', 'slot'],
    ['sk:spline', 'Spline', 'spline'], ['sk:point', 'Point', 'point'], ['sk:text', 'Text', 'text'], '|',
    ['sk:trim', 'Trim Entities', 'trim'], ['sk:sfillet', 'Sketch Fillet', 'sfillet'], ['skOffset', 'Offset Entities', 'offset'], ['skConvert', 'Convert Entities', 'convert'],
    ['skMirror', 'Mirror Entities', 'mirror'], ['skLinear', 'Linear Sketch Pattern', 'lpattern'], ['skCircular', 'Circular Sketch Pattern', 'cpattern'], '|',
    ['skRelation', 'Add Relation', 'relation'], ['skConstruction', 'Construction Geometry', 'construction'], ['skImportDXF', 'Insert DXF/SVG', 'dxf'],
  ],
  Surfaces: [
    ['surfExtrude', 'Extruded Surface', 'surfExtrude'], ['surfRevolve', 'Revolved Surface', 'surfRevolve'], ['surfSweep', 'Swept Surface', 'surfSweep'], ['surfLoft', 'Lofted Surface', 'surfLoft'],
    ['surfPlanar', 'Planar Surface', 'surfPlanar'], ['surfOffset', 'Offset Surface', 'surfOffset'], '|', ['knit', 'Knit Surface', 'knit'], ['thicken', 'Thicken', 'thicken'], ['deleteBody', 'Delete Body', 'deleteBody'],
  ],
  'Sheet Metal': [
    ['baseFlange', 'Base Flange/Tab', 'baseFlange'], ['edgeFlange', 'Edge Flange', 'edgeFlange'], '|', ['extrudeCut', 'Extruded Cut', 'cut'], ['hole', 'Hole Wizard', 'hole'], ['fillet', 'Break Corner (Fillet)', 'fillet'], '|',
    ['flatPattern', 'Flat Pattern', 'flat'], ['flatDXF', 'Export Flat DXF', 'dxf'],
  ],
  Weldments: [
    ['sketch', '2D Sketch', 'sketch'], ['sketch3d', '3D Sketch', 'sketch3d'], '|', ['structuralMember', 'Structural Member', 'member'], ['extrudeCut', 'Extruded Cut', 'cut'], ['fillet', 'Fillet Bead (Fillet)', 'fillet'], ['chamfer', 'Chamfer', 'chamfer'], '|',
    ['cutlist', 'Cut List', 'cutlist'],
  ],
  'Mesh Modeling': [
    ['import', 'Import Mesh', 'import'], ['meshDecimate', 'Decimate Mesh', 'decimate'], ['meshSmooth', 'Smooth Mesh', 'smooth'], ['meshTransform', 'Scale / Move Mesh', 'scale'], ['meshFlip', 'Flip Normals', 'mirror'], '|',
    ['meshToSolid', 'Convert to Solid', 'tosolid'], ['solidToMesh', 'Solid to Mesh Body', 'tomesh'], ['meshInfo', 'Mesh Info', 'mesh'],
  ],
  Evaluate: [
    ['measure', 'Measure', 'measure'], ['massProps', 'Mass Properties', 'mass'], ['sectionView', 'Section View', 'section'], ['checkGeometry', 'Check', 'check'], ['boundingBox', 'Bounding Box', 'bbox'], ['material', 'Edit Material', 'material'], ['statistics', 'Performance', 'options'],
  ],
  Simulation: [
    ['simStudy', 'Static Study', 'sim'], ['material', 'Apply Material', 'material'], ['simClear', 'Hide Results', 'eye'],
  ],
  Render: [
    ['appearance', 'Edit Appearance', 'appearance'], ['faceColor', 'Face Color', 'texture'], ['scene', 'Edit Scene', 'scene'], ['renderImage', 'Final Render', 'render'], ['screenshot', 'Save Image', 'export'], '|', ['turntable', 'Turntable', 'turntable'],
  ],
  Drawing: [
    ['drwTemplate', 'Sheet Format', 'template'], ['drwStandard', 'Standard 3 View', 'stdviews'], ['drwView', 'Model View', 'view'], '|',
    ['drwDimension', 'Smart Dimension', 'dimension'], ['drwNote', 'Note', 'note'], ['drwCenter', 'Center Mark', 'centermark'], ['drwDelete', 'Delete', 'delete'], '|',
    ['drwTitle', 'Title Block', 'edit'], ['fonts', 'Fonts', 'font'], '|', ['drwPDF', 'Export PDF', 'pdf'], ['drwDXF', 'Export DXF', 'dxf'], ['drwSVG', 'Export SVG', 'export'],
  ],
};

const MENUS = {
  File: [
    ['New', 'new', 'newDoc', 'Ctrl+N'], ['Open…', 'open', 'open', 'Ctrl+O'], ['Save', 'save', 'save', 'Ctrl+S'], '-',
    ['Import…', 'import', 'import'], ['Export…', 'export', 'export'], '-',
    ['Make Drawing from Part', 'drawing', 'toDrawing'], ['Fonts…', 'font', 'fonts'], ['Properties…', 'edit', 'docProps'],
  ],
  Edit: [
    ['Undo', 'undo', 'undo', 'Ctrl+Z'], ['Redo', 'redo', 'redo', 'Ctrl+Y'], '-', ['Rebuild', 'rebuild', 'rebuild', 'Ctrl+B'], ['Delete', 'delete', 'deleteSel', 'Del'], ['Suppress / Unsuppress', 'suppress', 'suppressSel'],
  ],
  View: [
    ['Zoom to Fit', 'fit', 'fit', 'F'], ['Front', 'views', 'view:front', 'Ctrl+1'], ['Back', 'views', 'view:back', 'Ctrl+2'], ['Left', 'views', 'view:left', 'Ctrl+3'], ['Right', 'views', 'view:right', 'Ctrl+4'],
    ['Top', 'views', 'view:top', 'Ctrl+5'], ['Bottom', 'views', 'view:bottom', 'Ctrl+6'], ['Isometric', 'views', 'view:iso', 'Ctrl+7'], ['Normal To', 'normal', 'normalTo', 'Ctrl+8'], '-',
    ['Shaded With Edges', 'shadedEdges', 'display:shadedEdges'], ['Shaded', 'shaded', 'display:shaded'], ['Hidden Lines Removed', 'hidden', 'display:hidden'], ['Wireframe', 'wireframe', 'display:wireframe'], '-',
    ['Section View', 'section', 'sectionView'], ['Show / Hide Planes', 'planes', 'togglePlanes'], '-',
    ['Turntable', 'turntable', 'turntable'], ['Animations On / Off', 'turntable', 'toggleAnimations'],
  ],
  Insert: [
    ['Sketch', 'sketch', 'sketch'], ['3D Sketch', 'sketch3d', 'sketch3d'], ['Reference Plane', 'plane', 'plane'], '-',
    ['Extruded Boss/Base', 'extrude', 'extrude'], ['Extruded Cut', 'cut', 'extrudeCut'], ['Revolve', 'revolve', 'revolve'], ['Sweep', 'sweep', 'sweep'], ['Loft', 'loft', 'loft'], '-',
    ['Fillet', 'fillet', 'fillet'], ['Chamfer', 'chamfer', 'chamfer'], ['Shell', 'shell', 'shell'], ['Hole Wizard', 'hole', 'hole'], ['Pattern / Mirror', 'lpattern', 'linearPattern'],
  ],
  Tools: [
    ['Measure', 'measure', 'measure'], ['Mass Properties', 'mass', 'massProps'], ['Material…', 'material', 'material'], ['Static Study', 'sim', 'simStudy'], '-', ['Appearance', 'appearance', 'appearance'], ['Final Render', 'render', 'renderImage'],
  ],
  Help: [['Quick Start', 'help', 'help'], ['Keyboard & Mouse', 'help', 'helpKeys'], ['File Format Support', 'help', 'helpFormats'], ['About SOQUA design', 'help', 'about']],
};

// ---------------------------------------------------------------- shell
export function buildShell() {
  const mb = $('#menubar');
  for (const [name, items] of Object.entries(MENUS)) {
    const b = el('button', { text: name });
    b.addEventListener('click', () => {
      const r = b.getBoundingClientRect();
      popup(items.map((it) => (it === '-' ? '-' : { label: it[0], icon: it[1], key: it[3], action: () => run(it[2]) })), r.left, r.bottom);
      b.classList.add('open');
    });
    mb.append(b);
  }
  const q = $('#quick');
  for (const [c, t, i] of [['newDoc', 'New', 'new'], ['open', 'Open', 'open'], ['save', 'Save', 'save'], ['undo', 'Undo (Ctrl+Z)', 'undo'], ['redo', 'Redo (Ctrl+Y)', 'redo'], ['rebuild', 'Rebuild (Ctrl+B)', 'rebuild']])
    q.append(el('button', { title: t, html: icon(i), onclick: () => run(c) }));
  const hud = $('#hud');
  const hb = (c, t, i) => el('button', { title: t, html: icon(i), 'data-cmd': c, onclick: () => run(c) });
  hud.append(hb('fit', 'Zoom to Fit (F)', 'fit'), hb('viewMenu', 'View Orientation', 'views'), hb('normalTo', 'Normal To (Ctrl+8)', 'normal'), hb('displayMenu', 'Display Style', 'shadedEdges'), hb('sectionView', 'Section View', 'section'), hb('togglePlanes', 'Show / Hide Planes', 'planes'), hb('appearance', 'Edit Appearance', 'appearance'));
  $('#drawerBtn').addEventListener('click', () => $('#left').classList.toggle('open'));
  for (const b of document.querySelectorAll('#left-tabs button')) b.addEventListener('click', () => showLeft(b.dataset.tab));
  for (const b of document.querySelectorAll('#mode-tabs button')) b.addEventListener('click', () => run(b.dataset.mode === 'drawing' ? 'toDrawing' : 'toModel'));
  $('#docname').addEventListener('dblclick', async () => {
    const n = await promptDlg('Rename document', 'Document name:', app.doc.name);
    if (n) {
      app.doc.name = n;
      refreshTitle();
      buildTree();
    }
  });
  buildRibbon();
  window.addEventListener('keydown', onKey);
}

export function refreshTitle() {
  const star = app.dirty ? ' *' : '';
  $('#docname').textContent = app.doc.name + (app.mode === 'drawing' ? ' – Sheet1' : '.soqua') + star;
  $('#docname').title = app.dirty ? 'Unsaved changes – use Save (Ctrl+S) to keep a .soqua file. Double-click to rename.' : 'Double-click to rename';
  document.title = `${app.doc.name}${star} – SOQUA design`;
}
app.markDirty = () => {
  if (!app.dirty) {
    app.dirty = true;
    refreshTitle();
  }
};
app.markClean = () => {
  app.dirty = false;
  refreshTitle();
};

export function setTab(tab) {
  app.tab = tab;
  buildRibbon();
}
export function buildRibbon() {
  const tabs = $('#ribbon-tabs');
  tabs.innerHTML = '';
  const names = app.mode === 'drawing' ? ['Drawing', 'Evaluate'] : Object.keys(RIBBON).filter((n) => n !== 'Drawing');
  if (!names.includes(app.tab)) app.tab = names[0];
  for (const n of names) tabs.append(el('button', { text: n, class: n === app.tab ? 'active' : '', onclick: () => setTab(n) }));
  const rb = $('#ribbon');
  rb.innerHTML = '';
  const inSketch = !!app.sketcher;
  for (const it of RIBBON[app.tab]) {
    if (it === '|') {
      rb.append(el('div', { class: 'rb-sep' }));
      continue;
    }
    const [cmd, label, ic] = it;
    const isSk = cmd.startsWith('sk:') || cmd.startsWith('sk');
    let disabled = false;
    if (cmd.startsWith('sk:') || ['skOffset', 'skConvert', 'skMirror', 'skLinear', 'skCircular', 'skRelation', 'skConstruction', 'skImportDXF', 'exitSketch'].includes(cmd)) disabled = !inSketch;
    else if (inSketch && cmd !== 'sketch' && isSk === false && app.tab !== 'Evaluate') disabled = !['extrude', 'extrudeCut', 'revolve', 'revolveCut', 'baseFlange', 'structuralMember', 'surfExtrude', 'surfRevolve', 'surfPlanar'].includes(cmd);
    if (cmd === 'sketch' && inSketch) disabled = true;
    const active = inSketch && cmd === 'sk:' + app.sketcher.tool;
    rb.append(el('button', { class: 'rb' + (active ? ' active' : ''), disabled, title: label, html: icon(ic) + `<span>${esc(label)}</span>`, onclick: () => (cmd.startsWith('sk:') ? run('skTool', cmd.slice(3)) : run(cmd)) }));
  }
}

function onKey(e) {
  if (!$('#modal').hidden) return;
  if (e.target.matches('input, textarea, select')) {
    // Esc still cancels the open PropertyManager while typing in one of its fields
    if (e.key === 'Escape' && pmActive() && e.target.closest('#pm')) closePM(false);
    return;
  }
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') return e.preventDefault(), run('undo');
  if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) return e.preventDefault(), run('redo');
  if (mod && k === 's') return e.preventDefault(), run('save');
  if (mod && k === 'o') return e.preventDefault(), run('open');
  if (mod && k === 'b') return e.preventDefault(), run('rebuild');
  if (mod && /^[1-8]$/.test(k)) {
    e.preventDefault();
    return run(['view:front', 'view:back', 'view:left', 'view:right', 'view:top', 'view:bottom', 'view:iso', 'normalTo'][+k - 1]);
  }
  if (app.sketcher) return; // sketcher has its own keys
  if (k === 'f') return run('fit');
  if (k === 'escape') {
    if (pmActive()) closePM(false);
    else setSelection([]);
  }
  if (k === 'enter' && pmActive() && !pmActive().spec.noOK) closePM(true);
  if (k === 'delete') run('deleteSel');
}

// ---------------------------------------------------------------- selection
export function hitToItem(h) {
  if (!h) return null;
  const vp = app.vp;
  if (h.kind === 'face') {
    const info = vp.info(h);
    const item = { kind: 'face', key: vp.hitKey(h), label: `Face<${h.index + 1}>`, sig: info.sig, info, hit: h, bodyId: h.body.id, bodyKind: h.body.kind };
    if (info.planar) {
      // sketch origin = the model origin projected onto the face, like SOLIDWORKS
      const n = V.norm(info.normal);
      item.plane = planeFromNormal(V.mul(n, V.dot(info.center, n)), n);
      item.planeSpec = { type: 'face', sig: info.sig, plane: item.plane };
    }
    return item;
  }
  if (h.kind === 'edge') {
    const info = vp.info(h);
    return { kind: 'edge', key: vp.hitKey(h), label: `Edge<${h.index + 1}>`, sig: info.sig, info, hit: h, bodyId: h.body.id };
  }
  if (h.kind === 'vertex') return { kind: 'vertex', key: vp.hitKey(h), label: `Vertex (${h.point.map((x) => fmt(x, 1)).join(', ')})`, point: h.point, hit: h };
  if (h.kind === 'plane') return { kind: 'plane', key: 'p' + h.name, label: h.name, name: h.name, plane: h.plane, planeSpec: h.spec, hit: h };
  if (h.kind === 'sketch' || h.kind === 'feature') {
    const f = app.doc.get(h.id);
    if (!f) return null;
    const kind = f.type === 'sketch' || f.type === 'sketch3d' ? 'sketch' : f.type === 'plane' ? 'plane' : 'feature';
    const item = { kind, key: 's' + h.id, label: f.name, id: f.id, featureType: f.type, hit: { kind: 'feature', id: f.id } };
    if (kind === 'plane') {
      item.plane = app.doc.state.planes[f.id];
      item.planeSpec = { type: 'feature', id: f.id };
      item.name = f.name;
    }
    return item;
  }
  if (h.kind === 'mesh') return { kind: 'mesh', key: vp.hitKey(h), label: h.body.name, id: h.body.id, hit: h };
  if (h.kind === 'surface') return { kind: 'surface', key: 'b' + h.id, label: h.name, id: h.id, hit: { kind: 'feature', id: h.id } };
  return null;
}

export function setSelection(items) {
  app.selection = items;
  syncHighlight();
  buildTree();
  showSelectionInfo();
  if (app.onSelChange) app.onSelChange();
}
export function syncHighlight() {
  const pm = pmActive();
  const list = [...app.selection];
  if (pm) for (const f of pm.spec.fields) if (f.type === 'sel') list.push(...(pm.vals[f.key] || []));
  app.vp.setSelection(list.map((i) => i.hit).filter((h) => h && (h.body ? app.vp.bodies.includes(h.body) : true)));
}
function showSelectionInfo() {
  const s = app.selection;
  if (app.sketcher || pmActive()) return;
  if (!s.length) return setHint('Ready');
  if (s.length === 1) {
    const i = s[0];
    if (i.kind === 'edge') return setHint(`${i.label}: length ${fmt(i.info.length, 3)} mm${i.info.radius ? `, radius ${fmt(i.info.radius, 3)} mm` : ''}`);
    if (i.kind === 'face') return setHint(`${i.label}: ${i.info.type.toLowerCase()} face, area ${fmt(i.info.area, 2)} mm²`);
    return setHint(i.label);
  }
  setHint(`${s.length} items selected`);
}

// re-find picked geometry after a rebuild so highlight / chips stay valid
export function resolveItem(it) {
  if (!it.sig || !it.hit || !it.hit.body) return it;
  const body = app.vp.bodies.find((b) => b.id === (it.bodyId || 'solid'));
  if (!body || !body.shape) return { ...it, hit: null };
  try {
    if (it.kind === 'face') {
      const [f] = K.matchFaces(body.shape, [it.sig]);
      const idx = body.shape.faces.findIndex((x) => x.isSame(f));
      return { ...it, hit: { kind: 'face', body, index: idx } };
    }
    if (it.kind === 'edge') {
      const [e] = K.matchEdges(body.shape, [it.sig]);
      const idx = body.shape.edges.findIndex((x) => x.isSame(e));
      return { ...it, hit: { kind: 'edge', body, index: idx } };
    }
  } catch (e) {
    /* ignore */
  }
  return { ...it, hit: null };
}

function onPick(h, e) {
  if (app.mode !== 'model') return;
  const item = hitToItem(h);
  const pm = pmActive();
  if (pm && pm.activeSel) {
    if (item && pm.pick(item)) {
      syncHighlight();
      return;
    }
    if (item) toast(`Select ${pm.activeSel.accept ? pm.activeSel.accept.join(' / ') : 'an item'} for this box.`);
    return;
  }
  if (app.pickOnce && item) {
    const fn = app.pickOnce;
    if (fn(item) !== false) return;
  }
  if (!item) return setSelection([]);
  const multi = e && (e.ctrlKey || e.shiftKey || e.metaKey);
  const at = app.selection.findIndex((x) => x.key === item.key);
  if (multi) setSelection(at >= 0 ? app.selection.filter((_, i) => i !== at) : [...app.selection, item]);
  else setSelection(at >= 0 && app.selection.length === 1 ? [] : [item]);
}

function onContext(h, e) {
  if (app.sketcher) return;
  const item = hitToItem(h);
  if (item && !app.selection.some((x) => x.key === item.key)) setSelection([item]);
  const items = [];
  if (item && item.planeSpec) items.push({ label: 'Sketch', icon: 'sketch', action: () => run('sketch') }, { label: 'Normal To', icon: 'normal', action: () => run('normalTo') });
  if (item && item.kind === 'edge') items.push({ label: 'Fillet', icon: 'fillet', action: () => run('fillet') }, { label: 'Chamfer', icon: 'chamfer', action: () => run('chamfer') });
  if (item && item.kind === 'face') items.push({ label: 'Shell (remove face)', icon: 'shell', action: () => run('shell') }, { label: 'Face Color…', icon: 'texture', action: () => run('faceColor') });
  if (item && item.kind === 'sketch') items.push({ label: 'Edit Sketch', icon: 'sketch', action: () => run('editFeature', item.id) });
  if (item) items.push({ label: 'Measure', icon: 'measure', action: () => run('measure') });
  items.push('-', { label: 'Zoom to Fit', icon: 'fit', action: () => run('fit') }, { label: 'Isometric', icon: 'views', action: () => run('view:iso') }, { label: 'Section View', icon: 'section', action: () => run('sectionView') });
  popup(items, e.clientX, e.clientY);
}

// ---------------------------------------------------------------- feature tree
export function buildTree() {
  const t = $('#tree');
  const doc = app.doc;
  if (!doc) return;
  t.innerHTML = '';
  if (app.mode === 'drawing' && app.drawing) return app.drawing.buildTree(t);
  const selKeys = new Set(app.selection.map((s) => s.key));
  const row = (cls, ic, text, opts = {}) => {
    const r = el('div', { class: 'ti ' + cls, html: `${ic}<span>${esc(text)}</span>${opts.badge ? `<i class="badge" title="${esc(opts.badge)}">⚠</i>` : ''}`, title: opts.title || opts.badge || text });
    if (opts.click) r.addEventListener('click', opts.click);
    if (opts.dbl) r.addEventListener('dblclick', opts.dbl);
    if (opts.ctx) r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.ctx(e);
    });
    t.append(r);
    return r;
  };
  t.append(el('div', { class: 'tree-head', html: `${icon('part')}<span>${esc(doc.name)}</span>` }));
  row('', icon('material'), `Material <${doc.material}>`, { dbl: () => run('material'), ctx: (e) => popup([{ label: 'Edit Material…', icon: 'material', action: () => run('material') }], e.clientX, e.clientY) });
  for (const name of ['Front', 'Top', 'Right']) {
    const key = 'p' + name + ' Plane';
    row(selKeys.has(key) ? 'sel' : '', icon('plane'), name + ' Plane', {
      click: (e) => pickFromTree({ kind: 'plane', name: name + ' Plane', plane: BASE_PLANES[name], spec: { type: 'base', name } }, e),
      ctx: (e) => {
        pickFromTree({ kind: 'plane', name: name + ' Plane', plane: BASE_PLANES[name], spec: { type: 'base', name } });
        popup([{ label: 'Sketch', icon: 'sketch', action: () => run('sketch') }, { label: 'Normal To', icon: 'normal', action: () => run('normalTo') }], e.clientX, e.clientY);
      },
    });
  }
  row('', icon('origin'), 'Origin');
  const children = new Map();
  const absorbed = new Set();
  for (const f of doc.features) for (const r of featureRefs(f)) {
    const src = doc.get(r);
    if (src && (src.type === 'sketch' || src.type === 'sketch3d') && !absorbed.has(r)) {
      absorbed.add(r);
      if (!children.has(f.id)) children.set(f.id, []);
      children.get(f.id).push(src);
    }
  }
  const featRow = (f, child) => {
    const cls = [child ? 'child' : '', f.suppressed ? 'sup' : '', f.error ? 'err' : '', f.rolledBack ? 'rolled' : '', selKeys.has('s' + f.id) ? 'sel' : ''].join(' ');
    row(cls, featureIcon(f.type, f), f.name, {
      badge: f.error,
      click: (e) => pickFromTree({ kind: 'feature', id: f.id }, e),
      dbl: () => run('editFeature', f.id),
      ctx: (e) => {
        if (!selKeys.has('s' + f.id)) pickFromTree({ kind: 'feature', id: f.id });
        const isSk = f.type === 'sketch';
        popup([
          { label: isSk ? 'Edit Sketch' : 'Edit Feature', icon: isSk ? 'sketch' : 'edit', action: () => run('editFeature', f.id) },
          isSk && { label: 'Edit Sketch Plane…', icon: 'plane', action: () => run('editSketchPlane', f.id) },
          isSk && { label: f.params.visible === false || (f.params.visible === undefined && absorbed.has(f.id)) ? 'Show' : 'Hide', icon: 'eye', action: () => run('toggleSketchVisible', f.id) },
          { label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', action: () => doc.setSuppressed(f.id, !f.suppressed) },
          { label: 'Rollback to here', icon: 'rebuild', action: () => doc.setRollback(f.id) },
          doc.rollback && { label: 'Roll to end', icon: 'rebuild', action: () => doc.setRollback(null) },
          { label: 'Rename…', icon: 'edit', action: async () => {
            const n = await promptDlg('Rename feature', 'Name:', f.name);
            if (n) doc.rename(f.id, n);
          } },
          '-', { label: 'Delete', icon: 'delete', action: () => run('deleteFeature', f.id) },
        ], e.clientX, e.clientY);
      },
    });
  };
  for (const f of doc.features) {
    if (absorbed.has(f.id)) continue;
    featRow(f, false);
    for (const c of children.get(f.id) || []) featRow(c, true);
    if (doc.rollback === f.id) t.append(el('div', { class: 'rollbar', title: 'Rollback bar – double-click to roll to the end', ondblclick: () => doc.setRollback(null) }));
  }
  const st = doc.state;
  const nb = (st.solid ? 1 : 0), ns = st.surfaces.length, nm = st.meshes.length;
  if (nb) {
    row('folder', icon('folder'), `Solid Bodies(${st.solid.solids ? Math.max(1, st.solid.solids.length) : 1})`);
  }
  if (ns) {
    row('folder', icon('folder'), `Surface Bodies(${ns})`);
    for (const s of st.surfaces) row('child' + (selKeys.has('b' + s.id) ? ' sel' : ''), icon('surfPlanar'), s.name, { click: (e) => pickFromTree({ kind: 'surface', id: s.id, name: s.name }, e) });
  }
  if (nm) {
    row('folder', icon('folder'), `Mesh Bodies(${nm})`);
    for (const m of st.meshes) row('child', icon('mesh'), `${m.name} (${Math.round((m.data.indices ? m.data.indices.length : m.data.positions.length / 3) / 3).toLocaleString()} tris)`, { click: (e) => pickFromTree({ kind: 'feature', id: m.id }, e) });
  }
  if (st.cutlist.length) row('folder', icon('cutlist'), `Cut list(${st.cutlist.length})`, { dbl: () => run('cutlist'), click: () => run('cutlist') });
  if (!doc.features.length) t.append(el('div', { class: 'tree-note', html: 'Start with <b>Sketch</b>: pick a plane, draw a closed profile, then use <b>Extruded Boss/Base</b>. Or use <b>File ▸ Import</b> to open STEP, IGES, STL, OBJ, DXF and more.' }));
}

function pickFromTree(h, e) {
  const item = hitToItem(h.kind === 'plane' ? { kind: 'plane', name: h.name, plane: h.plane, spec: h.spec } : h);
  if (!item) return;
  const pm = pmActive();
  if (pm && pm.activeSel) {
    if (pm.pick(item)) syncHighlight();
    return;
  }
  if (app.pickOnce && app.pickOnce(item) !== false) return;
  const multi = e && (e.ctrlKey || e.shiftKey || e.metaKey);
  setSelection(multi ? [...app.selection.filter((x) => x.key !== item.key), item] : [item]);
  if (item.kind === 'sketch') {
    app.vp.buildSketches(app.doc);
    app.vp.render();
  }
}

// ---------------------------------------------------------------- sketch mode
export function enterSketch(featureId, isNew = false) {
  const doc = app.doc;
  const f = doc.get(featureId);
  if (!f) return;
  if (pmActive()) closePM(false);
  app.sketchEdit = { id: featureId, isNew, before: isNew ? null : JSON.stringify(f.params.sketch), prevRollback: doc.rollback };
  doc.rollback = featureId;
  app.vp.hiddenSketch = featureId;
  doc.rebuild();
  const s = doc.state.sketches[featureId];
  const plane = s ? s.plane : resolvePlane(f.params.plane, doc.state);
  app.vp.normalTo(plane);
  app.sketcher = new Sketcher(app.vp, f.params.sketch, plane, {
    onChange: (what) => {
      if (what === 'tool' || what === 'selection') buildRibbon();
    },
  });
  setSelection([]);
  const corner = $('#corner');
  corner.hidden = false;
  corner.innerHTML = '';
  corner.append(el('button', { class: 'ok', title: 'Exit sketch and keep changes', text: '✔', onclick: () => exitSketch(true) }), el('button', { class: 'cancel', title: 'Discard changes to this sketch', text: '✖', onclick: () => exitSketch(false) }));
  app.tab = 'Sketch';
  buildRibbon();
  app.sketcher.setTool(isNew ? 'line' : 'select');
  buildRibbon();
  buildTree();
  setTimeout(() => {
    if (!isNew) app.vp.fit();
  }, 300);
}

export function exitSketch(keep = true) {
  if (!app.sketcher) return null;
  const doc = app.doc, ed = app.sketchEdit;
  const f = doc.get(ed.id);
  app.sketcher.destroy();
  app.sketcher = null;
  app.sketchEdit = null;
  app.vp.hiddenSketch = null;
  $('#corner').hidden = true;
  $('#sk-status').textContent = '';
  $('#coords').textContent = '';
  doc.rollback = ed.prevRollback || null;
  let id = ed.id;
  if (!keep) {
    if (ed.isNew) {
      doc.features = doc.features.filter((x) => x.id !== ed.id);
      doc._undo.pop();
      id = null;
    } else f.params.sketch = JSON.parse(ed.before);
  } else if (ed.isNew && f.params.sketch.ents.length === 0) {
    doc.features = doc.features.filter((x) => x.id !== ed.id);
    doc._undo.pop();
    id = null;
  } else if (!ed.isNew && JSON.stringify(f.params.sketch) !== ed.before) {
    // make the edit undoable
    const now = f.params.sketch;
    f.params.sketch = JSON.parse(ed.before);
    doc.checkpoint();
    f.params.sketch = now;
  }
  doc.rebuild();
  app.tab = 'Features';
  buildRibbon();
  setHint('Ready');
  app.vp.setView('iso');
  setTimeout(() => app.vp.fit(), 280);
  return id;
}

export function startSketchOn(planeSpec) {
  const f = app.doc.addFeature('sketch', { plane: planeSpec, sketch: emptySketch() });
  enterSketch(f.id, true);
}

// ---------------------------------------------------------------- lifecycle
export function attachDoc(doc) {
  if (app.sketcher) exitSketch(false);
  if (pmActive()) closePM(false);
  app.doc = doc;
  doc.on((what) => {
    if (what === 'rebuild') {
      if (app.mode === 'model') {
        app.vp.setState(doc);
        app.selection = app.selection.map(resolveItem).filter((i) => i.hit || !i.sig);
        const pm = pmActive();
        if (pm) for (const f of pm.spec.fields) if (f.type === 'sel' && pm.vals[f.key]) pm.vals[f.key] = pm.vals[f.key].map(resolveItem);
        syncHighlight();
      } else if (app.drawing) app.drawing.modelChanged();
      scheduleAutosave();
      if (attached) app.markDirty();
    }
    buildTree();
  });
  let attached = false;
  app.dirty = false;
  refreshTitle();
  doc.rebuild();
  attached = true;
  app.vp.setView('iso', false);
  app.vp.resize();
  app.vp.fit(false);
}

let saveTimer = 0;
export function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const s = app.doc.serialize();
      if (s.length < 4_500_000) localStorage.setItem(AUTOSAVE, s);
    } catch (e) {
      /* quota */
    }
  }, 1200);
}
export function loadAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE);
    if (s) return Document.deserialize(s);
  } catch (e) {
    console.warn('autosave could not be restored', e);
  }
  return null;
}

export function initApp() {
  app.vp = new Viewport($('#gl'), $('#labels'));
  // motion: on by default, off when the system asks for reduced motion, and the user's own choice wins
  let pref = null;
  try {
    pref = localStorage.getItem('soqua-anim');
  } catch (e) {
    /* private mode */
  }
  app.anim = pref === '1' || (pref !== '0' && !matchMedia('(prefers-reduced-motion: reduce)').matches);
  app.vp.animate = app.anim;
  document.body.classList.toggle('no-anim', !app.anim);
  app.vp.onPick = onPick;
  app.vp.onContext = onContext;
  app.vp.onDbl = (h) => {
    const it = hitToItem(h);
    if (it && it.kind === 'sketch') run('editFeature', it.id);
  };
  app.vp.onHover = (h, e) => {
    if (app.sketcher) return;
    const c = $('#coords');
    c.textContent = h && h.point ? `X ${fmt(h.point[0], 1)}  Y ${fmt(h.point[1], 1)}  Z ${fmt(h.point[2], 1)}` : '';
  };
  buildShell();
  // never fail silently: surface unexpected errors to the user
  window.addEventListener('error', (e) => e.message && !/ResizeObserver/.test(e.message) && toast('Unexpected error: ' + e.message, true));
  window.addEventListener('unhandledrejection', (e) => {
    const m = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    toast(/WebAssembly|Exception/.test(m) ? 'That operation failed in the geometry kernel.' : 'Unexpected error: ' + m, true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (app.dirty && app.doc && app.doc.features.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  app.api = { attachDoc, Document, run, enterSketch, exitSketch, setSelection, hitToItem }; // console scripting / tests
}

export { FEATURE_LABELS, Document };
