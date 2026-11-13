// Minimal IGES reader for curve entities (wireframe): 110 line, 100 circular arc, 106 copious data,
// 126 rational B-spline curve, with 124 transformation matrices applied. Surfaces/solids are not read
// (the OpenCascade build used here has no IGES translator) - use STEP for exact solids.

export function parseIGES(text) {
  const D = [], P = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.padEnd(80, ' ');
    const sec = line[72];
    if (sec === 'D') D.push(line);
    else if (sec === 'P') {
      const de = parseInt(line.slice(64, 72));
      P[de] = (P[de] || '') + line.slice(0, 64);
    }
  }
  const ents = {};
  for (let i = 0; i + 1 < D.length; i += 2) {
    const a = D[i], b = D[i + 1];
    const de = parseInt(a.slice(73, 80));
    const type = parseInt(a.slice(0, 8));
    const xform = parseInt(a.slice(48, 56)) || 0;
    const form = parseInt(b.slice(32, 40)) || 0;
    const body = (P[de] || '').split(';')[0];
    const params = body.split(',').slice(1).map((s) => parseFloat(s.trim().replace(/[dD]/, 'E')));
    ents[de] = { de, type, form, xform, params };
  }
  const matrix = (de) => {
    const e = ents[de];
    if (!e || e.type !== 124) return null;
    const p = e.params;
    return (q) => [p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3], p[4] * q[0] + p[5] * q[1] + p[6] * q[2] + p[7], p[8] * q[0] + p[9] * q[1] + p[10] * q[2] + p[11]];
  };
  const polylines = [];
  for (const e of Object.values(ents)) {
    const p = e.params;
    let pts = null;
    if (e.type === 110) pts = [[p[0], p[1], p[2]], [p[3], p[4], p[5]]];
    else if (e.type === 100) {
      const [z, cx, cy, sx, sy, ex, ey] = p;
      const r = Math.hypot(sx - cx, sy - cy);
      const a1 = Math.atan2(sy - cy, sx - cx);
      let sw = Math.atan2(ey - cy, ex - cx) - a1;
      if (sw <= 1e-12) sw += 2 * Math.PI;
      const n = Math.max(8, Math.ceil(sw / (Math.PI / 24)));
      pts = Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(a1 + (sw * i) / n), cy + r * Math.sin(a1 + (sw * i) / n), z]);
    } else if (e.type === 106) {
      const ip = p[0], n = p[1];
      pts = [];
      if (ip === 1) for (let i = 0; i < n; i++) pts.push([p[3 + i * 2], p[4 + i * 2], p[2]]);
      else {
        const stride = ip === 2 ? 3 : 6;
        for (let i = 0; i < n; i++) pts.push([p[2 + i * stride], p[3 + i * stride], p[4 + i * stride]]);
      }
    } else if (e.type === 126) {
      const K = p[0], M = p[1];
      const nK = K + M + 2;
      const knots = p.slice(6, 6 + nK);
      const w = p.slice(6 + nK, 6 + nK + K + 1);
      const cp = [];
      const c0 = 6 + nK + K + 1;
      for (let i = 0; i <= K; i++) cp.push([p[c0 + i * 3], p[c0 + 1 + i * 3], p[c0 + 2 + i * 3]]);
      const v0 = p[c0 + (K + 1) * 3], v1 = p[c0 + 1 + (K + 1) * 3];
      const t0 = Number.isFinite(v0) ? v0 : knots[M], t1 = Number.isFinite(v1) ? v1 : knots[K + 1];
      const evalAt = (t) => {
        let k = M;
        while (k < K && t >= knots[k + 1]) k++;
        const d = [];
        for (let j = 0; j <= M; j++) {
          const i = j + k - M;
          d.push([cp[i][0] * w[i], cp[i][1] * w[i], cp[i][2] * w[i], w[i]]);
        }
        for (let r = 1; r <= M; r++)
          for (let j = M; j >= r; j--) {
            const i = j + k - M;
            const den = knots[i + M - r + 1] - knots[i];
            const al = den > 1e-14 ? (t - knots[i]) / den : 0;
            for (let c = 0; c < 4; c++) d[j][c] = (1 - al) * d[j - 1][c] + al * d[j][c];
          }
        const q = d[M];
        return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
      };
      if (M === 1) pts = cp;
      else {
        const n = Math.max(12, K * 6), span = t1 - t0;
        pts = Array.from({ length: n + 1 }, (_, i) => evalAt(i === n ? t1 - 1e-9 * Math.max(1, Math.abs(span)) : t0 + (span * i) / n));
      }
    }
    if (!pts || pts.length < 2 || pts.some((q) => q.some((x) => !Number.isFinite(x)))) continue;
    const m = e.xform ? matrix(e.xform) : null;
    polylines.push(m ? pts.map(m) : pts);
  }
  const counts = {};
  for (const e of Object.values(ents)) counts[e.type] = (counts[e.type] || 0) + 1;
  return { polylines, counts };
}
