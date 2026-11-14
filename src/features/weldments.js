// Weldment structural members: sweep a standard section along every line of a 2D or 3D sketch,
// mitre the joints where exactly two members meet, and report a cut list with weights.
import * as K from '../kernel.js';
import { V, toWorld } from '../geom.js';

// Section types. fields = the custom dimensions each type uses:
//   w = width / leg / diameter, h = height, t = wall or web thickness, tf = flange thickness
export const SECTIONS = {
  'Square tube': { fields: ['w', 't'], def: { w: 40, t: 3 }, std: 'EN 10219 SHS' },
  'Rectangular tube': { fields: ['w', 'h', 't'], def: { w: 60, h: 40, t: 3 }, std: 'EN 10219 RHS' },
  Pipe: { fields: ['w', 't'], def: { w: 33.7, t: 3.2 }, std: 'EN 10219 CHS' },
  'Angle iron': { fields: ['w', 'h', 't'], def: { w: 40, h: 40, t: 4 }, std: 'EN 10056 L' },
  'C channel': { fields: ['w', 'h', 't', 'tf'], def: { w: 50, h: 100, t: 6, tf: 8.5 }, std: 'UPN' },
  'I beam': { fields: ['w', 'h', 't', 'tf'], def: { w: 55, h: 100, t: 4.1, tf: 5.7 }, std: 'IPE' },
  'H beam (HEA)': { fields: ['w', 'h', 't', 'tf'], def: { w: 100, h: 96, t: 5, tf: 8 }, std: 'HEA' },
  'H beam (HEB)': { fields: ['w', 'h', 't', 'tf'], def: { w: 100, h: 100, t: 6, tf: 10 }, std: 'HEB' },
  'T bar': { fields: ['w', 'h', 't'], def: { w: 40, h: 40, t: 5 }, std: 'EN 10055 T' },
  'Flat bar': { fields: ['w', 't'], def: { w: 40, t: 5 }, std: 'EN 10058' },
  'Round bar': { fields: ['w'], def: { w: 20 }, std: 'EN 10060' },
  'Square bar': { fields: ['w'], def: { w: 20 }, std: 'EN 10059' },
};

// Standard nominal sizes (mm). Tubes: [w, (h,) t]; beams/channels: [name, h, b, tw, tf].
const sq = [[20, 2], [25, 2], [25, 3], [30, 2], [30, 3], [40, 2], [40, 3], [40, 4], [50, 3], [50, 4], [50, 5], [60, 3], [60, 4], [60, 5], [70, 4], [80, 4], [80, 5], [80, 6], [90, 5], [100, 4], [100, 5], [100, 6], [100, 8], [120, 5], [120, 6], [120, 8], [150, 6], [150, 8], [150, 10], [200, 8], [200, 10]];
const rect = [[40, 20, 2], [50, 25, 2], [50, 30, 3], [60, 30, 3], [60, 40, 3], [60, 40, 4], [80, 40, 3], [80, 40, 4], [80, 60, 4], [100, 50, 4], [100, 50, 5], [100, 60, 4], [100, 80, 5], [120, 60, 4], [120, 60, 5], [120, 80, 5], [140, 80, 5], [150, 100, 5], [150, 100, 6], [160, 80, 6], [200, 100, 6], [200, 100, 8], [250, 150, 8]];
const pipe = [[17.2, 2.3], [21.3, 2.6], [26.9, 2.6], [33.7, 3.2], [42.4, 3.2], [48.3, 3.2], [60.3, 3.6], [76.1, 3.6], [88.9, 4], [101.6, 4], [114.3, 4.5], [139.7, 5], [168.3, 5.6], [219.1, 6.3], [273, 6.3]];
const angle = [[20, 3], [25, 3], [30, 3], [30, 4], [35, 4], [40, 4], [40, 5], [45, 5], [50, 5], [50, 6], [60, 6], [65, 7], [70, 7], [75, 8], [80, 8], [90, 9], [100, 10], [120, 12], [150, 15]];
const upn = [[50, 50, 38, 5, 7], [65, 65, 42, 5.5, 7.5], [80, 80, 45, 6, 8], [100, 100, 50, 6, 8.5], [120, 120, 55, 7, 9], [140, 140, 60, 7, 10], [160, 160, 65, 7.5, 10.5], [180, 180, 70, 8, 11], [200, 200, 75, 8.5, 11.5], [220, 220, 80, 9, 12.5], [240, 240, 85, 9.5, 13], [260, 260, 90, 10, 14], [300, 300, 100, 10, 16]];
const ipe = [[80, 80, 46, 3.8, 5.2], [100, 100, 55, 4.1, 5.7], [120, 120, 64, 4.4, 6.3], [140, 140, 73, 4.7, 6.9], [160, 160, 82, 5, 7.4], [180, 180, 91, 5.3, 8], [200, 200, 100, 5.6, 8.5], [220, 220, 110, 5.9, 9.2], [240, 240, 120, 6.2, 9.8], [270, 270, 135, 6.6, 10.2], [300, 300, 150, 7.1, 10.7], [330, 330, 160, 7.5, 11.5], [360, 360, 170, 8, 12.7], [400, 400, 180, 8.6, 13.5]];
const hea = [[100, 96, 100, 5, 8], [120, 114, 120, 5, 8], [140, 133, 140, 5.5, 8.5], [160, 152, 160, 6, 9], [180, 171, 180, 6, 9.5], [200, 190, 200, 6.5, 10], [220, 210, 220, 7, 11], [240, 230, 240, 7.5, 12], [260, 250, 260, 7.5, 12.5], [280, 270, 280, 8, 13], [300, 290, 300, 8.5, 14]];
const heb = [[100, 100, 100, 6, 10], [120, 120, 120, 6.5, 11], [140, 140, 140, 7, 12], [160, 160, 160, 8, 13], [180, 180, 180, 8.5, 14], [200, 200, 200, 9, 15], [220, 220, 220, 9.5, 16], [240, 240, 240, 10, 17], [260, 260, 260, 10, 17.5], [280, 280, 280, 10.5, 18], [300, 300, 300, 11, 19]];
const tee = [[30, 4], [35, 4.5], [40, 5], [50, 6], [60, 7], [70, 8], [80, 9], [100, 11]];
const flat = [[20, 3], [20, 5], [25, 3], [25, 5], [30, 3], [30, 5], [30, 8], [40, 4], [40, 5], [40, 8], [40, 10], [50, 5], [50, 6], [50, 8], [50, 10], [60, 6], [60, 8], [60, 10], [80, 8], [80, 10], [100, 8], [100, 10], [100, 12], [120, 10], [150, 10]];
const rounds = [6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100];
const squares = [8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 50, 60];
const n = (x) => String(x).replace('.', ',').replace(',', '.');

export const STANDARD_SIZES = {
  'Square tube': sq.map(([w, t]) => ({ label: `${n(w)} x ${n(w)} x ${n(t)}`, w, t })),
  'Rectangular tube': rect.map(([w, h, t]) => ({ label: `${n(w)} x ${n(h)} x ${n(t)}`, w, h, t })),
  Pipe: pipe.map(([w, t]) => ({ label: `Ø${n(w)} x ${n(t)}`, w, t })),
  'Angle iron': angle.map(([w, t]) => ({ label: `L ${n(w)} x ${n(w)} x ${n(t)}`, w, h: w, t })),
  'C channel': upn.map(([nm, h, b, tw, tf]) => ({ label: `UPN ${nm}`, w: b, h, t: tw, tf })),
  'I beam': ipe.map(([nm, h, b, tw, tf]) => ({ label: `IPE ${nm}`, w: b, h, t: tw, tf })),
  'H beam (HEA)': hea.map(([nm, h, b, tw, tf]) => ({ label: `HEA ${nm}`, w: b, h, t: tw, tf })),
  'H beam (HEB)': heb.map(([nm, h, b, tw, tf]) => ({ label: `HEB ${nm}`, w: b, h, t: tw, tf })),
  'T bar': tee.map(([w, t]) => ({ label: `T ${n(w)} x ${n(w)} x ${n(t)}`, w, h: w, t })),
  'Flat bar': flat.map(([w, t]) => ({ label: `${n(w)} x ${n(t)}`, w, t })),
  'Round bar': rounds.map((w) => ({ label: `Ø${n(w)}`, w })),
  'Square bar': squares.map((w) => ({ label: `${n(w)} x ${n(w)}`, w })),
};

export function profileLabel(pr) {
  if (pr.size) return `${pr.type} ${pr.size}`;
  return `${pr.type} ${[pr.w, pr.h, pr.t, pr.tf].filter((x) => x !== undefined && x !== '' && x !== null).join(' x ')}`;
}

// rounded rectangle outline, counter-clockwise
function rrect(W, H, r, seg = 4) {
  r = Math.max(0, Math.min(r, W / 2 - 1e-6, H / 2 - 1e-6));
  if (r < 1e-6) return [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]];
  const out = [];
  const corners = [[W / 2 - r, -H / 2 + r, -90], [W / 2 - r, H / 2 - r, 0], [-W / 2 + r, H / 2 - r, 90], [-W / 2 + r, -H / 2 + r, 180]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= seg; i++) {
    const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}
const circle = (r, k = 48) => Array.from({ length: k }, (_, i) => [r * Math.cos((i / k) * 2 * Math.PI), r * Math.sin((i / k) * 2 * Math.PI)]);

// Section outline(s) in local (u, v) coordinates, centred on the path. outer is CCW, inner is CCW too.
export function sectionLoops(pr) {
  const w = +pr.w, h = +(pr.h || pr.w), t = +(pr.t || 0), tf = +(pr.tf || pr.t || 0);
  switch (pr.type) {
    case 'Square tube': return { outer: rrect(w, w, Math.min(2 * t, w / 4)), inner: rrect(w - 2 * t, w - 2 * t, Math.min(t, w / 4)) };
    case 'Rectangular tube': return { outer: rrect(w, h, Math.min(2 * t, Math.min(w, h) / 4)), inner: rrect(w - 2 * t, h - 2 * t, Math.min(t, Math.min(w, h) / 4)) };
    case 'Pipe': return { outer: circle(w / 2), inner: circle(w / 2 - t) };
    case 'Round bar': return { outer: circle(w / 2) };
    case 'Square bar': return { outer: rrect(w, w, 0) };
    case 'Flat bar': return { outer: rrect(w, t, 0) };
    case 'Angle iron': return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + t], [-w / 2 + t, -h / 2 + t], [-w / 2 + t, h / 2], [-w / 2, h / 2]] };
    case 'T bar': return { outer: [[-w / 2, h / 2], [-w / 2, h / 2 - t], [-t / 2, h / 2 - t], [-t / 2, -h / 2], [t / 2, -h / 2], [t / 2, h / 2 - t], [w / 2, h / 2 - t], [w / 2, h / 2]] };
    case 'C channel': return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + tf], [-w / 2 + t, -h / 2 + tf], [-w / 2 + t, h / 2 - tf], [w / 2, h / 2 - tf], [w / 2, h / 2], [-w / 2, h / 2]] };
    case 'I beam':
    case 'H beam (HEA)':
    case 'H beam (HEB)':
      return { outer: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + tf], [t / 2, -h / 2 + tf], [t / 2, h / 2 - tf], [w / 2, h / 2 - tf], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, h / 2 - tf], [-t / 2, h / 2 - tf], [-t / 2, -h / 2 + tf], [-w / 2, -h / 2 + tf]] };
    default: return { outer: rrect(w, w, 0) };
  }
}

const polyArea = (p) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2;
// cross-section area in mm² (exact for circles, polygon area otherwise)
export function sectionArea(pr) {
  const w = +pr.w, t = +(pr.t || 0);
  if (pr.type === 'Pipe') return Math.PI * ((w / 2) ** 2 - (w / 2 - t) ** 2);
  if (pr.type === 'Round bar') return Math.PI * (w / 2) ** 2;
  const l = sectionLoops(pr);
  return polyArea(l.outer) - (l.inner ? polyArea(l.inner) : 0);
}

function profileError(pr) {
  const w = +pr.w, h = +(pr.h || pr.w), t = +(pr.t || 0), tf = +(pr.tf || pr.t || 0);
  if (!(w > 0)) return 'The profile width must be greater than zero';
  const f = SECTIONS[pr.type] ? SECTIONS[pr.type].fields : [];
  if (f.includes('t') && !(t > 0)) return 'The wall thickness must be greater than zero';
  if (['Square tube', 'Pipe'].includes(pr.type) && 2 * t >= w) return 'The wall is too thick for this profile';
  if (pr.type === 'Rectangular tube' && 2 * t >= Math.min(w, h)) return 'The wall is too thick for this profile';
  if (f.includes('tf') && (2 * tf >= h || t >= w)) return 'Flange or web thickness is too large for this profile';
  return null;
}

export function buildStructuralMembers(s, p) {
  const pr = p.profile || { type: 'Square tube', w: 40, t: 3 };
  const bad = profileError(pr);
  if (bad) throw new Error(bad);
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
  const upRef = s.kind === '3d' ? [0, 0, 1] : s.plane.n;
  const rot = ((+p.angle || 0) * Math.PI) / 180;
  const area = sectionArea(pr);
  const solids = [], cutlist = [];
  segs.forEach((g, i) => {
    const len = V.dist(g.a, g.b);
    if (len < 1e-6) return;
    const d = V.norm(V.sub(g.b, g.a));
    let u0 = V.cross(upRef, d);
    if (V.len(u0) < 1e-6) u0 = V.cross([1, 0, 0], d);
    u0 = V.norm(u0);
    const v0 = V.cross(d, u0);
    // rotate the section about the member axis
    const u = V.add(V.mul(u0, Math.cos(rot)), V.mul(v0, Math.sin(rot)));
    const v = V.add(V.mul(u0, -Math.sin(rot)), V.mul(v0, Math.cos(rot)));
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
    for (const t of trims) solid = solid.cut(K.halfSpace(t.P, t.m, ext * 6 + len));
    solids.push(solid);
    cutlist.push({ item: i + 1, description: profileLabel(pr), length: len, miter: trims.length, area });
  });
  return { shape: K.fuseAll(solids), cutlist };
}
