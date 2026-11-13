// Geometry kernel wrapper. All exact B-rep work is done by OpenCascade (WASM) through replicad.
// Everything above this file talks in plain arrays / JSON so the UI never touches OC objects directly
// except for the opaque `shape` handles it passes back in.
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';
import { V, toWorld, planeY, circle3 } from './geom.js';
import { arcMid } from './sketch/profile.js';

let OC = null;
export const kernelReady = () => !!OC;
export { R };
export const getOC = () => OC;

export async function initKernel(opts = {}) {
  if (OC) return;
  OC = await opencascade(opts);
  R.setOC(OC);
}

const v3 = (v) => [v.x, v.y, v.z];
const vec = (a) => new R.Vector(a);

// ---------------------------------------------------------------- wires & faces from sketch loops

function itemEdge(it, pl) {
  const s = it.seg;
  const W = (p) => toWorld(pl, p);
  if (s.type === 'line') return it.rev ? R.makeLine(W(s.b), W(s.a)) : R.makeLine(W(s.a), W(s.b));
  if (s.type === 'arc') {
    const m = arcMid(s);
    return it.rev ? R.makeThreePointArc(W(s.b), W(m), W(s.a)) : R.makeThreePointArc(W(s.a), W(m), W(s.b));
  }
  if (s.type === 'circle') return R.makeCircle(s.r, W(s.c), pl.n);
  if (s.type === 'spline') {
    const pts = (it.rev ? [...s.pts].reverse() : s.pts).map(W);
    return R.makeBSplineApproximation(pts, { tolerance: 1e-4, degMax: 3 });
  }
  throw new Error('Unsupported sketch entity ' + s.type);
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// ccw: undefined = keep drawing order, true = counter-clockwise about the plane normal, false = clockwise
export function chainToWire(chain, pl, ccw) {
  let items = chain.items;
  if (items.length === 1 && items[0].seg.type === 'circle') {
    const s = items[0].seg;
    return R.assembleWire([R.makeCircle(s.r, toWorld(pl, s.c), ccw === false ? V.neg(pl.n) : pl.n)]);
  }
  if (ccw !== undefined && chain.poly && signedArea(chain.poly) > 0 !== ccw) {
    items = [...items].reverse().map((it) => ({ seg: it.seg, rev: !it.rev }));
  }
  return R.assembleWire(items.map((it) => itemEdge(it, pl)));
}

export function regionFace(region, pl) {
  const outer = chainToWire(region.outer, pl, true);
  const holes = region.holes.map((h) => chainToWire(h, pl, false));
  return R.makeFace(outer, holes);
}

export function polylineWire(points3d, closed = false) {
  const edges = [];
  for (let i = 0; i < points3d.length - 1; i++) edges.push(R.makeLine(points3d[i], points3d[i + 1]));
  if (closed) edges.push(R.makeLine(points3d[points3d.length - 1], points3d[0]));
  return R.assembleWire(edges);
}

export function polygonFace(points3d) {
  return R.makeFace(polylineWire(points3d, true));
}

// Text outlines (uses a font loaded with loadFont) as faces on a plane.
export async function loadKernelFont(buffer, family) {
  await R.loadFont(buffer, family, true);
}

export function textFaces(text, pl, { size = 10, family, x = 0, y = 0 } = {}) {
  const drawing = R.drawText(text, { startX: x, startY: y, fontSize: size, fontFamily: family });
  const plane = new R.Plane(pl.o, pl.x, pl.n);
  const sk = drawing.sketchOnPlane(plane);
  const list = sk.sketches ? sk.sketches : [sk];
  const faces = [];
  for (const s of list) {
    try {
      faces.push(s.face());
    } catch (e) {
      /* skip broken glyph */
    }
  }
  return faces;
}

// ---------------------------------------------------------------- solids

export function fuseAll(shapes) {
  let out = null;
  for (const s of shapes) out = out ? out.fuse(s) : s;
  return out;
}

export function compound(shapes) {
  // makeCompound takes ownership of its inputs, so hand it clones
  return shapes.length === 1 ? shapes[0] : R.makeCompound(shapes.map((s) => s.clone()));
}

export function extrudeFaces(faces, vector) {
  return fuseAll(faces.map((f) => R.basicFaceExtrusion(f, vec(vector))));
}

export function extrudeWire(wire, vector) {
  // surface (shell) from an open or closed wire
  const prism = new OC.BRepPrimAPI_MakePrism(wire.wrapped, vec(vector).wrapped, false, true);
  return R.cast(prism.Shape());
}

export function revolveFaces(faces, origin, dir, angleDeg) {
  return fuseAll(faces.map((f) => R.revolution(f, origin, dir, angleDeg)));
}

export function revolveWire(wire, origin, dir, angleDeg) {
  const ax = R.makeAx1(origin, dir);
  const rev = new OC.BRepPrimAPI_MakeRevol(wire.wrapped, ax, (angleDeg * Math.PI) / 180, false);
  return R.cast(rev.Shape());
}

export function sweepProfile(profile, spineWire, { frenet = false } = {}) {
  // profile: Face (-> solid) or Wire (-> shell). Sharp path corners are mitred; helical paths
  // need the Frenet frame so the section follows the twist.
  const cfg = frenet ? { frenet: true } : { transitionMode: 'right', forceProfileSpineOthogonality: false };
  if (profile.outerWire) {
    let solid = R.genericSweep(profile.clone().outerWire(), spineWire.clone(), cfg);
    for (const w of profile.clone().innerWires()) solid = solid.cut(R.genericSweep(w, spineWire.clone(), cfg));
    return solid;
  }
  const res = R.genericSweep(profile, spineWire.clone(), cfg, true);
  return Array.isArray(res) ? res[0] : res;
}

export function loftWires(wires, { ruled = false, shell = false } = {}) {
  return R.loft(wires, { ruled }, shell);
}

export function applyOp(base, tool, op) {
  if (op === 'new' || (!base && op === 'add')) return base && op === 'new' ? compound([base, tool]) : tool;
  if (!base) throw new Error('There is no solid body to ' + (op === 'cut' ? 'cut' : 'modify'));
  if (op === 'add') return base.fuse(tool);
  if (op === 'cut') return base.cut(tool);
  if (op === 'intersect') return base.intersect(tool);
  throw new Error('Unknown operation ' + op);
}

// ---- helix / thread / half-space
export function makeHelix({ pitch, height, radius, origin = [0, 0, 0], axis = [0, 0, 1], lefthand = false }) {
  return R.makeHelix(pitch, height, radius, origin, V.norm(axis), lefthand);
}

export function sampleWire(wire, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(v3(wire.pointAt(i / n)));
  return pts;
}

// Solid to subtract for a V-thread around an axis. internal = thread inside a hole.
export function threadTool({ origin, axis, radius, pitch, length, depth, internal = false, lefthand = false }) {
  const a = V.norm(axis);
  const helix = R.makeHelix(pitch, length, radius, origin, a, lefthand);
  const p0 = v3(helix.startPoint);
  const foot = V.add(origin, V.mul(a, V.dot(V.sub(p0, origin), a)));
  const radial = V.norm(V.sub(p0, foot));
  const s = internal ? 1 : -1; // apex direction: into the material
  const h = pitch * 0.42;
  const base = V.add(p0, V.mul(radial, -s * 0.05));
  const tri = polygonFace([V.add(base, V.mul(a, h)), V.add(base, V.mul(a, -h)), V.add(p0, V.mul(radial, s * depth))]);
  return R.genericSweep(tri.outerWire(), helix, { frenet: true });
}

// Big block covering the side the normal points AWAY from (cutting with it keeps the +normal side).
export function halfSpace(point, normal, size) {
  const n = V.norm(normal);
  const ref = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = V.norm(V.cross(ref, n)), w = V.cross(n, u);
  const c = (i, j) => V.add(point, V.add(V.mul(u, i * size), V.mul(w, j * size)));
  return R.basicFaceExtrusion(polygonFace([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]), vec(V.mul(n, -size)));
}

export const makeBox = (a, b) => R.makeBox(a, b);
export const makeCylinder = (r, h, o, d) => R.makeCylinder(r, h, o, d);
export const makeSphere = (r) => R.makeSphere(r);

export function transformShape(shape, { translate, rotate, mirror, scale }) {
  let s = shape.clone();
  if (translate) s = s.translate(translate);
  if (rotate) s = s.rotate(rotate.angle, rotate.origin, rotate.axis);
  if (mirror) s = s.mirror(mirror.normal, mirror.origin);
  if (scale) s = s.scale(scale.factor, scale.center || [0, 0, 0]);
  return s;
}

// ---------------------------------------------------------------- persistent-ish references
// Faces / edges are remembered by a geometric signature and re-found after a rebuild.

export function edgeSig(e) {
  return { m: v3(e.pointAt(0.5)), a: v3(e.startPoint), b: v3(e.endPoint), l: e.length };
}

export function faceSig(f) {
  const c = v3(f.center);
  let n = [0, 0, 0];
  try {
    n = v3(f.normalAt(f.center));
  } catch (e) {
    /* degenerate */
  }
  return { c, n, t: f.geomType };
}

export function matchEdges(shape, sigs) {
  const edges = shape.edges;
  const out = [];
  for (const sg of sigs) {
    let best = null, bd = Infinity;
    for (const e of edges) {
      const d = V.dist(v3(e.pointAt(0.5)), sg.m) + 0.25 * Math.abs(e.length - sg.l);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (best && !out.includes(best)) out.push(best);
  }
  return out;
}

export function matchFaces(shape, sigs) {
  const faces = shape.faces;
  const out = [];
  for (const sg of sigs) {
    let best = null, bd = Infinity;
    for (const f of faces) {
      let d = V.dist(v3(f.center), sg.c);
      try {
        const n = v3(f.normalAt(f.center));
        d += (1 - V.dot(n, sg.n)) * 5;
      } catch (e) {
        /* ignore */
      }
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    if (best && !out.includes(best)) out.push(best);
  }
  return out;
}

export function filletEdges(shape, sigs, radius) {
  const targets = matchEdges(shape, sigs);
  if (!targets.length) throw new Error('Select at least one edge');
  return shape.fillet((e) => (targets.some((t) => t.isSame(e)) ? radius : null));
}

export function chamferEdges(shape, sigs, dist) {
  const targets = matchEdges(shape, sigs);
  if (!targets.length) throw new Error('Select at least one edge');
  return shape.chamfer((e) => (targets.some((t) => t.isSame(e)) ? dist : null));
}

export function shellFaces(shape, sigs, thickness) {
  const targets = matchFaces(shape, sigs);
  if (!targets.length) throw new Error('Select at least one face to remove');
  return shape.shell(Math.abs(thickness), (f) => f.when(({ element }) => targets.some((t) => t.isSame(element))));
}

export function draftFaces(shape, sigs, angleDeg, neutral) {
  const targets = matchFaces(shape, sigs);
  if (!targets.length) throw new Error('Select faces to draft');
  const plane = new R.Plane(neutral.o, neutral.x, neutral.n);
  return shape.draft(angleDeg, (f) => f.when(({ element }) => targets.some((t) => t.isSame(element))), plane);
}

export function offsetFace(face, d) {
  return R.makeOffset(face, d);
}

// Thicken a face / shell into a solid: offset every face, close the sides, sew and fuse.
export function thicken(shape, thickness) {
  const solids = [];
  for (const f of shape.faces) {
    if (f.geomType === 'PLANE') {
      const n = v3(f.normalAt(f.center));
      solids.push(R.basicFaceExtrusion(f, vec(V.mul(n, thickness))));
      continue;
    }
    const off = R.makeOffset(f, thickness).faces[0];
    const side = R.loft([f.clone().outerWire(), off.clone().outerWire()], { ruled: true }, true);
    const sewn = sew([f.clone(), off.clone(), side], 1e-3);
    solids.push(R.makeSolid(sewn.faces.length ? sewn.faces : [f, off]));
  }
  return fuseAll(solids);
}

export function sew(shapes, tol = 1e-3) {
  const sewing = new OC.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  for (const s of shapes) sewing.Add(s.wrapped);
  const progress = new OC.Message_ProgressRange();
  sewing.Perform(progress);
  return R.cast(sewing.SewedShape());
}

// ---------------------------------------------------------------- tessellation for display

export function tessellate(shape, { tolerance = 0.05, angularTolerance = 0.25 } = {}) {
  OC.ReplicadMeshExtractor.mesh(shape.wrapped, tolerance, angularTolerance);
  const positions = [], normals = [], indices = [], faceGroups = [];
  const faces = shape.faces;
  faces.forEach((f, i) => {
    const t = f.triangulation(positions.length / 3);
    if (!t) return;
    const start = indices.length;
    for (const x of t.vertices) positions.push(x);
    for (const x of t.verticesNormals) normals.push(x);
    for (const x of t.trianglesIndexes) indices.push(x);
    faceGroups.push({ start, count: indices.length - start, face: i });
  });
  const bb = bbox(shape);
  const diag = V.dist(bb.min, bb.max) || 1;
  const lines = [], edgeGroups = [];
  const edges = shape.edges;
  edges.forEach((e, i) => {
    let pts;
    try {
      if (e.geomType === 'LINE') pts = [v3(e.startPoint), v3(e.endPoint)];
      else {
        const n = Math.min(96, Math.max(8, Math.ceil(e.length / (diag * 0.004))));
        pts = [];
        for (let k = 0; k <= n; k++) pts.push(v3(e.pointAt(k / n)));
      }
    } catch (err) {
      return;
    }
    const start = lines.length / 3;
    for (let k = 0; k < pts.length - 1; k++) lines.push(...pts[k], ...pts[k + 1]);
    edgeGroups.push({ start, count: lines.length / 3 - start, edge: i });
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceGroups,
    lines: new Float32Array(lines),
    edgeGroups,
    bbox: bb,
    nFaces: faces.length,
    nEdges: edges.length,
  };
}

export function bbox(shape) {
  const b = shape.boundingBox.bounds;
  return { min: [...b[0]], max: [...b[1]] };
}

export function faceInfo(shape, i) {
  const f = shape.faces[i];
  if (!f) return null;
  const sig = faceSig(f);
  let area = 0;
  try {
    area = R.measureArea(f);
  } catch (e) {
    /* ignore */
  }
  const info = { kind: 'face', index: i, type: f.geomType, center: sig.c, normal: sig.n, area, sig, planar: f.geomType === 'PLANE' };
  if (f.geomType === 'CYLINDRE' || f.geomType === 'CYLINDER') {
    // radius and axis from one of the circular boundary edges
    for (const e of f.edges) {
      if (e.geomType !== 'CIRCLE') continue;
      try {
        const c = circle3d(...[0, 0.3, 0.6].map((t) => v3(e.pointAt(t))));
        if (c) {
          info.radius = c.r;
          info.axis = c.n;
          info.axisPoint = c.c;
          break;
        }
      } catch (err) {
        /* try the next edge */
      }
    }
  }
  return info;
}

export function edgeInfo(shape, i) {
  const e = shape.edges[i];
  if (!e) return null;
  const sig = edgeSig(e);
  const info = { kind: 'edge', index: i, type: e.geomType, length: e.length, a: sig.a, b: sig.b, mid: sig.m, sig, closed: e.isClosed };
  if (e.geomType === 'CIRCLE') {
    const p = [0, 0.3, 0.6].map((t) => v3(e.pointAt(t)));
    const c = circle3d(p[0], p[1], p[2]);
    if (c) {
      info.radius = c.r;
      info.center = c.c;
      info.axis = c.n;
    }
  } else if (e.geomType === 'LINE') {
    info.dir = V.norm(V.sub(sig.b, sig.a));
  }
  return info;
}

export function circle3d(a, b, c) {
  const u = V.sub(b, a), w = V.sub(c, a);
  const n = V.cross(u, w);
  const nl = V.len(n);
  if (nl < 1e-12) return null;
  const nn = V.mul(n, 1 / nl);
  const ex = V.norm(u), ey = V.cross(nn, ex);
  const b2 = [V.dot(u, ex), 0], c2 = [V.dot(w, ex), V.dot(w, ey)];
  const cc = circle3([0, 0], b2, c2);
  if (!cc) return null;
  return { c: V.add(a, V.add(V.mul(ex, cc.c[0]), V.mul(ey, cc.c[1]))), r: cc.r, n: nn };
}

export function massProps(shape) {
  const out = { volume: 0, area: 0, com: [0, 0, 0] };
  try {
    const p = R.measureShapeVolumeProperties(shape);
    out.volume = p.volume;
    out.com = [...p.centerOfMass];
  } catch (e) {
    /* surfaces have no volume */
  }
  try {
    out.area = R.measureArea(shape);
  } catch (e) {
    /* ignore */
  }
  try {
    out.bbox = bbox(shape);
  } catch (e) {
    out.bbox = { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return out;
}

export function distanceBetween(a, b) {
  return R.measureDistanceBetween(a, b);
}

export function isValid(shape) {
  try {
    const an = new OC.BRepCheck_Analyzer(shape.wrapped, true);
    const ok = an.IsValid();
    an.delete();
    return ok;
  } catch (e) {
    return true;
  }
}

// ---------------------------------------------------------------- hidden line projection (drawings)

// dir: direction the viewer looks along; x: the direction that should point right on the sheet.
export function projectShape(shape, dir, x) {
  const d = V.norm(dir);
  const bb = bbox(shape);
  const center = V.lerp(bb.min, bb.max, 0.5);
  const cam = new R.ProjectionCamera(center, V.neg(d), x);
  const { visible, hidden } = R.makeProjectedEdges(shape, cam, true);
  const conv = (edges) => {
    const out = [];
    for (const e of edges) {
      try {
        const t = e.geomType;
        if (t === 'LINE') {
          const a = v3(e.startPoint), b = v3(e.endPoint);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-7) out.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
        } else if (t === 'CIRCLE') {
          const p = [0, 0.5, 1].map((k) => v3(e.pointAt(k)));
          if (e.isClosed) {
            const q = v3(e.pointAt(0.25));
            const c = circle3(p[0], q, p[1]);
            if (c) out.push({ type: 'circle', cx: c.c[0], cy: c.c[1], r: c.r });
          } else {
            const c = circle3(p[0], p[1], p[2]);
            if (!c) continue;
            let a1 = Math.atan2(p[0][1] - c.c[1], p[0][0] - c.c[0]);
            let a2 = Math.atan2(p[2][1] - c.c[1], p[2][0] - c.c[0]);
            const am = Math.atan2(p[1][1] - c.c[1], p[1][0] - c.c[0]);
            const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            // ensure ccw from a1 to a2 passes through am
            if (norm(am - a1) > norm(a2 - a1)) [a1, a2] = [a2, a1];
            out.push({ type: 'arc', cx: c.c[0], cy: c.c[1], r: c.r, a1: (a1 * 180) / Math.PI, a2: (a2 * 180) / Math.PI });
          }
        } else {
          const n = 24, pts = [];
          for (let k = 0; k <= n; k++) {
            const p = v3(e.pointAt(k / n));
            pts.push([p[0], p[1]]);
          }
          out.push({ type: 'polyline', pts, closed: false });
        }
      } catch (err) {
        /* skip */
      }
    }
    return out;
  };
  return { visible: conv(visible), hidden: conv(hidden) };
}

// ---------------------------------------------------------------- import / export

export function exportSTEP(bodies) {
  return R.exportSTEP(
    bodies.map((b) => ({ shape: b.shape, name: b.name || 'Body', color: b.color || '#9aa3ad' })),
    { unit: 'MM', modelUnit: 'MM' }
  );
}

export function exportSTL(shape, { binary = true, tolerance = 0.02, angularTolerance = 0.2 } = {}) {
  return shape.blobSTL({ binary, tolerance, angularTolerance });
}

export async function importSTEP(blob) {
  return R.importSTEP(blob);
}

// Build a B-rep shell/solid from a triangle soup (mesh -> solid conversion). Slow for big meshes.
export function solidFromTriangles(positions, maxTris = 20000) {
  const n = positions.length / 9;
  if (n > maxTris) throw new Error(`Mesh has ${n} triangles; convert to solid supports up to ${maxTris}. Decimate it first.`);
  const faces = [];
  for (let i = 0; i < n; i++) {
    const p = positions.subarray ? positions.subarray(i * 9, i * 9 + 9) : positions.slice(i * 9, i * 9 + 9);
    const a = [p[0], p[1], p[2]], b = [p[3], p[4], p[5]], c = [p[6], p[7], p[8]];
    if (V.len(V.cross(V.sub(b, a), V.sub(c, a))) < 1e-10) continue;
    try {
      faces.push(polygonFace([a, b, c]));
    } catch (e) {
      /* skip degenerate */
    }
  }
  const sewn = sew(faces, 1e-3);
  try {
    return R.makeSolid(sewn.faces ? [sewn] : faces);
  } catch (e) {
    return sewn;
  }
}

export { planeY };
