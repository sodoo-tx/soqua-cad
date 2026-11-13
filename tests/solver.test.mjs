import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSketch, sketchDOF, constraintStatus } from '../src/sketch/solver.js';

const TOL = 1e-6;
const near = (a, b, msg, tol = TOL) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || 'near'}: expected ${b}, got ${a}`);
const P = (s, id) => s.pts[id];
const dist = (s, p, q) => Math.hypot(P(s, q).x - P(s, p).x, P(s, q).y - P(s, p).y);
const ent = (s, id) => s.ents.find((e) => e.id === id);
const dir = (s, lid) => {
  const l = ent(s, lid);
  return [P(s, l.b).x - P(s, l.a).x, P(s, l.b).y - P(s, l.a).y];
};
const lineLen = (s, lid) => Math.hypot(...dir(s, lid));
const sdist = (s, pid, lid) => {
  const l = ent(s, lid), a = P(s, l.a), [dx, dy] = dir(s, lid), p = P(s, pid);
  return (dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.hypot(dx, dy);
};
const snapshot = (s) => JSON.stringify(s);
const solveOk = (s, opts) => {
  const r = solveSketch(s, opts);
  assert.equal(r.ok, true, `solve failed: ${JSON.stringify(r)}`);
  assert.ok(r.residual < 1e-12, `residual ${r.residual}`);
  for (const id of Object.keys(s.pts)) {
    assert.ok(Number.isFinite(s.pts[id].x) && Number.isFinite(s.pts[id].y), 'finite coords');
  }
  return r;
};

function rectangle() {
  return {
    pts: {
      p1: { x: 0, y: 0, fixed: true },
      p2: { x: 9, y: 1 },
      p3: { x: 11, y: 6 },
      p4: { x: -1, y: 5 },
    },
    ents: [
      { id: 'l1', type: 'line', a: 'p1', b: 'p2' },
      { id: 'l2', type: 'line', a: 'p2', b: 'p3' },
      { id: 'l3', type: 'line', a: 'p3', b: 'p4' },
      { id: 'l4', type: 'line', a: 'p4', b: 'p1' },
    ],
    cons: [
      { id: 'c1', type: 'horizontal', line: 'l1' },
      { id: 'c2', type: 'vertical', line: 'l2' },
      { id: 'c3', type: 'horizontal', line: 'l3' },
      { id: 'c4', type: 'vertical', line: 'l4' },
      { id: 'd1', type: 'length', line: 'l1', value: 10 },
      { id: 'd2', type: 'length', line: 'l2', value: 5 },
    ],
  };
}

// two free lines used by many single-constraint tests
function twoLines() {
  return {
    pts: {
      a: { x: 0, y: 0 }, b: { x: 10, y: 1 },
      c: { x: 2, y: 5 }, d: { x: 9, y: 9 },
    },
    ents: [
      { id: 'l1', type: 'line', a: 'a', b: 'b' },
      { id: 'l2', type: 'line', a: 'c', b: 'd' },
    ],
    cons: [],
  };
}

test('rectangle: dof 0, solves, re-solves after dimension change', () => {
  const s = rectangle();
  const r = solveOk(s);
  assert.equal(r.dof, 0);
  assert.equal(sketchDOF(s), 0);
  near(P(s, 'p2').x, 10); near(P(s, 'p2').y, 0);
  near(P(s, 'p3').x, 10); near(P(s, 'p3').y, 5);
  near(P(s, 'p4').x, 0); near(P(s, 'p4').y, 5);
  assert.deepEqual(P(s, 'p1'), { x: 0, y: 0, fixed: true });

  s.cons.find((c) => c.id === 'd1').value = 200;
  s.cons.find((c) => c.id === 'd2').value = 0.5;
  solveOk(s);
  near(P(s, 'p2').x, 200); near(P(s, 'p2').y, 0);
  near(P(s, 'p3').x, 200); near(P(s, 'p3').y, 0.5);
  near(P(s, 'p4').x, 0); near(P(s, 'p4').y, 0.5);
  const st = constraintStatus(s);
  assert.equal(st.dof, 0);
  assert.equal(st.overDefined, false);
  assert.deepEqual(st.conflicting, []);
});

test('coincident', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'coincident', p: 'b', q: 'c' });
  solveOk(s);
  near(dist(s, 'b', 'c'), 0);
});

test('pointOnLine', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'pointOnLine', p: 'c', line: 'l1' });
  solveOk(s);
  near(sdist(s, 'c', 'l1'), 0);
});

test('pointOnCircle (circle and arc)', () => {
  const s = {
    pts: { o: { x: 1, y: 1 }, p: { x: 7, y: 3 }, a: { x: 4, y: 1 }, b: { x: 1, y: 4.5 }, q: { x: 5, y: 6 } },
    ents: [
      { id: 'ci', type: 'circle', c: 'o', r: 4 },
      { id: 'ar', type: 'arc', c: 'o', a: 'a', b: 'b' },
    ],
    cons: [
      { id: 'k1', type: 'pointOnCircle', p: 'p', ent: 'ci' },
      { id: 'k2', type: 'pointOnCircle', p: 'q', ent: 'ar' },
    ],
  };
  solveOk(s);
  near(dist(s, 'o', 'p'), ent(s, 'ci').r);
  near(dist(s, 'o', 'q'), dist(s, 'o', 'a'));
  near(dist(s, 'o', 'a'), dist(s, 'o', 'b'), 'arc invariant');
});

test('midpoint', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'midpoint', p: 'c', line: 'l1' });
  solveOk(s);
  near(P(s, 'c').x, (P(s, 'a').x + P(s, 'b').x) / 2);
  near(P(s, 'c').y, (P(s, 'a').y + P(s, 'b').y) / 2);
});

test('horizontal / vertical (line form and point-pair form)', () => {
  const s = twoLines();
  s.cons.push({ id: 'h', type: 'horizontal', line: 'l1' });
  s.cons.push({ id: 'v', type: 'vertical', line: 'l2' });
  s.cons.push({ id: 'h2', type: 'horizontal', p: 'a', q: 'c' });
  s.cons.push({ id: 'v2', type: 'vertical', p: 'b', q: 'd' });
  solveOk(s);
  near(P(s, 'a').y, P(s, 'b').y);
  near(P(s, 'c').x, P(s, 'd').x);
  near(P(s, 'a').y, P(s, 'c').y);
  near(P(s, 'b').x, P(s, 'd').x);
});

test('parallel', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'parallel', l1: 'l1', l2: 'l2' });
  solveOk(s);
  const [ux, uy] = dir(s, 'l1'), [wx, wy] = dir(s, 'l2');
  near((ux * wy - uy * wx) / (Math.hypot(ux, uy) * Math.hypot(wx, wy)), 0);
});

test('perpendicular', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'perpendicular', l1: 'l1', l2: 'l2' });
  solveOk(s);
  const [ux, uy] = dir(s, 'l1'), [wx, wy] = dir(s, 'l2');
  near((ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy)), 0);
});

test('collinear', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'collinear', l1: 'l1', l2: 'l2' });
  solveOk(s);
  near(sdist(s, 'c', 'l1'), 0);
  near(sdist(s, 'd', 'l1'), 0);
});

test('equal: lines, circles, circle+arc', () => {
  const s = twoLines();
  Object.assign(s.pts, { o1: { x: 20, y: 0 }, o2: { x: 30, y: 0 }, o3: { x: 40, y: 0 }, e: { x: 43, y: 0 }, f: { x: 40, y: 3.3 } });
  s.ents.push(
    { id: 'c1', type: 'circle', c: 'o1', r: 2 },
    { id: 'c2', type: 'circle', c: 'o2', r: 5 },
    { id: 'ar', type: 'arc', c: 'o3', a: 'e', b: 'f' },
  );
  s.cons.push({ id: 'k1', type: 'equal', e1: 'l1', e2: 'l2' });
  s.cons.push({ id: 'k2', type: 'equal', e1: 'c1', e2: 'c2' });
  s.cons.push({ id: 'k3', type: 'equal', e1: 'c2', e2: 'ar' });
  solveOk(s);
  near(lineLen(s, 'l1'), lineLen(s, 'l2'));
  near(ent(s, 'c1').r, ent(s, 'c2').r);
  near(ent(s, 'c2').r, dist(s, 'o3', 'e'));
  near(dist(s, 'o3', 'e'), dist(s, 'o3', 'f'));
  assert.ok(ent(s, 'c1').r > 0);
});

test('tangent: line + circle', () => {
  const s = {
    pts: { a: { x: 0, y: 0 }, b: { x: 10, y: 0.5 }, o: { x: 5, y: 4 } },
    ents: [
      { id: 'l', type: 'line', a: 'a', b: 'b' },
      { id: 'c', type: 'circle', c: 'o', r: 3 },
    ],
    cons: [{ id: 'k', type: 'tangent', e1: 'l', e2: 'c' }],
  };
  solveOk(s);
  near(Math.abs(sdist(s, 'o', 'l')), ent(s, 'c').r);
  assert.ok(sdist(s, 'o', 'l') > 0, 'centre stays on its side');
  // reversed argument order, centre on the other side
  const s2 = snapshotParse(s);
  s2.pts.o = { x: 5, y: -6 };
  s2.cons = [{ id: 'k', type: 'tangent', e1: 'c', e2: 'l' }];
  solveOk(s2);
  near(Math.abs(sdist(s2, 'o', 'l')), ent(s2, 'c').r);
  assert.ok(sdist(s2, 'o', 'l') < 0);
});
function snapshotParse(s) { return JSON.parse(JSON.stringify(s)); }

test('tangent: line + arc', () => {
  const s = {
    pts: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, o: { x: 5, y: 4 }, e: { x: 8, y: 4 }, f: { x: 5, y: 7.2 } },
    ents: [
      { id: 'l', type: 'line', a: 'a', b: 'b' },
      { id: 'ar', type: 'arc', c: 'o', a: 'e', b: 'f' },
    ],
    cons: [{ id: 'k', type: 'tangent', e1: 'l', e2: 'ar' }],
  };
  solveOk(s);
  near(Math.abs(sdist(s, 'o', 'l')), dist(s, 'o', 'e'));
  near(dist(s, 'o', 'e'), dist(s, 'o', 'f'));
});

test('tangent: circle + circle, external and internal', () => {
  const ext = {
    pts: { o1: { x: 0, y: 0 }, o2: { x: 9, y: 1 } },
    ents: [{ id: 'c1', type: 'circle', c: 'o1', r: 3 }, { id: 'c2', type: 'circle', c: 'o2', r: 5 }],
    cons: [{ id: 'k', type: 'tangent', e1: 'c1', e2: 'c2' }],
  };
  solveOk(ext);
  near(dist(ext, 'o1', 'o2'), ent(ext, 'c1').r + ent(ext, 'c2').r);

  const int = {
    pts: { o1: { x: 0, y: 0 }, o2: { x: 2.5, y: 0.4 } },
    ents: [{ id: 'c1', type: 'circle', c: 'o1', r: 3 }, { id: 'c2', type: 'circle', c: 'o2', r: 6 }],
    cons: [{ id: 'k', type: 'tangent', e1: 'c1', e2: 'c2' }],
  };
  solveOk(int);
  near(dist(int, 'o1', 'o2'), Math.abs(ent(int, 'c1').r - ent(int, 'c2').r));
  assert.ok(ent(int, 'c2').r > ent(int, 'c1').r);
});

test('concentric', () => {
  const s = {
    pts: { o1: { x: 0, y: 0 }, o2: { x: 2, y: 1 }, e: { x: 6, y: 1 }, f: { x: 2, y: 5.5 } },
    ents: [{ id: 'c1', type: 'circle', c: 'o1', r: 3 }, { id: 'ar', type: 'arc', c: 'o2', a: 'e', b: 'f' }],
    cons: [{ id: 'k', type: 'concentric', e1: 'c1', e2: 'ar' }],
  };
  solveOk(s);
  near(dist(s, 'o1', 'o2'), 0);
  near(dist(s, 'o2', 'e'), dist(s, 'o2', 'f'));
});

test('symmetric', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'symmetric', p: 'c', q: 'd', line: 'l1' });
  solveOk(s);
  near(sdist(s, 'c', 'l1'), -sdist(s, 'd', 'l1'));
  const [ux, uy] = dir(s, 'l1');
  near(((P(s, 'd').x - P(s, 'c').x) * ux + (P(s, 'd').y - P(s, 'c').y) * uy) / Math.hypot(ux, uy), 0);
  assert.ok(Math.abs(sdist(s, 'c', 'l1')) > 0.1, 'points did not collapse onto the line');
});

test('fix constraint behaves like pts.fixed', () => {
  const s = twoLines();
  s.cons.push({ id: 'f', type: 'fix', p: 'a' });
  s.cons.push({ id: 'k', type: 'coincident', p: 'a', q: 'c' });
  solveOk(s);
  assert.equal(P(s, 'a').x, 0); assert.equal(P(s, 'a').y, 0);
  near(P(s, 'c').x, 0); near(P(s, 'c').y, 0);
  assert.equal(sketchDOF(s), 4); // b (2) + d (2)
});

test('distance / hdistance / vdistance keep sign', () => {
  const s = twoLines();
  s.cons.push({ id: 'k1', type: 'distance', p: 'a', q: 'b', value: 25 });
  s.cons.push({ id: 'k2', type: 'hdistance', p: 'd', q: 'c', value: 3 });   // dx currently -7
  s.cons.push({ id: 'k3', type: 'vdistance', p: 'c', q: 'd', value: 12 });  // dy currently +4
  solveOk(s);
  near(dist(s, 'a', 'b'), 25);
  near(P(s, 'c').x - P(s, 'd').x, -3);
  near(P(s, 'd').y - P(s, 'c').y, 12);
});

test('length', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'length', line: 'l2', value: 3 });
  solveOk(s);
  near(lineLen(s, 'l2'), 3);
});

test('pointLineDistance keeps side', () => {
  const s = twoLines();
  s.cons.push({ id: 'k', type: 'pointLineDistance', p: 'c', line: 'l1', value: 2 });
  const side = Math.sign(sdist(s, 'c', 'l1'));
  solveOk(s);
  near(sdist(s, 'c', 'l1'), side * 2);
  const s2 = twoLines();
  s2.pts.c = { x: 2, y: -5 };
  s2.cons.push({ id: 'k', type: 'pointLineDistance', p: 'c', line: 'l1', value: 2 });
  solveOk(s2);
  near(sdist(s2, 'c', 'l1'), -2);
});

test('radius / diameter on circle and arc', () => {
  const s = {
    pts: { o1: { x: 0, y: 0 }, o2: { x: 20, y: 0 }, e: { x: 23, y: 0 }, f: { x: 20, y: 3.4 }, o3: { x: 40, y: 0 } },
    ents: [
      { id: 'c1', type: 'circle', c: 'o1', r: 3 },
      { id: 'ar', type: 'arc', c: 'o2', a: 'e', b: 'f' },
      { id: 'c3', type: 'circle', c: 'o3', r: 1 },
    ],
    cons: [
      { id: 'k1', type: 'radius', ent: 'c1', value: 7.5 },
      { id: 'k2', type: 'radius', ent: 'ar', value: 6 },
      { id: 'k3', type: 'diameter', ent: 'c3', value: 9 },
    ],
  };
  solveOk(s);
  near(ent(s, 'c1').r, 7.5);
  near(dist(s, 'o2', 'e'), 6);
  near(dist(s, 'o2', 'f'), 6);
  near(ent(s, 'c3').r, 4.5);
});

test('angle keeps orientation branch', () => {
  const ang = (s) => {
    const [ux, uy] = dir(s, 'l1'), [wx, wy] = dir(s, 'l2');
    return (Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy) * 180) / Math.PI;
  };
  const s = twoLines(); // l2 is rotated counter-clockwise from l1 (about +24 deg)
  s.cons.push({ id: 'k', type: 'angle', l1: 'l1', l2: 'l2', value: 60 });
  solveOk(s);
  near(ang(s), 60, 'ccw branch', 1e-6);

  const s2 = twoLines();
  s2.pts.d = { x: 9, y: 2 };  // l2 now clockwise from l1
  s2.cons.push({ id: 'k', type: 'angle', l1: 'l1', l2: 'l2', value: 60 });
  solveOk(s2);
  near(ang(s2), -60, 'cw branch', 1e-6);

  // big change, obtuse
  s.cons[0].value = 150;
  solveOk(s);
  near(ang(s), 150, 'obtuse', 1e-6);
});

test('arc radius invariant is restored and kept', () => {
  const s = {
    pts: { o: { x: 0, y: 0 }, a: { x: 5, y: 0 }, b: { x: 0, y: 7 } },
    ents: [{ id: 'ar', type: 'arc', c: 'o', a: 'a', b: 'b' }],
    cons: [],
  };
  assert.equal(sketchDOF(s), 5);
  solveOk(s);
  near(dist(s, 'o', 'a'), dist(s, 'o', 'b'));
  solveOk(s, { drag: { p: 'a', x: 9, y: 2 } });
  near(dist(s, 'o', 'a'), dist(s, 'o', 'b'));
  near(P(s, 'a').x, 9, 'drag x', 1e-2); near(P(s, 'a').y, 2, 'drag y', 1e-2);
});

test('drag of an under-constrained point keeps hard constraints', () => {
  const s = {
    pts: { a: { x: 0, y: 0, fixed: true }, b: { x: 10, y: 0 } },
    ents: [{ id: 'l', type: 'line', a: 'a', b: 'b' }],
    cons: [{ id: 'd', type: 'length', line: 'l', value: 10 }],
  };
  const r = solveOk(s, { drag: { p: 'b', x: 0, y: 20 } });
  assert.equal(r.dof, 1);
  near(lineLen(s, 'l'), 10);
  near(P(s, 'b').x, 0, 'follows cursor direction', 1e-3);
  near(P(s, 'b').y, 10, 'follows cursor direction', 1e-3);

  // rectangle with only one dimension: dragging p3 changes the height, width stays 10
  const q = rectangle();
  q.cons = q.cons.filter((c) => c.id !== 'd2');
  solveOk(q);
  const r2 = solveOk(q, { drag: { p: 'p3', x: 14, y: 8 } });
  assert.equal(r2.dof, 1);
  near(P(q, 'p3').x, 10); near(P(q, 'p3').y, 8, 'height follows', 1e-2);
  near(P(q, 'p2').x, 10); near(P(q, 'p2').y, 0);
  near(P(q, 'p4').x, 0); near(P(q, 'p4').y, P(q, 'p3').y);

  // free point: lands exactly on the cursor
  const f = { pts: { a: { x: 1, y: 2 } }, ents: [{ id: 'p', type: 'point', p: 'a' }], cons: [] };
  solveOk(f, { drag: { p: 'a', x: -3, y: 4 } });
  assert.deepEqual(P(f, 'a'), { x: -3, y: 4 });

  // dragging a fixed / fully constrained point does nothing
  const g = rectangle();
  solveOk(g);
  solveOk(g, { drag: { p: 'p3', x: 50, y: 50 } });
  near(P(g, 'p3').x, 10); near(P(g, 'p3').y, 5);
  solveOk(g, { drag: { p: 'p1', x: 50, y: 50 } });
  assert.equal(P(g, 'p1').x, 0);
});

test('drag a rigid unanchored body translates it', () => {
  const s = rectangle();
  delete s.pts.p1.fixed;
  solveOk(s);
  const before = snapshotParse(s);
  solveOk(s, { drag: { p: 'p3', x: before.pts.p3.x + 3, y: before.pts.p3.y - 2 } });
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    near(P(s, id).x - before.pts[id].x, 3, `${id} dx`, 1e-2);
    near(P(s, id).y - before.pts[id].y, -2, `${id} dy`, 1e-2);
  }
  near(lineLen(s, 'l1'), 10); near(lineLen(s, 'l2'), 5);
});

test('drag circle radius', () => {
  const s = {
    pts: { o: { x: 0, y: 0 }, p: { x: 3, y: 0 } },
    ents: [{ id: 'c', type: 'circle', c: 'o', r: 3 }],
    cons: [{ id: 'k', type: 'pointOnCircle', p: 'p', ent: 'c' }],
  };
  solveOk(s, { drag: { ent: 'c', r: 8 } });
  near(ent(s, 'c').r, 8, 'radius follows', 1e-2);
  near(dist(s, 'o', 'p'), ent(s, 'c').r);
  // with a radius dimension the drag loses
  s.cons.push({ id: 'r', type: 'radius', ent: 'c', value: 8 });
  solveOk(s);
  solveOk(s, { drag: { ent: 'c', r: 20 } });
  near(ent(s, 'c').r, 8);
});

test('over-constrained conflicting dimensions: ok=false, sketch unchanged', () => {
  const s = rectangle();
  solveOk(s);
  s.cons.push({ id: 'bad', type: 'length', line: 'l3', value: 20 });
  const before = snapshot(s);
  const r = solveSketch(s);
  assert.equal(r.ok, false);
  assert.ok(r.residual > 1e-6);
  assert.equal(snapshot(s), before, 'sketch must be untouched');
  assert.ok(r.failed.length > 0);
  assert.ok(r.failed.includes('bad') || r.failed.includes('d1'));
  const st = constraintStatus(s);
  assert.equal(st.overDefined, true);
  assert.ok(st.conflicting.includes('bad') || st.conflicting.includes('d1'));
  assert.equal(snapshot(s), before, 'constraintStatus must not mutate');
});

test('redundant but consistent constraint: solvable, flagged overDefined', () => {
  const s = rectangle();
  solveOk(s);
  s.cons.push({ id: 'dup', type: 'length', line: 'l3', value: 10 });
  const r = solveOk(s);
  assert.equal(r.dof, 0);
  const st = constraintStatus(s);
  assert.equal(st.overDefined, true);
  assert.deepEqual(st.conflicting, []);
  assert.equal(st.redundant, 1);
});

test('DOF counts', () => {
  assert.equal(sketchDOF({ pts: { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, ents: [{ id: 'l', type: 'line', a: 'a', b: 'b' }], cons: [] }), 4);
  assert.equal(sketchDOF({ pts: { o: { x: 0, y: 0 } }, ents: [{ id: 'c', type: 'circle', c: 'o', r: 2 }], cons: [] }), 3);
  const tri = {
    pts: { a: { x: 0, y: 0, fixed: true }, b: { x: 4.2, y: 0.3 }, c: { x: 3.7, y: 2.6 } },
    ents: [
      { id: 'l1', type: 'line', a: 'a', b: 'b' },
      { id: 'l2', type: 'line', a: 'b', b: 'c' },
      { id: 'l3', type: 'line', a: 'c', b: 'a' },
    ],
    cons: [
      { id: 'h', type: 'horizontal', line: 'l1' },
      { id: 'd1', type: 'length', line: 'l1', value: 4 },
      { id: 'd2', type: 'length', line: 'l2', value: 3 },
      { id: 'd3', type: 'length', line: 'l3', value: 5 },
    ],
  };
  assert.equal(sketchDOF(tri), 0);
  const r = solveOk(tri);
  assert.equal(r.dof, 0);
  near(P(tri, 'b').x, 4); near(P(tri, 'b').y, 0);
  near(P(tri, 'c').x, 4); near(P(tri, 'c').y, 3);
  // spline points are plain free points
  assert.equal(sketchDOF({ pts: { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, c: { x: 2, y: 0 } }, ents: [{ id: 's', type: 'spline', pts: ['a', 'b', 'c'] }], cons: [] }), 6);
});

test('large dimension changes converge (continuation / robustness)', () => {
  const tri = {
    pts: { a: { x: 0, y: 0, fixed: true }, b: { x: 4, y: 0 }, c: { x: 4, y: 3 } },
    ents: [
      { id: 'l1', type: 'line', a: 'a', b: 'b' },
      { id: 'l2', type: 'line', a: 'b', b: 'c' },
      { id: 'l3', type: 'line', a: 'c', b: 'a' },
    ],
    cons: [
      { id: 'h', type: 'horizontal', line: 'l1' },
      { id: 'd1', type: 'length', line: 'l1', value: 200 },
      { id: 'd2', type: 'length', line: 'l2', value: 150 },
      { id: 'd3', type: 'length', line: 'l3', value: 250 },
    ],
  };
  solveOk(tri);
  near(P(tri, 'b').x, 200); near(P(tri, 'c').x, 200); near(P(tri, 'c').y, 150);
  for (const [a, b, c] of [[0.4, 0.3, 0.5], [4000, 3000, 5000], [10, 10, 10]]) {
    tri.cons[1].value = a; tri.cons[2].value = b; tri.cons[3].value = c;
    solveOk(tri);
    near(lineLen(tri, 'l1'), a, 'l1', 1e-6 * Math.max(1, a));
    near(lineLen(tri, 'l2'), b, 'l2', 1e-6 * Math.max(1, a));
    near(lineLen(tri, 'l3'), c, 'l3', 1e-6 * Math.max(1, a));
    assert.ok(P(tri, 'c').y > 0, 'triangle did not flip');
  }
});

test('degenerate inputs never produce NaN', () => {
  const s = {
    pts: {
      a: { x: 1, y: 1 }, b: { x: 1, y: 1 },           // zero-length line
      c: { x: 1, y: 1 }, d: { x: 4, y: 1 },
      o1: { x: 0, y: 0 }, o2: { x: 0, y: 0 },         // coincident centres
      e: { x: 0, y: 0 }, f: { x: 0, y: 0 },           // degenerate arc
    },
    ents: [
      { id: 'l1', type: 'line', a: 'a', b: 'b' },
      { id: 'l2', type: 'line', a: 'c', b: 'd' },
      { id: 'c1', type: 'circle', c: 'o1', r: 2 },
      { id: 'c2', type: 'circle', c: 'o2', r: 3 },
      { id: 'ar', type: 'arc', c: 'o1', a: 'e', b: 'f' },
    ],
    cons: [
      { id: 'k1', type: 'parallel', l1: 'l1', l2: 'l2' },
      { id: 'k2', type: 'perpendicular', l1: 'l1', l2: 'l2' },
      { id: 'k3', type: 'angle', l1: 'l1', l2: 'l2', value: 30 },
      { id: 'k4', type: 'pointOnLine', p: 'd', line: 'l1' },
      { id: 'k5', type: 'tangent', e1: 'c1', e2: 'c2' },
      { id: 'k6', type: 'tangent', e1: 'l1', e2: 'c1' },
      { id: 'k7', type: 'symmetric', p: 'c', q: 'd', line: 'l1' },
      { id: 'k8', type: 'length', line: 'l1', value: 5 },
      { id: 'k9', type: 'missing-type', foo: 1 },
      { id: 'k10', type: 'distance', p: 'nope', q: 'a', value: 1 },
      { id: 'k11', type: 'equal', e1: 'l1', e2: 'c1' },
    ],
  };
  const r = solveSketch(s);
  assert.ok(Number.isFinite(r.residual) || r.ok === false);
  assert.ok(Number.isFinite(r.dof));
  for (const id of Object.keys(s.pts)) {
    assert.ok(Number.isFinite(s.pts[id].x) && Number.isFinite(s.pts[id].y), `pt ${id} finite`);
  }
  for (const e of s.ents) if (e.type === 'circle') assert.ok(Number.isFinite(e.r));
  assert.ok(Number.isFinite(sketchDOF(s)));
  const st = constraintStatus(s);
  assert.ok(Number.isFinite(st.dof));
  // empty sketch
  assert.deepEqual(solveSketch({ pts: {}, ents: [], cons: [] }), { ok: true, residual: 0, iterations: 0, dof: 0, failed: [] });
});

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

function bigSketch() {
  // 80-line staircase polyline + 20 circles = 100 entities, 150 constraints, one connected component
  const s = { pts: { p0: { x: 0, y: 0, fixed: true } }, ents: [], cons: [] };
  let x = 0, y = 0, k = 0;
  for (let i = 0; i < 80; i++) {
    const horiz = i % 2 === 0;
    if (horiz) x += 10 + (i % 5); else y += 6 + (i % 3);
    s.pts[`p${i + 1}`] = { x, y };
    s.ents.push({ id: `l${i}`, type: 'line', a: `p${i}`, b: `p${i + 1}` });
    s.cons.push({ id: `k${k++}`, type: horiz ? 'horizontal' : 'vertical', line: `l${i}` });          // 80
    if (i % 2 === 1) s.cons.push({ id: `k${k++}`, type: 'length', line: `l${i}`, value: 6 + (i % 3) }); // 40
  }
  for (let j = 0; j < 20; j++) {
    const li = j * 4;                      // a horizontal line
    const a = s.pts[`p${li}`], b = s.pts[`p${li + 1}`];
    s.pts[`o${j}`] = { x: (a.x + b.x) / 2, y: a.y - 2 };
    s.ents.push({ id: `c${j}`, type: 'circle', c: `o${j}`, r: 2 });
    s.cons.push({ id: `k${k++}`, type: 'tangent', e1: `l${li}`, e2: `c${j}` });                      // 20
    if (j % 2 === 0) s.cons.push({ id: `k${k++}`, type: 'radius', ent: `c${j}`, value: 2 });         // 10
  }
  return s;
}

test('timing: 100 entities / 150 constraints drag step', () => {
  const s = bigSketch();
  assert.equal(s.ents.length, 100);
  assert.equal(s.cons.length, 150);
  const r0 = solveOk(s);
  // warm up the JIT
  for (let i = 0; i < 30; i++) solveSketch(s, { drag: { p: 'p80', x: P(s, 'p80').x + 0.3, y: P(s, 'p80').y + 0.2 } });

  const N = 60;
  let worst = 0, total = 0, totalNoDof = 0, iters = 0;
  for (let i = 0; i < N; i++) {
    const tgt = { p: i % 2 ? 'p80' : 'p41', x: 0, y: 0 };
    tgt.x = P(s, tgt.p).x + 1.5 * Math.cos(i); tgt.y = P(s, tgt.p).y + 1.5 * Math.sin(i);
    const t0 = performance.now();
    const r = solveSketch(s, { drag: tgt });
    const dt = performance.now() - t0;
    assert.equal(r.ok, true);
    assert.ok(r.residual < 1e-12);
    iters += r.iterations;
    total += dt; if (dt > worst) worst = dt;
    const t1 = performance.now();
    const r2 = solveSketch(s, { drag: { p: tgt.p, x: tgt.x + 0.5, y: tgt.y - 0.5 }, dof: false });
    totalNoDof += performance.now() - t1;
    assert.equal(r2.ok, true);
  }
  // hard constraints still hold after all the dragging
  for (const c of s.cons) {
    if (c.type === 'horizontal') near(dir(s, c.line)[1], 0);
    if (c.type === 'vertical') near(dir(s, c.line)[0], 0);
    if (c.type === 'length') near(lineLen(s, c.line), c.value);
    if (c.type === 'radius') near(ent(s, c.ent).r, c.value);
    if (c.type === 'tangent') near(Math.abs(sdist(s, ent(s, c.e2).c, c.e1)), ent(s, c.e2).r);
  }
  const avg = total / N;
  const t2 = performance.now();
  const dof = sketchDOF(s);
  const tDof = performance.now() - t2;
  console.log(
    `[timing] 100 ents / 150 cons, dof=${dof} (initial solve dof=${r0.dof}): drag step avg ${avg.toFixed(2)} ms, ` +
    `worst ${worst.toFixed(2)} ms, avg LM iterations ${(iters / N).toFixed(1)}; ` +
    `with opts.dof=false avg ${(totalNoDof / N).toFixed(2)} ms; sketchDOF alone ${tDof.toFixed(2)} ms`,
  );
  assert.ok(avg < 100, `avg drag step ${avg} ms`);
});
