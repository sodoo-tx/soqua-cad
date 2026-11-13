// Interactive 2D sketcher that runs inside the 3D viewport on a sketch plane.
import * as THREE from 'three';
import { V, toWorld, toLocal, uid, fmt, circle3, ccwSweep } from '../geom.js';
import { sketchSegments, segPoints } from './profile.js';
import { solveSketch, sketchDOF } from './solver.js';
import { textPolylines, DEFAULT_FONT } from '../fonts.js';
import { el, toast, setHint, promptDlg, popup } from '../ui/ui.js';
import * as K from '../kernel.js';

const COL = { under: 0x1b4fd8, full: 0x101418, cons: 0x6d7a88, sel: 0x00a8f0, hover: 0xff8a00, dim: 0x6b7480, preview: 0x1b4fd8 };
const GLYPH = { horizontal: '—', vertical: '|', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: '⌒', concentric: '◎', coincident: '•', collinear: '⫽', midpoint: '⊢', fix: '⚓', symmetric: '⇔', pointOnLine: '∙', pointOnCircle: '∙' };
const DIMS = ['distance', 'hdistance', 'vdistance', 'length', 'pointLineDistance', 'radius', 'diameter', 'angle'];

export class Sketcher {
  constructor(vp, sketch, plane, opts = {}) {
    this.vp = vp;
    this.sk = sketch;
    this.pl = plane;
    this.onChange = opts.onChange || (() => {});
    this.getSelection3d = opts.getSelection3d || (() => []);
    if (!this.sk.pts.origin) this.sk.pts.origin = { x: 0, y: 0, fixed: true };
    this.sel = new Set();
    this.hover = null;
    this.tool = 'select';
    this.clicks = [];
    this.cursor = [0, 0];
    this.snapInfo = null;
    this.undoStack = [];
    this.group = vp.groups.active;
    this.labelEls = [];
    this.vp.tool = this;
    this.noHover = true;
    this._key = (e) => this.key(e);
    window.addEventListener('keydown', this._key);
    this.vp.onCamera = () => this.updateLabels();
    this.redraw();
  }
  destroy() {
    window.removeEventListener('keydown', this._key);
    this.vp.tool = null;
    this.vp.onCamera = null;
    this.vp.disposeGroup(this.group);
    this.clearLabels();
    this.vp.render();
  }

  // ---------------------------------------------------------------- helpers
  P(id) {
    const p = this.sk.pts[id];
    return [p.x, p.y];
  }
  ent(id) {
    return this.sk.ents.find((e) => e.id === id);
  }
  tol() {
    return this.vp.pxSize() * 9;
  }
  addPt(x, y, extra = {}) {
    const id = uid('p');
    this.sk.pts[id] = { x, y, ...extra };
    return id;
  }
  addEnt(e) {
    e.id = uid('e');
    if (this.constructionMode) e.construction = true;
    this.sk.ents.push(e);
    return e;
  }
  addCon(c) {
    c.id = uid('c');
    this.sk.cons.push(c);
    return c;
  }
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.sk));
    if (this.undoStack.length > 80) this.undoStack.shift();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    const d = JSON.parse(s);
    this.sk.pts = d.pts;
    this.sk.ents = d.ents;
    this.sk.cons = d.cons;
    this.sel.clear();
    this.clicks = [];
    this.changed(false);
    return true;
  }
  solve(opts) {
    try {
      return solveSketch(this.sk, opts);
    } catch (e) {
      console.warn('solver error', e);
      return { ok: false };
    }
  }
  changed(solve = true) {
    if (solve) this.solve();
    this.redraw();
    this.onChange();
  }
  status() {
    let dof = 0;
    try {
      dof = sketchDOF(this.sk);
    } catch (e) {
      dof = 1;
    }
    return { dof, label: dof > 0 ? 'Under Defined' : 'Fully Defined', cls: dof > 0 ? 'under' : 'full' };
  }

  // ---------------------------------------------------------------- snapping & hit testing
  entDist(e, p) {
    const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (e.type === 'line') {
      const a = this.P(e.a), b = this.P(e.b);
      const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return { d: d2(p, q), q, t };
    }
    if (e.type === 'circle') {
      const c = this.P(e.c), dd = d2(p, c) || 1e-9;
      return { d: Math.abs(dd - e.r), q: [c[0] + ((p[0] - c[0]) / dd) * e.r, c[1] + ((p[1] - c[1]) / dd) * e.r] };
    }
    if (e.type === 'arc') {
      const c = this.P(e.c), a = this.P(e.a), b = this.P(e.b);
      const r = d2(a, c), dd = d2(p, c) || 1e-9;
      const a1 = Math.atan2(a[1] - c[1], a[0] - c[0]), sw = ccwSweep(a1, Math.atan2(b[1] - c[1], b[0] - c[0]));
      let t = (Math.atan2(p[1] - c[1], p[0] - c[0]) - a1) % (2 * Math.PI);
      if (t < 0) t += 2 * Math.PI;
      if (t <= sw) return { d: Math.abs(dd - r), q: [c[0] + ((p[0] - c[0]) / dd) * r, c[1] + ((p[1] - c[1]) / dd) * r] };
      return { d: Math.min(d2(p, a), d2(p, b)), q: d2(p, a) < d2(p, b) ? a : b };
    }
    if (e.type === 'spline' || e.type === 'text') {
      const polys = e.type === 'text' ? this.textPolys(e) : [segPoints(sketchSegments({ pts: this.sk.pts, ents: [{ ...e, construction: false }] })[0] || { type: 'line', a: [0, 0], b: [0, 0] })];
      let best = { d: Infinity, q: p };
      for (const poly of polys)
        for (let i = 0; i < poly.length - 1; i++) {
          const a = poly[i], b = poly[i + 1];
          const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1e-12;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
          const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const d = d2(p, q);
          if (d < best.d) best = { d, q };
        }
      return best;
    }
    if (e.type === 'point') return { d: d2(p, this.P(e.p)), q: this.P(e.p) };
    return { d: Infinity, q: p };
  }
  textPolys(e) {
    const p = this.sk.pts[e.p] || { x: 0, y: 0 };
    return textPolylines(e.text || '', e.font || DEFAULT_FONT, e.height || 10, p.x, p.y);
  }
  // what is under p: {kind:'pt', id} | {kind:'ent', id}
  hit(p, { points = true, skipPts = [] } = {}) {
    const tol = this.tol();
    if (points) {
      let best = null, bd = tol;
      for (const [id, q] of Object.entries(this.sk.pts)) {
        if (skipPts.includes(id)) continue;
        const d = Math.hypot(q.x - p[0], q.y - p[1]);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      if (best) return { kind: 'pt', id: best };
    }
    let best = null, bd = tol * 0.8;
    for (const e of this.sk.ents) {
      const r = this.entDist(e, p);
      if (r.d < bd) {
        bd = r.d;
        best = { kind: 'ent', id: e.id, q: r.q };
      }
    }
    return best;
  }
  // snap the cursor for drawing. returns {x, y, pt?, on?, h?, v?}
  snap(p, skipPts = []) {
    const tol = this.tol();
    const h = this.hit(p, { skipPts });
    if (h && h.kind === 'pt') {
      const q = this.sk.pts[h.id];
      return { x: q.x, y: q.y, pt: h.id, kind: 'endpoint' };
    }
    // midpoints
    for (const e of this.sk.ents) {
      if (e.type !== 'line' || skipPts.includes(e.a) || skipPts.includes(e.b)) continue;
      const a = this.P(e.a), b = this.P(e.b);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.hypot(m[0] - p[0], m[1] - p[1]) < tol) return { x: m[0], y: m[1], mid: e.id, kind: 'midpoint' };
    }
    if (h && h.kind === 'ent') {
      const e = this.ent(h.id);
      if (e.type === 'line' || e.type === 'circle' || e.type === 'arc') return { x: h.q[0], y: h.q[1], on: e.id, kind: 'on' };
    }
    const out = { x: p[0], y: p[1] };
    const last = this.clicks.length ? this.clicks[this.clicks.length - 1] : null;
    if (last && ['line', 'centerline'].includes(this.tool)) {
      if (Math.abs(p[1] - last.y) < tol * 0.7) {
        out.y = last.y;
        out.h = true;
        out.kind = 'horizontal';
      } else if (Math.abs(p[0] - last.x) < tol * 0.7) {
        out.x = last.x;
        out.v = true;
        out.kind = 'vertical';
      }
    }
    // align with origin axes
    if (!out.kind) {
      if (Math.abs(p[0]) < tol * 0.5) out.x = 0;
      if (Math.abs(p[1]) < tol * 0.5) out.y = 0;
    }
    return out;
  }
  // make (or reuse) a point for a snap result, adding the implied relation
  pointFor(s) {
    if (s.pt) return s.pt;
    const id = this.addPt(s.x, s.y);
    if (s.on) {
      const e = this.ent(s.on);
      this.addCon(e.type === 'line' ? { type: 'pointOnLine', p: id, line: e.id } : { type: 'pointOnCircle', p: id, ent: e.id });
    } else if (s.mid) this.addCon({ type: 'midpoint', p: id, line: s.mid });
    return id;
  }

  // ---------------------------------------------------------------- pointer events (from viewport)
  setTool(t) {
    this.tool = t;
    this.clicks = [];
    this.preview = null;
    const hints = {
      select: 'Select or drag sketch entities. Double-click a dimension to edit it.', line: 'Line: click start point, then next points. Double-click or Esc to end the chain.',
      centerline: 'Centerline: click two points.', rect: 'Corner rectangle: click two opposite corners.', crect: 'Center rectangle: click the center, then a corner.',
      circle: 'Circle: click the center, then a point on the circle.', arc3: '3-point arc: click start, end, then a point on the arc.', arcc: 'Centerpoint arc: click center, start, then end.',
      polygon: 'Polygon: click the center, then a vertex.', slot: 'Straight slot: click the two centers, then drag out the width.', spline: 'Spline: click through-points; double-click to finish.',
      point: 'Point: click to place.', dimension: 'Smart Dimension: click a line, circle, arc or two points/lines, then click to place the dimension.',
      schamfer: 'Sketch chamfer: click a corner where two lines meet.',
      trim: 'Trim: click the part of an entity you want to remove.', sfillet: 'Sketch fillet: click a corner where two lines meet.', text: 'Text: click where the text starts.',
    };
    setHint(hints[t] || t);
    this.redraw();
  }
  cancelStroke() {
    this.dragging = null;
  }
  down(e) {
    if (e.button !== 0) return false;
    const p = this.vp.planePoint(e, this.pl);
    if (!p) return false;
    this.downAt = [e.clientX, e.clientY];
    this.movedFar = false;
    if (this.tool === 'select') {
      const h = this.hit(p);
      if (!h) return false; // let the viewport rotate
      this.checkpointPending = JSON.stringify(this.sk);
      if (h.kind === 'pt') this.dragging = { kind: 'pt', id: h.id };
      else {
        const en = this.ent(h.id);
        if (en.type === 'circle') this.dragging = { kind: 'circle', id: en.id };
        else if (en.type === 'line') {
          const a = this.P(en.a), b = this.P(en.b);
          this.dragging = { kind: 'line', id: en.id, grab: p, a0: a, b0: b };
        } else if (en.type === 'arc') this.dragging = { kind: 'pt', id: Math.hypot(...V.sub([...this.P(en.a), 0], [...p, 0])) < Math.hypot(...V.sub([...this.P(en.b), 0], [...p, 0])) ? en.a : en.b };
        else if (en.type === 'text' || en.type === 'point') this.dragging = { kind: 'pt', id: en.p };
        else this.dragging = { kind: 'none' };
      }
      this.dragHit = h;
      return true;
    }
    return true;
  }
  move(e) {
    const p = this.vp.planePoint(e, this.pl);
    if (!p) return;
    this.cursor = p;
    if (this.downAt && Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) this.movedFar = true;
    const c = document.getElementById('coords');
    if (c) c.textContent = `X ${fmt(p[0])}  Y ${fmt(p[1])} mm`;
    if (this.tool === 'select') {
      if (this.dragging && this.movedFar && e.buttons) {
        const d = this.dragging;
        if (d.kind === 'pt') this.solve({ drag: { p: d.id, x: p[0], y: p[1] } });
        else if (d.kind === 'circle') {
          const en = this.ent(d.id), cc = this.P(en.c);
          this.solve({ drag: { ent: d.id, r: Math.max(1e-3, Math.hypot(p[0] - cc[0], p[1] - cc[1])) } });
        } else if (d.kind === 'line') {
          const en = this.ent(d.id);
          const dx = p[0] - d.grab[0], dy = p[1] - d.grab[1];
          this.solve({ drag: { p: en.a, x: d.a0[0] + dx, y: d.a0[1] + dy } });
          this.solve({ drag: { p: en.b, x: d.b0[0] + dx, y: d.b0[1] + dy } });
        }
        this.redraw();
        return;
      }
      const h = this.hit(p);
      const key = h ? h.id : null;
      if (key !== this.hover) {
        this.hover = key;
        this.redraw();
      }
      return;
    }
    this.snapInfo = this.snap(p);
    this.redrawPreview();
  }
  up(e) {
    const p = this.vp.planePoint(e, this.pl) || this.cursor;
    if (this.tool === 'select') {
      const d = this.dragging;
      this.dragging = null;
      if (d && this.movedFar) {
        if (this.checkpointPending) this.undoStack.push(this.checkpointPending);
        this.changed(false);
        return;
      }
      const h = this.dragHit;
      if (h) {
        if (!(e.ctrlKey || e.shiftKey || e.metaKey)) this.sel.clear();
        if (this.sel.has(h.id)) this.sel.delete(h.id);
        else this.sel.add(h.id);
        this.redraw();
        this.onChange('selection');
      }
      return;
    }
    this.toolClick(this.snap(p), e);
  }
  // click on empty space while select tool is active (viewport calls this when down() returned false)
  click(e) {
    if (this.tool === 'select') {
      if (this.sel.size) {
        this.sel.clear();
        this.redraw();
        this.onChange('selection');
      }
      return true;
    }
    return true;
  }
  dbl() {
    if (this.tool === 'line' || this.tool === 'spline' || this.tool === 'centerline') this.finishChain();
  }
  key(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (this.clicks.length) this.finishChain();
      else if (this.tool !== 'select') this.setTool('select');
      else if (this.sel.size) {
        this.sel.clear();
        this.redraw();
      }
      this.onChange('tool');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.sel.size) {
        e.preventDefault();
        this.deleteSelection();
      }
    } else if (e.key === 'Enter' && this.clicks.length) this.finishChain();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.undo();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const map = { l: 'line', c: 'circle', r: 'rect', a: 'arc3', d: 'dimension', t: 'trim', s: 'spline', p: 'point' };
      if (map[e.key.toLowerCase()]) {
        this.setTool(map[e.key.toLowerCase()]);
        this.onChange('tool');
      }
    }
  }
  finishChain() {
    if (this.tool === 'spline' && this.clicks.length >= 2) {
      this.checkpoint();
      this.addEnt({ type: 'spline', pts: this.clicks.map((c) => this.pointFor(c)) });
    }
    this.clicks = [];
    this.preview = null;
    this.changed();
  }

  // ---------------------------------------------------------------- drawing tools
  async toolClick(s, e) {
    const t = this.tool, n = this.clicks.length;
    const first = this.clicks[0];
    switch (t) {
      case 'line':
      case 'centerline': {
        if (!n) {
          this.clicks.push({ ...s, pt: this.pointForLater(s) });
          break;
        }
        const prev = this.clicks[n - 1];
        if (Math.hypot(s.x - prev.x, s.y - prev.y) < 1e-6) {
          this.finishChain();
          break;
        }
        this.checkpoint();
        const a = prev.pt || (prev.pt = this.pointFor(prev));
        const b = this.pointFor(s);
        const line = this.addEnt({ type: 'line', a, b });
        if (t === 'centerline') line.construction = true;
        if (s.h) this.addCon({ type: 'horizontal', line: line.id });
        if (s.v) this.addCon({ type: 'vertical', line: line.id });
        this.changed();
        const closedOnExisting = !!s.pt;
        if (t === 'centerline' || closedOnExisting) this.clicks = [];
        else this.clicks = [{ x: this.sk.pts[b].x, y: this.sk.pts[b].y, pt: b }];
        break;
      }
      case 'rect':
      case 'crect': {
        if (!n) {
          this.clicks.push(s);
          break;
        }
        let x1 = first.x, y1 = first.y, x2 = s.x, y2 = s.y;
        if (t === 'crect') {
          x1 = 2 * first.x - s.x;
          y1 = 2 * first.y - s.y;
        }
        if (Math.abs(x2 - x1) < 1e-6 || Math.abs(y2 - y1) < 1e-6) break;
        this.checkpoint();
        const pa = t === 'rect' ? this.pointFor(first) : this.addPt(x1, y1);
        const pb = this.addPt(x2, y1), pc = t === 'rect' ? this.pointFor(s) : this.addPt(x2, y2), pd = this.addPt(x1, y2);
        if (t === 'crect') this.sk.pts[pc].x = x2, (this.sk.pts[pc].y = y2);
        const l1 = this.addEnt({ type: 'line', a: pa, b: pb }), l2 = this.addEnt({ type: 'line', a: pb, b: pc });
        const l3 = this.addEnt({ type: 'line', a: pc, b: pd }), l4 = this.addEnt({ type: 'line', a: pd, b: pa });
        this.addCon({ type: 'horizontal', line: l1.id });
        this.addCon({ type: 'vertical', line: l2.id });
        this.addCon({ type: 'horizontal', line: l3.id });
        this.addCon({ type: 'vertical', line: l4.id });
        if (t === 'crect') {
          const diag = this.addEnt({ type: 'line', a: pa, b: pc, construction: true });
          diag.construction = true;
          this.addCon({ type: 'midpoint', p: this.pointFor(first), line: diag.id });
        }
        this.clicks = [];
        this.changed();
        break;
      }
      case 'circle': {
        if (!n) {
          this.clicks.push(s);
          break;
        }
        const r = Math.hypot(s.x - first.x, s.y - first.y);
        if (r < 1e-6) break;
        this.checkpoint();
        const c = this.pointFor(first);
        const en = this.addEnt({ type: 'circle', c, r });
        if (s.pt) this.addCon({ type: 'pointOnCircle', p: s.pt, ent: en.id });
        this.clicks = [];
        this.changed();
        break;
      }
      case 'arc3': {
        if (n < 2) {
          this.clicks.push(s);
          break;
        }
        const A = [first.x, first.y], B = [this.clicks[1].x, this.clicks[1].y], M = [s.x, s.y];
        const cc = circle3(A, B, M);
        if (!cc) break;
        this.checkpoint();
        const c = this.addPt(cc.c[0], cc.c[1]);
        let a = this.pointFor(first), b = this.pointFor(this.clicks[1]);
        const a1 = Math.atan2(A[1] - cc.c[1], A[0] - cc.c[0]);
        const sweepB = ccwSweep(a1, Math.atan2(B[1] - cc.c[1], B[0] - cc.c[0]));
        const sweepM = ccwSweep(a1, Math.atan2(M[1] - cc.c[1], M[0] - cc.c[0]));
        if (sweepM > sweepB) [a, b] = [b, a];
        this.addEnt({ type: 'arc', c, a, b });
        this.clicks = [];
        this.changed();
        break;
      }
      case 'arcc': {
        if (n < 2) {
          this.clicks.push(s);
          break;
        }
        const C = [first.x, first.y], A = [this.clicks[1].x, this.clicks[1].y];
        const r = Math.hypot(A[0] - C[0], A[1] - C[1]);
        const ang = Math.atan2(s.y - C[1], s.x - C[0]);
        const a1 = Math.atan2(A[1] - C[1], A[0] - C[0]);
        this.checkpoint();
        const c = this.pointFor(first);
        let a = this.pointFor(this.clicks[1]);
        let b = s.pt && Math.abs(Math.hypot(s.x - C[0], s.y - C[1]) - r) < 1e-6 ? s.pt : this.addPt(C[0] + r * Math.cos(ang), C[1] + r * Math.sin(ang));
        if (ccwSweep(a1, ang) > Math.PI) [a, b] = [b, a];
        this.addEnt({ type: 'arc', c, a, b });
        this.clicks = [];
        this.changed();
        break;
      }
      case 'polygon': {
        if (!n) {
          this.clicks.push(s);
          break;
        }
        const sides = Math.max(3, Math.min(40, this.polygonSides || 6));
        const r = Math.hypot(s.x - first.x, s.y - first.y);
        if (r < 1e-6) break;
        this.checkpoint();
        const c = this.pointFor(first);
        const a0 = Math.atan2(s.y - first.y, s.x - first.x);
        const circ = this.addEnt({ type: 'circle', c, r });
        circ.construction = true;
        const ids = [];
        for (let i = 0; i < sides; i++) {
          const id = i === 0 && s.pt ? s.pt : this.addPt(first.x + r * Math.cos(a0 + (i * 2 * Math.PI) / sides), first.y + r * Math.sin(a0 + (i * 2 * Math.PI) / sides));
          ids.push(id);
          this.addCon({ type: 'pointOnCircle', p: id, ent: circ.id });
        }
        const lines = ids.map((id, i) => this.addEnt({ type: 'line', a: id, b: ids[(i + 1) % sides] }));
        lines.forEach((l) => (l.construction = !!this.constructionMode));
        for (let i = 1; i < sides; i++) this.addCon({ type: 'equal', e1: lines[0].id, e2: lines[i].id });
        this.clicks = [];
        this.changed();
        break;
      }
      case 'slot': {
        if (n < 2) {
          this.clicks.push(s);
          break;
        }
        const A = [first.x, first.y], B = [this.clicks[1].x, this.clicks[1].y];
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (L < 1e-6) break;
        const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, nx = -uy, ny = ux;
        const r = Math.abs((s.x - A[0]) * nx + (s.y - A[1]) * ny);
        if (r < 1e-6) break;
        this.checkpoint();
        const c1 = this.pointFor(first), c2 = this.pointFor(this.clicks[1]);
        const p1 = this.addPt(A[0] + nx * r, A[1] + ny * r), p2 = this.addPt(B[0] + nx * r, B[1] + ny * r);
        const p3 = this.addPt(B[0] - nx * r, B[1] - ny * r), p4 = this.addPt(A[0] - nx * r, A[1] - ny * r);
        const l1 = this.addEnt({ type: 'line', a: p1, b: p2 }), l2 = this.addEnt({ type: 'line', a: p3, b: p4 });
        const a1 = this.addEnt({ type: 'arc', c: c2, a: p3, b: p2 }), a2 = this.addEnt({ type: 'arc', c: c1, a: p1, b: p4 });
        const cl = this.addEnt({ type: 'line', a: c1, b: c2 });
        cl.construction = true;
        this.addCon({ type: 'tangent', e1: l1.id, e2: a1.id });
        this.addCon({ type: 'tangent', e1: l2.id, e2: a1.id });
        this.addCon({ type: 'tangent', e1: l1.id, e2: a2.id });
        this.addCon({ type: 'tangent', e1: l2.id, e2: a2.id });
        this.addCon({ type: 'parallel', l1: l1.id, l2: cl.id });
        this.clicks = [];
        this.changed();
        break;
      }
      case 'spline':
        this.clicks.push(s);
        break;
      case 'point': {
        this.checkpoint();
        this.addEnt({ type: 'point', p: this.pointFor(s) });
        this.changed();
        break;
      }
      case 'text': {
        const text = await promptDlg('Sketch Text', 'Text (it will be turned into profiles you can extrude or cut):', 'SOQUA');
        if (!text) break;
        const h = parseFloat(await promptDlg('Sketch Text', 'Text height (mm):', '10')) || 10;
        this.checkpoint();
        this.addEnt({ type: 'text', p: this.addPt(s.x, s.y), text, height: h, font: this.textFont || DEFAULT_FONT });
        this.setTool('select');
        this.changed();
        this.onChange('tool');
        break;
      }
      case 'dimension':
        this.dimensionClick(s);
        break;
      case 'trim':
        this.trimAt([s.x, s.y]);
        break;
      case 'sfillet':
        await this.filletAt(s);
        break;
      case 'schamfer':
        await this.chamferAt(s);
        break;
    }
    this.redrawPreview();
  }
  pointForLater(s) {
    return s.pt || null;
  }

  deleteSelection() {
    this.checkpoint();
    const ids = new Set(this.sel);
    // selected points delete the entities that use them
    for (const e of this.sk.ents) if ([e.a, e.b, e.c, e.p, ...(e.pts || [])].some((p) => ids.has(p))) ids.add(e.id);
    this.sk.ents = this.sk.ents.filter((e) => !ids.has(e.id));
    this.sk.cons = this.sk.cons.filter((c) => !ids.has(c.id));
    this.cleanup();
    this.sel.clear();
    this.changed();
  }
  // drop constraints with dangling refs and points nobody uses
  cleanup() {
    const entIds = new Set(this.sk.ents.map((e) => e.id));
    const used = new Set(['origin']);
    for (const e of this.sk.ents) for (const p of [e.a, e.b, e.c, e.p, ...(e.pts || [])]) if (p) used.add(p);
    this.sk.cons = this.sk.cons.filter((c) => {
      for (const k of ['line', 'ent', 'l1', 'l2', 'e1', 'e2']) if (c[k] && !entIds.has(c[k])) return false;
      for (const k of ['p', 'q']) if (c[k] && !used.has(c[k]) && !this.sk.pts[c[k]]) return false;
      for (const k of ['p', 'q']) if (c[k] && !used.has(c[k])) return false;
      return true;
    });
    for (const id of Object.keys(this.sk.pts)) if (!used.has(id)) delete this.sk.pts[id];
  }
  toggleConstruction() {
    const ents = [...this.sel].map((id) => this.ent(id)).filter(Boolean);
    if (!ents.length) {
      this.constructionMode = !this.constructionMode;
      toast(this.constructionMode ? 'Construction mode ON: new geometry is for reference only' : 'Construction mode OFF');
      return;
    }
    this.checkpoint();
    for (const e of ents) e.construction = !e.construction;
    this.changed(false);
  }

  // ---------------------------------------------------------------- relations
  selectionParts() {
    const ents = [], pts = [];
    for (const id of this.sel) {
      const e = this.ent(id);
      if (e) ents.push(e);
      else if (this.sk.pts[id]) pts.push(id);
    }
    return { ents, pts, lines: ents.filter((e) => e.type === 'line'), rounds: ents.filter((e) => e.type === 'circle' || e.type === 'arc') };
  }
  availableRelations() {
    const { ents, pts, lines, rounds } = this.selectionParts();
    const out = [];
    if (lines.length >= 1 && ents.length === lines.length && !pts.length) out.push('horizontal', 'vertical');
    if (pts.length === 2 && !ents.length) out.push('horizontal', 'vertical', 'coincident');
    if (lines.length === 2 && ents.length === 2 && !pts.length) out.push('parallel', 'perpendicular', 'equal', 'collinear');
    if (lines.length > 2 && ents.length === lines.length) out.push('equal', 'parallel');
    if (rounds.length === 2 && ents.length === 2) out.push('equal', 'concentric', 'tangent');
    if (lines.length === 1 && rounds.length === 1 && ents.length === 2) out.push('tangent');
    if (pts.length === 1 && lines.length === 1 && ents.length === 1) out.push('coincident', 'midpoint');
    if (pts.length === 1 && rounds.length === 1 && ents.length === 1) out.push('coincident');
    if (pts.length === 2 && lines.length === 1 && ents.length === 1) out.push('symmetric');
    if (pts.length || ents.length) out.push('fix');
    return [...new Set(out)];
  }
  addRelation(type) {
    const { ents, pts, lines, rounds } = this.selectionParts();
    this.checkpoint();
    const before = this.sk.cons.length;
    const add = (c) => this.addCon(c);
    if (type === 'horizontal' || type === 'vertical') {
      if (pts.length === 2) add({ type, p: pts[0], q: pts[1] });
      else lines.forEach((l) => add({ type, line: l.id }));
    } else if (type === 'coincident') {
      if (pts.length === 2) add({ type, p: pts[0], q: pts[1] });
      else if (lines.length) add({ type: 'pointOnLine', p: pts[0], line: lines[0].id });
      else add({ type: 'pointOnCircle', p: pts[0], ent: rounds[0].id });
    } else if (type === 'midpoint') add({ type, p: pts[0], line: lines[0].id });
    else if (type === 'parallel' || type === 'perpendicular' || type === 'collinear') for (let i = 1; i < lines.length; i++) add({ type, l1: lines[0].id, l2: lines[i].id });
    else if (type === 'equal') for (let i = 1; i < ents.length; i++) add({ type, e1: ents[0].id, e2: ents[i].id });
    else if (type === 'concentric' || type === 'tangent') add({ type, e1: ents[0].id, e2: ents[1].id });
    else if (type === 'symmetric') add({ type, p: pts[0], q: pts[1], line: lines[0].id });
    else if (type === 'fix') {
      const all = new Set(pts);
      for (const e of ents) for (const p of [e.a, e.b, e.c, e.p, ...(e.pts || [])]) if (p) all.add(p);
      for (const p of all) add({ type: 'fix', p });
    }
    const r = this.solve();
    if (!r.ok) {
      this.sk.cons.length = before;
      this.undoStack.pop();
      this.solve();
      toast('That relation conflicts with existing relations or dimensions (the sketch would be over defined).', true);
    }
    this.changed(false);
  }

  // ---------------------------------------------------------------- dimensions
  dimensionClick(s) {
    const p = [s.x, s.y];
    const picks = this.clicks;
    const h = this.hit(p);
    if (picks.length && (!h || picks.ready)) return this.placeDimension(p);
    if (!h) return;
    picks.push(h);
    const first = picks[0], e1 = first.kind === 'ent' ? this.ent(first.id) : null;
    // decide if we already have enough to place
    if (picks.length === 1) {
      if (e1 && (e1.type === 'line' || e1.type === 'circle' || e1.type === 'arc')) picks.maybe = true; // can place now or pick a second item
    } else picks.ready = true;
    setHint(picks.ready ? 'Click to place the dimension.' : 'Click to place the dimension, or pick a second entity to dimension between.');
  }
  placeDimension(pos) {
    const picks = this.clicks;
    const a = picks[0], b = picks[1];
    const ea = a.kind === 'ent' ? this.ent(a.id) : null, eb = b && b.kind === 'ent' ? this.ent(b.id) : null;
    let con = null;
    const ptDim = (p, q) => {
      const P = this.P(p), Q = this.P(q);
      const lo = [Math.min(P[0], Q[0]), Math.min(P[1], Q[1])], hi = [Math.max(P[0], Q[0]), Math.max(P[1], Q[1])];
      const dx = Math.abs(P[0] - Q[0]), dy = Math.abs(P[1] - Q[1]);
      const inX = pos[0] > lo[0] && pos[0] < hi[0], inY = pos[1] > lo[1] && pos[1] < hi[1];
      if (dx > 1e-6 && dy > 1e-6) {
        if (inX && !inY) return { type: 'hdistance', p, q, value: dx };
        if (inY && !inX) return { type: 'vdistance', p, q, value: dy };
      }
      return { type: 'distance', p, q, value: Math.hypot(dx, dy) };
    };
    if (!b) {
      if (ea && ea.type === 'line') con = ptDim(ea.a, ea.b);
      else if (ea && ea.type === 'circle') con = { type: 'diameter', ent: ea.id, value: ea.r * 2 };
      else if (ea && ea.type === 'arc') con = { type: 'radius', ent: ea.id, value: Math.hypot(...V.sub([...this.P(ea.a), 0], [...this.P(ea.c), 0])) };
    } else {
      const pa = a.kind === 'pt' ? a.id : ea && ea.type !== 'line' ? ea.c || ea.p : null;
      const pb = b.kind === 'pt' ? b.id : eb && eb.type !== 'line' ? eb.c || eb.p : null;
      if (pa && pb) con = ptDim(pa, pb);
      else if (ea && eb && ea.type === 'line' && eb.type === 'line') {
        const d1 = V.sub([...this.P(ea.b), 0], [...this.P(ea.a), 0]), d2 = V.sub([...this.P(eb.b), 0], [...this.P(eb.a), 0]);
        const cross = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / ((V.len(d1) * V.len(d2)) || 1);
        if (cross < 1e-6) con = { type: 'pointLineDistance', p: eb.a, line: ea.id, value: this.entDistInfinite(ea, this.P(eb.a)) };
        else {
          const ang = Math.acos(Math.max(-1, Math.min(1, V.dot(d1, d2) / (V.len(d1) * V.len(d2))))) * (180 / Math.PI);
          con = { type: 'angle', l1: ea.id, l2: eb.id, value: ang };
        }
      } else {
        const line = ea && ea.type === 'line' ? ea : eb;
        const pt = line === ea ? pb : pa;
        if (line && pt) con = { type: 'pointLineDistance', p: pt, line: line.id, value: this.entDistInfinite(line, this.P(pt)) };
      }
    }
    this.clicks = [];
    if (!con || !(con.value > 1e-9)) {
      toast('Those entities cannot be dimensioned together.', true);
      return;
    }
    this.checkpoint();
    con.pos = pos;
    this.addCon(con);
    this.changed();
    this.editDimension(con, true);
  }
  entDistInfinite(line, p) {
    const a = this.P(line.a), b = this.P(line.b);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return Math.abs(((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / L);
  }
  editDimension(con, isNew = false) {
    const lab = this.labelEls.find((l) => l.con === con.id);
    const host = this.vp.labels;
    const pos = this.vp.project(toWorld(this.pl, con.pos));
    const inp = el('input', { class: 'dimedit', type: 'text', value: fmt(con.value, 3), style: { left: pos[0] + 'px', top: pos[1] + 'px', pointerEvents: 'auto' } });
    host.append(inp);
    if (lab) lab.el.style.visibility = 'hidden';
    inp.focus();
    inp.select();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      inp.remove();
      if (apply) {
        let v;
        try {
          v = Function('"use strict";return (' + inp.value.replace(/[^0-9+\-*/().,eE ]/g, '').replace(/,/g, '.') + ')')();
        } catch (e) {
          v = NaN;
        }
        if (Number.isFinite(v) && v > 0 && Math.abs(v - con.value) > 1e-12) {
          const old = con.value, snap = JSON.stringify(this.sk);
          if (!isNew) this.undoStack.push(snap);
          con.value = v;
          const r = this.solve();
          if (!r.ok) {
            con.value = old;
            this.solve();
            toast('The sketch cannot be solved with that value (it conflicts with other dimensions or relations).', true);
          }
        }
      }
      this.changed(false);
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------------------------------------------------------------- trim / fillet / offset / mirror / pattern / convert
  intersections(e) {
    // parameters along e where other entities cross it. line: t in [0,1]; circle/arc: angle
    const out = [];
    const mine = this.shape(e);
    for (const o of this.sk.ents) {
      if (o === e || !['line', 'circle', 'arc'].includes(o.type)) continue;
      for (const p of intersect(mine, this.shape(o))) out.push(p);
    }
    return out;
  }
  shape(e) {
    if (e.type === 'line') return { type: 'line', a: this.P(e.a), b: this.P(e.b) };
    if (e.type === 'circle') return { type: 'circle', c: this.P(e.c), r: e.r };
    const c = this.P(e.c), a = this.P(e.a), b = this.P(e.b);
    const a1 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    return { type: 'arc', c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), a1, sweep: ccwSweep(a1, Math.atan2(b[1] - c[1], b[0] - c[0])) };
  }
  trimAt(p) {
    const h = this.hit(p, { points: false });
    if (!h) return;
    const e = this.ent(h.id);
    if (!['line', 'circle', 'arc'].includes(e.type)) return;
    const pts = this.intersections(e);
    this.checkpoint();
    const dropCons = () => (this.sk.cons = this.sk.cons.filter((c) => ![c.line, c.ent, c.l1, c.l2, c.e1, c.e2].includes(e.id)));
    if (e.type === 'line') {
      const a = this.P(e.a), b = this.P(e.b);
      const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
      const tOf = (q) => ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / L2;
      const ts = pts.map(tOf).filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((x, y) => x - y);
      const tc = tOf(p);
      const lo = Math.max(0, ...ts.filter((t) => t < tc)), hi = Math.min(1, ...ts.filter((t) => t > tc));
      const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      this.sk.ents = this.sk.ents.filter((x) => x !== e);
      dropCons();
      if (lo > 0) this.sk.ents.push({ id: uid('e'), type: 'line', a: e.a, b: this.addPt(...at(lo)), construction: e.construction });
      if (hi < 1) this.sk.ents.push({ id: uid('e'), type: 'line', a: this.addPt(...at(hi)), b: e.b, construction: e.construction });
    } else {
      const sh = this.shape(e);
      const c = sh.c, r = sh.r;
      const angOf = (q) => Math.atan2(q[1] - c[1], q[0] - c[0]);
      const base = e.type === 'arc' ? sh.a1 : angOf(p) + Math.PI; // measure sweeps from here
      const total = e.type === 'arc' ? sh.sweep : 2 * Math.PI;
      const rel = (ang) => {
        let t = (ang - base) % (2 * Math.PI);
        if (t < 0) t += 2 * Math.PI;
        return t;
      };
      const ts = pts.map((q) => rel(angOf(q))).filter((t) => t > 1e-6 && t < total - 1e-6).sort((x, y) => x - y);
      if (e.type === 'circle' && ts.length < 2) {
        this.undoStack.pop();
        toast('Nothing to trim against: the circle needs to cross at least two entities.');
        return;
      }
      const tc = rel(angOf(p));
      const lo = Math.max(0, ...ts.filter((t) => t < tc)), hi = Math.min(total, ...ts.filter((t) => t > tc));
      const at = (t) => [c[0] + r * Math.cos(base + t), c[1] + r * Math.sin(base + t)];
      this.sk.ents = this.sk.ents.filter((x) => x !== e);
      dropCons();
      if (e.type === 'circle') this.sk.ents.push({ id: uid('e'), type: 'arc', c: e.c, a: this.addPt(...at(hi)), b: this.addPt(...at(lo + 2 * Math.PI)), construction: e.construction });
      else {
        if (lo > 0) this.sk.ents.push({ id: uid('e'), type: 'arc', c: e.c, a: e.a, b: this.addPt(...at(lo)), construction: e.construction });
        if (hi < total) this.sk.ents.push({ id: uid('e'), type: 'arc', c: e.c, a: this.addPt(...at(hi)), b: e.b, construction: e.construction });
      }
    }
    this.cleanup();
    this.changed();
  }
  async chamferAt(s) {
    if (!s.pt) return toast('Click the corner point shared by two lines.');
    const lines = this.sk.ents.filter((e) => e.type === 'line' && (e.a === s.pt || e.b === s.pt));
    if (lines.length !== 2) return toast('A sketch chamfer needs a corner where exactly two lines meet.');
    const dist = parseFloat(await promptDlg('Sketch Chamfer', 'Chamfer distance (mm):', String(this.lastChamfer || 5)));
    if (!(dist > 0)) return;
    this.lastChamfer = dist;
    const V0 = this.P(s.pt);
    const other = (l) => this.P(l.a === s.pt ? l.b : l.a);
    const len = (l) => Math.hypot(...sub2(other(l), V0));
    if (dist >= len(lines[0]) || dist >= len(lines[1])) return toast('The distance is too large for this corner.', true);
    this.checkpoint();
    const ids = lines.map((l) => {
      const dir = norm2(sub2(other(l), V0));
      const p = this.addPt(V0[0] + dir[0] * dist, V0[1] + dir[1] * dist);
      if (l.a === s.pt) l.a = p;
      else l.b = p;
      return p;
    });
    const cut = this.addEnt({ type: 'line', a: ids[0], b: ids[1] });
    cut.construction = false;
    this.cleanup();
    this.changed();
  }
  async filletAt(s) {
    if (!s.pt) return toast('Click the corner point shared by two lines.');
    const lines = this.sk.ents.filter((e) => e.type === 'line' && (e.a === s.pt || e.b === s.pt));
    if (lines.length !== 2) return toast('A sketch fillet needs a corner where exactly two lines meet.');
    const r = parseFloat(await promptDlg('Sketch Fillet', 'Fillet radius (mm):', String(this.lastFillet || 5)));
    if (!(r > 0)) return;
    this.lastFillet = r;
    const V0 = this.P(s.pt);
    const other = (l) => this.P(l.a === s.pt ? l.b : l.a);
    const d1 = norm2(sub2(other(lines[0]), V0)), d2 = norm2(sub2(other(lines[1]), V0));
    const cosA = d1[0] * d2[0] + d1[1] * d2[1];
    const half = Math.acos(Math.max(-1, Math.min(1, cosA))) / 2;
    const t = r / Math.tan(half);
    if (!(t > 0) || t > Math.hypot(...sub2(other(lines[0]), V0)) || t > Math.hypot(...sub2(other(lines[1]), V0))) return toast('The radius is too large for this corner.', true);
    this.checkpoint();
    const p1 = this.addPt(V0[0] + d1[0] * t, V0[1] + d1[1] * t), p2 = this.addPt(V0[0] + d2[0] * t, V0[1] + d2[1] * t);
    const bis = norm2([d1[0] + d2[0], d1[1] + d2[1]]);
    const dist = r / Math.sin(half);
    const c = this.addPt(V0[0] + bis[0] * dist, V0[1] + bis[1] * dist);
    for (const [l, p] of [[lines[0], p1], [lines[1], p2]]) {
      if (l.a === s.pt) l.a = p;
      else l.b = p;
    }
    const C = this.P(c);
    const a1 = Math.atan2(this.P(p1)[1] - C[1], this.P(p1)[0] - C[0]), a2 = Math.atan2(this.P(p2)[1] - C[1], this.P(p2)[0] - C[0]);
    const arc = this.addEnt(ccwSweep(a1, a2) < Math.PI ? { type: 'arc', c, a: p1, b: p2 } : { type: 'arc', c, a: p2, b: p1 });
    arc.construction = false;
    this.addCon({ type: 'tangent', e1: lines[0].id, e2: arc.id });
    this.addCon({ type: 'tangent', e1: lines[1].id, e2: arc.id });
    this.addCon({ type: 'radius', ent: arc.id, value: r, pos: [C[0] - bis[0] * r * 0.4, C[1] - bis[1] * r * 0.4] });
    this.cleanup();
    this.changed();
  }
  copyEnts(ents, map) {
    // map: (x,y) -> [x,y]; returns new entities
    const pmap = {};
    const mp = (id) => {
      if (!pmap[id]) {
        const q = map(this.sk.pts[id].x, this.sk.pts[id].y);
        pmap[id] = this.addPt(q[0], q[1]);
      }
      return pmap[id];
    };
    const flip = map.flip;
    const out = [];
    for (const e of ents) {
      const n = { id: uid('e'), type: e.type, construction: e.construction };
      if (e.type === 'line') Object.assign(n, { a: mp(e.a), b: mp(e.b) });
      else if (e.type === 'circle') Object.assign(n, { c: mp(e.c), r: e.r * (map.scale || 1) });
      else if (e.type === 'arc') Object.assign(n, flip ? { c: mp(e.c), a: mp(e.b), b: mp(e.a) } : { c: mp(e.c), a: mp(e.a), b: mp(e.b) });
      else if (e.type === 'spline') n.pts = e.pts.map(mp);
      else if (e.type === 'point') n.p = mp(e.p);
      else continue;
      this.sk.ents.push(n);
      out.push(n);
    }
    return out;
  }
  mirrorSelection() {
    const { ents, lines } = this.selectionParts();
    const axis = lines.find((l) => l.construction) || lines[lines.length - 1];
    const src = ents.filter((e) => e !== axis);
    if (!axis || !src.length) return toast('Select the entities to mirror and a centerline (construction line) to mirror about.');
    const a = this.P(axis.a), b = this.P(axis.b);
    const d = norm2(sub2(b, a));
    const map = (x, y) => {
      const v = [x - a[0], y - a[1]], k = v[0] * d[0] + v[1] * d[1];
      return [a[0] + 2 * k * d[0] - v[0], a[1] + 2 * k * d[1] - v[1]];
    };
    map.flip = true;
    this.checkpoint();
    this.copyEnts(src, map);
    this.changed();
  }
  offsetSelection(dist) {
    const { ents } = this.selectionParts();
    if (!ents.length) return toast('Select entities to offset first.');
    this.checkpoint();
    for (const e of ents) {
      if (e.type === 'circle') this.addEnt({ type: 'circle', c: e.c, r: Math.max(1e-3, e.r + dist) });
      else if (e.type === 'arc') {
        const c = this.P(e.c), a = this.P(e.a), b = this.P(e.b), r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        const k = Math.max(1e-3, r + dist) / r;
        this.addEnt({ type: 'arc', c: e.c, a: this.addPt(c[0] + (a[0] - c[0]) * k, c[1] + (a[1] - c[1]) * k), b: this.addPt(c[0] + (b[0] - c[0]) * k, c[1] + (b[1] - c[1]) * k) });
      }
    }
    // chains of lines: mitred offset
    const lines = ents.filter((e) => e.type === 'line');
    const used = new Set();
    for (const l0 of lines) {
      if (used.has(l0)) continue;
      const chain = [l0];
      used.add(l0);
      let grew = true;
      while (grew) {
        grew = false;
        for (const l of lines) {
          if (used.has(l)) continue;
          const last = chain[chain.length - 1], first = chain[0];
          if (l.a === last.b || l.b === last.b || l.a === last.a || l.b === last.a) {
            chain.push(l);
            used.add(l);
            grew = true;
          } else if (l.a === first.a || l.b === first.a || l.a === first.b || l.b === first.b) {
            chain.unshift(l);
            used.add(l);
            grew = true;
          }
        }
      }
      // ordered vertex list
      let ids = [chain[0].a, chain[0].b];
      if (chain[1] && ![chain[1].a, chain[1].b].includes(ids[1])) ids.reverse();
      for (let i = 1; i < chain.length; i++) ids.push(chain[i].a === ids[ids.length - 1] ? chain[i].b : chain[i].a);
      const closed = ids[0] === ids[ids.length - 1] && ids.length > 3;
      if (closed) ids.pop();
      const P = ids.map((id) => this.P(id));
      const n = P.length;
      const segN = (i) => {
        const a = P[i], b = P[(i + 1) % n];
        const d = norm2(sub2(b, a));
        return [d[1], -d[0]]; // right-hand normal
      };
      const out = [];
      for (let i = 0; i < n; i++) {
        const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
        const n1 = hasPrev ? segN((i - 1 + n) % n) : null, n2 = hasNext ? segN(i) : null;
        let nn;
        if (n1 && n2) {
          const s = [n1[0] + n2[0], n1[1] + n2[1]], k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
          nn = k > 1e-6 ? [s[0] / k, s[1] / k] : n2;
        } else nn = n1 || n2;
        out.push(this.addPt(P[i][0] + nn[0] * dist, P[i][1] + nn[1] * dist));
      }
      for (let i = 0; i < (closed ? n : n - 1); i++) this.addEnt({ type: 'line', a: out[i], b: out[(i + 1) % n] });
    }
    this.changed();
  }
  patternSelection({ kind, count, dx = 0, dy = 0, angle = 360 }) {
    const { ents } = this.selectionParts();
    if (!ents.length) return toast('Select entities to pattern first.');
    this.checkpoint();
    for (let i = 1; i < count; i++) {
      if (kind === 'linear') this.copyEnts(ents, (x, y) => [x + dx * i, y + dy * i]);
      else {
        const a = ((angle / (Math.abs(angle - 360) < 1e-9 ? count : count - 1)) * i * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        this.copyEnts(ents, (x, y) => [x * c - y * s, x * s + y * c]);
      }
    }
    this.changed();
  }
  // project model edges (from the 3D selection) into the sketch as fixed geometry
  convertEntities(hits) {
    const edges = [];
    for (const h of hits) {
      if (h.kind === 'edge') edges.push(h.body.shape.edges[h.index]);
      else if (h.kind === 'face') edges.push(...h.body.shape.faces[h.index].edges);
    }
    if (!edges.length) return toast('Select model faces or edges first, then use Convert Entities.');
    this.checkpoint();
    const L = (v) => {
      const l = toLocal(this.pl, [v.x, v.y, v.z]);
      return [l[0], l[1]];
    };
    const fx = { fixed: true };
    let n = 0;
    for (const e of edges) {
      try {
        const t = e.geomType;
        if (t === 'LINE') {
          const a = L(e.startPoint), b = L(e.endPoint);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;
          this.addEnt({ type: 'line', a: this.addPt(a[0], a[1], fx), b: this.addPt(b[0], b[1], fx) });
        } else if (t === 'CIRCLE') {
          const p = [0, 0.25, 0.5, 1].map((k) => L(e.pointAt(k)));
          const cc = circle3(p[0], p[1], p[2]);
          if (!cc) {
            this.addEnt({ type: 'line', a: this.addPt(p[0][0], p[0][1], fx), b: this.addPt(p[3][0], p[3][1], fx) });
          } else if (e.isClosed) this.addEnt({ type: 'circle', c: this.addPt(cc.c[0], cc.c[1], fx), r: cc.r });
          else {
            const a1 = Math.atan2(p[0][1] - cc.c[1], p[0][0] - cc.c[0]);
            const sm = ccwSweep(a1, Math.atan2(p[2][1] - cc.c[1], p[2][0] - cc.c[0])), se = ccwSweep(a1, Math.atan2(p[3][1] - cc.c[1], p[3][0] - cc.c[0]));
            const A = this.addPt(p[0][0], p[0][1], fx), B = this.addPt(p[3][0], p[3][1], fx);
            this.addEnt({ type: 'arc', c: this.addPt(cc.c[0], cc.c[1], fx), a: sm < se ? A : B, b: sm < se ? B : A });
          }
        } else {
          const ids = [];
          for (let k = 0; k <= 10; k++) {
            const q = L(e.pointAt(k / 10));
            ids.push(this.addPt(q[0], q[1], fx));
          }
          this.addEnt({ type: 'spline', pts: ids });
        }
        n++;
      } catch (err) {
        /* skip */
      }
    }
    this.mergeCoincident();
    this.changed(false);
    toast(`Converted ${n} edge${n === 1 ? '' : 's'} into the sketch.`);
  }
  // merge points that sit on top of each other so contours close
  mergeCoincident(tol = 1e-5) {
    const ids = Object.keys(this.sk.pts);
    const rep = {};
    for (let i = 0; i < ids.length; i++) {
      if (rep[ids[i]]) continue;
      for (let j = i + 1; j < ids.length; j++) {
        if (rep[ids[j]]) continue;
        const a = this.sk.pts[ids[i]], b = this.sk.pts[ids[j]];
        if (Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol) rep[ids[j]] = ids[i];
      }
    }
    const r = (id) => rep[id] || id;
    for (const e of this.sk.ents) {
      for (const k of ['a', 'b', 'c', 'p']) if (e[k]) e[k] = r(e[k]);
      if (e.pts) e.pts = e.pts.map(r);
    }
    for (const c of this.sk.cons) for (const k of ['p', 'q']) if (c[k]) c[k] = r(c[k]);
    for (const id of Object.keys(rep)) delete this.sk.pts[id];
  }

  // ---------------------------------------------------------------- drawing
  clearLabels() {
    for (const l of this.labelEls) l.el.remove();
    this.labelEls = [];
  }
  redraw() {
    const vp = this.vp, g = this.group;
    vp.disposeGroup(g);
    const W = (p) => toWorld(this.pl, p);
    const st = this.status();
    const base = st.dof > 0 ? COL.under : COL.full;
    const buckets = { norm: [], cons: [], sel: [], hov: [], dim: [] };
    const push = (arr, pts) => {
      for (let i = 0; i < pts.length - 1; i++) arr.push(...W(pts[i]), ...W(pts[i + 1]));
    };
    for (const e of this.sk.ents) {
      let polys = [];
      if (e.type === 'text') polys = this.textPolys(e);
      else if (e.type === 'point') continue;
      else {
        const s = sketchSegments({ pts: this.sk.pts, ents: [{ ...e, construction: false }] })[0];
        if (s) polys = [segPoints(s)];
      }
      const arr = this.sel.has(e.id) ? buckets.sel : this.hover === e.id ? buckets.hov : e.construction ? buckets.cons : buckets.norm;
      for (const p of polys) push(arr, p);
    }
    // dimension graphics
    this.clearLabels();
    const dimGeo = (c) => {
      const pos = c.pos || [0, 0];
      const E = (id) => this.ent(id);
      if (['distance', 'hdistance', 'vdistance'].includes(c.type)) {
        const P = this.P(c.p), Q = this.P(c.q);
        let p2, q2;
        if (c.type === 'hdistance') (p2 = [P[0], pos[1]]), (q2 = [Q[0], pos[1]]);
        else if (c.type === 'vdistance') (p2 = [pos[0], P[1]]), (q2 = [pos[0], Q[1]]);
        else {
          const d = norm2(sub2(Q, P)), nrm = [-d[1], d[0]];
          const off = (pos[0] - P[0]) * nrm[0] + (pos[1] - P[1]) * nrm[1];
          p2 = [P[0] + nrm[0] * off, P[1] + nrm[1] * off];
          q2 = [Q[0] + nrm[0] * off, Q[1] + nrm[1] * off];
        }
        push(buckets.dim, [P, p2]);
        push(buckets.dim, [Q, q2]);
        push(buckets.dim, [p2, q2]);
        return [(p2[0] + q2[0]) / 2, (p2[1] + q2[1]) / 2];
      }
      if (c.type === 'radius' || c.type === 'diameter') {
        const e = E(c.ent);
        if (e) push(buckets.dim, [this.P(e.c), pos]);
      } else if (c.type === 'pointLineDistance') {
        const l = E(c.line);
        if (l) {
          const r = this.entDist(l, this.P(c.p));
          const a = this.P(l.a), b = this.P(l.b), P = this.P(c.p);
          const d = norm2(sub2(b, a));
          const k = (P[0] - a[0]) * d[0] + (P[1] - a[1]) * d[1];
          push(buckets.dim, [P, [a[0] + d[0] * k, a[1] + d[1] * k]]);
        }
      }
      return pos;
    };
    for (const c of this.sk.cons) {
      if (!DIMS.includes(c.type)) continue;
      const at = dimGeo(c);
      const pre = c.type === 'diameter' ? 'Ø' : c.type === 'radius' ? 'R' : '';
      const suf = c.type === 'angle' ? '°' : '';
      const d = el('div', { class: 'dimlabel', text: pre + fmt(c.value, 3) + suf, title: 'Double-click to edit, Delete to remove' });
      d.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this.editDimension(c);
      });
      d.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        this.sel.clear();
        this.sel.add(c.id);
        // drag to reposition
        const move = (m) => {
          const q = this.vp.planePoint(m, this.pl);
          if (q) {
            c.pos = q;
            this.redraw();
          }
        };
        const upF = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', upF);
          this.onChange();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', upF);
      });
      if (this.sel.has(c.id)) d.style.outline = '2px solid #00a8f0';
      this.vp.labels.append(d);
      this.labelEls.push({ el: d, p: W(at), con: c.id });
    }
    // relation glyphs
    const seen = {};
    for (const c of this.sk.cons) {
      if (DIMS.includes(c.type) || !GLYPH[c.type]) continue;
      if (c.type === 'pointOnLine' || c.type === 'pointOnCircle' || c.type === 'coincident') continue;
      let at = null;
      const e = this.ent(c.line || c.e1 || c.l1 || c.ent);
      if (e && e.type === 'line') {
        const a = this.P(e.a), b = this.P(e.b);
        at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      } else if (e && e.c) at = this.P(e.c);
      else if (c.p && this.sk.pts[c.p]) at = this.P(c.p);
      if (!at) continue;
      const key = at.map((x) => x.toFixed(3)).join(',');
      seen[key] = (seen[key] || 0) + 1;
      const d = el('div', { class: 'dimlabel', text: GLYPH[c.type], title: c.type + ' (click, then Delete to remove)', style: { background: 'rgba(214,240,214,.9)', color: '#1d6b2a', fontSize: '11px', marginLeft: seen[key] * 14 + 'px', marginTop: '-12px' } });
      d.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        this.sel.clear();
        this.sel.add(c.id);
        this.redraw();
      });
      if (this.sel.has(c.id)) d.style.outline = '2px solid #00a8f0';
      this.vp.labels.append(d);
      this.labelEls.push({ el: d, p: W(at) });
    }
    g.add(vp.fat(buckets.norm, base, 2), vp.fat(buckets.cons, COL.cons, 1.3, true), vp.fat(buckets.dim, COL.dim, 1), vp.fat(buckets.hov, COL.hover, 3), vp.fat(buckets.sel, COL.sel, 3));
    // points
    const pos = [], col = [];
    const cN = new THREE.Color(base), cS = new THREE.Color(COL.sel), cH = new THREE.Color(COL.hover), cO = new THREE.Color(0xd0312d);
    for (const [id, p] of Object.entries(this.sk.pts)) {
      pos.push(...W([p.x, p.y]));
      const c = id === 'origin' ? cO : this.sel.has(id) ? cS : this.hover === id ? cH : cN;
      col.push(c.r, c.g, c.b);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }));
    points.renderOrder = 12;
    g.add(points);
    // sketch plane grid-less outline + axes
    const sz = Math.max(40, this.vp.halfH * 0.9);
    g.add(vp.fat([...W([-sz, 0]), ...W([sz, 0])], 0xd0312d, 0.8), vp.fat([...W([0, -sz]), ...W([0, sz])], 0x2e9e3a, 0.8));
    this.previewObj = null;
    this.redrawPreview();
    this.updateLabels();
    const ss = document.getElementById('sk-status');
    if (ss) {
      ss.textContent = st.label;
      ss.className = st.cls;
    }
    vp.render();
  }
  updateLabels() {
    for (const l of this.labelEls) {
      const s = this.vp.project(l.p);
      l.el.style.left = s[0] + 'px';
      l.el.style.top = s[1] + 'px';
    }
  }
  redrawPreview() {
    if (this.previewObj) {
      this.group.remove(this.previewObj);
      this.previewObj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) this.vp.lineMats.delete(o.material);
      });
      this.previewObj = null;
    }
    const s = this.snapInfo, n = this.clicks.length;
    if (!s || this.tool === 'select') return this.vp.render();
    const W = (p) => toWorld(this.pl, p);
    const arr = [];
    const poly = (pts) => {
      for (let i = 0; i < pts.length - 1; i++) arr.push(...W(pts[i]), ...W(pts[i + 1]));
    };
    const c0 = this.clicks[0], cur = [s.x, s.y];
    const arcPts = (c, r, a1, sw) => Array.from({ length: 41 }, (_, i) => [c[0] + r * Math.cos(a1 + (sw * i) / 40), c[1] + r * Math.sin(a1 + (sw * i) / 40)]);
    if (n) {
      const f = [c0.x, c0.y];
      const t = this.tool;
      if (t === 'line' || t === 'centerline') poly([[this.clicks[n - 1].x, this.clicks[n - 1].y], cur]);
      else if (t === 'rect') poly([f, [cur[0], f[1]], cur, [f[0], cur[1]], f]);
      else if (t === 'crect') {
        const o = [2 * f[0] - cur[0], 2 * f[1] - cur[1]];
        poly([o, [cur[0], o[1]], cur, [o[0], cur[1]], o]);
      } else if (t === 'circle' || t === 'polygon') {
        const r = Math.hypot(cur[0] - f[0], cur[1] - f[1]);
        if (t === 'circle') poly(arcPts(f, r, 0, Math.PI * 2));
        else {
          const sides = this.polygonSides || 6, a0 = Math.atan2(cur[1] - f[1], cur[0] - f[0]);
          poly(Array.from({ length: sides + 1 }, (_, i) => [f[0] + r * Math.cos(a0 + (i * 2 * Math.PI) / sides), f[1] + r * Math.sin(a0 + (i * 2 * Math.PI) / sides)]));
        }
      } else if (t === 'arc3') {
        if (n === 1) poly([f, cur]);
        else {
          const B = [this.clicks[1].x, this.clicks[1].y], cc = circle3(f, B, cur);
          if (cc) {
            const a1 = Math.atan2(f[1] - cc.c[1], f[0] - cc.c[0]);
            const sB = ccwSweep(a1, Math.atan2(B[1] - cc.c[1], B[0] - cc.c[0])), sM = ccwSweep(a1, Math.atan2(cur[1] - cc.c[1], cur[0] - cc.c[0]));
            poly(sM < sB ? arcPts(cc.c, cc.r, a1, sB) : arcPts(cc.c, cc.r, a1 + sB, 2 * Math.PI - sB));
          }
        }
      } else if (t === 'arcc') {
        if (n === 1) poly([f, cur]);
        else {
          const A = [this.clicks[1].x, this.clicks[1].y], r = Math.hypot(A[0] - f[0], A[1] - f[1]);
          const a1 = Math.atan2(A[1] - f[1], A[0] - f[0]), sw = ccwSweep(a1, Math.atan2(cur[1] - f[1], cur[0] - f[0]));
          poly(sw > Math.PI ? arcPts(f, r, a1 + sw, 2 * Math.PI - sw) : arcPts(f, r, a1, sw));
        }
      } else if (t === 'slot') {
        if (n === 1) poly([f, cur]);
        else {
          const B = [this.clicks[1].x, this.clicks[1].y], L = Math.hypot(B[0] - f[0], B[1] - f[1]) || 1;
          const u = [(B[0] - f[0]) / L, (B[1] - f[1]) / L], nn = [-u[1], u[0]];
          const r = Math.abs((cur[0] - f[0]) * nn[0] + (cur[1] - f[1]) * nn[1]);
          const ang = Math.atan2(u[1], u[0]);
          poly([...arcPts(B, r, ang - Math.PI / 2, Math.PI), ...arcPts(f, r, ang + Math.PI / 2, Math.PI), [B[0] - nn[0] * r, B[1] - nn[1] * r]]);
        }
      } else if (t === 'spline') poly([...this.clicks.map((c) => [c.x, c.y]), cur]);
    }
    const grp = new THREE.Group();
    grp.add(this.vp.fat(arr, COL.preview, 1.6));
    // snap marker
    const m = this.vp.pxSize() * 5;
    const mk = [];
    if (s.kind) {
      mk.push(...W([s.x - m, s.y - m]), ...W([s.x + m, s.y - m]), ...W([s.x + m, s.y - m]), ...W([s.x + m, s.y + m]), ...W([s.x + m, s.y + m]), ...W([s.x - m, s.y + m]), ...W([s.x - m, s.y + m]), ...W([s.x - m, s.y - m]));
    }
    grp.add(this.vp.fat(mk, 0xf0a000, 1.5));
    this.previewObj = grp;
    this.group.add(grp);
    this.vp.render();
  }
}

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const norm2 = (a) => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};

// intersection points between two primitive shapes (line segment / circle / arc)
function intersect(A, B) {
  const out = [];
  const onArc = (s, p) => {
    if (s.type !== 'arc') return true;
    let t = (Math.atan2(p[1] - s.c[1], p[0] - s.c[0]) - s.a1) % (2 * Math.PI);
    if (t < 0) t += 2 * Math.PI;
    return t <= s.sweep + 1e-9;
  };
  const onSeg = (s, p) => {
    if (s.type !== 'line') return onArc(s, p);
    const L2 = (s.b[0] - s.a[0]) ** 2 + (s.b[1] - s.a[1]) ** 2 || 1e-12;
    const t = ((p[0] - s.a[0]) * (s.b[0] - s.a[0]) + (p[1] - s.a[1]) * (s.b[1] - s.a[1])) / L2;
    return t >= -1e-9 && t <= 1 + 1e-9;
  };
  if (A.type === 'line' && B.type === 'line') {
    const d1 = sub2(A.b, A.a), d2 = sub2(B.b, B.a);
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-12) return out;
    const w = sub2(B.a, A.a);
    const t = (w[0] * d2[1] - w[1] * d2[0]) / den, u = (w[0] * d1[1] - w[1] * d1[0]) / den;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push([A.a[0] + d1[0] * t, A.a[1] + d1[1] * t]);
    return out;
  }
  if (A.type === 'line' || B.type === 'line') {
    const L = A.type === 'line' ? A : B, C = A.type === 'line' ? B : A;
    const d = sub2(L.b, L.a), f = sub2(L.a, C.c);
    const a = d[0] * d[0] + d[1] * d[1], b = 2 * (f[0] * d[0] + f[1] * d[1]), c = f[0] * f[0] + f[1] * f[1] - C.r * C.r;
    const disc = b * b - 4 * a * c;
    if (disc < 0 || a < 1e-12) return out;
    for (const sgn of [-1, 1]) {
      const t = (-b + sgn * Math.sqrt(disc)) / (2 * a);
      const p = [L.a[0] + d[0] * t, L.a[1] + d[1] * t];
      if (t >= -1e-9 && t <= 1 + 1e-9 && onArc(C, p)) out.push(p);
    }
    return out;
  }
  const d = Math.hypot(B.c[0] - A.c[0], B.c[1] - A.c[1]);
  if (d < 1e-9 || d > A.r + B.r || d < Math.abs(A.r - B.r)) return out;
  const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, A.r * A.r - a * a));
  const m = [A.c[0] + ((B.c[0] - A.c[0]) * a) / d, A.c[1] + ((B.c[1] - A.c[1]) * a) / d];
  for (const sgn of [-1, 1]) {
    const p = [m[0] + (sgn * h * (B.c[1] - A.c[1])) / d, m[1] - (sgn * h * (B.c[0] - A.c[0])) / d];
    if (onSeg(A, p) && onSeg(B, p)) out.push(p);
  }
  return out;
}
