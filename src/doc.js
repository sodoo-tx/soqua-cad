// Parametric document: an ordered feature list (the FeatureManager tree) that is replayed
// through the kernel to produce bodies. Everything in `features` is plain JSON so documents
// save/load/undo trivially.
import * as K from './kernel.js';
import { V, BASE_PLANES, toWorld, toLocal, planeY, uid, offsetPlane } from './geom.js';
import { evalSketchProfile, sketchSegments, findLoops } from './sketch/profile.js';
import { buildStructuralMembers } from './features/weldments.js';
import { buildEdgeFlange } from './features/sheetmetal.js';

export const FEATURE_LABELS = {
  sketch: 'Sketch', sketch3d: '3DSketch', plane: 'Plane', extrude: 'Boss-Extrude', revolve: 'Revolve', sweep: 'Sweep', loft: 'Loft',
  fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', draft: 'Draft', hole: 'Hole', linearPattern: 'LPattern',
  circularPattern: 'CirPattern', mirror: 'Mirror', scale: 'Scale', moveBody: 'Body-Move/Copy', import: 'Imported',
  surfExtrude: 'Surface-Extrude', surfRevolve: 'Surface-Revolve', surfPlanar: 'Surface-Plane', surfLoft: 'Surface-Loft',
  surfSweep: 'Surface-Sweep', surfOffset: 'Surface-Offset', thicken: 'Thicken', knit: 'Surface-Knit', deleteBody: 'Body-Delete',
  baseFlange: 'Base-Flange', edgeFlange: 'Edge-Flange', structuralMember: 'Structural Member', mesh: 'Mesh', rib: 'Rib', text: 'Text',
  primitive: 'Primitive', combine: 'Combine',
};

export function emptySketch() {
  return { pts: {}, ents: [], cons: [] };
}

export class Document {
  constructor() {
    this.name = 'Part1';
    this.features = [];
    this.rollback = null; // feature id after which the rollback bar sits (null = end)
    this.material = 'Plain Carbon Steel';
    this.appearance = { color: '#aeb6bf', preset: 'Brushed steel', faces: {} };
    this.sheetMetal = null;
    this.drawing = null;
    this.custom = { title: '', drawnBy: '', checkedBy: '', customer: '', material: '' };
    this.blobs = {}; // large binary payloads (meshes) keyed by id, kept out of undo snapshots
    this.state = emptyState();
    this._cache = [];
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this._counters = {};
  }

  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  emit(what = 'change') {
    for (const fn of this._listeners) fn(what);
  }

  nextName(type, params) {
    let base = FEATURE_LABELS[type] || type;
    if (params && params.op === 'cut') base = { extrude: 'Cut-Extrude', revolve: 'Cut-Revolve', sweep: 'Cut-Sweep', loft: 'Cut-Loft' }[type] || base;
    let n = 1;
    const used = new Set(this.features.map((f) => f.name));
    while (used.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  get(id) {
    return this.features.find((f) => f.id === id);
  }
  indexOf(id) {
    return this.features.findIndex((f) => f.id === id);
  }

  // ---- editing (each call is one undo step)
  snapshot() {
    return JSON.stringify({ name: this.name, features: this.features, rollback: this.rollback, material: this.material, appearance: this.appearance, drawing: this.drawing, custom: this.custom });
  }
  restore(json) {
    const d = JSON.parse(json);
    this.name = d.name;
    this.features = d.features;
    this.rollback = d.rollback ?? null;
    this.material = d.material || this.material;
    this.appearance = d.appearance || this.appearance;
    this.drawing = d.drawing || null;
    this.custom = d.custom || this.custom;
  }
  checkpoint() {
    this._undo.push(this.snapshot());
    if (this._undo.length > 60) this._undo.shift();
    this._redo.length = 0;
  }
  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this.snapshot());
    this.restore(this._undo.pop());
    this.rebuild();
    return true;
  }
  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this.snapshot());
    this.restore(this._redo.pop());
    this.rebuild();
    return true;
  }

  addFeature(type, params, opts = {}) {
    this.checkpoint();
    const f = { id: uid('f'), type, name: opts.name || this.nextName(type, params), suppressed: false, params };
    let at = this.features.length;
    if (this.rollback) at = this.indexOf(this.rollback) + 1;
    this.features.splice(at, 0, f);
    if (this.rollback) this.rollback = f.id;
    if (!opts.silent) this.rebuild();
    return f;
  }
  updateFeature(id, params, { checkpoint = true } = {}) {
    const f = this.get(id);
    if (!f) return;
    if (checkpoint) this.checkpoint();
    f.params = params;
    this.rebuild();
  }
  removeFeature(id) {
    const f = this.get(id);
    if (!f) return;
    this.checkpoint();
    // also drop features that directly consume it (sketch -> extrude keeps the sketch, the reverse deletes children)
    const dead = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of this.features) {
        if (dead.has(g.id)) continue;
        if (featureRefs(g).some((r) => dead.has(r))) {
          dead.add(g.id);
          grew = true;
        }
      }
    }
    if (this.rollback && dead.has(this.rollback)) this.rollback = null;
    this.features = this.features.filter((g) => !dead.has(g.id));
    this.rebuild();
  }
  setSuppressed(id, v) {
    const f = this.get(id);
    if (!f) return;
    this.checkpoint();
    f.suppressed = v;
    this.rebuild();
  }
  rename(id, name) {
    const f = this.get(id);
    if (f && name) {
      this.checkpoint();
      f.name = name;
      this.emit('tree');
    }
  }
  setRollback(id) {
    this.rollback = id;
    this.rebuild();
  }
  moveFeature(id, toIndex) {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.checkpoint();
    const [f] = this.features.splice(i, 1);
    this.features.splice(Math.max(0, Math.min(this.features.length, toIndex)), 0, f);
    this.rebuild();
  }

  // ---- persistence
  serialize() {
    const blobs = {};
    for (const [k, v] of Object.entries(this.blobs)) blobs[k] = { positions: b64(v.positions), indices: v.indices ? b64(v.indices) : null, colors: v.colors ? b64(v.colors) : null };
    return JSON.stringify({ app: 'SOQUA design', version: 1, doc: JSON.parse(this.snapshot()), blobs });
  }
  static deserialize(text) {
    const j = JSON.parse(text);
    if (!j.doc) throw new Error('Not a SOQUA design document');
    const d = new Document();
    d.restore(JSON.stringify(j.doc));
    for (const [k, v] of Object.entries(j.blobs || {})) {
      d.blobs[k] = { positions: new Float32Array(unb64(v.positions)), indices: v.indices ? new Uint32Array(unb64(v.indices)) : null, colors: v.colors ? new Float32Array(unb64(v.colors)) : null };
    }
    return d;
  }

  // ---- regeneration
  rebuild() {
    const st = emptyState();
    let end = this.features.length;
    if (this.rollback) end = this.indexOf(this.rollback) + 1;
    let key = '';
    const cache = [];
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      f.rolledBack = i >= end;
      if (f.rolledBack) {
        delete f.error;
        continue;
      }
      key += '|' + JSON.stringify([f.id, f.type, f.suppressed, f.params]);
      const hit = this._cache[i];
      if (hit && hit.key === key) {
        copyState(hit.state, st);
        f.error = hit.error;
        cache[i] = hit;
        continue;
      }
      delete f.error;
      if (!f.suppressed) {
        try {
          runFeature(this, f, st);
        } catch (e) {
          f.error = friendly(e);
          console.warn(`Feature ${f.name} failed:`, e);
        }
      }
      cache[i] = { key, state: copyState(st, emptyState()), error: f.error };
    }
    this._cache = cache;
    this.state = st;
    this.emit('rebuild');
    return st;
  }
}

function friendly(e) {
  const m = e && e.message ? e.message : String(e);
  if (/WebAssembly|Exception|\[object/.test(m) || /^\d+$/.test(m)) return 'The geometry kernel could not build this feature with the current inputs.';
  return m;
}

function b64(arr) {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

export function emptyState() {
  return { solid: null, surfaces: [], meshes: [], sketches: {}, planes: {}, tools: {}, cutlist: [], sheetMetal: null, flanges: [] };
}
function copyState(a, b) {
  b.solid = a.solid;
  b.surfaces = [...a.surfaces];
  b.meshes = [...a.meshes];
  b.sketches = { ...a.sketches };
  b.planes = { ...a.planes };
  b.tools = { ...a.tools };
  b.cutlist = [...a.cutlist];
  b.sheetMetal = a.sheetMetal;
  b.flanges = [...a.flanges];
  return b;
}

// ids of features this feature depends on
export function featureRefs(f) {
  const p = f.params || {};
  const out = [];
  for (const k of ['sketch', 'profile', 'path', 'surface']) if (typeof p[k] === 'string') out.push(p[k]);
  for (const k of ['profiles', 'features', 'surfaces']) if (Array.isArray(p[k])) out.push(...p[k]);
  if (p.plane && p.plane.type === 'feature') out.push(p.plane.id);
  if (p.base && p.base.type === 'feature') out.push(p.base.id);
  return out;
}

// ---------------------------------------------------------------- plane resolution

export function resolvePlane(spec, st) {
  if (!spec) return BASE_PLANES.Front;
  if (spec.type === 'base') return BASE_PLANES[spec.name] || BASE_PLANES.Front;
  if (spec.type === 'feature') {
    const pl = st.planes[spec.id];
    if (!pl) throw new Error('The reference plane is missing');
    return pl;
  }
  if (spec.type === 'face') {
    // captured plane, re-seated onto the matching model face so the sketch follows the face when it moves
    const pl = { o: [...spec.plane.o], x: [...spec.plane.x], n: [...spec.plane.n] };
    if (st.solid && spec.sig) {
      const [f] = K.matchFaces(st.solid, [spec.sig]);
      if (f && f.geomType === 'PLANE') {
        const c = f.center;
        const d = V.dot(V.sub([c.x, c.y, c.z], pl.o), pl.n);
        pl.o = V.add(pl.o, V.mul(pl.n, d));
      }
    }
    return pl;
  }
  if (spec.type === 'fixed') return spec.plane;
  return BASE_PLANES.Front;
}

function sketchOf(st, id, what = 'sketch') {
  const s = st.sketches[id];
  if (!s) throw new Error(`The ${what} is missing or failed to rebuild`);
  return s;
}

function sketchFaces(s) {
  const faces = s.profile.regions.map((r) => K.regionFace(r, s.plane));
  if (s.textFaces) faces.push(...s.textFaces());
  return faces;
}

function requireFaces(s) {
  const faces = sketchFaces(s);
  if (!faces.length) throw new Error('The sketch has no closed contour. Close the profile (endpoints must meet) and try again.');
  return faces;
}

function bboxDiag(st, extra = 0) {
  if (!st.solid) return 1000 + extra;
  const b = K.bbox(st.solid);
  return V.dist(b.min, b.max) * 2 + 10 + extra;
}

// decide the default cut direction: into the material
function cutDir(st, pl) {
  if (!st.solid) return V.neg(pl.n);
  const b = K.bbox(st.solid);
  const c = V.lerp(b.min, b.max, 0.5);
  return V.dot(V.sub(c, pl.o), pl.n) > 1e-6 ? pl.n : V.neg(pl.n);
}

function extrusionSpan(st, s, p, isCut) {
  // returns {start: offset vector, vec: extrusion vector}
  let dir = isCut ? cutDir(st, s.plane) : s.plane.n;
  if (p.flip) dir = V.neg(dir);
  const through = bboxDiag(st);
  const d = Math.max(1e-6, +p.depth || 0);
  switch (p.end) {
    case 'mid':
      return { start: V.mul(dir, -d / 2), vec: V.mul(dir, d) };
    case 'through':
      return { start: [0, 0, 0], vec: V.mul(dir, through) };
    case 'throughBoth':
      return { start: V.mul(dir, -through), vec: V.mul(dir, through * 2) };
    case 'twoDir':
      return { start: V.mul(dir, -(+p.depth2 || 0)), vec: V.mul(dir, d + (+p.depth2 || 0)) };
    default:
      return { start: [0, 0, 0], vec: V.mul(dir, d) };
  }
}

function setSolid(st, f, tool, op) {
  st.solid = K.applyOp(st.solid, tool, op);
  st.tools[f.id] = { tool, op };
}

function revolveAxis(s, p) {
  const sk = s.sketch;
  let ent = p.axis && sk.ents.find((e) => e.id === p.axis);
  if (!ent) ent = sk.ents.find((e) => e.type === 'line' && e.construction);
  if (!ent) throw new Error('Add a centerline (construction line) to the sketch to revolve around, or pick an axis line.');
  const a = sk.pts[ent.a], b = sk.pts[ent.b];
  const o = toWorld(s.plane, [a.x, a.y]);
  const d = V.norm(V.sub(toWorld(s.plane, [b.x, b.y]), o));
  return { o, d };
}

function pathWire(st, id) {
  const s = sketchOf(st, id, 'path sketch');
  if (s.kind === '3d') {
    if (!s.chains.length) throw new Error('The 3D sketch has no connected path');
    return K.polylineWire(s.chains[0].pts, s.chains[0].closed);
  }
  if (s.profile.open.length) return K.chainToWire(s.profile.open[0], s.plane);
  if (s.profile.loops.length) return K.chainToWire(s.profile.loops[0], s.plane);
  throw new Error('The path sketch is empty');
}

function profileWire(st, id) {
  const s = sketchOf(st, id, 'profile sketch');
  if (s.profile.loops.length) return K.chainToWire(s.profile.regions[0].outer, s.plane, true);
  if (s.profile.open.length) return K.chainToWire(s.profile.open[0], s.plane);
  throw new Error('A profile sketch is empty');
}

function anyWires(s) {
  const out = [];
  for (const l of s.profile.loops) out.push(K.chainToWire(l, s.plane));
  for (const o of s.profile.open) out.push(K.chainToWire(o, s.plane));
  if (!out.length) throw new Error('The sketch is empty');
  return out;
}

function transformsFor(f, st) {
  const p = f.params;
  const list = [];
  if (f.type === 'linearPattern') {
    const d1 = V.norm(p.dir || [1, 0, 0]);
    const d2 = V.norm(p.dir2 || [0, 1, 0]);
    const n1 = Math.max(1, p.count | 0), n2 = Math.max(1, p.count2 | 0 || 1);
    for (let i = 0; i < n1; i++)
      for (let j = 0; j < n2; j++) {
        if (!i && !j) continue;
        list.push({ translate: V.add(V.mul(d1, i * (+p.spacing || 0)), V.mul(d2, j * (+p.spacing2 || 0))) });
      }
  } else if (f.type === 'circularPattern') {
    const n = Math.max(1, p.count | 0);
    const total = +p.angle || 360;
    const step = Math.abs(total - 360) < 1e-9 ? 360 / n : total / Math.max(1, n - 1);
    for (let i = 1; i < n; i++) list.push({ rotate: { angle: step * i, origin: p.axisO || [0, 0, 0], axis: V.norm(p.axisD || [0, 1, 0]) } });
  } else if (f.type === 'mirror') {
    const pl = resolvePlane(p.plane, st);
    list.push({ mirror: { normal: pl.n, origin: pl.o } });
  }
  return list;
}

// ---------------------------------------------------------------- feature handlers

function runFeature(doc, f, st) {
  const p = f.params;
  switch (f.type) {
    case 'sketch': {
      const plane = resolvePlane(p.plane, st);
      const profile = evalSketchProfile(p.sketch);
      const s = { kind: '2d', plane, profile, sketch: p.sketch };
      const texts = p.sketch.ents.filter((e) => e.type === 'text' && e.text);
      if (texts.length) {
        s.textFaces = () => {
          const out = [];
          for (const t of texts) {
            const pt = p.sketch.pts[t.p] || { x: 0, y: 0 };
            out.push(...K.textFaces(t.text, plane, { size: t.height || 10, family: t.font || undefined, x: pt.x, y: pt.y }));
          }
          return out;
        };
      }
      st.sketches[f.id] = s;
      break;
    }
    case 'sketch3d': {
      const pts = p.pts || [];
      const segs = (p.lines || []).filter(([i, j]) => pts[i] && pts[j]).map(([i, j]) => ({ a: pts[i], b: pts[j] }));
      st.sketches[f.id] = { kind: '3d', pts, segs, chains: chain3d(pts, p.lines || []) };
      break;
    }
    case 'plane': {
      const base = resolvePlane(p.base, st);
      let pl = offsetPlane(base, +p.offset || 0);
      if (p.angle) {
        const ax = p.about === 'y' ? planeY(base) : base.x;
        const ang = (p.angle * Math.PI) / 180;
        pl = { o: pl.o, x: V.rot(pl.x, ax, ang), n: V.rot(pl.n, ax, ang) };
      }
      if (p.flip) pl = { o: pl.o, x: V.neg(pl.x), n: V.neg(pl.n) };
      st.planes[f.id] = pl;
      break;
    }
    case 'extrude': {
      const s = sketchOf(st, p.sketch);
      const isCut = p.op === 'cut';
      const { start, vec } = extrusionSpan(st, s, p, isCut);
      let faces;
      if (p.thin && +p.thin > 0 && !s.profile.regions.length) faces = thinFaces(s, +p.thin);
      else faces = requireFaces(s);
      let tool = K.extrudeFaces(faces, vec);
      if (V.len(start) > 0) tool = tool.translate(start);
      if (p.draft && Math.abs(+p.draft) > 1e-6) tool = draftTool(tool, s.plane, +p.draft, vec);
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'revolve': {
      const s = sketchOf(st, p.sketch);
      const { o, d } = revolveAxis(s, p);
      const tool = K.revolveFaces(requireFaces(s), o, d, Math.min(360, Math.max(0.01, +p.angle || 360)));
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'sweep': {
      const s = sketchOf(st, p.profile, 'profile sketch');
      const spine = pathWire(st, p.path);
      const faces = requireFaces(s);
      const tool = K.fuseAll(faces.map((fc) => K.sweepProfile(fc, spine)));
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'loft': {
      if (!p.profiles || p.profiles.length < 2) throw new Error('Select at least two profile sketches');
      const wires = p.profiles.map((id) => profileWire(st, id));
      const tool = K.loftWires(wires, { ruled: !!p.ruled });
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'fillet':
      needSolid(st);
      st.solid = K.filletEdges(st.solid, p.edges || [], +p.radius);
      break;
    case 'chamfer':
      needSolid(st);
      st.solid = K.chamferEdges(st.solid, p.edges || [], +p.distance);
      break;
    case 'shell':
      needSolid(st);
      st.solid = K.shellFaces(st.solid, p.faces || [], +p.thickness);
      break;
    case 'draft': {
      needSolid(st);
      st.solid = K.draftFaces(st.solid, p.faces || [], +p.angle, resolvePlane(p.plane, st));
      break;
    }
    case 'hole': {
      needSolid(st);
      const s = sketchOf(st, p.sketch);
      const pl = s.plane;
      const sk = s.sketch;
      const centers = [];
      for (const e of sk.ents) {
        if (e.type === 'point') centers.push(sk.pts[e.p]);
        else if (e.type === 'circle' && !e.construction) centers.push(sk.pts[e.c]);
      }
      if (!centers.length) throw new Error('Place at least one point in the hole position sketch');
      const dir = p.flip ? pl.n : cutDir(st, pl);
      const depth = p.end === 'through' ? bboxDiag(st) : +p.depth;
      const r = +p.diameter / 2;
      const tools = [];
      for (const c of centers) {
        const o = toWorld(pl, [c.x, c.y]);
        const back = V.add(o, V.mul(dir, -0.01));
        tools.push(K.makeCylinder(r, depth + 0.01, back, dir));
        if (p.kind === 'cbore') tools.push(K.makeCylinder(+p.cboreDia / 2, +p.cboreDepth + 0.01, back, dir));
        if (p.kind === 'csink') {
          const R2 = +p.csinkDia / 2;
          const h = (R2 - r) / Math.tan(((+p.csinkAngle || 90) / 2) * (Math.PI / 180));
          const u = V.norm(V.cross(dir, Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
          const tri = K.polygonFace([o, V.add(o, V.mul(u, R2)), V.add(V.add(o, V.mul(u, r)), V.mul(dir, h)), V.add(o, V.mul(dir, h))]);
          tools.push(K.revolveFaces([tri], o, dir, 360));
        }
      }
      setSolid(st, f, K.fuseAll(tools), 'cut');
      break;
    }
    case 'linearPattern':
    case 'circularPattern':
    case 'mirror': {
      needSolid(st);
      const xf = transformsFor(f, st);
      const seeds = (p.features || []).map((id) => st.tools[id]).filter(Boolean);
      if (seeds.length) {
        for (const seed of seeds) for (const t of xf) st.solid = K.applyOp(st.solid, K.transformShape(seed.tool, t), seed.op);
      } else {
        const body = st.solid;
        for (const t of xf) st.solid = st.solid.fuse(K.transformShape(body, t));
      }
      break;
    }
    case 'scale': {
      needSolid(st);
      st.solid = K.transformShape(st.solid, { scale: { factor: +p.factor || 1, center: p.center || [0, 0, 0] } });
      break;
    }
    case 'moveBody': {
      needSolid(st);
      const t = {};
      if (p.translate) t.translate = p.translate;
      if (p.angle) t.rotate = { angle: +p.angle, origin: p.origin || [0, 0, 0], axis: V.norm(p.axis || [0, 1, 0]) };
      const moved = K.transformShape(st.solid, t);
      st.solid = p.copy ? st.solid.fuse(moved) : moved;
      break;
    }
    case 'primitive': {
      let tool;
      const o = p.origin || [0, 0, 0];
      if (p.kind === 'box') tool = K.makeBox(o, V.add(o, [+p.x, +p.y, +p.z]));
      else if (p.kind === 'cylinder') tool = K.makeCylinder(+p.r, +p.h, o, [0, 1, 0]);
      else tool = K.makeSphere(+p.r).translate(o);
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'import': {
      const shape = K.R.deserializeShape(p.brep);
      if (p.as === 'surface') st.surfaces.push({ id: f.id, name: f.name, shape });
      else setSolid(st, f, shape, st.solid ? 'new' : 'add');
      break;
    }
    // ---------------- surfaces
    case 'surfExtrude': {
      const s = sketchOf(st, p.sketch);
      const { start, vec } = extrusionSpan(st, s, p, false);
      let shape = K.compound(anyWires(s).map((w) => K.extrudeWire(w, vec)));
      if (V.len(start) > 0) shape = shape.translate(start);
      st.surfaces.push({ id: f.id, name: f.name, shape });
      break;
    }
    case 'surfRevolve': {
      const s = sketchOf(st, p.sketch);
      const { o, d } = revolveAxis(s, p);
      const shape = K.compound(anyWires(s).map((w) => K.revolveWire(w, o, d, +p.angle || 360)));
      st.surfaces.push({ id: f.id, name: f.name, shape });
      break;
    }
    case 'surfPlanar': {
      const s = sketchOf(st, p.sketch);
      st.surfaces.push({ id: f.id, name: f.name, shape: K.compound(requireFaces(s)) });
      break;
    }
    case 'surfLoft': {
      if (!p.profiles || p.profiles.length < 2) throw new Error('Select at least two profile sketches');
      const shape = K.loftWires(p.profiles.map((id) => profileWire(st, id)), { ruled: !!p.ruled, shell: true });
      st.surfaces.push({ id: f.id, name: f.name, shape });
      break;
    }
    case 'surfSweep': {
      const spine = pathWire(st, p.path);
      const shape = K.sweepProfile(profileWire(st, p.profile), spine);
      st.surfaces.push({ id: f.id, name: f.name, shape });
      break;
    }
    case 'surfOffset': {
      needSolid(st);
      const faces = K.matchFaces(st.solid, p.faces || []);
      if (!faces.length) throw new Error('Select faces to offset');
      st.surfaces.push({ id: f.id, name: f.name, shape: K.compound(faces.map((fc) => K.offsetFace(fc, +p.distance || 0))) });
      break;
    }
    case 'thicken': {
      const i = st.surfaces.findIndex((s) => s.id === p.surface);
      if (i < 0) throw new Error('Select a surface body to thicken');
      const tool = K.thicken(st.surfaces[i].shape, (p.flip ? -1 : 1) * (+p.thickness || 1));
      st.surfaces.splice(i, 1);
      setSolid(st, f, tool, p.op || 'add');
      break;
    }
    case 'knit': {
      const ids = p.surfaces || [];
      const parts = st.surfaces.filter((s) => ids.includes(s.id));
      if (parts.length < 2) throw new Error('Select at least two surface bodies to knit');
      const shape = K.sew(parts.map((s) => s.shape), +p.tolerance || 0.01);
      st.surfaces = st.surfaces.filter((s) => !ids.includes(s.id));
      if (p.solid) {
        try {
          setSolid(st, f, K.R.makeSolid(shape.faces), st.solid ? 'new' : 'add');
          break;
        } catch (e) {
          /* not closed -> keep as surface */
        }
      }
      st.surfaces.push({ id: f.id, name: f.name, shape });
      break;
    }
    case 'deleteBody': {
      if (p.body === 'solid') st.solid = null;
      else {
        st.surfaces = st.surfaces.filter((s) => s.id !== p.body);
        st.meshes = st.meshes.filter((s) => s.id !== p.body);
      }
      break;
    }
    // ---------------- sheet metal
    case 'baseFlange': {
      const s = sketchOf(st, p.sketch);
      const t = +p.thickness || 1;
      let dir = p.flip ? V.neg(s.plane.n) : s.plane.n;
      let tool;
      if (s.profile.regions.length) {
        tool = K.extrudeFaces(sketchFaces(s), V.mul(dir, t));
        st.sheetMetal = { thickness: t, radius: +p.radius || t, kFactor: +p.kFactor || 0.44, base: f.id, plane: s.plane, dir, regions: s.profile.regions, flat: true };
      } else {
        if (!s.profile.open.length) throw new Error('The sketch is empty');
        const depth = +p.depth || 50;
        const shell = K.compound(s.profile.open.map((c) => K.extrudeWire(K.chainToWire(c, s.plane), V.mul(dir, depth))));
        tool = K.thicken(shell, t);
        st.sheetMetal = { thickness: t, radius: +p.radius || t, kFactor: +p.kFactor || 0.44, base: f.id, plane: s.plane, dir, open: s.profile.open, depth, flat: false };
      }
      setSolid(st, f, tool, st.solid ? 'add' : 'add');
      break;
    }
    case 'edgeFlange': {
      needSolid(st);
      if (!st.sheetMetal) throw new Error('Create a Base Flange first (sheet metal parameters are missing)');
      const res = buildEdgeFlange(st.solid, p, st.sheetMetal);
      st.solid = K.applyOp(st.solid, res.tool, 'add');
      st.flanges.push({ id: f.id, ...res.info });
      break;
    }
    // ---------------- weldments
    case 'structuralMember': {
      const s = sketchOf(st, p.sketch);
      const res = buildStructuralMembers(s, p);
      setSolid(st, f, res.shape, 'add');
      st.cutlist.push(...res.cutlist.map((c) => ({ ...c, feature: f.name })));
      break;
    }
    // ---------------- mesh bodies
    case 'mesh': {
      const blob = doc.blobs[p.blob];
      if (!blob) throw new Error('Mesh data is missing from this document');
      st.meshes.push({ id: f.id, name: f.name, blob: p.blob, data: blob, color: p.color });
      break;
    }
    default:
      throw new Error('Unknown feature type ' + f.type);
  }
}

function needSolid(st) {
  if (!st.solid) throw new Error('This feature needs a solid body');
}

// thin-feature faces from open chains: offset the polyline both sides by t/2
function thinFaces(s, t) {
  const faces = [];
  for (const c of s.profile.open) {
    const poly = c.poly;
    const left = [], right = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[Math.max(0, i - 1)], b = poly[Math.min(poly.length - 1, i + 1)];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / d, ny = (b[0] - a[0]) / d;
      left.push([poly[i][0] + (nx * t) / 2, poly[i][1] + (ny * t) / 2]);
      right.push([poly[i][0] - (nx * t) / 2, poly[i][1] - (ny * t) / 2]);
    }
    const ring = [...left, ...right.reverse()].map((q) => toWorld(s.plane, q));
    faces.push(K.polygonFace(ring));
  }
  if (!faces.length) throw new Error('The sketch is empty');
  return faces;
}

function draftTool(tool, plane, angle, vecDir) {
  // draft the side faces (faces whose normal is perpendicular to the extrusion direction)
  const d = V.norm(vecDir);
  const sigs = tool.faces.map((fc) => K.faceSig(fc)).filter((sg) => Math.abs(V.dot(sg.n, d)) < 0.2);
  try {
    return K.draftFaces(tool, sigs, angle, plane);
  } catch (e) {
    return tool;
  }
}

// connect 3D sketch segments into polylines
function chain3d(pts, lines) {
  const used = new Array(lines.length).fill(false);
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const idx = [lines[i][0], lines[i][1]];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        const [a, b] = lines[j];
        const last = idx[idx.length - 1], first = idx[0];
        if (a === last) idx.push(b);
        else if (b === last) idx.push(a);
        else if (a === first) idx.unshift(b);
        else if (b === first) idx.unshift(a);
        else continue;
        used[j] = true;
        grew = true;
      }
    }
    const closed = idx.length > 2 && idx[0] === idx[idx.length - 1];
    if (closed) idx.pop();
    chains.push({ pts: idx.map((k) => pts[k]), closed });
  }
  return chains;
}

export { sketchSegments, findLoops, toLocal };
