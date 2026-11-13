// SOQUA design — linear-elastic static stress analysis on a voxel (hexahedral) grid.
//
// Pure JS, zero dependencies. Runs in a browser (main thread or Web Worker) and in node.
//
// Units: mm, N, MPa (N/mm^2). Density is given in kg/m^3 and gravity in m/s^2; they are
// converted internally (kg/m^3 -> tonne/mm^3 = x1e-12, m/s^2 -> mm/s^2 = x1000).
//
// Method:
//   1. Voxelize the closed triangle surface (parity ray casting along Z per XY column).
//   2. 8-node trilinear hexahedra, 2x2x2 Gauss; all elements are identical cubes so the
//      24x24 element matrix is built once.
//   3. Matrix-free Jacobi-preconditioned conjugate gradient. The operator is applied as a
//      27-point node stencil looked up by the 8-bit occupancy mask of the voxels around a
//      node (256 precomputed stencils) — mathematically identical to element-by-element
//      assembly of Ke but ~2.4x fewer flops and no scatter.
//   4. Strain recovery at nodes, averaged over the solid elements touching each node,
//      von Mises, trilinear sampling at the input vertices.

export const MATERIALS = {
  // name: { E (MPa), nu, density (kg/m^3), yield (MPa) }
  'Plain Carbon Steel': { E: 210000, nu: 0.28, density: 7800, yield: 220.6 },
  'AISI 304': { E: 190000, nu: 0.29, density: 8000, yield: 206.8 },
  'AISI 1020': { E: 200000, nu: 0.29, density: 7900, yield: 351.6 },
  'Alloy Steel': { E: 210000, nu: 0.28, density: 7700, yield: 620.4 },
  '6061-T6 Aluminium': { E: 69000, nu: 0.33, density: 2700, yield: 275 },
  '1060 Aluminium': { E: 69000, nu: 0.33, density: 2700, yield: 27.6 },
  'Brass': { E: 100000, nu: 0.33, density: 8500, yield: 239.7 },
  'Copper': { E: 110000, nu: 0.37, density: 8900, yield: 258.6 },
  'Titanium Ti-6Al-4V': { E: 113800, nu: 0.342, density: 4430, yield: 880 },
  // Malleable cast iron. Grey iron is brittle and has no real yield point.
  'Cast Iron': { E: 190000, nu: 0.27, density: 7300, yield: 275.7 },
  'ABS': { E: 2000, nu: 0.394, density: 1020, yield: 40 },
  'PLA': { E: 3500, nu: 0.36, density: 1240, yield: 50 },
  'Nylon 6/6': { E: 2800, nu: 0.39, density: 1140, yield: 70 },
  // Wood is orthotropic; these are along-the-grain values used as an isotropic stand-in.
  'Pine wood': { E: 9000, nu: 0.35, density: 500, yield: 40 },
};

const MAX_DOFS_DEFAULT = 900000;
const YIELD_MS = 50;

// ---------------------------------------------------------------------------------------
// Cooperative yielding
// ---------------------------------------------------------------------------------------

const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

let _yieldImpl = null;
function macrotask() {
  if (!_yieldImpl) {
    if (typeof setImmediate === 'function') {
      _yieldImpl = () => new Promise((r) => setImmediate(r));
    } else if (typeof MessageChannel !== 'undefined') {
      // Not subject to the 4 ms clamp browsers apply to nested setTimeout(0).
      const ch = new MessageChannel();
      const queue = [];
      ch.port1.onmessage = () => { const r = queue.shift(); if (r) r(); };
      _yieldImpl = () => new Promise((r) => { queue.push(r); ch.port2.postMessage(0); });
    } else {
      _yieldImpl = () => new Promise((r) => setTimeout(r, 0));
    }
  }
  return _yieldImpl();
}

function makeTicker(onProgress) {
  let last = now();
  let frac = 0, msg = '';
  const t = {
    set(f, m) { frac = f; if (m !== undefined) msg = m; },
    due() { return now() - last >= YIELD_MS; },
    async yield() {
      if (onProgress) { try { onProgress(Math.max(0, Math.min(1, frac)), msg); } catch (_) { /* ignore */ } }
      await macrotask();
      last = now();
    },
    async report(f, m) { t.set(f, m); await t.yield(); },
  };
  return t;
}

// ---------------------------------------------------------------------------------------
// Voxelizer
// ---------------------------------------------------------------------------------------

/**
 * Voxelize a closed triangle soup.
 * @param {Float32Array|ArrayLike<number>} positions 9 floats per triangle
 * @param {number} resolution voxels along the longest bbox axis (clamped 6..64)
 * @returns {Promise<null | { h:number, dims:[number,number,number], origin:[number,number,number],
 *   solid:Uint8Array, nVoxels:number, leakyColumns:number, resolution:number }>}
 *   `solid[i + nx*(j + ny*k)]`; voxel (i,j,k) spans origin + [i..i+1, j..j+1, k..k+1]*h.
 *   The grid is padded by one empty voxel on every side. Returns null for a degenerate mesh.
 */
export async function voxelize(positions, resolution = 28, _ticker = null) {
  const res = clampRes(resolution);
  const nT = Math.floor((positions ? positions.length : 0) / 9);
  if (nT < 4) return null;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < nT * 9; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const sx = maxx - minx, sy = maxy - miny, sz = maxz - minz;
  const L = Math.max(sx, sy, sz);
  if (!(L > 0) || !isFinite(L)) return null;
  const h = L / res;
  const nx = Math.max(1, Math.ceil(sx / h - 1e-6)) + 2;
  const ny = Math.max(1, Math.ceil(sy / h - 1e-6)) + 2;
  const nz = Math.max(1, Math.ceil(sz / h - 1e-6)) + 2;
  const ox = minx - h, oy = miny - h, oz = minz - h;
  // Tiny irrational jitter of the ray origin so rays do not run along mesh edges/vertices
  // (CAD meshes are full of vertices on "round" coordinates that coincide with voxel centres).
  const jx = h * 1.4142135623730951e-3, jy = h * 1.7320508075688772e-3;
  const cx0 = ox + 0.5 * h + jx, cy0 = oy + 0.5 * h + jy;

  // Rasterise every triangle over the XY column grid (the column grid is the 2D bucket grid)
  // and record (column, z) ray hits.
  let cap = Math.max(1024, nT * 2);
  let hitCol = new Int32Array(cap), hitZ = new Float64Array(cap), nHit = 0;
  const colCount = new Int32Array(nx * ny + 1);
  for (let t = 0; t < nT; t++) {
    if (_ticker && (t & 4095) === 4095 && _ticker.due()) await _ticker.yield();
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area2 === 0 || area2 !== area2) continue; // vertical or degenerate: never crossed
    const tminx = Math.min(ax, bx, cx), tmaxx = Math.max(ax, bx, cx);
    const tminy = Math.min(ay, by, cy), tmaxy = Math.max(ay, by, cy);
    let i0 = Math.ceil((tminx - cx0) / h), i1 = Math.floor((tmaxx - cx0) / h);
    let j0 = Math.ceil((tminy - cy0) / h), j1 = Math.floor((tmaxy - cy0) / h);
    if (i0 < 0) i0 = 0; if (i1 > nx - 1) i1 = nx - 1;
    if (j0 < 0) j0 = 0; if (j1 > ny - 1) j1 = ny - 1;
    const inv = 1 / area2;
    for (let j = j0; j <= j1; j++) {
      const py = cy0 + j * h;
      for (let i = i0; i <= i1; i++) {
        const px = cx0 + i * h;
        const w0 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * inv;
        if (w0 < 0) continue;
        const w1 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        if (nHit === cap) {
          cap *= 2;
          const c2 = new Int32Array(cap); c2.set(hitCol); hitCol = c2;
          const z2 = new Float64Array(cap); z2.set(hitZ); hitZ = z2;
        }
        const col = i + nx * j;
        hitCol[nHit] = col; hitZ[nHit] = w0 * az + w1 * bz + w2 * cz; nHit++;
        colCount[col + 1]++;
      }
    }
  }
  // Counting sort of the hits by column.
  for (let c = 0; c < nx * ny; c++) colCount[c + 1] += colCount[c];
  const fillPos = colCount.slice(0, nx * ny);
  const zs = new Float64Array(nHit);
  for (let q = 0; q < nHit; q++) zs[fillPos[hitCol[q]]++] = hitZ[q];

  const solid = new Uint8Array(nx * ny * nz);
  let nVoxels = 0, leaky = 0;
  const cz0 = oz + 0.5 * h;
  for (let c = 0; c < nx * ny; c++) {
    const s = colCount[c], e = colCount[c + 1];
    const cnt = e - s;
    if (cnt < 2) { if (cnt === 1) leaky++; continue; }
    if (cnt & 1) leaky++;
    const sub = zs.subarray(s, e);
    sub.sort();
    for (let q = 0; q + 1 < cnt; q += 2) {
      let k0 = Math.ceil((sub[q] - cz0) / h), k1 = Math.floor((sub[q + 1] - cz0) / h);
      if (k0 < 1) k0 = 1; if (k1 > nz - 2) k1 = nz - 2;
      for (let k = k0; k <= k1; k++) {
        const idx = c + nx * ny * k;
        if (!solid[idx]) { solid[idx] = 1; nVoxels++; }
      }
    }
  }
  return { h, dims: [nx, ny, nz], origin: [ox, oy, oz], solid, nVoxels, leakyColumns: leaky, resolution: res };
}

function clampRes(r) {
  r = Math.round(Number(r));
  if (!isFinite(r)) r = 28;
  return Math.max(6, Math.min(64, r));
}

// ---------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------

// Squared distance from point P to triangle ABC (Ericson, Real-Time Collision Detection 5.1.5).
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = bpx - w * (cx - bx), dy = bpy - w * (cy - by), dz = bpz - w * (cz - bz);
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------------------

// Shape function gradients dN_n/dx_d of the trilinear cube [0,h]^3 at unit coords (xi,eta,zeta) in [0,1].
// Local node n = a + 2b + 4c sits at (a,b,c)*h.
function shapeGrads(xi, eta, zeta, h, out, off) {
  for (let n = 0; n < 8; n++) {
    const a = n & 1, b = (n >> 1) & 1, c = (n >> 2) & 1;
    const wa = a ? xi : 1 - xi, wb = b ? eta : 1 - eta, wc = c ? zeta : 1 - zeta;
    const da = (a ? 1 : -1) / h, db = (b ? 1 : -1) / h, dc = (c ? 1 : -1) / h;
    out[off + 3 * n] = da * wb * wc;
    out[off + 3 * n + 1] = wa * db * wc;
    out[off + 3 * n + 2] = wa * wb * dc;
  }
}

/** 24x24 stiffness matrix (row-major Float64Array(576)) of a cube hex8 of edge h. Scales as E*h. */
export function hexStiffness(E, nu, h = 1) {
  const lam = E * nu / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  const Ke = new Float64Array(576);
  const g = new Float64Array(24);
  const gp = [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)];
  const w = h * h * h / 8;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    shapeGrads(gp[a], gp[b], gp[c], h, g, 0);
    for (let p = 0; p < 8; p++) {
      for (let q = 0; q < 8; q++) {
        const dot = g[3 * p] * g[3 * q] + g[3 * p + 1] * g[3 * q + 1] + g[3 * p + 2] * g[3 * q + 2];
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            let v = lam * g[3 * p + i] * g[3 * q + j] + mu * g[3 * p + j] * g[3 * q + i];
            if (i === j) v += mu * dot;
            Ke[(3 * p + i) * 24 + 3 * q + j] += v * w;
          }
        }
      }
    }
  }
  return Ke;
}

// Node stencils for all 256 occupancy masks of the 8 voxels around a node.
// Mask bit (dx + 2dy + 4dz) <=> voxel (i-1+dx, j-1+dy, k-1+dz) is solid, for node (i,j,k).
// Neighbour code = (ox+1) + 3(oy+1) + 9(oz+1) for node offset (ox,oy,oz) in {-1,0,1}^3.
function buildStencils(Ke) {
  const per = new Float64Array(8 * 27 * 9);
  const touched = new Uint8Array(8 * 27);
  for (let e = 0; e < 8; e++) {
    const dx = e & 1, dy = (e >> 1) & 1, dz = (e >> 2) & 1;
    const la = 7 - e; // this node's local index inside that voxel
    for (let lb = 0; lb < 8; lb++) {
      const ox = dx - 1 + (lb & 1), oy = dy - 1 + ((lb >> 1) & 1), oz = dz - 1 + ((lb >> 2) & 1);
      const nb = (ox + 1) + 3 * (oy + 1) + 9 * (oz + 1);
      touched[e * 27 + nb] = 1;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        per[(e * 27 + nb) * 9 + 3 * r + c] += Ke[(3 * la + r) * 24 + 3 * lb + c];
      }
    }
  }
  const start = new Int32Array(257);
  const codes = [];
  const coefs = [];
  const diag = new Float64Array(256 * 3);
  const acc = new Float64Array(27 * 9);
  const tch = new Uint8Array(27);
  for (let m = 0; m < 256; m++) {
    acc.fill(0); tch.fill(0);
    for (let e = 0; e < 8; e++) {
      if (!(m & (1 << e))) continue;
      for (let nb = 0; nb < 27; nb++) {
        if (!touched[e * 27 + nb]) continue;
        tch[nb] = 1;
        for (let q = 0; q < 9; q++) acc[nb * 9 + q] += per[(e * 27 + nb) * 9 + q];
      }
    }
    for (let nb = 0; nb < 27; nb++) {
      if (!tch[nb]) continue;
      codes.push(nb);
      for (let q = 0; q < 9; q++) coefs.push(acc[nb * 9 + q]);
    }
    diag[3 * m] = acc[13 * 9]; diag[3 * m + 1] = acc[13 * 9 + 4]; diag[3 * m + 2] = acc[13 * 9 + 8];
    start[m + 1] = codes.length;
  }
  return { start, codes: Uint8Array.from(codes), coefs: Float64Array.from(coefs), diag };
}

// ---------------------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------------------

function emptyResult(message, nVerts) {
  return {
    ok: false, message,
    voxelSize: 0, dims: [0, 0, 0], origin: [0, 0, 0], resolution: 0,
    nVoxels: 0, nNodes: 0, iterations: 0, residual: 0,
    vertexDisp: new Float32Array(nVerts * 3),
    vertexDispMag: new Float32Array(nVerts),
    vertexStress: new Float32Array(nVerts),
    maxDisp: 0, maxStress: 0, minFOS: Infinity,
    reaction: [0, 0, 0], appliedForce: [0, 0, 0],
    sample() { return { u: [0, 0, 0], vonMises: 0 }; },
  };
}

/**
 * Linear static solve. See the module header / project docs for the model format.
 * Extra optional model fields: `maxDofs` (default 900000) and
 * `stressRecovery`: 'corner' (default) | 'centre'.
 */
export async function solveStatic(model, onProgress) {
  const positions = model && model.positions;
  const nVerts = positions ? Math.floor(positions.length / 3) : 0;
  const fail = (msg) => emptyResult(msg, nVerts);
  if (!positions || positions.length < 36) return fail('No geometry: the body has no surface triangles.');
  const mat = model.material || {};
  const E = Number(mat.E), nu = Number(mat.nu);
  if (!(E > 0) || !isFinite(E)) return fail('Invalid material: Young\'s modulus E must be > 0.');
  if (!(nu > -1 && nu < 0.4999)) return fail('Invalid material: Poisson ratio must be between -1 and 0.5 (exclusive).');
  const density = Number(mat.density) || 0;
  const yieldStress = Number(mat.yield) || 0;
  const maxIter = Math.max(1, Math.floor(model.maxIter || 4000));
  const tol = model.tol > 0 ? model.tol : 1e-6;
  const maxDofs = model.maxDofs > 0 ? model.maxDofs : MAX_DOFS_DEFAULT;
  const cornerRecovery = model.stressRecovery !== 'centre' && model.stressRecovery !== 'center';
  const fixedTris = model.fixedTris;
  const loads = Array.isArray(model.loads) ? model.loads : [];
  if (!fixedTris || fixedTris.length < 9) {
    return fail('No fixed faces: at least one face must be fixed, otherwise the body is free to move (singular system).');
  }
  for (let li = 0; li < loads.length; li++) {
    const f = loads[li] && loads[li].force;
    if (!f || f.length < 3 || !isFinite(f[0]) || !isFinite(f[1]) || !isFinite(f[2])) {
      return fail(`Load ${li + 1} has an invalid force vector.`);
    }
  }

  const ticker = makeTicker(onProgress);
  const notes = [];
  await ticker.report(0, 'Voxelizing');

  // ---- 1. voxelize (with the DOF guard) --------------------------------------------------
  const requestedRes = clampRes(model.resolution === undefined ? 28 : model.resolution);
  let res = requestedRes;
  let vox, nx, ny, nz, NX, NY, NZ, NXY, nNodesGrid, nodeMask, nActive;
  const computeMasks = () => {
    const solid = vox.solid;
    nodeMask.fill(0);
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (!solid[i + nx * (j + ny * k)]) continue;
      // voxel (i,j,k) is the (dx,dy,dz) neighbour of node (i+1-dx, j+1-dy, k+1-dz)
      for (let e = 0; e < 8; e++) {
        const dx = e & 1, dy = (e >> 1) & 1, dz = (e >> 2) & 1;
        nodeMask[(i + 1 - dx) + NX * ((j + 1 - dy) + NY * (k + 1 - dz))] |= (1 << e);
      }
    }
    nActive = 0;
    for (let n = 0; n < nNodesGrid; n++) if (nodeMask[n]) nActive++;
  };
  for (let attempt = 0; ; attempt++) {
    vox = await voxelize(positions, res, ticker);
    if (!vox) return fail('Degenerate geometry: the body has zero size.');
    [nx, ny, nz] = vox.dims;
    NX = nx + 1; NY = ny + 1; NZ = nz + 1; NXY = NX * NY; nNodesGrid = NXY * NZ;
    nodeMask = new Uint8Array(nNodesGrid);
    computeMasks();
    if (nActive * 3 <= maxDofs || res <= 6 || attempt > 8) break;
    const next = Math.max(6, Math.min(res - 1, Math.floor(res * Math.cbrt(maxDofs / (nActive * 3)) * 0.98)));
    res = next;
  }
  if (res !== requestedRes) {
    notes.push(`Resolution reduced from ${requestedRes} to ${res} to stay under ${maxDofs} degrees of freedom.`);
  }
  if (vox.nVoxels === 0) {
    return fail('Voxelization produced no solid voxels — the surface is probably not closed, or the body is thinner than one voxel. Try a higher resolution.');
  }
  if (vox.leakyColumns > 0) {
    notes.push(`Surface does not look watertight (${vox.leakyColumns} voxel columns had an odd number of crossings); results may be unreliable.`);
  }
  const h = vox.h, solid = vox.solid;
  const ox = vox.origin[0], oy = vox.origin[1], oz = vox.origin[2];
  await ticker.report(0.08, 'Applying boundary conditions');

  // ---- 2. boundary conditions --------------------------------------------------------------
  // Marks active grid nodes whose distance to any triangle of `tris` is <= r. The node grid
  // itself is used as the 3D bucket grid: each triangle only visits the nodes inside its
  // (r-expanded) bounding box.
  const markNodesNear = async (tris, r, out) => {
    const nT = Math.floor(tris.length / 9), r2 = r * r;
    let count = 0;
    for (let t = 0; t < nT; t++) {
      if ((t & 1023) === 1023 && ticker.due()) await ticker.yield();
      const o = t * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
      const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
      let i0 = Math.ceil((Math.min(ax, bx, cx) - r - ox) / h), i1 = Math.floor((Math.max(ax, bx, cx) + r - ox) / h);
      let j0 = Math.ceil((Math.min(ay, by, cy) - r - oy) / h), j1 = Math.floor((Math.max(ay, by, cy) + r - oy) / h);
      let k0 = Math.ceil((Math.min(az, bz, cz) - r - oz) / h), k1 = Math.floor((Math.max(az, bz, cz) + r - oz) / h);
      if (i0 < 0) i0 = 0; if (i1 > nx) i1 = nx;
      if (j0 < 0) j0 = 0; if (j1 > ny) j1 = ny;
      if (k0 < 0) k0 = 0; if (k1 > nz) k1 = nz;
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const n = i + NX * (j + NY * k);
        if (!nodeMask[n] || out[n]) continue;
        const d2 = pointTriDist2(ox + i * h, oy + j * h, oz + k * h, ax, ay, az, bx, by, bz, cx, cy, cz);
        if (d2 <= r2) { out[n] = 1; count++; }
      }
    }
    return count;
  };
  const snapR = 0.87 * h;
  const fixed = new Uint8Array(nNodesGrid);
  const nFixed = await markNodesNear(fixedTris, snapR, fixed);
  if (nFixed === 0) {
    return fail('The fixed faces do not touch the voxel model (no grid nodes found on them). Try a higher resolution.');
  }

  // Drop voxels that are not face-connected to a fixed voxel: they would be free-floating
  // rigid bodies and make the system singular.
  {
    const reach = new Uint8Array(solid.length);
    const queue = new Int32Array(vox.nVoxels);
    let qh = 0, qt = 0;
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v = i + nx * (j + ny * k);
      if (!solid[v]) continue;
      const b = i + NX * (j + NY * k);
      if (fixed[b] || fixed[b + 1] || fixed[b + NX] || fixed[b + NX + 1] ||
        fixed[b + NXY] || fixed[b + NXY + 1] || fixed[b + NXY + NX] || fixed[b + NXY + NX + 1]) {
        reach[v] = 1; queue[qt++] = v;
      }
    }
    const nxy = nx * ny;
    const step = [1, -1, nx, -nx, nxy, -nxy];
    while (qh < qt) {
      const v = queue[qh++];
      for (let s = 0; s < 6; s++) {
        const w = v + step[s]; // padding guarantees w is in range for a solid v
        if (solid[w] && !reach[w]) { reach[w] = 1; queue[qt++] = w; }
      }
    }
    if (qt < vox.nVoxels) {
      const dropped = vox.nVoxels - qt;
      for (let v = 0; v < solid.length; v++) if (solid[v] && !reach[v]) solid[v] = 0;
      vox.nVoxels = qt;
      computeMasks();
      notes.push(`${dropped} voxel(s) not connected to a fixed face were ignored.`);
    }
  }

  // External force vector.
  const nDofGrid = nNodesGrid * 3;
  const f = new Float64Array(nDofGrid);
  const applied = [0, 0, 0];
  const mark = new Uint8Array(nNodesGrid);
  for (let li = 0; li < loads.length; li++) {
    const ld = loads[li];
    mark.fill(0);
    const cnt = ld.tris && ld.tris.length >= 9 ? await markNodesNear(ld.tris, snapR, mark) : 0;
    if (cnt === 0) {
      return fail(`Load ${li + 1} does not touch the voxel model (its faces match no grid nodes). Check the selected faces or raise the resolution.`);
    }
    // Prefer nodes that are free to move; a force put on a fixed node goes straight into the support.
    let nFree = 0;
    for (let n = 0; n < nNodesGrid; n++) if (mark[n] && !fixed[n]) nFree++;
    const useFreeOnly = nFree > 0;
    if (!useFreeOnly) notes.push(`Load ${li + 1} acts only on fixed nodes and has no effect on the body.`);
    const share = 1 / (useFreeOnly ? nFree : cnt);
    const fx = ld.force[0] * share, fy = ld.force[1] * share, fz = ld.force[2] * share;
    for (let n = 0; n < nNodesGrid; n++) {
      if (!mark[n] || (useFreeOnly && fixed[n])) continue;
      f[3 * n] += fx; f[3 * n + 1] += fy; f[3 * n + 2] += fz;
    }
    applied[0] += ld.force[0]; applied[1] += ld.force[1]; applied[2] += ld.force[2];
  }
  const nodeOff8 = new Int32Array(8);
  for (let n = 0; n < 8; n++) nodeOff8[n] = (n & 1) + NX * ((n >> 1) & 1) + NXY * ((n >> 2) & 1);
  const grav = model.gravity;
  if (grav && grav.length >= 3 && density > 0 && (grav[0] || grav[1] || grav[2])) {
    // rho [t/mm^3] * g [mm/s^2] * h^3 [mm^3] = N per voxel, lumped equally on its 8 nodes.
    const w = density * 1e-12 * 1000 * h * h * h;
    const gx = grav[0] * w, gy = grav[1] * w, gz = grav[2] * w;
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (!solid[i + nx * (j + ny * k)]) continue;
      const b = i + NX * (j + NY * k);
      for (let q = 0; q < 8; q++) {
        const n = b + nodeOff8[q];
        f[3 * n] += gx * 0.125; f[3 * n + 1] += gy * 0.125; f[3 * n + 2] += gz * 0.125;
      }
    }
    applied[0] += gx * vox.nVoxels; applied[1] += gy * vox.nVoxels; applied[2] += gz * vox.nVoxels;
  }

  // ---- 3. operator -------------------------------------------------------------------------
  const Ke = hexStiffness(E, nu, h);
  const st = buildStencils(Ke);
  const stStart = st.start, stCode = st.codes, stCoef = st.coefs, stDiag = st.diag;
  const off27 = new Int32Array(27);
  for (let c = 0; c < 27; c++) off27[c] = ((c % 3) - 1) + NX * ((((c / 3) | 0) % 3) - 1) + NXY * (((c / 9) | 0) - 1);

  let nFree = 0, nFix = 0;
  for (let n = 0; n < nNodesGrid; n++) if (nodeMask[n]) { if (fixed[n]) nFix++; else nFree++; }
  const freeList = new Int32Array(nFree), fixList = new Int32Array(nFix);
  nFree = 0; nFix = 0;
  for (let n = 0; n < nNodesGrid; n++) if (nodeMask[n]) { if (fixed[n]) fixList[nFix++] = n; else freeList[nFree++] = n; }

  // y[list] = (K x)[list]. x must be zero on fixed and inactive nodes (projection).
  const applyK = (list, x, y) => {
    const len = list.length;
    for (let q = 0; q < len; q++) {
      const n = list[q];
      const m = nodeMask[n];
      let a0 = 0, a1 = 0, a2 = 0;
      for (let e = stStart[m], e1 = stStart[m + 1]; e < e1; e++) {
        const j = 3 * (n + off27[stCode[e]]);
        const x0 = x[j], x1 = x[j + 1], x2 = x[j + 2];
        const c = 9 * e;
        a0 += stCoef[c] * x0 + stCoef[c + 1] * x1 + stCoef[c + 2] * x2;
        a1 += stCoef[c + 3] * x0 + stCoef[c + 4] * x1 + stCoef[c + 5] * x2;
        a2 += stCoef[c + 6] * x0 + stCoef[c + 7] * x1 + stCoef[c + 8] * x2;
      }
      const o = 3 * n;
      y[o] = a0; y[o + 1] = a1; y[o + 2] = a2;
    }
  };

  // ---- 4. PCG --------------------------------------------------------------------------------
  const u = new Float64Array(nDofGrid);
  let iterations = 0, residual = 0, converged = true;
  let fnorm2 = 0;
  for (let q = 0; q < nFree; q++) {
    const o = 3 * freeList[q];
    fnorm2 += f[o] * f[o] + f[o + 1] * f[o + 1] + f[o + 2] * f[o + 2];
  }
  if (nFree > 0 && fnorm2 > 0) {
    const r = new Float64Array(nDofGrid), z = new Float64Array(nDofGrid);
    const p = new Float64Array(nDofGrid), Ap = new Float64Array(nDofGrid);
    const Minv = new Float64Array(nDofGrid);
    let rz = 0;
    for (let q = 0; q < nFree; q++) {
      const n = freeList[q], o = 3 * n, m = 3 * nodeMask[n];
      for (let d = 0; d < 3; d++) {
        Minv[o + d] = 1 / stDiag[m + d];
        r[o + d] = f[o + d];
        z[o + d] = p[o + d] = Minv[o + d] * r[o + d];
        rz += r[o + d] * z[o + d];
      }
    }
    const fnorm = Math.sqrt(fnorm2);
    const logTol = Math.log(1 / tol);
    residual = 1; converged = false;
    ticker.set(0.1, 'Solving');
    while (iterations < maxIter) {
      applyK(freeList, p, Ap);
      let pAp = 0;
      for (let q = 0; q < nFree; q++) {
        const o = 3 * freeList[q];
        pAp += p[o] * Ap[o] + p[o + 1] * Ap[o + 1] + p[o + 2] * Ap[o + 2];
      }
      if (!(pAp > 0)) break; // breakdown (should not happen for an SPD system)
      const alpha = rz / pAp;
      let rr = 0, rzNew = 0;
      for (let q = 0; q < nFree; q++) {
        const o = 3 * freeList[q];
        u[o] += alpha * p[o]; u[o + 1] += alpha * p[o + 1]; u[o + 2] += alpha * p[o + 2];
        const r0 = (r[o] -= alpha * Ap[o]), r1 = (r[o + 1] -= alpha * Ap[o + 1]), r2 = (r[o + 2] -= alpha * Ap[o + 2]);
        rr += r0 * r0 + r1 * r1 + r2 * r2;
        const z0 = Minv[o] * r0, z1 = Minv[o + 1] * r1, z2 = Minv[o + 2] * r2;
        z[o] = z0; z[o + 1] = z1; z[o + 2] = z2;
        rzNew += r0 * z0 + r1 * z1 + r2 * z2;
      }
      iterations++;
      residual = Math.sqrt(rr) / fnorm;
      if (!isFinite(residual)) break;
      if (residual <= tol) { converged = true; break; }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let q = 0; q < nFree; q++) {
        const o = 3 * freeList[q];
        p[o] = z[o] + beta * p[o]; p[o + 1] = z[o + 1] + beta * p[o + 1]; p[o + 2] = z[o + 2] + beta * p[o + 2];
      }
      if (ticker.due()) {
        const prog = Math.max(0, Math.min(1, Math.log(1 / Math.max(residual, tol)) / logTol));
        ticker.set(0.1 + 0.8 * prog, `Solving (iteration ${iterations}, residual ${residual.toExponential(1)})`);
        await ticker.yield();
      }
    }
    if (!isFinite(residual)) {
      const out = fail('The solver diverged (non-finite residual). The model is probably not properly restrained.');
      out.iterations = iterations;
      return out;
    }
  }
  await ticker.report(0.9, 'Computing stresses');

  // ---- 5. reactions ----------------------------------------------------------------------------
  const reaction = [0, 0, 0];
  {
    const Ku = new Float64Array(nDofGrid);
    applyK(fixList, u, Ku);
    for (let q = 0; q < nFix; q++) {
      const o = 3 * fixList[q];
      reaction[0] += Ku[o] - f[o]; reaction[1] += Ku[o + 1] - f[o + 1]; reaction[2] += Ku[o + 2] - f[o + 2];
    }
  }

  // ---- 6. stress recovery ------------------------------------------------------------------------
  const lam = E * nu / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  const gradPts = new Float64Array(9 * 24);
  for (let n = 0; n < 8; n++) shapeGrads(n & 1, (n >> 1) & 1, (n >> 2) & 1, h, gradPts, n * 24);
  shapeGrads(0.5, 0.5, 0.5, h, gradPts, 8 * 24);
  const eps = new Float64Array(nNodesGrid * 6);
  const ecount = new Uint8Array(nNodesGrid);
  const ue = new Float64Array(24);
  const e6 = new Float64Array(6);
  const strainAt = (pt) => {
    const g = pt * 24;
    let exx = 0, eyy = 0, ezz = 0, gxy = 0, gyz = 0, gzx = 0;
    for (let n = 0; n < 8; n++) {
      const gx = gradPts[g + 3 * n], gy = gradPts[g + 3 * n + 1], gz = gradPts[g + 3 * n + 2];
      const ux = ue[3 * n], uy = ue[3 * n + 1], uz = ue[3 * n + 2];
      exx += gx * ux; eyy += gy * uy; ezz += gz * uz;
      gxy += gy * ux + gx * uy; gyz += gz * uy + gy * uz; gzx += gx * uz + gz * ux;
    }
    e6[0] = exx; e6[1] = eyy; e6[2] = ezz; e6[3] = gxy; e6[4] = gyz; e6[5] = gzx;
  };
  for (let k = 1; k < nz - 1; k++) {
    if (ticker.due()) await ticker.yield();
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (!solid[i + nx * (j + ny * k)]) continue;
      const b = i + NX * (j + NY * k);
      for (let q = 0; q < 8; q++) {
        const o = 3 * (b + nodeOff8[q]);
        ue[3 * q] = u[o]; ue[3 * q + 1] = u[o + 1]; ue[3 * q + 2] = u[o + 2];
      }
      if (!cornerRecovery) strainAt(8);
      for (let q = 0; q < 8; q++) {
        if (cornerRecovery) strainAt(q);
        const n = b + nodeOff8[q], o = 6 * n;
        eps[o] += e6[0]; eps[o + 1] += e6[1]; eps[o + 2] += e6[2];
        eps[o + 3] += e6[3]; eps[o + 4] += e6[4]; eps[o + 5] += e6[5];
        ecount[n]++;
      }
    }
  }
  const vm = new Float64Array(nNodesGrid);
  let maxStress = 0, maxDisp = 0;
  for (let n = 0; n < nNodesGrid; n++) {
    const c = ecount[n];
    if (!c) continue;
    const o = 6 * n, ic = 1 / c;
    const exx = eps[o] * ic, eyy = eps[o + 1] * ic, ezz = eps[o + 2] * ic;
    const tr = lam * (exx + eyy + ezz);
    const sx = tr + 2 * mu * exx, sy = tr + 2 * mu * eyy, sz = tr + 2 * mu * ezz;
    const txy = mu * eps[o + 3] * ic, tyz = mu * eps[o + 4] * ic, tzx = mu * eps[o + 5] * ic;
    const v = Math.sqrt(0.5 * ((sx - sy) * (sx - sy) + (sy - sz) * (sy - sz) + (sz - sx) * (sz - sx)) +
      3 * (txy * txy + tyz * tyz + tzx * tzx));
    vm[n] = v;
    if (v > maxStress) maxStress = v;
    const d = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
    if (d > maxDisp) maxDisp = d;
  }

  // ---- 7. sampling ---------------------------------------------------------------------------------
  // Locates the solid voxel containing (x,y,z), or the nearest solid voxel within 2 voxels
  // (the point is then clamped onto it). Sets sv (node base index) and tx,ty,tz in [0,1].
  let sv = -1, tx = 0, ty = 0, tz = 0;
  const locate = (x, y, z) => {
    const gx = (x - ox) / h, gy = (y - oy) / h, gz = (z - oz) / h;
    if (!(gx === gx && gy === gy && gz === gz)) { sv = -1; return false; }
    const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz);
    if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz && solid[i + nx * (j + ny * k)]) {
      sv = i + NX * (j + NY * k); tx = gx - i; ty = gy - j; tz = gz - k;
      return true;
    }
    for (let rad = 1; rad <= 2; rad++) {
      let best = Infinity, bi = 0, bj = 0, bk = 0;
      const k0 = Math.max(0, k - rad), k1 = Math.min(nz - 1, k + rad);
      const j0 = Math.max(0, j - rad), j1 = Math.min(ny - 1, j + rad);
      const i0 = Math.max(0, i - rad), i1 = Math.min(nx - 1, i + rad);
      for (let c = k0; c <= k1; c++) for (let b = j0; b <= j1; b++) for (let a = i0; a <= i1; a++) {
        if (!solid[a + nx * (b + ny * c)]) continue;
        const dx = gx < a ? a - gx : (gx > a + 1 ? gx - a - 1 : 0);
        const dy = gy < b ? b - gy : (gy > b + 1 ? gy - b - 1 : 0);
        const dz = gz < c ? c - gz : (gz > c + 1 ? gz - c - 1 : 0);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; bi = a; bj = b; bk = c; }
      }
      if (best < Infinity) {
        sv = bi + NX * (bj + NY * bk);
        tx = Math.min(1, Math.max(0, gx - bi)); ty = Math.min(1, Math.max(0, gy - bj)); tz = Math.min(1, Math.max(0, gz - bk));
        return true;
      }
    }
    sv = -1;
    return false;
  };
  const w8 = new Float64Array(8);
  const weights = () => {
    const ax = 1 - tx, ay = 1 - ty, az = 1 - tz;
    w8[0] = ax * ay * az; w8[1] = tx * ay * az; w8[2] = ax * ty * az; w8[3] = tx * ty * az;
    w8[4] = ax * ay * tz; w8[5] = tx * ay * tz; w8[6] = ax * ty * tz; w8[7] = tx * ty * tz;
  };
  const sample = (x, y, z) => {
    if (!locate(x, y, z)) return { u: [0, 0, 0], vonMises: 0 };
    weights();
    let ux = 0, uy = 0, uz = 0, s = 0;
    for (let q = 0; q < 8; q++) {
      const n = sv + nodeOff8[q], w = w8[q];
      ux += w * u[3 * n]; uy += w * u[3 * n + 1]; uz += w * u[3 * n + 2]; s += w * vm[n];
    }
    return { u: [ux, uy, uz], vonMises: s };
  };

  const vertexDisp = new Float32Array(nVerts * 3);
  const vertexDispMag = new Float32Array(nVerts);
  const vertexStress = new Float32Array(nVerts);
  let missed = 0;
  for (let v = 0; v < nVerts; v++) {
    if ((v & 8191) === 8191 && ticker.due()) { ticker.set(0.92 + 0.08 * v / nVerts); await ticker.yield(); }
    if (!locate(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2])) { missed++; continue; }
    weights();
    let ux = 0, uy = 0, uz = 0, s = 0;
    for (let q = 0; q < 8; q++) {
      const n = sv + nodeOff8[q], w = w8[q];
      ux += w * u[3 * n]; uy += w * u[3 * n + 1]; uz += w * u[3 * n + 2]; s += w * vm[n];
    }
    vertexDisp[3 * v] = ux; vertexDisp[3 * v + 1] = uy; vertexDisp[3 * v + 2] = uz;
    vertexDispMag[v] = Math.sqrt(ux * ux + uy * uy + uz * uz);
    vertexStress[v] = s;
  }
  if (missed > 0) notes.push(`${missed} surface vertices were further than 2 voxels from the voxel model and got zero results.`);

  // ---- 8. report -------------------------------------------------------------------------------------
  let ok = true, head;
  if (fnorm2 === 0) {
    head = 'No effective load: the result is zero everywhere.';
  } else if (converged) {
    head = `Converged in ${iterations} iterations (residual ${residual.toExponential(2)}).`;
  } else if (residual <= 1e-3) {
    head = `Stopped after ${iterations} iterations at residual ${residual.toExponential(2)} (target ${tol}); results are approximate.`;
  } else {
    ok = false;
    head = `Solver did not converge: residual ${residual.toExponential(2)} after ${iterations} iterations. The body may be poorly restrained (e.g. parts joined only along an edge); results are not reliable.`;
  }
  const result = {
    ok, message: [head, ...notes].join(' '),
    voxelSize: h, dims: [nx, ny, nz], origin: [ox, oy, oz], resolution: res,
    nVoxels: vox.nVoxels, nNodes: nActive, iterations, residual,
    vertexDisp, vertexDispMag, vertexStress,
    maxDisp, maxStress,
    minFOS: maxStress > 0 && yieldStress > 0 ? yieldStress / maxStress : Infinity,
    reaction, appliedForce: applied,
    sample,
  };
  await ticker.report(1, 'Done');
  return result;
}
