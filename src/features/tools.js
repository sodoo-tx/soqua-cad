// View, Evaluate, Render/Appearance, Simulation and Mesh commands.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { app, register, run, setSelection, syncHighlight, buildTree } from '../app.js';
import { openPM, closePM, pmActive, toast, setHint, el, modal, popup, esc, $ } from '../ui/ui.js';
import { V, BASE_PLANES, fmt, uid } from '../geom.js';
import { MATERIALS, solveStatic } from '../sim/fea.js';
import * as K from '../kernel.js';

// ---------------------------------------------------------------- view
for (const v of ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'dimetric', 'trimetric']) register('view:' + v, () => app.vp.setView(v));
for (const d of ['shadedEdges', 'shaded', 'hidden', 'wireframe']) register('display:' + d, () => app.vp.setDisplay(d));
register('fit', () => (app.mode === 'drawing' ? app.drawing.fit() : app.vp.fit()));
register('normalTo', () => {
  const s = app.sketcher ? { plane: app.sketcher.pl } : app.selection.find((i) => i.plane);
  if (!s) return toast('Select a plane or flat face first.');
  app.vp.normalTo(s.plane);
});
register('viewMenu', () => {
  const r = $('#hud').getBoundingClientRect();
  popup([['Front', 'front'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'], ['Top', 'top'], ['Bottom', 'bottom'], ['Isometric', 'iso'], ['Dimetric', 'dimetric'], ['Trimetric', 'trimetric']].map(([l, v]) => ({ label: l, icon: 'views', action: () => app.vp.setView(v) })), r.left, r.bottom + 2);
});
register('displayMenu', () => {
  const r = $('#hud').getBoundingClientRect();
  popup([['Shaded With Edges', 'shadedEdges'], ['Shaded', 'shaded'], ['Hidden Lines Removed', 'hidden'], ['Wireframe', 'wireframe']].map(([l, v]) => ({ label: l, icon: v, action: () => app.vp.setDisplay(v) })), r.left + 60, r.bottom + 2);
});
register('togglePlanes', () => app.vp.setShowPlanes(!app.vp.showPlanes));
register('turntable', () => {
  if (!app.anim) return toast('Animations are switched off (View ▸ Animations).');
  const on = !app.vp.turntable;
  app.vp.setTurntable(on);
  toast(on ? 'Turntable on – drag the model or click Turntable again to stop.' : 'Turntable off');
});
register('toggleAnimations', () => {
  app.anim = !app.anim;
  try {
    localStorage.setItem('soqua-anim', app.anim ? '1' : '0');
  } catch (e) {
    /* private mode */
  }
  document.body.classList.toggle('no-anim', !app.anim);
  app.vp.setAnimate(app.anim);
  toast(app.anim ? 'Animations on' : 'Animations off');
});
register('rebuild', () => {
  app.doc._cache = [];
  const t = performance.now();
  app.doc.rebuild();
  const errs = app.doc.features.filter((f) => f.error).length;
  toast(`Rebuilt in ${Math.round(performance.now() - t)} ms${errs ? ` – ${errs} feature(s) with errors` : ''}`, errs > 0);
});
register('undo', () => {
  if (app.sketcher) return app.sketcher.undo() || toast('Nothing to undo in this sketch.');
  if (pmActive()) closePM(false);
  if (!app.doc.undo()) toast('Nothing to undo.');
});
register('redo', () => {
  if (app.sketcher) return;
  if (!app.doc.redo()) toast('Nothing to redo.');
});

register('sectionView', () => {
  const vp = app.vp;
  if (vp.clip && !pmActive()) {
    vp.setClip(null);
    return toast('Section view off');
  }
  const bb = app.doc.state.solid ? K.bbox(app.doc.state.solid) : { min: [-50, -50, -50], max: [50, 50, 50] };
  const planes = { Front: BASE_PLANES.Front, Top: BASE_PLANES.Top, Right: BASE_PLANES.Right };
  const upd = (v) => {
    let pl = planes[v.plane];
    const picked = v.custom[0];
    if (picked && picked.plane) pl = picked.plane;
    const n = v.flip ? V.neg(pl.n) : pl.n;
    vp.setClip({ n, o: V.add(pl.o, V.mul(pl.n, v.offset)) });
  };
  const vals = { plane: 'Front', custom: [], offset: 0, flip: false };
  const span = V.dist(bb.min, bb.max);
  openPM({
    title: 'Section View', icon: 'section', message: 'Cuts the display only – the model is not changed. Click ✔ to keep the section, ✖ to remove it.',
    fields: [
      { key: 'plane', label: 'Section plane', group: 'Section 1', type: 'select', options: ['Front', 'Top', 'Right'] },
      { key: 'custom', label: 'or face/plane', group: 'Section 1', type: 'sel', accept: ['plane', 'face'], multi: false, autoFocus: false, placeholder: 'Optional: pick a plane or flat face' },
      { key: 'offset', label: 'Offset (mm)', group: 'Section 1', type: 'number', step: Math.max(0.5, Math.round(span / 100)) },
      { key: 'flip', label: 'Reverse direction', group: 'Section 1', type: 'check' },
    ],
    onChange: upd, onCancel: () => vp.setClip(null),
  }, vals);
  upd(vals);
});

// ---------------------------------------------------------------- evaluate
function shapeOf(item) {
  const h = item.hit;
  if (!h || !h.body || !h.body.shape) return null;
  if (item.kind === 'face') return h.body.shape.faces[h.index];
  if (item.kind === 'edge') return h.body.shape.edges[h.index];
  if (item.kind === 'vertex') return K.R.makeVertex(item.point);
  return null;
}
function measureHtml() {
  const s = app.selection.filter((i) => ['face', 'edge', 'vertex'].includes(i.kind));
  if (!s.length) return '<p>Select faces, edges or vertices in the graphics area (Ctrl+click for two items).</p>';
  const rows = [];
  for (const i of s) {
    if (i.kind === 'edge') {
      rows.push(['Edge length', fmt(i.info.length, 3) + ' mm']);
      if (i.info.radius) rows.push(['Radius / Diameter', `${fmt(i.info.radius, 3)} / ${fmt(i.info.radius * 2, 3)} mm`]);
    } else if (i.kind === 'face') {
      rows.push(['Face area', fmt(i.info.area, 3) + ' mm²'], ['Face type', i.info.type.toLowerCase()]);
    } else rows.push(['Vertex', i.point.map((x) => fmt(x, 3)).join(', ')]);
  }
  if (s.length === 2) {
    try {
      const a = shapeOf(s[0]), b = shapeOf(s[1]);
      rows.push(['<b>Minimum distance</b>', '<b>' + fmt(K.distanceBetween(a, b), 3) + ' mm</b>']);
      const ca = s[0].point || s[0].info.center || s[0].info.mid, cb = s[1].point || s[1].info.center || s[1].info.mid;
      const d = V.sub(cb, ca);
      rows.push(['Centre distance', fmt(V.len(d), 3) + ' mm'], ['ΔX, ΔY, ΔZ', d.map((x) => fmt(Math.abs(x), 3)).join(', ')]);
      const n1 = s[0].info && (s[0].info.normal || s[0].info.dir), n2 = s[1].info && (s[1].info.normal || s[1].info.dir);
      if (n1 && n2) rows.push(['Angle', fmt((Math.acos(Math.min(1, Math.abs(V.dot(V.norm(n1), V.norm(n2))))) * 180) / Math.PI, 2) + '°']);
    } catch (e) {
      /* ignore */
    }
  }
  return `<div class="kv">${rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('')}</div>`;
}
register('measure', () => {
  const pm = openPM({ title: 'Measure', icon: 'measure', noOK: true, fields: [{ key: 'out', type: 'info', html: () => measureHtml() }], onClose: () => (app.onSelChange = null) }, {});
  pm.activeSel = null;
  app.onSelChange = () => pm.refresh();
});
register('massProps', () => {
  const st = app.doc.state;
  if (!st.solid) return toast('There is no solid body to evaluate.');
  const m = K.massProps(st.solid);
  const mat = MATERIALS[app.doc.material] || MATERIALS['Plain Carbon Steel'];
  const mass = m.volume * 1e-9 * mat.density;
  const sz = V.sub(m.bbox.max, m.bbox.min);
  modal({
    title: 'Mass Properties',
    body: `<div class="kv"><b>Material</b><span>${esc(app.doc.material)}</span><b>Density</b><span>${mat.density} kg/m³</span>
      <b>Mass</b><span><b>${mass >= 1 ? fmt(mass, 3) + ' kg' : fmt(mass * 1000, 2) + ' g'}</b></span><b>Volume</b><span>${fmt(m.volume, 2)} mm³</span><b>Surface area</b><span>${fmt(m.area, 2)} mm²</span>
      <b>Center of mass</b><span>X ${fmt(m.com[0], 3)}, Y ${fmt(m.com[1], 3)}, Z ${fmt(m.com[2], 3)} mm</span><b>Bounding box</b><span>${sz.map((x) => fmt(x, 2)).join(' × ')} mm</span></div>`,
  });
});
register('boundingBox', () => {
  const st = app.doc.state;
  if (!st.solid) return toast('There is no solid body.');
  const b = K.bbox(st.solid), sz = V.sub(b.max, b.min);
  modal({ title: 'Bounding Box', body: `<div class="kv"><b>Size (X × Y × Z)</b><span>${sz.map((x) => fmt(x, 3)).join(' × ')} mm</span><b>Min</b><span>${b.min.map((x) => fmt(x, 3)).join(', ')}</span><b>Max</b><span>${b.max.map((x) => fmt(x, 3)).join(', ')}</span><b>Stock volume</b><span>${fmt(sz[0] * sz[1] * sz[2], 1)} mm³</span></div>` });
});
register('checkGeometry', () => {
  const st = app.doc.state;
  if (!st.solid) return toast('There is no solid body to check.');
  const ok = K.isValid(st.solid);
  const errs = app.doc.features.filter((f) => f.error);
  modal({ title: 'Check Entity', body: `<p>${ok ? '✅ The solid body is valid: no invalid faces or edges were found.' : '⚠ The kernel reports invalid geometry in the solid body.'}</p><p>${st.solid.faces.length} faces, ${st.solid.edges.length} edges.</p>${errs.length ? `<p><b>Features with rebuild errors:</b></p><ul>${errs.map((f) => `<li>${esc(f.name)}: ${esc(f.error)}</li>`).join('')}</ul>` : '<p>No rebuild errors.</p>'}` });
});
register('statistics', () => {
  const doc = app.doc;
  doc._cache = [];
  const t0 = performance.now();
  doc.rebuild();
  const t = performance.now() - t0;
  const st = doc.state;
  modal({ title: 'Performance Evaluation', body: `<div class="kv"><b>Features</b><span>${doc.features.length}</span><b>Full rebuild time</b><span>${fmt(t, 0)} ms</span><b>Faces / Edges</b><span>${st.solid ? st.solid.faces.length + ' / ' + st.solid.edges.length : '–'}</span><b>Surface bodies</b><span>${st.surfaces.length}</span><b>Mesh bodies</b><span>${st.meshes.length}</span></div>` });
});
register('material', () => {
  const body = el('div');
  const sel = el('select', { style: { width: '100%', padding: '6px' } });
  for (const n of Object.keys(MATERIALS)) sel.append(el('option', { value: n, text: n, selected: n === app.doc.material }));
  const info = el('div', { class: 'kv', style: { marginTop: '10px' } });
  const show = () => {
    const m = MATERIALS[sel.value];
    info.innerHTML = `<b>Elastic modulus</b><span>${m.E.toLocaleString()} MPa</span><b>Poisson's ratio</b><span>${m.nu}</span><b>Density</b><span>${m.density} kg/m³</span><b>Yield strength</b><span>${m.yield} MPa</span>`;
  };
  sel.addEventListener('change', show);
  show();
  body.append(sel, info);
  modal({ title: 'Material', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, action: () => {
    app.doc.checkpoint();
    app.doc.material = sel.value;
    buildTree();
    return true;
  } }] });
});

// ---------------------------------------------------------------- appearance / render
const texCache = {};
function procTexture(kind) {
  if (texCache[kind]) return texCache[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rnd = (() => {
    let s = 7;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  if (kind === 'wood') {
    g.fillStyle = '#b98a55';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(${90 + rnd() * 40},${55 + rnd() * 25},${25 + rnd() * 15},${0.15 + rnd() * 0.3})`;
      g.lineWidth = 1 + rnd() * 3;
      g.beginPath();
      const y = rnd() * 256;
      g.moveTo(0, y);
      g.bezierCurveTo(80, y + rnd() * 14 - 7, 170, y + rnd() * 14 - 7, 256, y);
      g.stroke();
    }
  } else if (kind === 'brushed') {
    g.fillStyle = '#c9ccd0';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) {
      const v = 150 + rnd() * 90;
      g.strokeStyle = `rgba(${v},${v},${v},.35)`;
      g.beginPath();
      const y = rnd() * 256, x = rnd() * 256;
      g.moveTo(x, y);
      g.lineTo(x + 40 + rnd() * 120, y);
      g.stroke();
    }
  } else if (kind === 'checker' || kind === 'tread') {
    g.fillStyle = kind === 'checker' ? '#f2f2f2' : '#9aa0a8';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = kind === 'checker' ? '#3c3f44' : '#6f757d';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2) kind === 'checker' ? g.fillRect(i * 32, j * 32, 32, 32) : (g.beginPath(), g.ellipse(i * 32 + 16, j * 32 + 16, 12, 4, ((i % 2 ? 1 : -1) * Math.PI) / 4, 0, 7), g.fill());
  } else if (kind === 'carbon') {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
      const v = (i + j) % 2 ? 38 : 22;
      const gr = g.createLinearGradient(i * 16, j * 16, i * 16 + 16, j * 16 + 16);
      gr.addColorStop(0, `rgb(${v + 30},${v + 30},${v + 34})`);
      gr.addColorStop(1, `rgb(${v},${v},${v})`);
      g.fillStyle = gr;
      g.fillRect(i * 16, j * 16, 16, 16);
    }
  } else if (kind === 'concrete') {
    g.fillStyle = '#a9a9a4';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) {
      const v = 120 + rnd() * 90;
      g.fillStyle = `rgba(${v},${v},${v - 4},.5)`;
      g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache[kind] = t;
  return t;
}
export const APPEARANCES = {
  'Brushed steel': { color: '#aeb6bf', metalness: 0.8, roughness: 0.42 }, 'Polished steel': { color: '#d5dade', metalness: 1, roughness: 0.12 }, 'Brushed aluminium': { color: '#cfd3d8', metalness: 0.85, roughness: 0.38, tex: 'brushed' },
  'Cast iron': { color: '#55595e', metalness: 0.6, roughness: 0.75 }, Gold: { color: '#e8b840', metalness: 1, roughness: 0.2 }, Copper: { color: '#c7734a', metalness: 1, roughness: 0.28 }, Brass: { color: '#cfa64a', metalness: 1, roughness: 0.3 },
  'Black oxide': { color: '#22252a', metalness: 0.7, roughness: 0.5 }, 'Red gloss plastic': { color: '#c8242b', metalness: 0, roughness: 0.18 }, 'Blue plastic': { color: '#2466c8', metalness: 0, roughness: 0.35 }, 'White plastic': { color: '#f1f1ee', metalness: 0, roughness: 0.4 },
  'Black rubber': { color: '#1c1c1c', metalness: 0, roughness: 0.95 }, Glass: { color: '#bfe3f2', metalness: 0, roughness: 0.05, opacity: 0.35 }, Wood: { color: '#ffffff', metalness: 0, roughness: 0.7, tex: 'wood' },
  'Carbon fibre': { color: '#ffffff', metalness: 0.3, roughness: 0.35, tex: 'carbon' }, Concrete: { color: '#ffffff', metalness: 0, roughness: 0.95, tex: 'concrete' }, 'Tread plate': { color: '#ffffff', metalness: 0.8, roughness: 0.45, tex: 'tread' }, Checker: { color: '#ffffff', metalness: 0, roughness: 0.6, tex: 'checker' },
  'Powder coat teal': { color: '#17505b', metalness: 0.1, roughness: 0.55 },
};
export function applyAppearance(doc) {
  const ap = doc.appearance;
  ap.map = ap.tex ? procTexture(ap.tex) : null;
}
register('appearance', () => {
  const doc = app.doc;
  const before = JSON.stringify({ ...doc.appearance, map: undefined });
  const vals = { preset: doc.appearance.preset || 'Brushed steel', color: doc.appearance.color, metalness: doc.appearance.metalness ?? 0.55, roughness: doc.appearance.roughness ?? 0.42, opacity: doc.appearance.opacity ?? 1 };
  const upd = (v, key, pm) => {
    if (key === 'preset') {
      const p = APPEARANCES[v.preset];
      Object.assign(v, { color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: p.opacity ?? 1, tex: p.tex || null });
      pm.refresh();
    }
    Object.assign(doc.appearance, { preset: v.preset, color: v.color, metalness: v.metalness, roughness: v.roughness, opacity: v.opacity, tex: v.tex ?? (APPEARANCES[v.preset] || {}).tex ?? null });
    applyAppearance(doc);
    app.vp.setState(doc);
  };
  openPM({
    title: 'Appearance', icon: 'appearance',
    fields: [
      { key: 'swatches', group: 'Appearances / Materials / Textures', type: 'custom', render: (pm) => {
        const w = el('div', { class: 'swatches' });
        for (const [n, p] of Object.entries(APPEARANCES)) w.append(el('button', { text: n, title: n, style: { background: p.tex ? `url(${procTexture(p.tex).image.toDataURL()}) center/64px` : p.color, opacity: 1 }, onclick: () => {
          pm.vals.preset = n;
          upd(pm.vals, 'preset', pm);
        } }));
        return w;
      } },
      { key: 'color', label: 'Color', group: 'Color', type: 'color' },
      { key: 'metalness', label: 'Metallic (0–1)', group: 'Surface Finish', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'roughness', label: 'Roughness (0–1)', group: 'Surface Finish', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'opacity', label: 'Opacity (0–1)', group: 'Surface Finish', type: 'number', min: 0.05, max: 1, step: 0.05 },
    ],
    onChange: upd,
    onOK: () => doc.checkpoint(),
    onCancel: () => {
      Object.assign(doc.appearance, JSON.parse(before));
      applyAppearance(doc);
      app.vp.setState(doc);
    },
  }, vals);
});
register('faceColor', () => {
  const faces = app.selection.filter((i) => i.kind === 'face');
  if (!faces.length) return toast('Select one or more faces first, then choose Face Color.');
  const inp = el('input', { type: 'color', value: '#d02c2c', style: { width: '100%', height: '40px' } });
  modal({ title: 'Face Color', body: el('div', {}, el('p', { text: `Color for ${faces.length} selected face(s):` }), inp), buttons: [
    { label: 'Remove color', action: () => {
      for (const f of faces) for (const [k, v] of Object.entries(app.doc.appearance.faces)) if (V.dist(v.sig.c, f.sig.c) < 1e-6) delete app.doc.appearance.faces[k];
      app.vp.setState(app.doc);
      return true;
    } },
    { label: 'Apply', primary: true, action: () => {
      app.doc.checkpoint();
      for (const f of faces) app.doc.appearance.faces[uid('fc')] = { sig: f.sig, color: inp.value };
      app.vp.setState(app.doc);
      setSelection([]);
      return true;
    } },
  ] });
});
register('scene', () => {
  const vp = app.vp, view = $('#view');
  const vals = { bg: app.sceneBg || 'default', floor: !!vp.floorOn, env: vp.scene.environmentIntensity, light: vp.light.intensity };
  openPM({
    title: 'Scene', icon: 'scene', noOK: true,
    fields: [
      { key: 'bg', label: 'Background', group: 'Background', type: 'select', options: [['default', 'Soft gradient'], ['white', 'Plain white'], ['dark', 'Dark'], ['studio', 'Studio']] },
      { key: 'floor', label: 'Floor shadows', group: 'Floor', type: 'check' },
      { key: 'env', label: 'Environment light', group: 'Lighting', type: 'number', min: 0, max: 3, step: 0.1 },
      { key: 'light', label: 'Key light', group: 'Lighting', type: 'number', min: 0, max: 6, step: 0.2 },
    ],
    onChange: (v) => {
      app.sceneBg = v.bg;
      view.classList.remove('bg-white', 'bg-dark', 'bg-studio');
      if (v.bg !== 'default') view.classList.add('bg-' + v.bg);
      vp.setFloor(v.floor);
      vp.scene.environmentIntensity = v.env;
      vp.light.intensity = v.light;
      vp.render();
    },
  }, vals);
});
function saveImage(mult, bg) {
  const url = app.vp.snapshot(mult, { background: bg });
  const a = el('a', { href: url, download: `${app.doc.name}.png` });
  a.click();
}
register('screenshot', () => saveImage(2, '#ffffff'));
register('renderImage', async () => {
  const body = el('div', { class: 'pm-group', html: `<div class="fld"><label>Resolution</label><select id="m"><option value="2">2× screen</option><option value="3" selected>3× screen</option><option value="4">4× screen</option></select></div><div class="fld"><label>Background</label><select id="b"><option value="#ffffff">White</option><option value="#eef2f6">Light grey</option><option value="#20262e">Dark</option></select></div><div class="fld wide"><label style="display:flex;gap:6px"><input type="checkbox" id="f" checked> Floor shadows</label></div><p style="color:#5d6b7a">Real-time physically based rendering (PBR) with image-based lighting and soft shadows. The image is saved as PNG.</p>` });
  const ok = await modal({ title: 'Final Render', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Render', primary: true, value: true }] });
  if (!ok) return;
  const vp = app.vp, hadFloor = vp.floorOn, disp = vp.display;
  vp.setDisplay('shaded');
  vp.setFloor(body.querySelector('#f').checked);
  saveImage(+body.querySelector('#m').value, body.querySelector('#b').value);
  vp.setFloor(hadFloor);
  vp.setDisplay(disp);
  toast('Render saved as PNG.');
});

// ---------------------------------------------------------------- simulation
function faceTris(item) {
  const t = item.hit.body.tess, g = t.faceGroups.find((x) => x.face === item.hit.index);
  const out = new Float32Array(g.count * 3);
  for (let k = 0; k < g.count; k++) out.set(t.positions.subarray(t.indices[g.start + k] * 3, t.indices[g.start + k] * 3 + 3), k * 3);
  return out;
}
function soup(tess) {
  const out = new Float32Array(tess.indices.length * 3);
  for (let k = 0; k < tess.indices.length; k++) out.set(tess.positions.subarray(tess.indices[k] * 3, tess.indices[k] * 3 + 3), k * 3);
  return out;
}
const ramp = (t) => {
  const stops = [[0x2b, 0x83, 0xba], [0xab, 0xdd, 0xa4], [0xff, 0xff, 0xbf], [0xfd, 0xae, 0x61], [0xd7, 0x19, 0x1c]];
  const x = Math.max(0, Math.min(0.9999, t)) * 4, i = Math.floor(x), f = x - i;
  return stops[i].map((c, k) => (c + (stops[i + 1][k] - c) * f) / 255);
};
let simAnim = 0;
function clearSim() {
  cancelAnimationFrame(simAnim);
  simAnim = 0;
  const g = app.vp.groups.extras;
  app.vp.disposeGroup(g);
  app.vp.groups.bodies.visible = true;
  $('#legend').hidden = true;
  app.vp.render();
}
register('simClear', clearSim);
register('simStudy', () => {
  const doc = app.doc, vp = app.vp;
  if (!doc.state.solid) return toast('A static study needs a solid body.');
  setSelection([]);
  const vals = { material: doc.material, fixed: [], loaded: [], force: 1000, dir: 'normal', resolution: 28, plot: 'stress', scale: 0, gravity: false, anim: true };
  let result = null, positions = null;
  const show = (v) => {
    if (!result) return;
    clearSim();
    const n = positions.length / 3;
    const pos = new Float32Array(positions);
    const field = v.plot === 'stress' ? result.vertexStress : result.vertexDispMag;
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, field[i]);
    const auto = (vp.modelSize * 0.08) / (result.maxDisp || 1);
    const sc = v.scale > 0 ? v.scale : auto;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col.set(ramp(field[i] / (max || 1)), i * 3);
      for (let k = 0; k < 3; k++) pos[i * 3 + k] += result.vertexDisp[i * 3 + k] * sc;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    vp.groups.extras.add(mesh);
    vp.groups.bodies.visible = false;
    const unit = v.plot === 'stress' ? 'MPa' : 'mm';
    const lg = $('#legend');
    lg.hidden = false;
    if (v.anim && vp.animate) {
      // breathe between the unloaded and the fully loaded shape so the way the part moves is obvious
      const attr = geo.attributes.position, arr = attr.array, disp = result.vertexDisp;
      let frame = 0;
      const loop = (now) => {
        const k = 0.5 - 0.5 * Math.cos(now * 0.0028);
        for (let i = 0; i < arr.length; i++) arr[i] = positions[i] + disp[i] * sc * k;
        attr.needsUpdate = true;
        if (frame++ % 4 === 0) geo.computeVertexNormals();
        vp.render();
        simAnim = requestAnimationFrame(loop);
      };
      simAnim = requestAnimationFrame(loop);
    }
    lg.innerHTML = `<b>${v.plot === 'stress' ? 'von Mises stress' : 'Displacement'}</b><div style="margin-top:6px"><div class="grad"></div><div class="ticks">${[1, 0.75, 0.5, 0.25, 0].map((k) => `<span>${fmt(max * k, max < 1 ? 4 : 2)} ${unit}</span>`).join('')}</div></div><div style="clear:both;padding-top:6px;color:#5d6b7a">Deformation ×${fmt(sc, 1)}</div>`;
    vp.render();
  };
  const runStudy = async (pm) => {
    const v = pm.vals;
    if (!v.fixed.length) return pm.setError('Select at least one face for the Fixed Geometry fixture.');
    if (!v.loaded.length && !v.gravity) return pm.setError('Select at least one face for the force, or enable gravity.');
    pm.setError('');
    const solidBody = vp.bodies.find((b) => b.id === 'solid');
    positions = soup(solidBody.tess);
    const mat = MATERIALS[v.material];
    const loads = [];
    if (v.loaded.length) {
      for (const f of v.loaded) {
        let d;
        if (v.dir === 'normal') d = V.mul(V.norm(f.info.normal), -1);
        else d = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] }[v.dir];
        loads.push({ tris: faceTris(f), force: V.mul(d, v.force / v.loaded.length) });
      }
    }
    const fixedArr = v.fixed.map(faceTris);
    const fixedTris = new Float32Array(fixedArr.reduce((s, a) => s + a.length, 0));
    let o = 0;
    for (const a of fixedArr) {
      fixedTris.set(a, o);
      o += a.length;
    }
    pm.setMessage('Solving… 0%');
    const t0 = performance.now();
    try {
      result = await solveStatic({ positions, fixedTris, loads, gravity: v.gravity ? [0, -9.81, 0] : null, material: mat, resolution: Math.round(v.resolution) }, (f, msg) => pmActive() === pm && pm.setMessage(`Solving… ${Math.round(f * 100)}% ${msg || ''}`));
    } catch (e) {
      console.error(e);
      result = { ok: false, message: 'The solver failed: ' + (e.message || e) };
    }
    if (pmActive() !== pm) return;
    if (!result.ok) {
      pm.setMessage('');
      pm.setError(result.message);
      result = null;
      return;
    }
    const fos = mat.yield / (result.maxStress || 1e-9);
    pm.setMessage(`Done in ${fmt((performance.now() - t0) / 1000, 1)} s · ${result.nVoxels.toLocaleString()} elements · Max von Mises ${fmt(result.maxStress, 2)} MPa · Max displacement ${fmt(result.maxDisp, 4)} mm · Minimum factor of safety ${fmt(fos, 2)} (yield ${mat.yield} MPa). ${result.message || ''}`);
    show(v);
  };
  openPM({
    title: 'Static Study', icon: 'sim', noOK: true,
    message: 'Linear static analysis. 1) choose a material, 2) pick fixed faces, 3) pick loaded faces and the force, 4) Run.',
    fields: [
      { key: 'material', label: 'Material', group: 'Material', type: 'select', options: Object.keys(MATERIALS) },
      { key: 'fixed', label: 'Fixed faces', group: 'Fixtures', type: 'sel', accept: ['face'], placeholder: 'Faces that cannot move' },
      { key: 'loaded', label: 'Loaded faces', group: 'External Loads', type: 'sel', accept: ['face'], placeholder: 'Faces the force acts on' },
      { key: 'force', label: 'Total force (N)', group: 'External Loads', type: 'number' },
      { key: 'dir', label: 'Direction', group: 'External Loads', type: 'select', options: [['normal', 'Normal to face (pushing)'], ['x', '+X'], ['-x', '−X'], ['y', '+Y'], ['-y', '−Y (down)'], ['z', '+Z'], ['-z', '−Z']] },
      { key: 'gravity', label: 'Include gravity (−Y)', group: 'External Loads', type: 'check' },
      { key: 'resolution', label: 'Mesh density', group: 'Mesh', type: 'number', min: 8, max: 64, step: 2 },
      { key: 'run', group: 'Run', type: 'buttons', buttons: [{ label: '▶ Run study', primary: true, action: (pm) => runStudy(pm) }, { label: 'Hide results', action: () => clearSim() }] },
      { key: 'plot', label: 'Plot', group: 'Results', type: 'select', options: [['stress', 'von Mises stress'], ['disp', 'Displacement']] },
      { key: 'scale', label: 'Deform. scale (0=auto)', group: 'Results', type: 'number', min: 0 },
      { key: 'anim', label: 'Animate the deformation', group: 'Results', type: 'check' },
    ],
    onChange: (v, key) => {
      if (key === 'material') doc.material = v.material;
      if (key === 'plot' || key === 'scale' || key === 'anim') show(v);
    },
    onClose: () => {
      clearSim();
      setSelection([]);
    },
  }, vals);
});

// ---------------------------------------------------------------- mesh modeling
function meshFeature() {
  const picked = app.selection.find((i) => i.kind === 'mesh' || (i.id && app.doc.get(i.id) && app.doc.get(i.id).type === 'mesh'));
  const f = picked ? app.doc.get(picked.id) : app.doc.features.filter((x) => x.type === 'mesh' && !x.suppressed).pop();
  if (!f) toast('There is no mesh body. Import an STL / OBJ / PLY / 3MF / GLB file first (File ▸ Import).');
  return f;
}
function meshGeometry(f) {
  const b = app.doc.blobs[f.params.blob];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
  if (b.indices) g.setIndex(new THREE.BufferAttribute(b.indices, 1));
  return g;
}
function storeMesh(f, geo) {
  const pos = geo.attributes.position.array;
  app.doc.blobs[f.params.blob] = { positions: pos instanceof Float32Array ? pos : new Float32Array(pos), indices: geo.index ? new Uint32Array(geo.index.array) : null };
  app.doc._cache = [];
  app.doc.rebuild();
}
export function addMeshBody(name, positions, indices, colors) {
  const id = uid('m');
  app.doc.blobs[id] = { positions, indices: indices || null, colors: colors || null };
  return app.doc.addFeature('mesh', { blob: id }, { name });
}
const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
register('meshDecimate', async () => {
  const f = meshFeature();
  if (!f) return;
  const g0 = meshGeometry(f);
  const n0 = triCount(g0);
  const body = el('div', { class: 'pm-group', html: `<p>${f.name}: ${n0.toLocaleString()} triangles</p><div class="fld"><label>Keep (%)</label><input id="p" type="number" value="50" min="1" max="99"></div>` });
  if (!(await modal({ title: 'Decimate Mesh', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Decimate', primary: true, value: true }] }))) return;
  const keep = Math.max(0.01, Math.min(0.99, +body.querySelector('#p').value / 100));
  toast('Decimating…');
  await new Promise((r) => setTimeout(r, 30));
  const merged = mergeVertices(g0, 1e-4);
  const remove = Math.floor(merged.attributes.position.count * (1 - keep));
  const { SimplifyModifier } = await import('three/examples/jsm/modifiers/SimplifyModifier.js');
  const out = await new SimplifyModifier().modify(merged, remove);
  storeMesh(f, out);
  toast(`Decimated: ${n0.toLocaleString()} → ${triCount(out).toLocaleString()} triangles`);
});
register('meshSmooth', async () => {
  const f = meshFeature();
  if (!f) return;
  const body = el('div', { class: 'pm-group', html: `<div class="fld"><label>Iterations</label><input id="n" type="number" value="3" min="1" max="50"></div><div class="fld"><label>Strength (0–1)</label><input id="s" type="number" value="0.5" step="0.1" min="0" max="1"></div>` });
  if (!(await modal({ title: 'Smooth Mesh (Laplacian)', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Smooth', primary: true, value: true }] }))) return;
  const iters = +body.querySelector('#n').value, lam = +body.querySelector('#s').value;
  const g = mergeVertices(meshGeometry(f), 1e-4);
  const pos = g.attributes.position.array, idx = g.index.array, n = pos.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]];
    nb[a].add(b).add(c);
    nb[b].add(a).add(c);
    nb[c].add(a).add(b);
  }
  for (let it = 0; it < iters; it++) {
    const next = new Float32Array(pos.length);
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, z = 0;
      for (const j of nb[i]) (x += pos[j * 3]), (y += pos[j * 3 + 1]), (z += pos[j * 3 + 2]);
      const k = nb[i].size || 1;
      next[i * 3] = pos[i * 3] + lam * (x / k - pos[i * 3]);
      next[i * 3 + 1] = pos[i * 3 + 1] + lam * (y / k - pos[i * 3 + 1]);
      next[i * 3 + 2] = pos[i * 3 + 2] + lam * (z / k - pos[i * 3 + 2]);
    }
    pos.set(next);
  }
  storeMesh(f, g);
  toast('Mesh smoothed.');
});
register('meshTransform', async () => {
  const f = meshFeature();
  if (!f) return;
  const body = el('div', { class: 'pm-group', html: `<div class="fld"><label>Scale factor</label><input id="s" type="number" value="1" step="any"></div><div class="fld"><label>Move X Y Z</label><div class="row"><input id="x" type="number" value="0"><input id="y" type="number" value="0"><input id="z" type="number" value="0"></div></div><div class="fld"><label>Rotate about</label><select id="ax"><option>X</option><option>Y</option><option>Z</option></select></div><div class="fld"><label>Angle (°)</label><input id="a" type="number" value="0"></div><p style="color:#5d6b7a">Tip: scale by 25.4 to convert inches to mm, or 1000 for metres.</p>` });
  if (!(await modal({ title: 'Scale / Move Mesh', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }] }))) return;
  const q = (id) => +body.querySelector(id).value || 0;
  const g = meshGeometry(f).clone();
  const s = q('#s') || 1;
  g.scale(s, s, s);
  const ax = body.querySelector('#ax').value, a = (q('#a') * Math.PI) / 180;
  if (a) ax === 'X' ? g.rotateX(a) : ax === 'Y' ? g.rotateY(a) : g.rotateZ(a);
  g.translate(q('#x'), q('#y'), q('#z'));
  storeMesh(f, g);
});
register('meshFlip', () => {
  const f = meshFeature();
  if (!f) return;
  const g = meshGeometry(f).clone();
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
  } else {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) [p[i + 3 + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + 3 + k]];
  }
  storeMesh(f, g);
  toast('Normals flipped.');
});
function meshStats(g) {
  const gi = g.index ? g : mergeVertices(g, 1e-4);
  const idx = gi.index.array, pos = gi.attributes.position.array;
  let vol = 0, area = 0;
  const edges = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const p = [0, 1, 2].map((k) => [pos[idx[i + k] * 3], pos[idx[i + k] * 3 + 1], pos[idx[i + k] * 3 + 2]]);
    vol += V.dot(p[0], V.cross(p[1], p[2])) / 6;
    area += V.len(V.cross(V.sub(p[1], p[0]), V.sub(p[2], p[0]))) / 2;
    for (let k = 0; k < 3; k++) {
      const a = idx[i + k], b = idx[i + ((k + 1) % 3)];
      const key = a < b ? a + '_' + b : b + '_' + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c !== 2) open++;
  return { tris: idx.length / 3, verts: pos.length / 3, vol: Math.abs(vol), area, open };
}
register('meshInfo', () => {
  const f = meshFeature();
  if (!f) return;
  const g = meshGeometry(f);
  g.computeBoundingBox();
  const s = meshStats(mergeVertices(g, 1e-4));
  const sz = g.boundingBox.getSize(new THREE.Vector3());
  modal({ title: 'Mesh Info', body: `<div class="kv"><b>Body</b><span>${esc(f.name)}</span><b>Triangles</b><span>${s.tris.toLocaleString()}</span><b>Vertices</b><span>${s.verts.toLocaleString()}</span><b>Size</b><span>${fmt(sz.x)} × ${fmt(sz.y)} × ${fmt(sz.z)} mm</span><b>Surface area</b><span>${fmt(s.area, 1)} mm²</span><b>Volume</b><span>${s.open ? '– (not watertight)' : fmt(s.vol, 1) + ' mm³'}</span><b>Watertight</b><span>${s.open ? `No – ${s.open} open / non-manifold edges` : 'Yes'}</span></div>` });
});
register('meshToSolid', async () => {
  const f = meshFeature();
  if (!f) return;
  const g = meshGeometry(f).toNonIndexed();
  const n = g.attributes.position.count / 3;
  if (n > 20000) return toast(`This mesh has ${n.toLocaleString()} triangles. Decimate it below 20,000 before converting to a solid.`, true);
  toast('Converting mesh to a solid body…');
  await new Promise((r) => setTimeout(r, 30));
  const shape = K.solidFromTriangles(g.attributes.position.array);
  const isSolid = K.massProps(shape).volume > 1e-9;
  app.doc.addFeature('import', { brep: shape.serialize(), as: isSolid ? 'solid' : 'surface', source: f.name }, { name: f.name + (isSolid ? '-Solid' : '-Surface') });
  app.doc.setSuppressed(f.id, true);
  toast(isSolid ? 'Converted to a solid body (faceted). The mesh body was suppressed.' : 'The mesh is not watertight, so it became a surface body.');
});
register('solidToMesh', () => {
  const b = app.vp.bodies.find((x) => x.id === 'solid');
  if (!b) return toast('There is no solid body.');
  addMeshBody(app.doc.name + '-Mesh', soup(b.tess), null);
  toast('Created a mesh body from the solid (the solid is unchanged).');
});

export { soup, meshGeometry, faceTris };
