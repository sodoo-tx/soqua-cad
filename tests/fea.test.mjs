import test from 'node:test';
import assert from 'node:assert/strict';
import { solveStatic, voxelize, MATERIALS } from '../src/sim/fea.js';

// ---- triangle soup builders -------------------------------------------------------------

function quad(a, b, c, d) { return [...a, ...b, ...c, ...a, ...c, ...d]; }

/** Axis-aligned box [0,sx]x[0,sy]x[0,sz]; returns the whole surface plus each face separately. */
function box(sx, sy, sz) {
  const p = (x, y, z) => [x * sx, y * sy, z * sz];
  const faces = {
    z0: quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)),
    z1: quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    x0: quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)),
    x1: quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
    y0: quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)),
    y1: quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
  };
  const out = {};
  for (const k in faces) out[k] = new Float32Array(faces[k]);
  out.all = new Float32Array(Object.values(faces).flat());
  return out;
}

function sphere(r, cx, cy, cz, nLon = 64, nLat = 32) {
  const pt = (i, j) => {
    const th = (i / nLon) * 2 * Math.PI, ph = (j / nLat) * Math.PI;
    return [cx + r * Math.sin(ph) * Math.cos(th), cy + r * Math.cos(ph), cz + r * Math.sin(ph) * Math.sin(th)];
  };
  const t = [];
  for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    if (j > 0) t.push(...a, ...b, ...c);
    if (j < nLat - 1) t.push(...a, ...c, ...d);
  }
  return new Float32Array(t);
}

const pct = (v, ref) => ((v - ref) / ref) * 100;
const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const STEEL = MATERIALS['Plain Carbon Steel'];

// ---- tests ------------------------------------------------------------------------------

test('materials table has the required entries', () => {
  for (const name of ['Plain Carbon Steel', 'AISI 304', 'AISI 1020', 'Alloy Steel', '6061-T6 Aluminium',
    '1060 Aluminium', 'Brass', 'Copper', 'Titanium Ti-6Al-4V', 'Cast Iron', 'ABS', 'PLA', 'Nylon 6/6', 'Pine wood']) {
    const m = MATERIALS[name];
    assert.ok(m, name);
    assert.ok(m.E > 0 && m.nu > 0 && m.nu < 0.5 && m.density > 0 && m.yield > 0, name);
  }
});

test('axial tension: 10x10x100 steel bar, 1000 N', async () => {
  const b = box(10, 10, 100);
  const F = 1000, L = 100, A = 100, E = STEEL.E;
  let progressCalls = 0, lastFrac = -1;
  const r = await solveStatic({
    positions: b.all, fixedTris: b.z0, loads: [{ tris: b.z1, force: [0, 0, F] }],
    gravity: null, material: STEEL, resolution: 40,
  }, (f) => { progressCalls++; assert.ok(f >= 0 && f <= 1); lastFrac = f; });
  assert.ok(r.ok, r.message);
  assert.deepEqual(r.dims, [6, 6, 42]);
  assert.equal(r.nVoxels, 4 * 4 * 40);
  assert.equal(r.nNodes, 5 * 5 * 41);
  assert.ok(progressCalls > 0 && lastFrac === 1);

  const dRef = F * L / (A * E), sRef = F / A;
  // mean displacement of the loaded end face
  let dz = 0, n = 0;
  for (let x = 0; x <= 10; x += 2.5) for (let y = 0; y <= 10; y += 2.5) { dz += r.sample(x, y, L).u[2]; n++; }
  dz /= n;
  const dCentre = r.sample(5, 5, L).u[2];
  const sMid = r.sample(5, 5, 50).vonMises, sSurf = r.sample(0, 5, 50).vonMises, sCorner = r.sample(10, 10, 60).vonMises;
  console.log(`[axial] ${r.message}`);
  console.log(`[axial] end displacement mean ${dz.toExponential(4)} mm vs FL/AE ${dRef.toExponential(4)} (${fmt(pct(dz, dRef))}); at face centre ${fmt(pct(dCentre, dRef))}`);
  console.log(`[axial] von Mises at mid-length: centre ${sMid.toFixed(4)}, surface ${sSurf.toFixed(4)}, corner ${sCorner.toFixed(4)} MPa vs F/A ${sRef} (${fmt(pct(sMid, sRef))})`);
  console.log(`[axial] reaction ${r.reaction.map((v) => v.toFixed(4))} N; maxStress ${r.maxStress.toFixed(2)} MPa (end effects), minFOS ${r.minFOS.toFixed(2)}`);
  assert.ok(Math.abs(pct(dz, dRef)) < 5);
  assert.ok(Math.abs(pct(dCentre, dRef)) < 5);
  for (const s of [sMid, sSurf, sCorner]) assert.ok(Math.abs(pct(s, sRef)) < 5);
  assert.ok(Math.abs(r.reaction[2] + F) < 1e-3 * F);
  assert.ok(Math.abs(r.reaction[0]) < 1e-3 * F && Math.abs(r.reaction[1]) < 1e-3 * F);
  assert.ok(Math.abs(r.minFOS - STEEL.yield / r.maxStress) < 1e-9);

  // per-vertex outputs: same order as positions, free-end vertices move by ~dRef, fixed ones do not
  assert.equal(r.vertexDisp.length, b.all.length);
  assert.equal(r.vertexDispMag.length, b.all.length / 3);
  assert.equal(r.vertexStress.length, b.all.length / 3);
  for (let v = 0; v < b.all.length / 3; v++) {
    const z = b.all[3 * v + 2];
    if (z === 0) assert.equal(r.vertexDispMag[v], 0);
    else assert.ok(Math.abs(pct(r.vertexDisp[3 * v + 2], dRef)) < 15); // corner nodes of the loaded face
  }
});

test('cantilever: 10x10x100 steel, 100 N transverse tip load', async () => {
  const b = box(10, 10, 100);
  const F = 100, L = 100, E = STEEL.E, I = 10 * 10 ** 3 / 12, c = 5;
  const dRef = F * L ** 3 / (3 * E * I);
  const run = async (resolution, extra = {}) => {
    const t0 = performance.now();
    const r = await solveStatic({
      positions: b.all, fixedTris: b.z0, loads: [{ tris: b.z1, force: [0, -F, 0] }],
      gravity: null, material: STEEL, resolution, ...extra,
    });
    const ms = performance.now() - t0;
    assert.ok(r.ok, r.message);
    const tip = -r.sample(5, 5, L).u[1];
    // bending stress on the tension surface (y = 10) at mid-length: M = F (L - z)
    const zs = 50, sRef = F * (L - zs) * c / I;
    const sSurf = r.sample(5, 10, zs).vonMises;
    const sRoot = F * L * c / I;
    console.log(`[cantilever res ${resolution}${extra.stressRecovery ? ' ' + extra.stressRecovery : ''}] ${r.dims.map((d) => d - 2).join('x')} voxels, ${r.iterations} it, ${ms.toFixed(0)} ms | tip ${tip.toFixed(5)} mm vs ${dRef.toFixed(5)} (${fmt(pct(tip, dRef))}) | ` +
      `surface stress @L/2 ${sSurf.toFixed(2)} vs Mc/I ${sRef.toFixed(2)} MPa (${fmt(pct(sSurf, sRef))}) | global max ${r.maxStress.toFixed(2)} vs root Mc/I ${sRoot.toFixed(2)} (${fmt(pct(r.maxStress, sRoot))})`);
    return { r, tip, sSurf, sRef, sRoot };
  };
  const a = await run(40); // 4 elements through the thickness
  assert.ok(Math.abs(pct(a.tip, dRef)) < 15);
  assert.ok(Math.abs(pct(a.sSurf, a.sRef)) < 25);
  assert.ok(Math.abs(pct(a.r.maxStress, a.sRoot)) < 25);
  assert.ok(Math.abs(a.r.reaction[1] - F) < 1e-3 * F);
  // informational: finer grid and the element-centre recovery variant
  const f = await run(60);
  assert.ok(Math.abs(pct(f.tip, dRef)) < 15);
  await run(40, { stressRecovery: 'centre' });
});

test('gravity: reaction equals the weight', async () => {
  const b = box(10, 10, 100);
  const r = await solveStatic({
    positions: b.all, fixedTris: b.z0, loads: [], gravity: [0, -9.81, 0], material: STEEL, resolution: 40,
  });
  assert.ok(r.ok, r.message);
  const W = 7800 * 10e-3 * 10e-3 * 100e-3 * 9.81; // N
  const q = W / 100, I = 10 ** 4 / 12, dRef = q * 100 ** 4 / (8 * STEEL.E * I);
  const tip = -r.sample(5, 5, 100).u[1];
  console.log(`[gravity] weight ${W.toFixed(5)} N, reaction Y ${r.reaction[1].toFixed(5)} N; tip sag ${tip.toExponential(4)} vs qL^4/8EI ${dRef.toExponential(4)} (${fmt(pct(tip, dRef))})`);
  assert.ok(Math.abs(r.reaction[1] - W) < 1e-3 * W);
  assert.ok(Math.abs(pct(tip, dRef)) < 15);
});

test('error handling', async () => {
  const b = box(10, 10, 100);
  const base = { positions: b.all, gravity: null, material: STEEL, resolution: 20 };
  const noFix = await solveStatic({ ...base, fixedTris: new Float32Array(0), loads: [{ tris: b.z1, force: [0, 0, 1] }] });
  assert.equal(noFix.ok, false);
  assert.match(noFix.message, /fixed/i);
  assert.equal(noFix.vertexStress.length, b.all.length / 3);

  const far = new Float32Array([500, 500, 500, 510, 500, 500, 500, 510, 500]);
  const noLoad = await solveStatic({ ...base, fixedTris: b.z0, loads: [{ tris: far, force: [0, 0, 1] }] });
  assert.equal(noLoad.ok, false);
  assert.match(noLoad.message, /Load 1/);

  const farFix = await solveStatic({ ...base, fixedTris: far, loads: [{ tris: b.z1, force: [0, 0, 1] }] });
  assert.equal(farFix.ok, false);
  console.log(`[errors] "${noFix.message}" | "${noLoad.message}" | "${farFix.message}"`);
});

test('DOF guard reduces the resolution', async () => {
  const b = box(10, 10, 100);
  const r = await solveStatic({
    positions: b.all, fixedTris: b.z0, loads: [{ tris: b.z1, force: [0, 0, 1000] }],
    gravity: null, material: STEEL, resolution: 40, maxDofs: 1200,
  });
  assert.ok(r.ok, r.message);
  assert.ok(r.nNodes * 3 <= 1200);
  assert.ok(r.resolution < 40);
  assert.match(r.message, /reduced/i);
  console.log(`[guard] ${r.message}`);
});

test('voxelizer: sphere volume at resolution 32', async () => {
  const R = 20;
  const v = await voxelize(sphere(R, 3, -7, 11), 32);
  const vol = v.nVoxels * v.h ** 3, ref = (4 / 3) * Math.PI * R ** 3;
  console.log(`[voxelizer] sphere: ${v.nVoxels} voxels, volume ${vol.toFixed(1)} vs ${ref.toFixed(1)} mm^3 (${fmt(pct(vol, ref))}), leaky columns ${v.leakyColumns}`);
  assert.equal(v.leakyColumns, 0);
  assert.ok(Math.abs(pct(vol, ref)) < 5);
});

test('performance: ~30k voxel solve (informational)', async () => {
  // 30x30x34 block = 30600 voxels, fixed at the bottom, sheared at the top
  const b = box(30, 30, 34);
  const t0 = performance.now();
  const r = await solveStatic({
    positions: b.all, fixedTris: b.z0, loads: [{ tris: b.z1, force: [500, 0, -2000] }],
    gravity: [0, 0, -9.81], material: STEEL, resolution: 34,
  });
  const ms = performance.now() - t0;
  console.log(`[perf] ${r.nVoxels} voxels, ${r.nNodes * 3} DOF: ${r.iterations} iterations, ${ms.toFixed(0)} ms total (${(ms / Math.max(1, r.iterations)).toFixed(2)} ms/iteration). ${r.message}`);
  assert.ok(r.ok, r.message);
  assert.equal(r.nVoxels, 30600);
});
