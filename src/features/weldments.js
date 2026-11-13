// Weldment structural members: sweep a standard section along every line of a 2D or 3D sketch,
// mitre the joints where exactly two members meet, and report a cut list.
import * as K from '../kernel.js';
import { V, toWorld } from '../geom.js';

export const SECTIONS = {
  'Square tube': { fields: ['w', 't'], def: { w: 40, t: 3 } },
  'Rectangular tube': { fields: ['w', 'h', 't'], def: { w: 60, h: 40, t: 3 } },
  Pipe: { fields: ['w', 't'], def: { w: 33.7, t: 3.2 } },
  'Angle iron': { fields: ['w', 'h', 't'], def: { w: 40, h: 40, t: 4 } },
  'Flat bar': { fields: ['w', 't'], def: { w: 40, t: 5 } },
  'C channel': { fields: ['w', 'h', 't'], def: { w: 40, h: 80, t: 5 } },
  'I beam': { fields: ['w', 'h', 't'], def: { w: 50, h: 100, t: 5 } },
  'Round bar': { fields: ['w'], def: { w: 20 } },
  'Square bar': { fields: ['w'], def: { w: 20 } },
};

// section outline(s) in local (u, v) coordinates, centred on the path
function sectionLoops(pr) {
  const w = +pr.w, h = +(pr.h || pr.w), t = +(pr.t || 0);
  const rect = (W, H) => [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
  const circ = (r) => Array.from({ length: 48 }, (_, i) => [r * Math.cos((i / 48) * 2 * Math.PI), r * Math.sin((i / 48) * 2 * Math.PI)]);
  switch (pr.type) {
    case 'Square tube': return { outer: rect(w, w), inner: rect(w - 2 * t, w - 2 * t) };
    case 'Rectangular tube': return { outer: rect(w, h), inner: rect(w - 2 * t, h - 2 * t) };
    case 'Pipe': return { outer: circ(w / 2), inner: circ(w / 2 - t), round: true };
    case 'Round bar': return { outer: circ(w / 2), round: true };
    case 'Square bar': return { outer: rect(w, w) };
    case 'Flat bar': return { outer: rect(w, t) };
    case 'Angle iron': return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + t], [-w / 2 + t, -h / 2 + t], [-w / 2 + t, h / 2], [-w / 2, h / 2]] };
    case 'C channel': return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + t], [-w / 2 + t, -h / 2 + t], [-w / 2 + t, h / 2 - t], [w / 2, h / 2 - t], [w / 2, h / 2], [-w / 2, h / 2]] };
    case 'I beam': return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + t], [t / 2, -h / 2 + t], [t / 2, h / 2 - t], [w / 2, h / 2 - t], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, h / 2 - t], [-t / 2, h / 2 - t], [-t / 2, -h / 2 + t], [-w / 2, -h / 2 + t]] };
    default: return { outer: rect(w, w) };
  }
}

function halfSpace(point, normal, size) {
  // big block occupying the side the normal points AWAY from (i.e. removes material where (p-point).normal < 0)
  const n = V.norm(normal);
  const ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = V.norm(V.cross(ref, n)), v = V.cross(n, u);
  const c = (a, b) => V.add(point, V.add(V.mul(u, a * size), V.mul(v, b * size)));
  const face = K.polygonFace([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]);
  return K.extrudeFaces([face], V.mul(n, -size));
}

export function buildStructuralMembers(s, p) {
  const pr = p.profile || { type: 'Square tube', w: 40, t: 3 };
  let segs;
  if (s.kind === '3d') segs = s.segs.map((g) => ({ a: g.a, b: g.b }));
  else segs = s.profile.segs.filter((g) => g.type === 'line').map((g) => ({ a: toWorld(s.plane, g.a), b: toWorld(s.plane, g.b) }));
  if (!segs.length) throw new Error('The sketch needs straight lines to place structural members on');
  const loops = sectionLoops(pr);
  const ext = Math.max(+pr.w, +(pr.h || pr.w)) * 1.5;
  const key = (q) => q.map((x) => x.toFixed(4)).join(',');
  const joints = new Map();
  segs.forEach((g, i) => {
    for (const end of ['a', 'b']) {
      const k = key(g[end]);
      if (!joints.has(k)) joints.set(k, []);
      joints.get(k).push({ i, end });
    }
  });
  const upRef = s.kind === '3d' ? [0, 1, 0] : s.plane.n;
  const solids = [], cutlist = [];
  segs.forEach((g, i) => {
    const len = V.dist(g.a, g.b);
    if (len < 1e-6) return;
    const d = V.norm(V.sub(g.b, g.a));
    let u = V.cross(upRef, d);
    if (V.len(u) < 1e-6) u = V.cross([1, 0, 0], d);
    u = V.norm(u);
    const v = V.cross(d, u);
    const trims = [];
    let start = g.a, end = g.b;
    if (p.miter !== false) {
      for (const which of ['a', 'b']) {
        const j = joints.get(key(g[which]));
        if (j.length !== 2) continue;
        const other = j.find((x) => x.i !== i);
        if (!other) continue;
        const og = segs[other.i];
        const P = g[which];
        const di = V.norm(V.sub(which === 'a' ? g.b : g.a, P));
        const dj = V.norm(V.sub(other.end === 'a' ? og.b : og.a, P));
        const m = V.sub(di, dj);
        if (V.len(m) < 1e-6) continue; // collinear
        trims.push({ P, m });
        if (which === 'a') start = V.add(g.a, V.mul(d, -ext));
        else end = V.add(g.b, V.mul(d, ext));
      }
    }
    const at = (q) => V.add(start, V.add(V.mul(u, q[0]), V.mul(v, q[1])));
    const outer = K.polylineWire(loops.outer.map(at), true);
    const holes = loops.inner ? [K.polylineWire([...loops.inner].reverse().map(at), true)] : [];
    let solid = K.extrudeFaces([K.R.makeFace(outer, holes)], V.sub(end, start));
    for (const t of trims) solid = solid.cut(halfSpace(t.P, t.m, ext * 6 + len));
    solids.push(solid);
    const dims = [pr.w, pr.h, pr.t].filter((x) => x !== undefined && x !== '').join(' x ');
    cutlist.push({ item: i + 1, description: `${pr.type} ${dims}`, length: len, miter: trims.length });
  });
  return { shape: K.fuseAll(solids), cutlist };
}
