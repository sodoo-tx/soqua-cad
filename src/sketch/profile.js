// Turns a sketch (points + entities) into closed loops / open chains and nested regions
// (outer boundary + holes) that features can extrude, revolve, sweep ...
import { ccwSweep } from '../geom.js';

const TAU = Math.PI * 2;

// Catmull-Rom (centripetal-ish, uniform here) sampling used for both display and geometry so they agree.
export function sampleSpline(pts, perSpan = 12) {
  if (pts.length < 3) return pts.map((p) => [...p]);
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let k = 0; k < perSpan; k++) {
      const t = k / perSpan, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push([...pts[n - 1]]);
  return out;
}

// Resolve sketch entities into plain 2D segments.
export function sketchSegments(sk, { construction = false } = {}) {
  const P = (id) => {
    const p = sk.pts[id];
    return p ? [p.x, p.y] : [0, 0];
  };
  const segs = [];
  for (const e of sk.ents) {
    if (!!e.construction !== construction) continue;
    if (e.type === 'line') {
      const a = P(e.a), b = P(e.b);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
      segs.push({ id: e.id, type: 'line', a, b });
    } else if (e.type === 'circle') {
      if (e.r > 1e-9) segs.push({ id: e.id, type: 'circle', c: P(e.c), r: e.r });
    } else if (e.type === 'arc') {
      const c = P(e.c), a = P(e.a), b = P(e.b);
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
      if (r < 1e-9) continue;
      const a1 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      const a2 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      segs.push({ id: e.id, type: 'arc', a, b, c, r, a1, sweep: ccwSweep(a1, a2) });
    } else if (e.type === 'spline') {
      const pts = e.pts.map(P);
      if (pts.length >= 2) segs.push({ id: e.id, type: 'spline', a: pts[0], b: pts[pts.length - 1], pts: sampleSpline(pts) });
    }
  }
  return segs;
}

// Discretise one segment into a polyline (in drawing direction a -> b).
export function segPoints(s, maxAngle = Math.PI / 24) {
  if (s.type === 'line') return [s.a, s.b];
  if (s.type === 'spline') return s.pts;
  if (s.type === 'circle') {
    const n = 72, out = [];
    for (let i = 0; i <= n; i++) out.push([s.c[0] + s.r * Math.cos((i / n) * TAU), s.c[1] + s.r * Math.sin((i / n) * TAU)]);
    return out;
  }
  const n = Math.max(2, Math.ceil(s.sweep / maxAngle));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = s.a1 + (s.sweep * i) / n;
    out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
  }
  out[0] = s.a;
  out[n] = s.b;
  return out;
}

export function arcMid(s) {
  const t = s.a1 + s.sweep / 2;
  return [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
}

function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Chain segments into closed loops and open chains.
export function findLoops(segs, tol = 1e-5) {
  const verts = [];
  const vid = (p) => {
    for (let i = 0; i < verts.length; i++) if (Math.abs(verts[i][0] - p[0]) < tol && Math.abs(verts[i][1] - p[1]) < tol) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const loops = [], open = [];
  const edges = [];
  for (const s of segs) {
    if (s.type === 'circle') {
      const poly = segPoints(s).slice(0, -1);
      loops.push({ items: [{ seg: s, rev: false }], poly, area: Math.abs(polyArea(poly)) });
    } else {
      edges.push({ s, va: vid(s.a), vb: vid(s.b), used: false });
    }
  }
  const adj = verts.map(() => []);
  edges.forEach((e, i) => {
    adj[e.va].push(i);
    adj[e.vb].push(i);
  });
  const nextEdge = (v, from) => {
    if (adj[v].length !== 2) return -1;
    const o = adj[v][0] === from ? adj[v][1] : adj[v][0];
    return edges[o].used ? -1 : o;
  };
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].used) continue;
    const e0 = edges[i];
    e0.used = true;
    const chain = [{ seg: e0.s, rev: false }];
    let closed = e0.va === e0.vb;
    // extend forward from vb
    let v = e0.vb, cur = i;
    while (!closed) {
      const n = nextEdge(v, cur);
      if (n < 0) break;
      const e = edges[n];
      e.used = true;
      const rev = e.va !== v;
      chain.push({ seg: e.s, rev });
      v = rev ? e.va : e.vb;
      cur = n;
      if (v === e0.va) closed = true;
    }
    if (!closed) {
      // extend backward from va
      v = e0.va;
      cur = i;
      for (;;) {
        const n = nextEdge(v, cur);
        if (n < 0) break;
        const e = edges[n];
        e.used = true;
        const rev = e.vb !== v; // we arrive at its b when walking backwards
        chain.unshift({ seg: e.s, rev });
        v = rev ? e.vb : e.va;
        cur = n;
      }
    }
    const poly = chainPoly(chain);
    if (closed) {
      poly.pop();
      loops.push({ items: chain, poly, area: Math.abs(polyArea(poly)) });
    } else open.push({ items: chain, poly });
  }
  return { loops, open };
}

export function chainPoly(items) {
  const poly = [];
  for (const it of items) {
    let pts = segPoints(it.seg);
    if (it.rev) pts = [...pts].reverse();
    if (poly.length) pts = pts.slice(1);
    poly.push(...pts);
  }
  return poly;
}

// Nest loops by containment: even depth = material boundary, odd depth = hole of its parent.
export function buildRegions(loops) {
  const depth = loops.map((l, i) => {
    let d = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && loops[j].area > l.area && pointInPoly(l.poly[0], loops[j].poly)) d++;
    return d;
  });
  const regions = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && pointInPoly(h.poly[0], l.poly));
    regions.push({ outer: l, holes });
  });
  return regions;
}

export function evalSketchProfile(sk) {
  const segs = sketchSegments(sk);
  const { loops, open } = findLoops(segs);
  return { segs, loops, open, regions: buildRegions(loops) };
}
