// SOQUA design - 2D geometric constraint solver.
// Pure JS, zero dependencies, runs in the browser and in node.
//
// Method: Levenberg-Marquardt on the stacked residual vector of all hard
// constraints. The sketch is split into connected components (constraints that
// share unknowns); each component is solved on its own. For under-constrained
// components (rows <= unknowns) the damped *minimum-norm* step
//     dx = W J^T (J W J^T + lambda*diag)^-1 (-r)
// is used, which is algebraically the LM step but only needs an m x m solve and
// moves the geometry as little as possible. Over-determined components use the
// classic (J^T J + lambda*diag) dx = -J^T r. Both are factored with a dense
// envelope (skyline) Cholesky after a Cuthill-McKee reordering.
//
// Dragging: the dragged point (or circle radius) is placed on the cursor and
// given a very high movement cost (W small), so the rest of the sketch adapts
// to it and it only moves back when the hard constraints force it to.

const EPS = 1e-12;
const FINE_TOL = 1e-22;      // internal polish target on the squared residual
const FAIL_TOL = 1e-6;       // |residual| above this => constraint reported as failed
const RANK_TOL = 1e-7;       // relative pivot threshold for numeric rank
const DRAG_WINV = 1e-4;      // inverse movement cost of dragged unknowns
const LAMBDA_MIN = 1e-10;
const LAMBDA_MAX = 1e10;
const TWO_PI = 2 * Math.PI;

function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  return a - TWO_PI * Math.round(a / TWO_PI);
}

function len(v, a, b) {
  return Math.hypot(v[b] - v[a], v[b + 1] - v[a + 1]);
}

/** signed distance of point p from the infinite line a-b (positive on the left of a->b) */
function sdist(v, p, a, b) {
  const dx = v[b] - v[a], dy = v[b + 1] - v[a + 1];
  const L = Math.hypot(dx, dy);
  if (L < EPS) return 0;
  return (dx * (v[p + 1] - v[a + 1]) - dy * (v[p] - v[a])) / L;
}

function uniq(arr) {
  const out = [];
  for (const x of arr) if (out.indexOf(x) < 0) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// Model: parameters + residual closures
// ---------------------------------------------------------------------------

function buildModel(sketch) {
  const pts = sketch.pts || {};
  const ents = sketch.ents || [];
  const cons = sketch.cons || [];
  const H = { t: 1 };                       // homotopy parameter for dimension continuation

  const ptIds = Object.keys(pts);
  const pIdx = new Map();
  ptIds.forEach((id, i) => pIdx.set(id, 2 * i));
  const np = 2 * ptIds.length;

  const entById = new Map();
  const circles = [];
  const rIdx = new Map();
  for (const e of ents) {
    if (!e) continue;
    entById.set(e.id, e);
    if (e.type === 'circle') {
      rIdx.set(e.id, np + circles.length);
      circles.push(e);
    }
  }
  const nParam = np + circles.length;
  const v = new Float64Array(nParam);
  const fixed = new Uint8Array(nParam);
  ptIds.forEach((id, i) => {
    const p = pts[id];
    v[2 * i] = Number.isFinite(p.x) ? p.x : 0;
    v[2 * i + 1] = Number.isFinite(p.y) ? p.y : 0;
    if (p.fixed) fixed[2 * i] = fixed[2 * i + 1] = 1;
  });
  circles.forEach((e, i) => { v[np + i] = Number.isFinite(e.r) ? e.r : 0; });
  for (const c of cons) {
    if (c && c.type === 'fix' && pIdx.has(c.p)) {
      const i = pIdx.get(c.p);
      fixed[i] = fixed[i + 1] = 1;
    }
  }

  const res = [];
  const add = (cid, f, deps) => res.push({ cid, f, deps: uniq(deps) });
  // dimension residual: meas(v) - value, with the value stepped from its
  // current measurement to the target as H.t goes 0 -> 1 (continuation).
  const dim = (cid, meas, deps, target) => {
    let m0 = meas(v);
    if (!Number.isFinite(m0)) m0 = target;
    const d = target - m0;
    add(cid, (s) => meas(s) - (m0 + d * H.t), deps);
  };

  const P = (id) => (pIdx.has(id) ? pIdx.get(id) : -1);
  const XY = (i) => [i, i + 1];
  const LN = (id) => {
    const e = entById.get(id);
    if (!e || e.type !== 'line') return null;
    const a = P(e.a), b = P(e.b);
    if (a < 0 || b < 0) return null;
    return { a, b, deps: [a, a + 1, b, b + 1] };
  };
  // circle-like: circle (radius is its own parameter) or arc (radius = |c-a|)
  const CL = (id) => {
    const e = entById.get(id);
    if (!e) return null;
    const c = P(e.c);
    if (c < 0) return null;
    if (e.type === 'circle') {
      const ri = rIdx.get(e.id);
      return { c, rad: (s) => s[ri], deps: [c, c + 1, ri] };
    }
    if (e.type === 'arc') {
      const a = P(e.a);
      if (a < 0) return null;
      return { c, rad: (s) => len(s, c, a), deps: [c, c + 1, a, a + 1] };
    }
    return null;
  };
  const pair = (c) => {
    if (c.line !== undefined && c.line !== null) {
      const l = LN(c.line);
      return l ? [l.a, l.b] : null;
    }
    const p = P(c.p), q = P(c.q);
    return p < 0 || q < 0 ? null : [p, q];
  };
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : (Number.isFinite(parseFloat(x)) ? parseFloat(x) : NaN));

  for (const c of cons) {
    if (!c) continue;
    const id = c.id;
    switch (c.type) {
      case 'coincident': {
        const p = P(c.p), q = P(c.q);
        if (p < 0 || q < 0 || p === q) break;
        add(id, (s) => s[p] - s[q], [p, q]);
        add(id, (s) => s[p + 1] - s[q + 1], [p + 1, q + 1]);
        break;
      }
      case 'pointOnLine': {
        const p = P(c.p), l = LN(c.line);
        if (p < 0 || !l) break;
        add(id, (s) => sdist(s, p, l.a, l.b), [...XY(p), ...l.deps]);
        break;
      }
      case 'pointOnCircle': {
        const p = P(c.p), e = CL(c.ent);
        if (p < 0 || !e) break;
        add(id, (s) => len(s, p, e.c) - e.rad(s), [...XY(p), ...e.deps]);
        break;
      }
      case 'midpoint': {
        const p = P(c.p), l = LN(c.line);
        if (p < 0 || !l) break;
        add(id, (s) => s[p] - 0.5 * (s[l.a] + s[l.b]), [p, l.a, l.b]);
        add(id, (s) => s[p + 1] - 0.5 * (s[l.a + 1] + s[l.b + 1]), [p + 1, l.a + 1, l.b + 1]);
        break;
      }
      case 'horizontal': {
        const pr = pair(c);
        if (!pr) break;
        const [a, b] = pr;
        add(id, (s) => s[b + 1] - s[a + 1], [a + 1, b + 1]);
        break;
      }
      case 'vertical': {
        const pr = pair(c);
        if (!pr) break;
        const [a, b] = pr;
        add(id, (s) => s[b] - s[a], [a, b]);
        break;
      }
      case 'parallel':
      case 'perpendicular':
      case 'angle': {
        const l1 = LN(c.l1), l2 = LN(c.l2);
        if (!l1 || !l2) break;
        // constant length scale so the (dimensionless) angular residual is in
        // model units and converges together with length constraints
        const g0 = Math.sqrt(len(v, l1.a, l1.b) * len(v, l2.a, l2.b));
        const s0 = g0 > 1e-9 ? g0 : 1;
        const deps = [...l1.deps, ...l2.deps];
        if (c.type === 'angle') {
          const val = num(c.value);
          if (!Number.isFinite(val)) break;
          const theta = (s) => {
            const ux = s[l1.b] - s[l1.a], uy = s[l1.b + 1] - s[l1.a + 1];
            const wx = s[l2.b] - s[l2.a], wy = s[l2.b + 1] - s[l2.a + 1];
            return Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
          };
          const al = (val * Math.PI) / 180;
          const t0 = theta(v);
          const d1 = wrapPi(al - t0), d2 = wrapPi(-al - t0);
          const delta = Math.abs(d1) <= Math.abs(d2) ? d1 : d2;   // nearest branch
          add(id, (s) => s0 * wrapPi(theta(s) - t0 - delta * H.t), deps);
        } else {
          const par = c.type === 'parallel';
          add(id, (s) => {
            const ux = s[l1.b] - s[l1.a], uy = s[l1.b + 1] - s[l1.a + 1];
            const wx = s[l2.b] - s[l2.a], wy = s[l2.b + 1] - s[l2.a + 1];
            const den = Math.hypot(ux, uy) * Math.hypot(wx, wy);
            if (den < EPS) return 0;
            return (s0 * (par ? ux * wy - uy * wx : ux * wx + uy * wy)) / den;
          }, deps);
        }
        break;
      }
      case 'collinear': {
        const l1 = LN(c.l1), l2 = LN(c.l2);
        if (!l1 || !l2) break;
        add(id, (s) => sdist(s, l2.a, l1.a, l1.b), [...XY(l2.a), ...l1.deps]);
        add(id, (s) => sdist(s, l2.b, l1.a, l1.b), [...XY(l2.b), ...l1.deps]);
        break;
      }
      case 'equal': {
        const l1 = LN(c.e1), l2 = LN(c.e2);
        if (l1 && l2) {
          add(id, (s) => len(s, l1.a, l1.b) - len(s, l2.a, l2.b), [...l1.deps, ...l2.deps]);
          break;
        }
        const c1 = CL(c.e1), c2 = CL(c.e2);
        if (c1 && c2) add(id, (s) => c1.rad(s) - c2.rad(s), [...c1.deps, ...c2.deps]);
        break;
      }
      case 'tangent': {
        let l = LN(c.e1), e = CL(c.e2);
        if (!l || !e) { l = LN(c.e2); e = CL(c.e1); }
        if (l && e) {
          // keep the centre on the side of the line where it currently is
          const sg = sdist(v, e.c, l.a, l.b) < 0 ? -1 : 1;
          add(id, (s) => sg * sdist(s, e.c, l.a, l.b) - e.rad(s), [...l.deps, ...e.deps]);
          break;
        }
        const c1 = CL(c.e1), c2 = CL(c.e2);
        if (c1 && c2) {
          const d = len(v, c1.c, c2.c), r1 = c1.rad(v), r2 = c2.rad(v);
          const deps = [...c1.deps, ...c2.deps];
          if (Math.abs(d - (r1 + r2)) <= Math.abs(d - Math.abs(r1 - r2))) {
            add(id, (s) => len(s, c1.c, c2.c) - (c1.rad(s) + c2.rad(s)), deps);       // external
          } else {
            const sg = r1 >= r2 ? 1 : -1;
            add(id, (s) => len(s, c1.c, c2.c) - sg * (c1.rad(s) - c2.rad(s)), deps);  // internal
          }
        }
        break;
      }
      case 'concentric': {
        const c1 = CL(c.e1), c2 = CL(c.e2);
        if (!c1 || !c2 || c1.c === c2.c) break;
        add(id, (s) => s[c1.c] - s[c2.c], [c1.c, c2.c]);
        add(id, (s) => s[c1.c + 1] - s[c2.c + 1], [c1.c + 1, c2.c + 1]);
        break;
      }
      case 'symmetric': {
        const p = P(c.p), q = P(c.q), l = LN(c.line);
        if (p < 0 || q < 0 || !l) break;
        const deps = [...XY(p), ...XY(q), ...l.deps];
        // midpoint of p,q lies on the line
        add(id, (s) => {
          const dx = s[l.b] - s[l.a], dy = s[l.b + 1] - s[l.a + 1];
          const L = Math.hypot(dx, dy);
          if (L < EPS) return 0;
          const mx = 0.5 * (s[p] + s[q]) - s[l.a], my = 0.5 * (s[p + 1] + s[q + 1]) - s[l.a + 1];
          return (dx * my - dy * mx) / L;
        }, deps);
        // p->q is perpendicular to the line
        add(id, (s) => {
          const dx = s[l.b] - s[l.a], dy = s[l.b + 1] - s[l.a + 1];
          const L = Math.hypot(dx, dy);
          if (L < EPS) return 0;
          return ((s[q] - s[p]) * dx + (s[q + 1] - s[p + 1]) * dy) / L;
        }, deps);
        break;
      }
      case 'distance': {
        const p = P(c.p), q = P(c.q), val = num(c.value);
        if (p < 0 || q < 0 || !Number.isFinite(val)) break;
        dim(id, (s) => len(s, p, q), [...XY(p), ...XY(q)], Math.abs(val));
        break;
      }
      case 'hdistance':
      case 'vdistance': {
        const p = P(c.p), q = P(c.q), val = num(c.value);
        if (p < 0 || q < 0 || !Number.isFinite(val)) break;
        const o = c.type === 'hdistance' ? 0 : 1;
        const sg = v[q + o] - v[p + o] < 0 ? -1 : 1;     // keep the current sign
        dim(id, (s) => s[q + o] - s[p + o], [p + o, q + o], sg * Math.abs(val));
        break;
      }
      case 'length': {
        const l = LN(c.line), val = num(c.value);
        if (!l || !Number.isFinite(val)) break;
        dim(id, (s) => len(s, l.a, l.b), l.deps, Math.abs(val));
        break;
      }
      case 'pointLineDistance': {
        const p = P(c.p), l = LN(c.line), val = num(c.value);
        if (p < 0 || !l || !Number.isFinite(val)) break;
        const sg = sdist(v, p, l.a, l.b) < 0 ? -1 : 1;   // keep the current side
        dim(id, (s) => sdist(s, p, l.a, l.b), [...XY(p), ...l.deps], sg * Math.abs(val));
        break;
      }
      case 'radius':
      case 'diameter': {
        const e = CL(c.ent), val = num(c.value);
        if (!e || !Number.isFinite(val)) break;
        dim(id, e.rad, e.deps, c.type === 'radius' ? Math.abs(val) : Math.abs(val) / 2);
        break;
      }
      default:
        break; // 'fix' handled above; unknown types are ignored
    }
  }

  // implicit: every arc has |c-a| = |c-b|
  for (const e of ents) {
    if (!e || e.type !== 'arc') continue;
    const c = P(e.c), a = P(e.a), b = P(e.b);
    if (c < 0 || a < 0 || b < 0 || a === b) continue;
    add(null, (s) => len(s, c, a) - len(s, c, b), [...XY(c), ...XY(a), ...XY(b)]);
  }

  return { v, fixed, res, H, np, ptIds, pIdx, circles, rIdx };
}

// ---------------------------------------------------------------------------
// Structure: unknown numbering, connected components
// ---------------------------------------------------------------------------

function prepare(model, wInvParam) {
  const { v, fixed, res } = model;
  const nParam = v.length;
  const uIdx = new Int32Array(nParam).fill(-1);
  const uParam = [];
  for (let i = 0; i < nParam; i++) if (!fixed[i]) { uIdx[i] = uParam.length; uParam.push(i); }
  const nU = uParam.length;

  const parent = new Int32Array(nU);
  for (let i = 0; i < nU; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };

  const constRows = [];
  const fdeps = new Array(res.length);
  for (let i = 0; i < res.length; i++) {
    const fd = res[i].deps.filter((d) => !fixed[d]);
    fdeps[i] = fd;
    if (!fd.length) { constRows.push(i); continue; }
    const r0 = find(uIdx[fd[0]]);
    for (let k = 1; k < fd.length; k++) {
      const rk = find(uIdx[fd[k]]);
      if (rk !== r0) parent[rk] = r0;
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < res.length; i++) {
    if (!fdeps[i].length) continue;
    const root = find(uIdx[fdeps[i][0]]);
    let comp = byRoot.get(root);
    if (!comp) { comp = { rows: [], vars: [] }; byRoot.set(root, comp); }
    comp.rows.push(i);
  }
  const loc = new Int32Array(nU);
  for (let k = 0; k < nU; k++) {
    const comp = byRoot.get(find(k));
    if (comp) { loc[k] = comp.vars.length; comp.vars.push(k); }
  }
  const comps = [...byRoot.values()];
  for (const comp of comps) {
    const m = comp.rows.length, n = comp.vars.length;
    comp.m = m; comp.n = n;
    comp.varParam = Int32Array.from(comp.vars, (k) => uParam[k]);
    comp.wInv = Float64Array.from(comp.varParam, (p) => (wInvParam ? wInvParam[p] : 1));
    comp.f = comp.rows.map((i) => res[i].f);
    comp.rowParams = comp.rows.map((i) => Int32Array.from(fdeps[i]));
    comp.rowCols = comp.rows.map((i) => Int32Array.from(fdeps[i], (d) => loc[uIdx[d]]));
    comp.rowVals = comp.rows.map((i) => new Float64Array(fdeps[i].length));
    comp.r = new Float64Array(m);
    comp.lin = null;
  }
  return { nU, comps, constRows };
}

function evalComp(comp, v, out) {
  const f = comp.f;
  let s = 0;
  for (let i = 0; i < f.length; i++) {
    const x = f[i](v);
    out[i] = x;
    s += x * x;
  }
  return s;
}

/** finite-difference Jacobian (4-point central stencil, step scaled per residual) */
function jacobian(comp, model) {
  const { v, np } = model;
  const m = comp.m;
  for (let i = 0; i < m; i++) {
    const f = comp.f[i], params = comp.rowParams[i], vals = comp.rowVals[i];
    // characteristic size of the geometry this residual touches
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, rr = 0;
    for (let p = 0; p < params.length; p++) {
      const d = params[p], x = v[d];
      if (d >= np) { if (Math.abs(x) > rr) rr = Math.abs(x); }
      else if (d & 1) { if (x < y0) y0 = x; if (x > y1) y1 = x; }
      else { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    let ell = Math.max(x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0, rr);
    if (!(ell > 1e-9) || !Number.isFinite(ell)) ell = 1;
    const h = 1e-3 * ell;
    for (let p = 0; p < params.length; p++) {
      const d = params[p], x = v[d];
      v[d] = x + h; const f1 = f(v);
      v[d] = x - h; const f2 = f(v);
      v[d] = x + 2 * h; const f3 = f(v);
      v[d] = x - 2 * h; const f4 = f(v);
      v[d] = x;
      const g = (8 * (f1 - f2) - (f3 - f4)) / (12 * h);
      vals[p] = Number.isFinite(g) ? g : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Linear algebra: Cuthill-McKee ordering + dense envelope Cholesky
// ---------------------------------------------------------------------------

function setupLinear(comp) {
  const m = comp.m, n = comp.n;
  const dual = m <= n;
  const N = dual ? m : n;
  // The system matrix is sum over "groups" g of a_g a_g^T.
  //  dual:   one group per unknown (its column of J), nodes are rows
  //  primal: one group per row of J, nodes are unknowns
  let gNodes, gRow, gPos;
  if (dual) {
    gNodes = Array.from({ length: n }, () => []);
    gRow = Array.from({ length: n }, () => []);
    gPos = Array.from({ length: n }, () => []);
    for (let i = 0; i < m; i++) {
      const cols = comp.rowCols[i];
      for (let p = 0; p < cols.length; p++) {
        gNodes[cols[p]].push(i); gRow[cols[p]].push(i); gPos[cols[p]].push(p);
      }
    }
  } else {
    gNodes = comp.rowCols.map((c) => Array.from(c));
    gRow = comp.rowCols.map((c, i) => Array.from(c, () => i));
    gPos = comp.rowCols.map((c) => Array.from(c, (_, p) => p));
  }

  // adjacency
  const nodeGroups = Array.from({ length: N }, () => []);
  for (let g = 0; g < gNodes.length; g++) for (const x of gNodes[g]) nodeGroups[x].push(g);
  const mark = new Int32Array(N).fill(-1);
  const adj = new Array(N);
  for (let x = 0; x < N; x++) {
    const a = [];
    mark[x] = x;
    for (const g of nodeGroups[x]) for (const y of gNodes[g]) if (mark[y] !== x) { mark[y] = x; a.push(y); }
    adj[x] = a;
  }
  // reverse Cuthill-McKee
  const order = [];
  const seen = new Uint8Array(N);
  const byDeg = (a, b) => adj[a].length - adj[b].length;
  const nodes = Array.from({ length: N }, (_, i) => i).sort(byDeg);
  for (const start of nodes) {
    if (seen[start]) continue;
    seen[start] = 1;
    let head = order.length;
    order.push(start);
    while (head < order.length) {
      const x = order[head++];
      const nb = adj[x].filter((y) => !seen[y]).sort(byDeg);
      for (const y of nb) { seen[y] = 1; order.push(y); }
    }
  }
  order.reverse();
  const pos = new Int32Array(N);
  for (let k = 0; k < N; k++) pos[order[k]] = k;
  const first = new Int32Array(N);
  for (let x = 0; x < N; x++) {
    let f = pos[x];
    for (const y of adj[x]) if (pos[y] < f) f = pos[y];
    first[pos[x]] = f;
  }

  comp.lin = {
    dual, N, pos, first,
    gIdx: gNodes.map((a) => Int32Array.from(a, (x) => pos[x])),
    gRow: gRow.map((a) => Int32Array.from(a)),
    gPos: gPos.map((a) => Int32Array.from(a)),
    M: new Float64Array(N * N),
    L: new Float64Array(N * N),
    damp: new Float64Array(N),
    rhs: new Float64Array(N),
    y: new Float64Array(N),
    tmp: new Float64Array(16),
  };
}

function assemble(comp) {
  const lin = comp.lin;
  const { dual, N, M, gIdx, gRow, gPos, pos, rhs, damp } = lin;
  M.fill(0);
  for (let g = 0; g < gIdx.length; g++) {
    const idx = gIdx[g], rows = gRow[g], ps = gPos[g], k = idx.length;
    if (lin.tmp.length < k) lin.tmp = new Float64Array(2 * k);
    const a = lin.tmp;
    const w = dual ? comp.wInv[g] : 1;
    for (let t = 0; t < k; t++) a[t] = comp.rowVals[rows[t]][ps[t]];
    for (let t = 0; t < k; t++) {
      const pt = idx[t], at = a[t] * w;
      if (at === 0) continue;
      for (let u = 0; u < k; u++) {
        const pu = idx[u];
        if (pu <= pt) M[pt * N + pu] += at * a[u];
      }
    }
  }
  let maxD = 0;
  for (let i = 0; i < N; i++) if (M[i * N + i] > maxD) maxD = M[i * N + i];
  const floor = Math.max(1e-9 * maxD, 1e-30);
  if (dual) {
    for (let i = 0; i < N; i++) { damp[i] = Math.max(M[i * N + i], floor); }
    for (let i = 0; i < comp.m; i++) rhs[pos[i]] = -comp.r[i];
  } else {
    for (let j = 0; j < N; j++) damp[pos[j]] = Math.max(M[pos[j] * N + pos[j]], floor) / comp.wInv[j];
    rhs.fill(0);
    for (let i = 0; i < comp.m; i++) {
      const cols = comp.rowCols[i], vals = comp.rowVals[i], ri = comp.r[i];
      for (let p = 0; p < cols.length; p++) rhs[pos[cols[p]]] -= vals[p] * ri;
    }
  }
}

/** in-place envelope Cholesky of the lower triangle; false if not positive definite */
function cholesky(L, N, first) {
  for (let i = 0; i < N; i++) {
    const fi = first[i], iN = i * N;
    for (let j = fi; j < i; j++) {
      const jN = j * N, fj = first[j];
      let s = L[iN + j];
      for (let k = fi > fj ? fi : fj; k < j; k++) s -= L[iN + k] * L[jN + k];
      L[iN + j] = s / L[jN + j];
    }
    let s = L[iN + i];
    for (let k = fi; k < i; k++) s -= L[iN + k] * L[iN + k];
    if (!(s > 0) || !Number.isFinite(s)) return false;
    L[iN + i] = Math.sqrt(s);
  }
  return true;
}

function cholSolve(L, N, first, b, y) {
  for (let i = 0; i < N; i++) {
    let s = b[i];
    const iN = i * N;
    for (let k = first[i]; k < i; k++) s -= L[iN + k] * y[k];
    y[i] = s / L[iN + i];
  }
  for (let i = N - 1; i >= 0; i--) {
    const iN = i * N;
    const x = y[i] / L[iN + i];
    y[i] = x;
    for (let k = first[i]; k < i; k++) y[k] -= L[iN + k] * x;
  }
}

// ---------------------------------------------------------------------------
// Levenberg-Marquardt on one component
// ---------------------------------------------------------------------------

function solveComp(comp, model, maxIter, tol) {
  const v = model.v;
  const { m, n, varParam } = comp;
  let cost = evalComp(comp, v, comp.r);
  if (!(cost > FINE_TOL)) return { cost, iters: 0 };
  if (!Number.isFinite(cost)) return { cost: Infinity, iters: 0 };
  if (!comp.lin) setupLinear(comp);
  const lin = comp.lin;
  const { N, L, M, damp, rhs, y, first, pos, dual } = lin;
  const x0 = new Float64Array(n), dx = new Float64Array(n), rNew = new Float64Array(m);
  let lambda = 1e-7, iters = 0, slow = 0;

  while (iters < maxIter && cost > FINE_TOL) {
    iters++;
    jacobian(comp, model);
    assemble(comp);
    for (let j = 0; j < n; j++) x0[j] = v[varParam[j]];
    let accepted = false, costNew = cost;
    for (let tries = 0; tries < 24 && lambda <= LAMBDA_MAX; tries++) {
      L.set(M);
      for (let i = 0; i < N; i++) L[i * N + i] += lambda * damp[i];
      if (!cholesky(L, N, first)) { lambda *= 10; continue; }
      cholSolve(L, N, first, rhs, y);
      if (dual) {
        dx.fill(0);
        for (let i = 0; i < m; i++) {
          const cols = comp.rowCols[i], vals = comp.rowVals[i], yi = y[pos[i]];
          for (let p = 0; p < cols.length; p++) dx[cols[p]] += vals[p] * yi;
        }
        for (let j = 0; j < n; j++) dx[j] *= comp.wInv[j];
      } else {
        for (let j = 0; j < n; j++) dx[j] = y[pos[j]];
      }
      for (let j = 0; j < n; j++) v[varParam[j]] = x0[j] + dx[j];
      costNew = evalComp(comp, v, rNew);
      if (costNew < cost) { accepted = true; break; }
      lambda *= 10;
    }
    if (!accepted) {
      for (let j = 0; j < n; j++) v[varParam[j]] = x0[j];
      break;
    }
    slow = cost - costNew < 1e-3 * cost ? slow + 1 : 0;
    cost = costNew;
    comp.r.set(rNew);
    lambda = Math.max(lambda * 0.1, LAMBDA_MIN);
    if (slow >= 5 && cost > tol) break;      // stagnated on an inconsistent system
    if (slow >= 2 && cost <= tol) break;     // at the rounding floor
  }
  return { cost, iters };
}

function solveAll(model, prep, maxIter, tol) {
  const { v, res } = model;
  let cost = 0, iters = 0;
  for (const i of prep.constRows) { const x = res[i].f(v); cost += x * x; }
  for (const comp of prep.comps) {
    const o = solveComp(comp, model, maxIter, tol);
    cost += o.cost;
    iters += o.iters;
  }
  if (Number.isNaN(cost)) cost = Infinity;
  return { cost, iters };
}

// ---------------------------------------------------------------------------
// Rank / degrees of freedom
// ---------------------------------------------------------------------------

/** numeric rank of a component's Jacobian (row elimination with column pivoting) */
function compRank(comp) {
  const { m, n } = comp;
  const rows = [];
  let maxNorm = 0;
  for (let i = 0; i < m; i++) {
    const d = new Float64Array(n);
    const cols = comp.rowCols[i], vals = comp.rowVals[i];
    let s = 0;
    for (let p = 0; p < cols.length; p++) d[cols[p]] += vals[p];
    for (let p = 0; p < cols.length; p++) s += d[cols[p]] * d[cols[p]];
    // (duplicate columns cannot occur: deps are unique)
    const nrm = Math.sqrt(s);
    if (nrm > maxNorm) maxNorm = nrm;
    rows.push({ d, nrm });
  }
  const piv = [], pcol = [];
  for (const { d, nrm } of rows) {
    if (!(nrm > 1e-9 * maxNorm) || !(nrm > 0)) continue;
    const inv = 1 / nrm;
    for (let j = 0; j < n; j++) d[j] *= inv;
    for (let k = 0; k < piv.length; k++) {
      const c = d[pcol[k]];
      if (c === 0) continue;
      const pr = piv[k];
      for (let j = 0; j < n; j++) d[j] -= c * pr[j];
      d[pcol[k]] = 0;
    }
    let best = 0, bj = -1;
    for (let j = 0; j < n; j++) { const a = Math.abs(d[j]); if (a > best) { best = a; bj = j; } }
    if (best > RANK_TOL) {
      const s = 1 / d[bj];
      for (let j = 0; j < n; j++) d[j] *= s;
      piv.push(d); pcol.push(bj);
      if (piv.length === n) break;
    }
  }
  return piv.length;
}

function rankInfo(model, prep) {
  let rank = 0, eqs = prep.constRows.length;
  for (const comp of prep.comps) {
    jacobian(comp, model);
    rank += compRank(comp);
    eqs += comp.m;
  }
  return { dof: prep.nU - rank, rank, equations: eqs, redundant: eqs - rank };
}

function collectFailed(model) {
  const out = [];
  const seen = new Set();
  for (const r of model.res) {
    if (r.cid === null || r.cid === undefined || seen.has(r.cid)) continue;
    const x = r.f(model.v);
    if (!(Math.abs(x) <= FAIL_TOL)) { seen.add(r.cid); out.push(r.cid); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Solve the sketch in place.
 * @param {object} sketch  { pts, ents, cons }
 * @param {object} [opts]
 * @param {{p:string,x:number,y:number}|{ent:string,r:number}} [opts.drag]
 * @param {number} [opts.maxIter=60]
 * @param {number} [opts.tol=1e-9]   on the summed squared residual
 * @param {boolean} [opts.dof=true]  pass false to skip the rank computation (dof is then -1)
 * @returns {{ok:boolean,residual:number,iterations:number,dof:number,failed:string[]}}
 */
export function solveSketch(sketch, opts = {}) {
  const maxIter = opts.maxIter ?? 60;
  const tol = opts.tol ?? 1e-9;
  const model = buildModel(sketch);
  const { v, H, fixed } = model;
  const orig = Float64Array.from(v);

  // drag goals
  const drags = [];
  const wInv = new Float64Array(v.length).fill(1);
  const dr = opts.drag;
  if (dr) {
    if (dr.p !== undefined && model.pIdx.has(dr.p)) {
      const i = model.pIdx.get(dr.p);
      if (!fixed[i] && Number.isFinite(dr.x) && Number.isFinite(dr.y)) {
        drags.push({ i, target: dr.x }, { i: i + 1, target: dr.y });
      }
    }
    if (dr.ent !== undefined && model.rIdx.has(dr.ent) && Number.isFinite(dr.r)) {
      drags.push({ i: model.rIdx.get(dr.ent), target: Math.abs(dr.r) });
    }
    for (const d of drags) wInv[d.i] = DRAG_WINV;
  }

  const prep = prepare(model, wInv);
  const setState = (t) => {
    H.t = t;
    for (const d of drags) v[d.i] = orig[d.i] + (d.target - orig[d.i]) * t;
  };

  setState(1);
  let out = solveAll(model, prep, maxIter, tol);
  let iterations = out.iters;
  let ok = out.cost <= tol;
  let failed = [];
  const firstCost = out.cost;

  if (!ok) {
    failed = collectFailed(model);
    // continuation: walk dimensions / drag target from the current state in steps
    for (const steps of [4, 16]) {
      v.set(orig);
      let good = true;
      for (let k = 1; k <= steps; k++) {
        setState(k / steps);
        out = solveAll(model, prep, maxIter, tol);
        iterations += out.iters;
        if (!(out.cost <= tol)) { good = false; break; }
      }
      if (good) { ok = true; break; }
    }
  }

  if (ok) for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) { ok = false; break; }

  if (!ok) {
    v.set(orig);
    H.t = 1;
    const dof = opts.dof === false ? -1 : rankInfo(model, prep).dof;
    if (!failed.length) failed = collectFailed(model);
    return { ok: false, residual: firstCost, iterations, dof, failed };
  }

  // write back
  const pts = sketch.pts;
  model.ptIds.forEach((id, k) => {
    if (fixed[2 * k]) return;
    pts[id].x = v[2 * k];
    pts[id].y = v[2 * k + 1];
  });
  model.circles.forEach((e, k) => { e.r = v[model.np + k]; });

  const dof = opts.dof === false ? -1 : rankInfo(model, prep).dof;
  return { ok: true, residual: out.cost, iterations, dof, failed: [] };
}

/** Remaining degrees of freedom at the current state (unknowns minus Jacobian rank). */
export function sketchDOF(sketch) {
  const model = buildModel(sketch);
  return rankInfo(model, prepare(model, null)).dof;
}

/**
 * @returns {{dof:number, overDefined:boolean, conflicting:string[], redundant:number}}
 * conflicting: constraints whose residual stays > 1e-6 after solving on a copy.
 * redundant:   number of constraint equations that add no rank (consistent duplicates
 *              or conflicting ones). overDefined = conflicting.length > 0 || redundant > 0.
 */
export function constraintStatus(sketch) {
  const copy = {
    pts: {},
    ents: (sketch.ents || []).map((e) => ({ ...e })),
    cons: sketch.cons || [],
  };
  for (const id of Object.keys(sketch.pts || {})) copy.pts[id] = { ...sketch.pts[id] };
  const r = solveSketch(copy, { dof: false });
  const model = buildModel(copy);            // solved state if ok, original state otherwise
  const info = rankInfo(model, prepare(model, null));
  const conflicting = r.ok ? [] : r.failed;
  return {
    dof: info.dof,
    overDefined: conflicting.length > 0 || info.redundant > 0,
    conflicting,
    redundant: info.redundant,
  };
}
