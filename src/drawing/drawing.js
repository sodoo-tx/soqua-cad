// 2D drawing sheets: sheet formats (title blocks), projected model views with hidden-line removal,
// dimensions, notes, centre marks, and vector export to PDF / DXF / SVG.
import { app, register, run, buildRibbon, buildTree, refreshTitle, scheduleAutosave } from '../app.js';
import { $, el, esc, toast, setHint, modal, popup, promptDlg, showLeft, closePM, pmActive } from '../ui/ui.js';
import { icon } from '../ui/icons.js';
import { fonts, DEFAULT_FONT } from '../fonts.js';
import { writeDXF } from '../io/dxf.js';
import { download } from '../io/files.js';
import { MATERIALS } from '../sim/fea.js';
import { uid, fmt, V } from '../geom.js';
import * as K from '../kernel.js';

const BASE = import.meta.env.BASE_URL;
const VIEWDEF = {
  // Z up (same convention as the 3D view)
  front: { dir: [0, 1, 0], x: [1, 0, 0], label: 'Front' }, back: { dir: [0, -1, 0], x: [-1, 0, 0], label: 'Back' },
  right: { dir: [-1, 0, 0], x: [0, 1, 0], label: 'Right' }, left: { dir: [1, 0, 0], x: [0, -1, 0], label: 'Left' },
  top: { dir: [0, 0, -1], x: [1, 0, 0], label: 'Top' }, bottom: { dir: [0, 0, 1], x: [1, 0, 0], label: 'Bottom' },
  iso: { dir: [-1, 1, -1], x: [1, 1, 0], label: 'Isometric' },
};
const SCALES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005];
const scaleText = (s) => (s >= 1 ? `${fmt(s)}:1` : `1:${fmt(1 / s)}`);
const LW = { visible: 0.35, hidden: 0.18, template: 0.2, dim: 0.18, center: 0.13 };
const templates = {};
let templateIndex = null;

async function loadIndex() {
  if (!templateIndex) {
    try {
      templateIndex = await (await fetch(`${BASE}templates/index.json`)).json();
    } catch (e) {
      templateIndex = [];
    }
    templateIndex.push({ id: 'blank_a4', name: 'A4 blank (landscape)', width: 297, height: 210 }, { id: 'blank_a3', name: 'A3 blank (landscape)', width: 420, height: 297 }, { id: 'blank_a2', name: 'A2 blank (landscape)', width: 594, height: 420 });
  }
  return templateIndex;
}
async function loadTemplate(id) {
  if (templates[id]) return templates[id];
  const meta = (await loadIndex()).find((t) => t.id === id) || templateIndex[0];
  if (meta.id.startsWith('blank_')) {
    const w = meta.width, h = meta.height, m = 10;
    templates[id] = { ...meta, lines: [[m, m, w - m, m], [w - m, m, w - m, h - m], [w - m, h - m, m, h - m], [m, h - m, m, m]], texts: [], images: [] };
    return templates[id];
  }
  const t = await (await fetch(`${BASE}templates/${meta.id}.json`)).json();
  for (const im of t.images || []) {
    try {
      const blob = await (await fetch(`${BASE}templates/${im.src}`)).blob();
      im.dataUrl = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(blob);
      });
    } catch (e) {
      /* logo optional */
    }
  }
  templates[id] = t;
  return t;
}

class Drawing {
  constructor() {
    this.host = $('#drawing');
    this.view = { k: 2, tx: 20, ty: 20 };
    this.sel = null;
    this.tool = 'select';
    this.clicks = [];
    this.cache = {};
    this.version = 0;
    this.items = [];
    this.bind();
  }
  get d() {
    return app.doc.drawing;
  }
  font() {
    return app.doc.custom.font && fonts[app.doc.custom.font] ? app.doc.custom.font : DEFAULT_FONT;
  }
  capRatio() {
    const f = fonts[this.font()];
    try {
      const r = f.ot.tables.os2.sCapHeight / f.ot.unitsPerEm;
      return r > 0.3 && r < 1 ? r : 0.7;
    } catch (e) {
      return 0.7;
    }
  }

  async open() {
    const doc = app.doc;
    if (!doc.drawing) {
      const idx = await loadIndex();
      doc.drawing = { template: idx[0].id, scale: 1, projection: 'first', views: [], dims: [], notes: [], centers: [] };
      this.tpl = await loadTemplate(doc.drawing.template);
      if (doc.state.solid) this.standardViews(false);
    } else this.tpl = await loadTemplate(doc.drawing.template);
    this.version++;
    this.render();
    this.fit();
  }
  // the sheet was edited: remember it (autosave) and flag unsaved changes
  touch() {
    app.markDirty();
    scheduleAutosave();
  }
  modelChanged() {
    this.version++;
    this.cache = {};
    this.render();
  }

  // ------------------------------------------------------------ model projections
  projection(type) {
    const key = type + ':' + this.version;
    if (!this.cache[key]) {
      const solid = app.doc.state.solid;
      if (!solid) return { visible: [], hidden: [], bb: [0, 0, 0, 0] };
      const def = VIEWDEF[type];
      let p;
      try {
        p = K.projectShape(solid, def.dir, V.norm(def.x));
      } catch (e) {
        console.warn('projection failed', e);
        p = { visible: [], hidden: [] };
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const ext = (x, y) => {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      };
      for (const e of p.visible) {
        if (e.type === 'line') ext(e.x1, e.y1), ext(e.x2, e.y2);
        else if (e.type === 'polyline') e.pts.forEach((q) => ext(q[0], q[1]));
        else ext(e.cx - e.r, e.cy - e.r), ext(e.cx + e.r, e.cy + e.r);
      }
      if (x0 === Infinity) x0 = y0 = x1 = y1 = 0;
      p.bb = [x0, y0, x1, y1];
      this.cache[key] = p;
    }
    return this.cache[key];
  }
  viewScale(v) {
    return v.scale || this.d.scale;
  }
  standardViews(announce = true) {
    const d = this.d;
    if (!app.doc.state.solid) return toast('There is no solid body to make views from. Model something first.');
    const first = d.projection === 'first';
    const types = ['front', 'top', first ? 'left' : 'right'];
    const P = Object.fromEntries(types.map((t) => [t, this.projection(t)]));
    const size = (t) => [P[t].bb[2] - P[t].bb[0], P[t].bb[3] - P[t].bb[1]];
    const [fw, fh] = size('front'), [, th] = size('top'), [sw] = size(types[2]);
    const W = this.tpl.width, H = this.tpl.height;
    const availW = W * 0.62, availH = H * 0.6;
    const gapMM = 22;
    let s = SCALES.find((k) => (fw + sw) * k + gapMM <= availW && (fh + th) * k + gapMM <= availH) || 0.005;
    d.scale = s;
    const totalW = (fw + sw) * s + gapMM, totalH = (fh + th) * s + gapMM;
    const left = W * 0.08 + (availW - totalW) / 2, bottom = H * 0.3 + (availH - totalH) / 2;
    const cx = left + (fw * s) / 2;
    const cyFront = first ? bottom + th * s + gapMM + (fh * s) / 2 : bottom + (fh * s) / 2;
    const cyTop = first ? bottom + (th * s) / 2 : bottom + fh * s + gapMM + (th * s) / 2;
    d.views = [
      { id: uid('v'), type: 'front', x: cx, y: cyFront, hidden: true },
      { id: uid('v'), type: 'top', x: cx, y: cyTop, hidden: true },
      { id: uid('v'), type: types[2], x: left + fw * s + gapMM + (sw * s) / 2, y: cyFront, hidden: true },
    ];
    d.dims = [];
    d.centers = [];
    this.touch();
    this.render();
    if (announce) toast(`Standard 3 views placed (${first ? 'first' : 'third'} angle projection, scale ${scaleText(s)}).`);
  }
  // sheet coordinates of a view-local model point
  toSheet(v, p) {
    const pr = this.projection(v.type), s = this.viewScale(v);
    const cx = (pr.bb[0] + pr.bb[2]) / 2, cy = (pr.bb[1] + pr.bb[3]) / 2;
    return [v.x + (p[0] - cx) * s, v.y + (p[1] - cy) * s];
  }
  toLocal(v, q) {
    const pr = this.projection(v.type), s = this.viewScale(v);
    const cx = (pr.bb[0] + pr.bb[2]) / 2, cy = (pr.bb[1] + pr.bb[3]) / 2;
    return [(q[0] - v.x) / s + cx, (q[1] - v.y) / s + cy];
  }
  viewRect(v) {
    const pr = this.projection(v.type), s = this.viewScale(v);
    const w = (pr.bb[2] - pr.bb[0]) * s, h = (pr.bb[3] - pr.bb[1]) * s;
    return [v.x - w / 2 - 3, v.y - h / 2 - 3, v.x + w / 2 + 3, v.y + h / 2 + 3];
  }

  // ------------------------------------------------------------ display list (sheet mm, y up)
  build() {
    const d = this.d, t = this.tpl, items = [];
    const c = app.doc.custom;
    for (const l of t.lines) items.push({ type: 'line', x1: l[0], y1: l[1], x2: l[2], y2: l[3], layer: 'TEMPLATE', lw: LW.template });
    for (const im of t.images || []) if (im.dataUrl) items.push({ type: 'image', ...im, layer: 'TEMPLATE' });
    const mat = c.material || app.doc.material;
    let mass = '';
    if (app.doc.state.solid) {
      try {
        const m = K.massProps(app.doc.state.solid).volume * 1e-9 * (MATERIALS[app.doc.material] || { density: 7800 }).density;
        mass = c.weight || (m >= 1 ? fmt(m, 2) + ' кг' : fmt(m * 1000, 1) + ' г');
      } catch (e) {
        /* ignore */
      }
    }
    const find = (s) => t.texts.find((x) => x.text.trim() === s);
    const nameCol = find('Нэр'), dateCol = find('Огноо');
    for (const tx of t.texts) {
      let text = tx.text;
      if (tx.field === 'title') text = c.title || app.doc.name;
      else if (tx.field === 'scale') text = 'SCALE:' + scaleText(d.scale);
      else if (tx.field === 'sheet') text = 'SHEET 1 OF 1';
      items.push({ type: 'text', x: tx.x, y: tx.y, h: tx.h, text, halign: tx.halign, valign: tx.valign, rot: tx.rot || 0, layer: 'TEMPLATE' });
      const key = tx.text.trim();
      const val = (s, x, y, h = 2.5, halign = 'center') => s && items.push({ type: 'text', x, y, h, text: String(s), halign, valign: tx.valign, rot: 0, layer: 'TITLE' });
      if (nameCol && ['Зурсан', 'Шалгасан', 'Захиалагч'].includes(key)) {
        val({ Зурсан: c.drawnBy, Шалгасан: c.checkedBy, Захиалагч: c.customer }[key], nameCol.x, tx.y);
        if (key === 'Зурсан' && dateCol) val(c.date || new Date().toISOString().slice(0, 10), dateCol.x, tx.y);
      } else if (key === 'Материал:') val(mat, tx.x + 2, tx.y - 6.5, 3, 'left');
      else if (key === 'Жин:') val(mass, tx.x + 9, tx.y, tx.h, 'left');
      else if (['Будаг', 'Хугацаа', 'Нэмэлт', 'Тоо/ш'].includes(key)) val({ Будаг: c.paint, Хугацаа: c.deadline, Нэмэлт: c.extra, 'Тоо/ш': c.qty }[key], tx.x, tx.y - 5.2, 2.5, tx.halign);
    }
    for (const v of d.views) {
      const pr = this.projection(v.type), s = this.viewScale(v);
      const cx = (pr.bb[0] + pr.bb[2]) / 2, cy = (pr.bb[1] + pr.bb[3]) / 2;
      const X = (x) => v.x + (x - cx) * s, Y = (y) => v.y + (y - cy) * s;
      const put = (list, layer, lw, dash) => {
        for (const e of list) {
          if (e.type === 'line') items.push({ type: 'line', x1: X(e.x1), y1: Y(e.y1), x2: X(e.x2), y2: Y(e.y2), layer, lw, dash, view: v.id });
          else if (e.type === 'circle') items.push({ type: 'circle', cx: X(e.cx), cy: Y(e.cy), r: e.r * s, layer, lw, dash, view: v.id });
          else if (e.type === 'arc') items.push({ type: 'arc', cx: X(e.cx), cy: Y(e.cy), r: e.r * s, a1: e.a1, a2: e.a2, layer, lw, dash, view: v.id });
          else items.push({ type: 'polyline', pts: e.pts.map((q) => [X(q[0]), Y(q[1])]), layer, lw, dash, view: v.id });
        }
      };
      if (v.hidden && v.type !== 'iso') put(pr.hidden, 'HIDDEN', LW.hidden, [2, 1]);
      put(pr.visible, 'VISIBLE', LW.visible);
      if (v.scale && v.scale !== d.scale) {
        const r = this.viewRect(v);
        items.push({ type: 'text', x: v.x, y: r[1] - 2, h: 3, text: `SCALE ${scaleText(v.scale)}`, halign: 'center', valign: 'top', rot: 0, layer: 'TEXT' });
      }
    }
    for (const cm of d.centers) {
      const v = d.views.find((x) => x.id === cm.view);
      if (!v) continue;
      const p = this.toSheet(v, cm.p), r = cm.r * this.viewScale(v) + 2.5;
      const dash = [6, 1.2, 1.2, 1.2];
      items.push({ type: 'line', x1: p[0] - r, y1: p[1], x2: p[0] + r, y2: p[1], layer: 'CENTER', lw: LW.center, dash, ref: cm.id });
      items.push({ type: 'line', x1: p[0], y1: p[1] - r, x2: p[0], y2: p[1] + r, layer: 'CENTER', lw: LW.center, dash, ref: cm.id });
    }
    for (const dm of d.dims) this.dimItems(dm, items);
    for (const n of d.notes) items.push({ type: 'text', x: n.x, y: n.y, h: n.h || 3.5, text: n.text, halign: 'left', valign: 'baseline', rot: 0, layer: 'TEXT', ref: n.id });
    this.items = items;
    return items;
  }
  dimValue(dm) {
    if (dm.text) return dm.text;
    if (dm.kind === 'diameter') return 'Ø' + fmt(dm.r * 2, 2);
    if (dm.kind === 'radius') return 'R' + fmt(dm.r, 2);
    const dx = Math.abs(dm.p2[0] - dm.p1[0]), dy = Math.abs(dm.p2[1] - dm.p1[1]);
    return fmt(dm.orient === 'h' ? dx : dm.orient === 'v' ? dy : Math.hypot(dx, dy), 2);
  }
  dimItems(dm, items) {
    const v = this.d.views.find((x) => x.id === dm.view);
    if (!v) return;
    const th = 3.5, lw = LW.dim, layer = 'DIMENSION', ref = dm.id;
    const line = (a, b) => items.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], layer, lw, ref });
    const arrow = (tip, dir) => items.push({ type: 'arrow', tip, dir, layer, ref });
    const txt = this.dimValue(dm);
    if (dm.kind === 'diameter' || dm.kind === 'radius') {
      const c = this.toSheet(v, dm.p1), r = dm.r * this.viewScale(v);
      const dv = [dm.pos[0] - c[0], dm.pos[1] - c[1]], L = Math.hypot(dv[0], dv[1]) || 1, u = [dv[0] / L, dv[1] / L];
      const rim = [c[0] + u[0] * r, c[1] + u[1] * r];
      const start = dm.kind === 'diameter' ? [c[0] - u[0] * r, c[1] - u[1] * r] : c;
      line(start, L > r ? dm.pos : rim);
      arrow(rim, L > r ? [-u[0], -u[1]] : u);
      if (dm.kind === 'diameter') arrow(start, L > r ? u : [-u[0], -u[1]]);
      const right = u[0] >= 0;
      const end = [dm.pos[0] + (right ? 1 : -1) * (txt.length * th * 0.62 + 2), dm.pos[1]];
      if (L > r) line(dm.pos, end);
      items.push({ type: 'text', x: (dm.pos[0] + end[0]) / 2, y: dm.pos[1] + 0.8, h: th, text: txt, halign: 'center', valign: 'baseline', rot: 0, layer, ref, dimText: true });
      return;
    }
    const a = this.toSheet(v, dm.p1), b = this.toSheet(v, dm.p2);
    let a2, b2;
    if (dm.orient === 'h') (a2 = [a[0], dm.pos[1]]), (b2 = [b[0], dm.pos[1]]);
    else if (dm.orient === 'v') (a2 = [dm.pos[0], a[1]]), (b2 = [dm.pos[0], b[1]]);
    else {
      const dd = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(dd[0], dd[1]) || 1, n = [-dd[1] / L, dd[0] / L];
      const off = (dm.pos[0] - a[0]) * n[0] + (dm.pos[1] - a[1]) * n[1];
      a2 = [a[0] + n[0] * off, a[1] + n[1] * off];
      b2 = [b[0] + n[0] * off, b[1] + n[1] * off];
    }
    const ext = (p, q) => {
      const dd = [q[0] - p[0], q[1] - p[1]], L = Math.hypot(dd[0], dd[1]);
      if (L < 1e-6) return;
      const u = [dd[0] / L, dd[1] / L];
      line([p[0] + u[0] * 1, p[1] + u[1] * 1], [q[0] + u[0] * 1.5, q[1] + u[1] * 1.5]);
    };
    ext(a, a2);
    ext(b, b2);
    line(a2, b2);
    const dd = [b2[0] - a2[0], b2[1] - a2[1]], L = Math.hypot(dd[0], dd[1]) || 1, u = [dd[0] / L, dd[1] / L];
    arrow(a2, [-u[0], -u[1]]);
    arrow(b2, u);
    let rot = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
    if (rot > 90.01 || rot <= -89.99) rot += 180;
    const rr = (rot * Math.PI) / 180, n = [-Math.sin(rr), Math.cos(rr)];
    items.push({ type: 'text', x: (a2[0] + b2[0]) / 2 + n[0] * 0.9, y: (a2[1] + b2[1]) / 2 + n[1] * 0.9, h: th, text: txt, halign: 'center', valign: 'baseline', rot, layer, ref, dimText: true });
  }

  // ------------------------------------------------------------ SVG
  svgBody(items, forExport = false) {
    const H = this.tpl.height, cap = this.capRatio(), font = this.font();
    const y = (v) => H - v;
    const out = [];
    const st = (it) => `stroke="${it.ref && this.sel && this.sel.id === it.ref && !forExport ? '#1f6fb5' : '#000'}" stroke-width="${it.lw || 0.2}" fill="none"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''} stroke-linecap="round"`;
    for (const it of items) {
      if (it.type === 'line') out.push(`<line x1="${f(it.x1)}" y1="${f(y(it.y1))}" x2="${f(it.x2)}" y2="${f(y(it.y2))}" ${st(it)}/>`);
      else if (it.type === 'circle') out.push(`<circle cx="${f(it.cx)}" cy="${f(y(it.cy))}" r="${f(it.r)}" ${st(it)}/>`);
      else if (it.type === 'arc') {
        const a1 = (it.a1 * Math.PI) / 180, a2 = (it.a2 * Math.PI) / 180;
        let sw = (it.a2 - it.a1) % 360;
        if (sw <= 0) sw += 360;
        out.push(`<path d="M${f(it.cx + it.r * Math.cos(a1))} ${f(y(it.cy + it.r * Math.sin(a1)))} A${f(it.r)} ${f(it.r)} 0 ${sw > 180 ? 1 : 0} 0 ${f(it.cx + it.r * Math.cos(a2))} ${f(y(it.cy + it.r * Math.sin(a2)))}" ${st(it)}/>`);
      } else if (it.type === 'polyline') out.push(`<polyline points="${it.pts.map((p) => f(p[0]) + ',' + f(y(p[1]))).join(' ')}" ${st(it)}/>`);
      else if (it.type === 'arrow') {
        const [tx, ty] = it.tip, [ux, uy] = it.dir, L = 3, w = 0.55;
        const bx = tx - ux * L, by = ty - uy * L;
        out.push(`<path d="M${f(tx)} ${f(y(ty))} L${f(bx - uy * w)} ${f(y(by + ux * w))} L${f(bx + uy * w)} ${f(y(by - ux * w))} Z" fill="${this.sel && this.sel.id === it.ref && !forExport ? '#1f6fb5' : '#000'}"/>`);
      } else if (it.type === 'image') out.push(`<image href="${it.dataUrl}" x="${f(it.x)}" y="${f(y(it.y + it.h))}" width="${f(it.w)}" height="${f(it.h)}" preserveAspectRatio="none"/>`);
      else if (it.type === 'text') {
        const fs = it.h / cap;
        const lines = String(it.text).split('\n');
        const anchor = it.halign === 'center' ? 'middle' : it.halign === 'right' ? 'end' : 'start';
        const dy0 = it.valign === 'top' ? it.h : it.valign === 'middle' ? it.h / 2 : 0;
        const color = it.ref && this.sel && this.sel.id === it.ref && !forExport ? '#1f6fb5' : '#000';
        lines.forEach((ln, i) => {
          const yy = y(it.y) + dy0 + i * it.h * 1.6;
          out.push(`<text x="${f(it.x)}" y="${f(yy)}" font-size="${f(fs)}" font-family="'${font}', sans-serif" text-anchor="${anchor}" fill="${color}"${it.rot ? ` transform="rotate(${f(-it.rot)} ${f(it.x)} ${f(y(it.y))})"` : ''}>${esc(ln)}</text>`);
        });
      }
    }
    return out.join('');
  }
  render() {
    if (app.mode !== 'drawing' || !this.d || !this.tpl) return;
    const items = this.build();
    const t = this.tpl, v = this.view;
    let overlay = '';
    for (const vw of this.d.views) {
      const r = this.viewRect(vw);
      const selected = this.sel && this.sel.id === vw.id;
      overlay += `<rect x="${f(r[0])}" y="${f(t.height - r[3])}" width="${f(r[2] - r[0])}" height="${f(r[3] - r[1])}" fill="none" stroke="${selected ? '#1f6fb5' : 'none'}" stroke-width="0.3" stroke-dasharray="2 1"/>`;
    }
    if (this.preview) overlay += this.preview;
    this.host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(${v.tx} ${v.ty}) scale(${v.k})"><rect x="0" y="0" width="${t.width}" height="${t.height}" fill="#fff" stroke="#3a4350" stroke-width="${0.6 / v.k}"/>${this.svgBody(items)}${overlay}</g></svg>`;
    buildTree();
  }
  fit() {
    if (!this.tpl) return;
    const r = this.host.getBoundingClientRect();
    const k = Math.min((r.width - 30) / this.tpl.width, (r.height - 30) / this.tpl.height);
    this.view = { k, tx: (r.width - this.tpl.width * k) / 2, ty: (r.height - this.tpl.height * k) / 2 };
    this.render();
  }
  sheetPoint(e) {
    const r = this.host.getBoundingClientRect();
    return [(e.clientX - r.left - this.view.tx) / this.view.k, this.tpl.height - (e.clientY - r.top - this.view.ty) / this.view.k];
  }

  // ------------------------------------------------------------ hit testing
  hitView(p) {
    for (const v of [...this.d.views].reverse()) {
      const r = this.viewRect(v);
      if (p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]) return v;
    }
    return null;
  }
  hitAnnotation(p) {
    const tol = 6 / this.view.k + 1;
    for (const it of [...this.items].reverse()) {
      if (!it.ref) continue;
      if (it.type === 'text') {
        const w = String(it.text).length * it.h * 0.62;
        const x0 = it.halign === 'center' ? it.x - w / 2 : it.x;
        if (p[0] > x0 - tol && p[0] < x0 + w + tol && p[1] > it.y - tol && p[1] < it.y + it.h + tol) return it.ref;
      } else if (it.type === 'line') {
        const dx = it.x2 - it.x1, dy = it.y2 - it.y1, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((p[0] - it.x1) * dx + (p[1] - it.y1) * dy) / L2));
        if (Math.hypot(p[0] - it.x1 - dx * t, p[1] - it.y1 - dy * t) < tol * 0.5) return it.ref;
      }
    }
    return null;
  }
  // nearest model geometry in a view: {kind:'point', p (local)} | {kind:'line', a, b} | {kind:'circle'|'arc', c, r}
  snapGeometry(v, p) {
    const pr = this.projection(v.type), s = this.viewScale(v);
    const q = this.toLocal(v, p), tol = (7 / this.view.k) / s;
    let best = null, bd = tol;
    const pt = (x, y) => {
      const d = Math.hypot(q[0] - x, q[1] - y);
      if (d < bd) {
        bd = d;
        best = { kind: 'point', p: [x, y] };
      }
    };
    for (const e of pr.visible) {
      if (e.type === 'line') pt(e.x1, e.y1), pt(e.x2, e.y2);
      else if (e.type === 'arc') {
        pt(e.cx + e.r * Math.cos((e.a1 * Math.PI) / 180), e.cy + e.r * Math.sin((e.a1 * Math.PI) / 180));
        pt(e.cx + e.r * Math.cos((e.a2 * Math.PI) / 180), e.cy + e.r * Math.sin((e.a2 * Math.PI) / 180));
      }
    }
    if (best) return best;
    bd = tol;
    for (const e of pr.visible) {
      if (e.type === 'line') {
        const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((q[0] - e.x1) * dx + (q[1] - e.y1) * dy) / L2));
        const d = Math.hypot(q[0] - e.x1 - dx * t, q[1] - e.y1 - dy * t);
        if (d < bd) (bd = d), (best = { kind: 'line', a: [e.x1, e.y1], b: [e.x2, e.y2] });
      } else if (e.type === 'circle' || e.type === 'arc') {
        const d = Math.abs(Math.hypot(q[0] - e.cx, q[1] - e.cy) - e.r);
        if (d < bd) (bd = d), (best = { kind: e.type, c: [e.cx, e.cy], r: e.r });
      }
    }
    return best;
  }

  // ------------------------------------------------------------ interaction
  setTool(t) {
    this.tool = t;
    this.clicks = [];
    this.preview = null;
    const hints = { select: 'Drag views, dimensions and notes to move them. Delete removes the selected item. Wheel zooms, drag empty space to pan.', dimension: 'Smart Dimension: click an edge, a circle/arc, or two points in a view, then click to place.', note: 'Note: click where the note should go.', center: 'Center Mark: click a circle or arc.' };
    setHint(hints[t] || '');
    this.host.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.render();
  }
  bind() {
    const h = this.host;
    const ptrs = new Map();
    let drag = null, pinch = null, moved = false, down = null;
    h.addEventListener('contextmenu', (e) => e.preventDefault());
    h.addEventListener('pointerdown', (e) => {
      h.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, e);
      moved = false;
      down = [e.clientX, e.clientY];
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
        drag = null;
        return;
      }
      const p = this.sheetPoint(e);
      if (e.button !== 0 || this.tool !== 'select') {
        drag = { mode: e.button === 0 ? 'tool' : 'pan', x: e.clientX, y: e.clientY };
        return;
      }
      const ann = this.hitAnnotation(p);
      const v = ann ? null : this.hitView(p);
      if (ann) {
        const dm = this.d.dims.find((x) => x.id === ann), n = this.d.notes.find((x) => x.id === ann), cm = this.d.centers.find((x) => x.id === ann);
        this.sel = { id: ann, kind: dm ? 'dim' : n ? 'note' : 'center' };
        drag = { mode: 'ann', obj: dm || n, p0: p, start: dm ? [...dm.pos] : n ? [n.x, n.y] : null };
      } else if (v) {
        this.sel = { id: v.id, kind: 'view' };
        drag = { mode: 'view', obj: v, p0: p, start: [v.x, v.y] };
      } else {
        this.sel = null;
        drag = { mode: 'pan', x: e.clientX, y: e.clientY };
      }
      this.render();
    });
    h.addEventListener('pointermove', (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, e);
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
        this.view.tx += cx - pinch.cx;
        this.view.ty += cy - pinch.cy;
        this.zoomAt(d / Math.max(1, pinch.d), { clientX: cx, clientY: cy });
        pinch = { d, cx, cy };
        moved = true;
        return;
      }
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) moved = true;
      const p = this.sheetPoint(e);
      $('#coords').textContent = `X ${fmt(p[0], 1)}  Y ${fmt(p[1], 1)} mm`;
      if (!drag) {
        if (this.tool === 'dimension' && this.clicks.length) this.dimPreview(p);
        return;
      }
      if (drag.mode === 'pan' || (drag.mode === 'tool' && moved && e.pointerType === 'touch')) {
        this.view.tx += e.clientX - drag.x;
        this.view.ty += e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        this.render();
      } else if (drag.mode === 'view' && moved) {
        drag.obj.x = drag.start[0] + p[0] - drag.p0[0];
        drag.obj.y = drag.start[1] + p[1] - drag.p0[1];
        this.render();
      } else if (drag.mode === 'ann' && moved && drag.obj) {
        const nx = drag.start[0] + p[0] - drag.p0[0], ny = drag.start[1] + p[1] - drag.p0[1];
        if (drag.obj.pos) drag.obj.pos = [nx, ny];
        else (drag.obj.x = nx), (drag.obj.y = ny);
        this.render();
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      const dg = drag;
      drag = null;
      if (!dg) return;
      if (dg.mode === 'tool' && !moved) this.toolClick(this.sheetPoint(e));
      if ((dg.mode === 'view' || dg.mode === 'ann') && moved) this.touch();
    };
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
    h.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.18), e);
    }, { passive: false });
    h.addEventListener('dblclick', async (e) => {
      const p = this.sheetPoint(e);
      const ann = this.hitAnnotation(p);
      const n = this.d.notes.find((x) => x.id === ann), dm = this.d.dims.find((x) => x.id === ann);
      if (n) {
        const t = await promptDlg('Edit Note', 'Text:', n.text);
        if (t !== null) n.text = t;
      } else if (dm) {
        const t = await promptDlg('Dimension Text', 'Override text (leave empty for the measured value). Examples: 2x Ø8, M8, 50 ±0.1', dm.text || '');
        if (t !== null) dm.text = t;
      } else if (this.hitView(p)) return run('drwViewProps');
      this.render();
    });
    window.addEventListener('keydown', (e) => {
      if (app.mode !== 'drawing' || e.target.matches('input, textarea, select') || !$('#modal').hidden) return;
      if (e.key === 'Delete' || e.key === 'Backspace') run('drwDelete');
      if (e.key === 'Escape') this.setTool('select'), buildRibbon();
    });
  }
  zoomAt(fac, e) {
    const r = this.host.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.max(0.2, Math.min(80, this.view.k * fac));
    this.view.tx = mx - ((mx - this.view.tx) * k) / this.view.k;
    this.view.ty = my - ((my - this.view.ty) * k) / this.view.k;
    this.view.k = k;
    this.render();
  }
  dimPreview(p) {
    const dm = this.pendingDim(p);
    if (!dm) return;
    const items = [];
    this.dimItems(dm, items);
    this.preview = `<g opacity=".6">${this.svgBody(items)}</g>`;
    this.render();
  }
  pendingDim(pos) {
    const c = this.clicks;
    if (!c.length) return null;
    const v = c[0].view, a = c[0].g, b = c[1] && c[1].g;
    if (!b) {
      if (a.kind === 'circle') return { id: 'tmp', view: v.id, kind: 'diameter', p1: a.c, r: a.r, pos };
      if (a.kind === 'arc') return { id: 'tmp', view: v.id, kind: 'radius', p1: a.c, r: a.r, pos };
      if (a.kind === 'line') return { id: 'tmp', view: v.id, kind: 'linear', p1: a.a, p2: a.b, orient: this.orientFor(v, a.a, a.b, pos), pos };
      return null;
    }
    const pa = a.kind === 'point' ? a.p : a.kind === 'line' ? a.a : a.c, pb = b.kind === 'point' ? b.p : b.kind === 'line' ? b.a : b.c;
    return { id: 'tmp', view: v.id, kind: 'linear', p1: pa, p2: pb, orient: this.orientFor(v, pa, pb, pos), pos };
  }
  orientFor(v, p1, p2, pos) {
    const a = this.toSheet(v, p1), b = this.toSheet(v, p2);
    const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
    if (dx < 1e-6) return 'v';
    if (dy < 1e-6) return 'h';
    const inX = pos[0] > Math.min(a[0], b[0]) && pos[0] < Math.max(a[0], b[0]), inY = pos[1] > Math.min(a[1], b[1]) && pos[1] < Math.max(a[1], b[1]);
    if (inX && !inY) return 'h';
    if (inY && !inX) return 'v';
    return 'a';
  }
  async toolClick(p) {
    const d = this.d;
    if (this.tool === 'note') {
      const t = await promptDlg('Note', 'Note text:', '');
      if (t) d.notes.push({ id: uid('n'), x: p[0], y: p[1], text: t, h: 3.5 }), this.touch();
      this.setTool('select');
      buildRibbon();
      return;
    }
    const v = this.clicks.length ? this.clicks[0].view : this.hitView(p);
    if (this.tool === 'center') {
      const g = v && this.snapGeometry(v, p);
      if (!g || (g.kind !== 'circle' && g.kind !== 'arc')) return toast('Click a circle or arc in a view.');
      d.centers.push({ id: uid('cm'), view: v.id, p: g.c, r: g.r });
      this.touch();
      return this.render();
    }
    if (this.tool === 'dimension') {
      const c = this.clicks;
      const g = v && this.snapGeometry(v, p);
      const haveEnough = c.length === 2 || (c.length === 1 && c[0].g.kind !== 'point');
      if (c.length && (!g || haveEnough)) {
        if (c.length === 1 && c[0].g.kind === 'point') return toast('Pick a second point, or press Esc.');
        const dm = this.pendingDim(p);
        dm.id = uid('d');
        d.dims.push(dm);
        this.clicks = [];
        this.preview = null;
        this.touch();
        return this.render();
      }
      if (!g) return toast('Click on an edge, circle or endpoint inside a view.');
      c.push({ view: v, g });
      setHint(c.length === 1 && g.kind !== 'point' ? 'Click to place the dimension (or pick a second point first).' : c.length === 1 ? 'Pick the second point.' : 'Click to place the dimension.');
    }
  }

  buildTree(t) {
    const d = this.d;
    t.append(el('div', { class: 'tree-head', html: `${icon('drawing')}<span>${esc(app.doc.name)} – Drawing</span>` }));
    const row = (ic, text, opts = {}) => {
      const r = el('div', { class: 'ti ' + (opts.cls || ''), html: `${icon(ic)}<span>${esc(text)}</span>` });
      if (opts.click) r.addEventListener('click', opts.click);
      if (opts.dbl) r.addEventListener('dblclick', opts.dbl);
      t.append(r);
    };
    if (!d || !this.tpl) return;
    row('template', `Sheet Format: ${this.tpl.name}`, { dbl: () => run('drwTemplate') });
    row('options', `Sheet scale ${scaleText(d.scale)} · ${d.projection === 'first' ? 'First' : 'Third'} angle`, { dbl: () => run('drwTemplate') });
    for (const v of d.views) row('view', `Drawing View: ${VIEWDEF[v.type].label}`, { cls: 'child' + (this.sel && this.sel.id === v.id ? ' sel' : ''), click: () => {
      this.sel = { id: v.id, kind: 'view' };
      this.render();
    }, dbl: () => run('drwViewProps') });
    if (d.dims.length) row('dimension', `Dimensions (${d.dims.length})`);
    if (d.notes.length) row('note', `Notes (${d.notes.length})`);
    t.append(el('div', { class: 'tree-note', html: 'Double-click a view for its properties, a dimension to override its text, a note to edit it. Title-block values come from <b>Title Block</b>.' }));
  }

  // ------------------------------------------------------------ export
  exportSVG() {
    const t = this.tpl;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}mm" height="${t.height}mm" viewBox="0 0 ${t.width} ${t.height}"><rect width="${t.width}" height="${t.height}" fill="#fff"/>${this.svgBody(this.build(), true)}</svg>`;
  }
  exportDXF() {
    const ents = [];
    const lt = (it) => (it.layer === 'HIDDEN' ? 'HIDDEN' : it.layer === 'CENTER' ? 'CENTER' : undefined);
    for (const it of this.build()) {
      const base = { layer: it.layer === 'TITLE' ? 'TEXT' : it.layer, linetype: lt(it) };
      if (it.type === 'line') ents.push({ type: 'line', x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, ...base });
      else if (it.type === 'circle') ents.push({ type: 'circle', cx: it.cx, cy: it.cy, r: it.r, ...base });
      else if (it.type === 'arc') ents.push({ type: 'arc', cx: it.cx, cy: it.cy, r: it.r, a1: it.a1, a2: it.a2, ...base });
      else if (it.type === 'polyline') ents.push({ type: 'polyline', pts: it.pts, closed: false, ...base });
      else if (it.type === 'text') ents.push({ type: 'text', x: it.x, y: it.y, h: it.h, text: it.text, rot: it.rot || 0, halign: it.halign, valign: it.valign, ...base });
      else if (it.type === 'arrow') {
        const [tx, ty] = it.tip, [ux, uy] = it.dir, L = 3, w = 0.55, bx = tx - ux * L, by = ty - uy * L;
        ents.push({ type: 'polyline', pts: [[tx, ty], [bx - uy * w, by + ux * w], [bx + uy * w, by - ux * w]], closed: true, ...base });
      }
    }
    return writeDXF({ entities: ents, layers: { TEMPLATE: { color: 8 }, VISIBLE: { color: 7 }, HIDDEN: { color: 8, linetype: 'HIDDEN' }, CENTER: { color: 1, linetype: 'CENTER' }, DIMENSION: { color: 3 }, TEXT: { color: 7 } }, units: 'mm' });
  }
  async exportPDF() {
    const { jsPDF } = await import('jspdf');
    const t = this.tpl, H = t.height, cap = this.capRatio();
    const pdf = new jsPDF({ orientation: t.width >= t.height ? 'landscape' : 'portrait', unit: 'mm', format: [t.width, t.height], compress: true });
    const fname = this.font(), fo = fonts[fname];
    let fontOK = false;
    if (fo) {
      try {
        const u8 = new Uint8Array(fo.buffer);
        let bin = '';
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        pdf.addFileToVFS('soqua.ttf', btoa(bin));
        pdf.addFont('soqua.ttf', 'soqua', 'normal', undefined, 'Identity-H');
        pdf.setFont('soqua', 'normal');
        fontOK = true;
      } catch (e) {
        console.warn('font embedding failed', e);
      }
    }
    const y = (v) => H - v;
    for (const it of this.build()) {
      pdf.setDrawColor(0);
      pdf.setLineWidth(it.lw || 0.2);
      pdf.setLineDashPattern(it.dash || [], 0);
      pdf.setLineCap('round');
      if (it.type === 'line') pdf.line(it.x1, y(it.y1), it.x2, y(it.y2));
      else if (it.type === 'circle') pdf.circle(it.cx, y(it.cy), it.r, 'S');
      else if (it.type === 'arc' || it.type === 'polyline') {
        let pts = it.pts;
        if (it.type === 'arc') {
          let sw = (it.a2 - it.a1) % 360;
          if (sw <= 0) sw += 360;
          const n = Math.max(6, Math.ceil(sw / 4));
          pts = Array.from({ length: n + 1 }, (_, i) => {
            const a = ((it.a1 + (sw * i) / n) * Math.PI) / 180;
            return [it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a)];
          });
        }
        const segs = [];
        for (let i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], -(pts[i][1] - pts[i - 1][1])]);
        if (segs.length) pdf.lines(segs, pts[0][0], y(pts[0][1]), [1, 1], 'S', false);
      } else if (it.type === 'arrow') {
        const [tx, ty] = it.tip, [ux, uy] = it.dir, L = 3, w = 0.55, bx = tx - ux * L, by = ty - uy * L;
        pdf.setFillColor(0);
        pdf.triangle(tx, y(ty), bx - uy * w, y(by + ux * w), bx + uy * w, y(by - ux * w), 'F');
      } else if (it.type === 'image') {
        try {
          pdf.addImage(it.dataUrl, /png/i.test(it.dataUrl.slice(0, 30)) ? 'PNG' : 'JPEG', it.x, y(it.y + it.h), it.w, it.h);
        } catch (e) {
          /* skip */
        }
      } else if (it.type === 'text') {
        pdf.setFontSize(((it.h / cap) * 72) / 25.4);
        pdf.setTextColor(0);
        const dy0 = it.valign === 'top' ? it.h : it.valign === 'middle' ? it.h / 2 : 0;
        String(it.text).split('\n').forEach((ln, i) => {
          if (!fontOK) ln = ln.replace(/[^\x00-\xff]/g, '?');
          const off = dy0 + i * it.h * 1.6;
          const r = ((it.rot || 0) * Math.PI) / 180;
          // rotate the baseline offset together with the text
          pdf.text(ln, it.x + off * Math.sin(r), y(it.y) + off * Math.cos(r), { align: it.halign === 'center' ? 'center' : it.halign === 'right' ? 'right' : 'left', angle: it.rot || 0 });
        });
      }
    }
    return pdf.output('blob');
  }
}
const f = (x) => +(+x).toFixed(3);

// ---------------------------------------------------------------- commands
function dr() {
  if (!app.drawing) app.drawing = new Drawing();
  return app.drawing;
}
register('toDrawing', async () => {
  if (app.mode === 'drawing') return;
  if (app.sketcher) run('exitSketch');
  if (pmActive()) closePM(false);
  app.mode = 'drawing';
  $('#drawing').hidden = false;
  $('#hud').hidden = true;
  $('#legend').hidden = true;
  for (const b of document.querySelectorAll('#mode-tabs button')) b.classList.toggle('active', b.dataset.mode === 'drawing');
  app.tab = 'Drawing';
  buildRibbon();
  showLeft('tree');
  refreshTitle();
  await dr().open();
  dr().setTool('select');
});
register('toModel', () => {
  if (app.mode === 'model') return;
  app.mode = 'model';
  $('#drawing').hidden = true;
  $('#hud').hidden = false;
  for (const b of document.querySelectorAll('#mode-tabs button')) b.classList.toggle('active', b.dataset.mode === 'model');
  app.tab = 'Features';
  buildRibbon();
  refreshTitle();
  app.vp.setState(app.doc);
  app.vp.resize();
  buildTree();
  setHint('Ready');
});
register('drwTemplate', async () => {
  const D = dr(), d = D.d;
  const idx = await loadIndex();
  const body = el('div', { class: 'pm-group' });
  const sel = el('select');
  for (const t of idx) sel.append(el('option', { value: t.id, text: `${t.name}  (${t.width} × ${t.height} mm)`, selected: t.id === d.template }));
  const sc = el('select');
  for (const s of SCALES) sc.append(el('option', { value: s, text: scaleText(s), selected: Math.abs(s - d.scale) < 1e-9 }));
  const pj = el('select', {}, el('option', { value: 'first', text: 'First angle (ISO / GOST)', selected: d.projection === 'first' }), el('option', { value: 'third', text: 'Third angle (ANSI)', selected: d.projection === 'third' }));
  body.append(el('div', { class: 'fld' }, el('label', { text: 'Sheet format' }), sel), el('div', { class: 'fld' }, el('label', { text: 'Sheet scale' }), sc), el('div', { class: 'fld' }, el('label', { text: 'Projection' }), pj), el('p', { style: { color: '#5d6b7a' }, text: 'Sheet formats were converted from your own SOLIDWORKS .slddrt files. Changing the projection type re-places the standard views the next time you use Standard 3 View.' }));
  const ok = await modal({ title: 'Sheet Properties', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  d.template = sel.value;
  d.scale = +sc.value;
  d.projection = pj.value;
  D.tpl = await loadTemplate(d.template);
  D.touch();
  D.render();
  D.fit();
});
register('drwStandard', () => dr().standardViews());
register('drwView', () => {
  const D = dr();
  if (!app.doc.state.solid) return toast('There is no solid body to make a view from.');
  const r = $('#ribbon').getBoundingClientRect();
  popup(Object.entries(VIEWDEF).map(([k, v]) => ({ label: v.label, icon: 'view', action: () => {
    const t = D.tpl;
    const view = { id: uid('v'), type: k, x: t.width * (0.3 + 0.1 * (D.d.views.length % 4)), y: t.height * 0.72, hidden: k !== 'iso' };
    if (!D.d.views.length) {
      const pr = D.projection(k), w = pr.bb[2] - pr.bb[0], h = pr.bb[3] - pr.bb[1];
      D.d.scale = SCALES.find((s) => w * s < t.width * 0.4 && h * s < t.height * 0.4) || 0.01;
    }
    D.d.views.push(view);
    D.sel = { id: view.id, kind: 'view' };
    D.render();
    toast('View added – drag it into place.');
  } })), r.left + 120, r.bottom);
});
register('drwViewProps', async () => {
  const D = dr();
  const v = D.sel && D.d.views.find((x) => x.id === D.sel.id);
  if (!v) return toast('Select a view first.');
  const body = el('div', { class: 'pm-group' });
  const sc = el('select', {}, el('option', { value: '', text: `Use sheet scale (${scaleText(D.d.scale)})`, selected: !v.scale }));
  for (const s of SCALES) sc.append(el('option', { value: s, text: scaleText(s), selected: v.scale === s }));
  const hid = el('input', { type: 'checkbox', checked: !!v.hidden });
  body.append(el('div', { class: 'fld' }, el('label', { text: 'Scale' }), sc), el('div', { class: 'fld wide' }, el('label', { style: { display: 'flex', gap: '6px' } }, hid, 'Show hidden lines (dashed)')));
  const ok = await modal({ title: `Drawing View – ${VIEWDEF[v.type].label}`, body, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }] });
  if (!ok) return;
  v.scale = sc.value ? +sc.value : null;
  v.hidden = hid.checked;
  D.render();
});
register('drwDimension', () => (dr().setTool('dimension'), buildRibbon()));
register('drwNote', () => (dr().setTool('note'), buildRibbon()));
register('drwCenter', () => (dr().setTool('center'), buildRibbon()));
register('drwDelete', () => {
  const D = dr(), d = D.d, s = D.sel;
  if (!s) return;
  d.views = d.views.filter((x) => x.id !== s.id);
  d.dims = d.dims.filter((x) => x.id !== s.id && d.views.some((v) => v.id === x.view));
  d.centers = d.centers.filter((x) => x.id !== s.id && d.views.some((v) => v.id === x.view));
  d.notes = d.notes.filter((x) => x.id !== s.id);
  D.sel = null;
  D.touch();
  D.render();
});
register('drwPDF', async () => {
  download(await dr().exportPDF(), `${app.doc.name}.pdf`);
  toast('PDF exported (vector, with the drawing font embedded).');
});
register('drwDXF', () => download(new Blob([dr().exportDXF()]), `${app.doc.name}-drawing.dxf`));
register('drwSVG', () => download(new Blob([dr().exportSVG()], { type: 'image/svg+xml' }), `${app.doc.name}-drawing.svg`));
register('drwExportMenu', () => modal({ title: 'Export Drawing', body: '<p>Choose a format for the current sheet.</p>', buttons: [{ label: 'PDF', primary: true, action: () => (run('drwPDF'), true) }, { label: 'DXF', action: () => (run('drwDXF'), true) }, { label: 'SVG', action: () => (run('drwSVG'), true) }, { label: 'Close' }] }));

export { Drawing, loadTemplate, loadIndex };
