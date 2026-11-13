// Sheet metal: edge flanges (bend + flange built exactly) and a flat pattern for
// base-flange plates with edge flanges attached to the plate's outer edges.
import * as K from '../kernel.js';
import { V, toLocal } from '../geom.js';

const v3 = (v) => [v.x, v.y, v.z];

export function buildEdgeFlange(solid, p, sm) {
  const [edge] = K.matchEdges(solid, [p.edge]);
  if (!edge || edge.geomType !== 'LINE') throw new Error('Select a straight outer edge of the sheet');
  const a = v3(edge.startPoint), b = v3(edge.endPoint);
  const e = V.norm(V.sub(b, a));
  const t = sm.thickness, r = sm.radius;
  const adj = solid.faces.filter((f) => f.geomType === 'PLANE' && f.edges.some((x) => x.isSame(edge)));
  if (adj.length !== 2) throw new Error('The selected edge must lie between two flat faces');
  const normals = adj.map((f) => v3(f.normalAt(f.center)));
  const extent = (f, dir) => {
    let lo = Infinity, hi = -Infinity;
    for (const x of f.edges) for (const q of [v3(x.startPoint), v3(x.endPoint)]) {
      const d = V.dot(q, dir);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return hi - lo;
  };
  const e0 = extent(adj[0], normals[1]), e1 = extent(adj[1], normals[0]);
  let side, big;
  if (Math.abs(e0 - t) < t * 0.05 + 1e-6) [side, big] = [0, 1];
  else if (Math.abs(e1 - t) < t * 0.05 + 1e-6) [side, big] = [1, 0];
  else throw new Error('Select an edge on the thickness face of the sheet (the long edge of the thin side)');
  const s = normals[side]; // pointing out of the plate edge
  const u = normals[big]; // direction the flange rises
  const ang = ((+p.angle || 90) * Math.PI) / 180;
  const L = Math.max(0, +p.length || 20);
  const sign = V.dot(V.cross(e, s), u) > 0 ? 1 : -1;
  const axisDir = V.mul(e, sign);
  const axisPt = V.add(a, V.mul(u, r));
  const rect = [a, b, V.add(b, V.mul(u, -t)), V.add(a, V.mul(u, -t))];
  let tool = K.revolveFaces([K.polygonFace(rect)], axisPt, axisDir, (ang * 180) / Math.PI);
  if (L > 1e-6) {
    const rot = (q) => V.add(axisPt, V.rot(V.sub(q, axisPt), axisDir, ang));
    const n2 = V.rot(s, axisDir, ang);
    tool = tool.fuse(K.extrudeFaces([K.polygonFace(rect.map(rot))], V.mul(n2, L)));
  }
  const allowance = ang * (r + sm.kFactor * t);
  return { tool, info: { a, b, s, u, length: L, angle: +p.angle || 90, allowance } };
}

// Flat pattern as 2D entities in the base-flange sketch plane.
export function flatPattern(sm, flanges) {
  if (!sm || !sm.flat) throw new Error('Flat pattern is available for parts that start with a closed-profile Base Flange');
  const ents = [];
  const addPoly = (poly, layer) => {
    for (let i = 0; i < poly.length; i++) {
      const q = poly[(i + 1) % poly.length];
      ents.push({ type: 'line', x1: poly[i][0], y1: poly[i][1], x2: q[0], y2: q[1], layer });
    }
  };
  for (const reg of sm.regions) {
    addPoly(reg.outer.poly, 'OUTLINE');
    for (const h of reg.holes) addPoly(h.poly, 'OUTLINE');
  }
  for (const f of flanges) {
    const a = toLocal(sm.plane, f.a), b = toLocal(sm.plane, f.b);
    const s3 = toLocal({ o: [0, 0, 0], x: sm.plane.x, n: sm.plane.n }, f.s);
    const sl = Math.hypot(s3[0], s3[1]);
    if (sl < 0.5) continue; // flange not attached to a base edge
    const s = [s3[0] / sl, s3[1] / sl];
    const tot = f.allowance + f.length;
    const off = (q, d) => [q[0] + s[0] * d, q[1] + s[1] * d];
    const a2 = off(a, tot), b2 = off(b, tot);
    ents.push({ type: 'line', x1: a[0], y1: a[1], x2: a2[0], y2: a2[1], layer: 'OUTLINE' });
    ents.push({ type: 'line', x1: a2[0], y1: a2[1], x2: b2[0], y2: b2[1], layer: 'OUTLINE' });
    ents.push({ type: 'line', x1: b2[0], y1: b2[1], x2: b[0], y2: b[1], layer: 'OUTLINE' });
    const am = off(a, f.allowance / 2), bm = off(b, f.allowance / 2);
    ents.push({ type: 'line', x1: am[0], y1: am[1], x2: bm[0], y2: bm[1], layer: 'BEND', linetype: 'CENTER' });
  }
  return ents;
}
