// SOQUA design - DXF import / export (pure JS, no dependencies, browser + node).
//
//   parseDXF(text)  -> { units, extents:{min:[x,y],max:[x,y]}, layers, entities, styles, header }
//   writeDXF({ entities, layers, units }) -> string (ASCII DXF, AC1009 / R12 flavour)
//
// Normalized entities (2D, angles in degrees unless noted):
//   {type:'line', x1,y1,x2,y2}
//   {type:'circle', cx,cy,r}
//   {type:'arc', cx,cy,r,a1,a2}                      ccw from a1 to a2
//   {type:'polyline', pts:[[x,y,bulge?],...], closed}
//   {type:'ellipse', cx,cy,mx,my,ratio,t1,t2}        t1/t2 in radians
//   {type:'spline', degree,ctrl,knots,fit,closed,pts}
//   {type:'text', x,y,h,text,rot,halign,valign,style,font}
//   {type:'point', x,y}
// Every entity may carry layer, color (ACI), linetype.

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const MAX_BLOCK_DEPTH = 16;
const ARC_SEGMENTS = 64; // segments per full circle when sampling curves
const SPLINE_SAMPLES = 8; // samples per knot span

/* ------------------------------------------------------------------ */
/* low level reader                                                    */
/* ------------------------------------------------------------------ */

class Reader {
  constructor(text) {
    this.t = text;
    this.p = 0;
    this.n = text.length;
    this.code = -1;
    this.value = '';
    this.eof = false;
  }

  // Read the next (code, value) pair. Returns false at end of input.
  next() {
    const t = this.t;
    if (this.p >= this.n) { this.eof = true; return false; }
    let e = t.indexOf('\n', this.p);
    if (e < 0) { this.eof = true; this.p = this.n; return false; }
    const code = parseInt(t.slice(this.p, e), 10);
    const vs = e + 1;
    let ve = t.indexOf('\n', vs);
    if (ve < 0) ve = this.n;
    this.p = ve + 1;
    this.code = Number.isNaN(code) ? -1 : code;
    this.value = t.slice(vs, ve > vs && t.charCodeAt(ve - 1) === 13 ? ve - 1 : ve);
    return true;
  }

  // Advance to the next pair whose code is 0 without materialising the
  // skipped values (keeps huge OLE2FRAME / image blobs cheap).
  skipToZero() {
    const t = this.t;
    for (;;) {
      if (this.p >= this.n) { this.eof = true; return false; }
      const e = t.indexOf('\n', this.p);
      if (e < 0) { this.eof = true; this.p = this.n; return false; }
      const code = parseInt(t.slice(this.p, e), 10);
      const vs = e + 1;
      let ve = t.indexOf('\n', vs);
      if (ve < 0) ve = this.n;
      this.p = ve + 1;
      if (code === 0) {
        this.code = 0;
        this.value = t.slice(vs, ve > vs && t.charCodeAt(ve - 1) === 13 ? ve - 1 : ve);
        return true;
      }
    }
  }

  // Collect the pairs of the current record (up to the next code 0).
  collect(keepXData) {
    const C = [];
    const V = [];
    while (this.next() && this.code !== 0) {
      const c = this.code;
      if (c === 310 || c < 0) continue;
      if (c >= 1000 && !keepXData) continue;
      C.push(c);
      V.push(this.value);
    }
    return { C, V };
  }
}

function gv(r, code) {
  const i = r.C.indexOf(code);
  return i < 0 ? undefined : r.V[i];
}

function gn(r, code, def) {
  const i = r.C.indexOf(code);
  if (i < 0) return def;
  const f = parseFloat(r.V[i]);
  return Number.isFinite(f) ? f : def;
}

function gi(r, code, def) {
  const i = r.C.indexOf(code);
  if (i < 0) return def;
  const f = parseInt(r.V[i], 10);
  return Number.isFinite(f) ? f : def;
}

/* ------------------------------------------------------------------ */
/* text decoding                                                       */
/* ------------------------------------------------------------------ */

const MB_CODEPAGES = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 4: 'johab', 5: 'gbk' };
const HEX4 = /^[0-9A-Fa-f]{4}$/;

function decodeMultiByte(n, hex) {
  try {
    const hi = parseInt(hex.slice(0, 2), 16);
    const lo = parseInt(hex.slice(2, 4), 16);
    const bytes = hi ? new Uint8Array([hi, lo]) : new Uint8Array([lo]);
    return new TextDecoder(MB_CODEPAGES[n]).decode(bytes);
  } catch {
    return '�';
  }
}

// Decode \U+XXXX and \M+nXXXX escapes (valid in TEXT, MTEXT, names ...).
function decodeUnicodeEscapes(s) {
  if (s.indexOf('\\') < 0) return s;
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_, n, h) => decodeMultiByte(+n, h));
}

// %%d %%p %%c %%u %%o %%k %%nnn %%% control codes.
function decodePercentCodes(s) {
  if (s.indexOf('%%') < 0) return s;
  return s.replace(/%%(\d{3}|.)/g, (m, c) => {
    if (c.length === 3) return String.fromCharCode(parseInt(c, 10));
    switch (c.toLowerCase()) {
      case 'd': return '°';
      case 'p': return '±';
      case 'c': return '⌀';
      case 'u': case 'o': case 'k': return '';
      case '%': return '%';
      default: return m;
    }
  });
}

/**
 * Strip MTEXT inline formatting. Returns { text, font } where font is the
 * first \f<name>|...; font override found (or null).
 */
export function decodeMText(raw) {
  const s = String(raw ?? '');
  let out = '';
  let font = null;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const c = s[i + 1];
      if (c === undefined) break;
      if (c === 'U' && s[i + 2] === '+' && HEX4.test(s.substr(i + 3, 4))) {
        out += String.fromCharCode(parseInt(s.substr(i + 3, 4), 16));
        i += 6;
        continue;
      }
      if (c === 'M' && s[i + 2] === '+' && /[1-5]/.test(s[i + 3] || '') && HEX4.test(s.substr(i + 4, 4))) {
        out += decodeMultiByte(+s[i + 3], s.substr(i + 4, 4));
        i += 7;
        continue;
      }
      if (c === '\\' || c === '{' || c === '}') { out += c; i++; continue; }
      if (c === 'P' || c === 'N' || c === 'X') { out += '\n'; i++; continue; }
      if (c === '~') { out += ' '; i++; continue; }
      if ('LlOoKk'.indexOf(c) >= 0) { i++; continue; }
      if ('fFHCcAWQTpS'.indexOf(c) >= 0) {
        const end = s.indexOf(';', i + 2);
        if (end < 0) { i++; continue; }
        const arg = s.slice(i + 2, end);
        if (c === 'f' || c === 'F') {
          if (font === null) {
            const name = arg.split('|')[0].trim();
            if (name) font = name;
          }
        } else if (c === 'S') {
          // stacked text: "num/den", "num#den", "num^den"
          out += arg.replace(/\\([#^/])/g, '$1').replace(/[#^]/g, '/').replace(/\/\s*$/, '');
        }
        i = end;
        continue;
      }
      out += ch; // unknown escape: keep verbatim
      continue;
    }
    if (ch === '{' || ch === '}') continue;
    if (ch === '^') {
      const c = s[i + 1];
      if (c === 'I') { out += ' '; i++; continue; }
      if (c === 'J') { out += '\n'; i++; continue; }
      if (c === 'M') { i++; continue; }
    }
    if (ch === '\r') continue;
    out += ch;
  }
  return { text: decodePercentCodes(out), font };
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function norm360(a) {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

function arcSweepDeg(a1, a2) {
  let sw = (a2 - a1) % 360;
  if (sw <= 1e-12) sw += 360;
  return sw;
}

// Convert a bulge segment into an arc description (signed sweep, radians).
function bulgeArc(x1, y1, x2, y2, b) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (!b || d < 1e-14) return null;
  const k = (1 - b * b) / (4 * b);
  const cx = (x1 + x2) / 2 - dy * k;
  const cy = (y1 + y2) / 2 + dx * k;
  const r = (d * (1 + b * b)) / (4 * Math.abs(b));
  return { cx, cy, r, start: Math.atan2(y1 - cy, x1 - cx), sweep: 4 * Math.atan(b) };
}

function sampleArcInto(out, cx, cy, r, start, sweep, skipFirst) {
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / TAU) * ARC_SEGMENTS));
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = start + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

function ellipseRange(e) {
  const t1 = Number.isFinite(e.t1) ? e.t1 : 0;
  let t2 = Number.isFinite(e.t2) ? e.t2 : TAU;
  while (t2 <= t1 + 1e-12) t2 += TAU;
  while (t2 - t1 > TAU + 1e-9) t2 -= TAU;
  return [t1, t2];
}

function isFullEllipse(e) {
  const [t1, t2] = ellipseRange(e);
  return Math.abs(t2 - t1 - TAU) < 1e-9;
}

function ellipsePoints(e) {
  const [t1, t2] = ellipseRange(e);
  const ratio = Number.isFinite(e.ratio) ? e.ratio : 1;
  const nx = -e.my * ratio;
  const ny = e.mx * ratio;
  const n = Math.max(8, Math.ceil(((t2 - t1) / TAU) * 72));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t1 + ((t2 - t1) * i) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push([e.cx + c * e.mx + s * nx, e.cy + c * e.my + s * ny]);
  }
  return pts;
}

function polylineFlat(e) {
  const src = e.pts || [];
  const out = [];
  const n = src.length;
  if (!n) return out;
  out.push([src[0][0], src[0][1]]);
  const segs = e.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p = src[i];
    const q = src[(i + 1) % n];
    const arc = p[2] ? bulgeArc(p[0], p[1], q[0], q[1], p[2]) : null;
    if (arc) {
      sampleArcInto(out, arc.cx, arc.cy, arc.r, arc.start, arc.sweep, true);
      out[out.length - 1] = [q[0], q[1]];
    } else {
      out.push([q[0], q[1]]);
    }
  }
  return out;
}

/* ---- B-spline ---- */

function deBoor(deg, ctrl, w, knots, span, u) {
  const d = [];
  for (let j = 0; j <= deg; j++) {
    const idx = span - deg + j;
    const p = ctrl[idx];
    const wt = w ? w[idx] : 1;
    d.push([p[0] * wt, p[1] * wt, wt]);
  }
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = span - deg + j;
      const den = knots[i + deg - r + 1] - knots[i];
      const a = den > 0 ? (u - knots[i]) / den : 0;
      const A = d[j - 1];
      const B = d[j];
      d[j] = [(1 - a) * A[0] + a * B[0], (1 - a) * A[1] + a * B[1], (1 - a) * A[2] + a * B[2]];
    }
  }
  const p = d[deg];
  const ww = p[2] || 1;
  return [p[0] / ww, p[1] / ww];
}

function catmullRom(fit, closed) {
  const n = fit.length;
  if (n < 3) return fit.map((p) => [p[0], p[1]]);
  const out = [];
  const segs = closed ? n : n - 1;
  const at = (i) => (closed ? fit[((i % n) + n) % n] : fit[Math.max(0, Math.min(n - 1, i))]);
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let j = 0; j < SPLINE_SAMPLES; j++) {
      const t = j / SPLINE_SAMPLES;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  const last = at(segs);
  out.push([last[0], last[1]]);
  return out;
}

/**
 * Sample a spline into a polyline. Uses de Boor on the control polygon when
 * available (rational if weights are given), otherwise a Catmull-Rom
 * interpolation of the fit points.
 */
export function sampleSpline(sp) {
  const ctrl = sp.ctrl || [];
  const n = ctrl.length;
  if (n >= 2) {
    let deg = Math.max(1, Math.min(sp.degree | 0 || 3, n - 1));
    let knots = sp.knots || [];
    const need = n + deg + 1;
    let valid = knots.length >= need;
    if (valid) {
      for (let i = 1; i < need; i++) if (!(knots[i] >= knots[i - 1])) { valid = false; break; }
    }
    if (!valid || deg !== (sp.degree | 0)) {
      // clamped uniform knot vector
      knots = [];
      for (let i = 0; i < need; i++) knots.push(i <= deg ? 0 : i >= n ? n - deg : i - deg);
    }
    const w = sp.weights && sp.weights.length === n ? sp.weights : null;
    const pts = [];
    for (let span = deg; span < n; span++) {
      const u0 = knots[span];
      const u1 = knots[span + 1];
      if (!(u1 > u0)) continue;
      for (let j = 0; j < SPLINE_SAMPLES; j++) {
        pts.push(deBoor(deg, ctrl, w, knots, span, u0 + ((u1 - u0) * j) / SPLINE_SAMPLES));
      }
    }
    // end point
    let last = n - 1;
    while (last > deg && !(knots[last + 1] > knots[last])) last--;
    pts.push(deBoor(deg, ctrl, w, knots, last, knots[n]));
    if (pts.length >= 2) return pts;
  }
  const fit = sp.fit || [];
  if (fit.length) return catmullRom(fit, !!sp.closed);
  return ctrl.map((p) => [p[0], p[1]]);
}

/**
 * Flatten any curve entity into a list of [x,y] points to be drawn as a
 * polyline (closed shapes repeat their first point). Returns null for
 * entities that are not curves (text, point, unknown).
 */
export function entityToPoints(e) {
  if (!e) return null;
  switch (e.type) {
    case 'line':
      return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'circle': {
      const out = [];
      sampleArcInto(out, e.cx, e.cy, e.r, 0, TAU, false);
      out[out.length - 1] = [out[0][0], out[0][1]];
      return out;
    }
    case 'arc': {
      const out = [];
      sampleArcInto(out, e.cx, e.cy, e.r, e.a1 * DEG, arcSweepDeg(e.a1, e.a2) * DEG, false);
      return out;
    }
    case 'polyline': {
      const out = polylineFlat(e);
      return out;
    }
    case 'ellipse': {
      const out = ellipsePoints(e);
      if (isFullEllipse(e) && out.length) out[out.length - 1] = [out[0][0], out[0][1]];
      return out;
    }
    case 'spline': {
      const pts = e.pts && e.pts.length ? e.pts : sampleSpline(e);
      return pts.map((p) => [p[0], p[1]]);
    }
    default:
      return null;
  }
}

function arcBoundsInto(bb, cx, cy, r, startRad, sweepRad) {
  const a0 = sweepRad >= 0 ? startRad : startRad + sweepRad;
  const sw = Math.abs(sweepRad);
  bb.add(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
  bb.add(cx + r * Math.cos(a0 + sw), cy + r * Math.sin(a0 + sw));
  // quadrant points inside the sweep
  const first = Math.ceil((a0 - 1e-12) / (Math.PI / 2));
  for (let k = first; k * (Math.PI / 2) <= a0 + sw + 1e-12; k++) {
    const a = k * (Math.PI / 2);
    bb.add(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

function makeBounds() {
  return {
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    add(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < this.minX) this.minX = x;
      if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
    },
  };
}

/** Bounding box of a list of entities: {min:[x,y],max:[x,y]} or null if empty. */
export function computeExtents(entities) {
  const bb = makeBounds();
  for (const e of entities || []) {
    if (!e) continue;
    switch (e.type) {
      case 'line':
        bb.add(e.x1, e.y1);
        bb.add(e.x2, e.y2);
        break;
      case 'circle':
        bb.add(e.cx - e.r, e.cy - e.r);
        bb.add(e.cx + e.r, e.cy + e.r);
        break;
      case 'arc':
        arcBoundsInto(bb, e.cx, e.cy, e.r, e.a1 * DEG, arcSweepDeg(e.a1, e.a2) * DEG);
        break;
      case 'polyline': {
        const pts = e.pts || [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const p = pts[i];
          bb.add(p[0], p[1]);
          if (p[2] && (i < n - 1 || e.closed)) {
            const q = pts[(i + 1) % n];
            const arc = bulgeArc(p[0], p[1], q[0], q[1], p[2]);
            if (arc) arcBoundsInto(bb, arc.cx, arc.cy, arc.r, arc.start, arc.sweep);
          }
        }
        break;
      }
      case 'ellipse':
      case 'spline': {
        const pts = entityToPoints(e) || [];
        for (const p of pts) bb.add(p[0], p[1]);
        break;
      }
      case 'text':
      case 'point':
        bb.add(e.x, e.y);
        break;
      default:
        break;
    }
  }
  if (bb.minX === Infinity) return null;
  return { min: [bb.minX, bb.minY], max: [bb.maxX, bb.maxY] };
}

/* ------------------------------------------------------------------ */
/* entity construction                                                 */
/* ------------------------------------------------------------------ */

const KNOWN = new Set([
  'LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'SEQEND', 'ELLIPSE', 'SPLINE',
  'TEXT', 'MTEXT', 'ATTRIB', 'POINT', 'INSERT', 'DIMENSION', 'SOLID', 'TRACE',
]);

const HALIGN = ['left', 'center', 'right'];
const VALIGN_TEXT = ['baseline', 'bottom', 'middle', 'top'];

function common(e, r) {
  const layer = gv(r, 8);
  e.layer = layer !== undefined && layer.trim() !== '' ? decodeUnicodeEscapes(layer.trim()) : '0';
  const color = gi(r, 62, undefined);
  if (color !== undefined) e.color = color;
  const lt = gv(r, 6);
  if (lt !== undefined && lt.trim() !== '') e.linetype = lt.trim();
  if (gi(r, 67, 0) === 1) e._paper = true;
  return e;
}

function mirrored(r) {
  return gn(r, 230, 1) < 0;
}

function buildEntity(type, r) {
  switch (type) {
    case 'LINE':
      return common({ type: 'line', x1: gn(r, 10, 0), y1: gn(r, 20, 0), x2: gn(r, 11, 0), y2: gn(r, 21, 0) }, r);
    case 'POINT':
      return common({ type: 'point', x: gn(r, 10, 0), y: gn(r, 20, 0) }, r);
    case 'CIRCLE': {
      const m = mirrored(r);
      const cx = gn(r, 10, 0);
      return common({ type: 'circle', cx: m ? -cx : cx, cy: gn(r, 20, 0), r: Math.abs(gn(r, 40, 0)) }, r);
    }
    case 'ARC': {
      const m = mirrored(r);
      const cx = gn(r, 10, 0);
      let a1 = gn(r, 50, 0);
      let a2 = gn(r, 51, 360);
      if (m) [a1, a2] = [norm360(180 - a2), norm360(180 - a1)];
      return common({ type: 'arc', cx: m ? -cx : cx, cy: gn(r, 20, 0), r: Math.abs(gn(r, 40, 0)), a1, a2 }, r);
    }
    case 'LWPOLYLINE': {
      const m = mirrored(r);
      const pts = [];
      let cur = null;
      for (let i = 0; i < r.C.length; i++) {
        const c = r.C[i];
        if (c === 10) {
          const x = parseFloat(r.V[i]) || 0;
          cur = [m ? -x : x, 0];
          pts.push(cur);
        } else if (c === 20 && cur) {
          cur[1] = parseFloat(r.V[i]) || 0;
        } else if (c === 42 && cur) {
          const b = parseFloat(r.V[i]) || 0;
          if (b) cur[2] = m ? -b : b;
        }
      }
      if (!pts.length) return null;
      return common({ type: 'polyline', pts, closed: (gi(r, 70, 0) & 1) === 1 }, r);
    }
    case 'POLYLINE': {
      const flags = gi(r, 70, 0);
      const e = common({ type: 'polyline', pts: [], closed: (flags & 1) === 1 }, r);
      e._mesh = (flags & (16 | 64)) !== 0;
      e._splineFit = (flags & 4) !== 0;
      e._mirror = mirrored(r);
      return e;
    }
    case 'ELLIPSE': {
      const m = mirrored(r);
      let t1 = gn(r, 41, 0);
      let t2 = gn(r, 42, TAU);
      if (m) [t1, t2] = [-t2, -t1];
      const mx = gn(r, 11, 1);
      const my = gn(r, 21, 0);
      if (Math.hypot(mx, my) < 1e-14) return null;
      return common({ type: 'ellipse', cx: gn(r, 10, 0), cy: gn(r, 20, 0), mx, my, ratio: gn(r, 40, 1), t1, t2 }, r);
    }
    case 'SPLINE': {
      const flags = gi(r, 70, 0);
      const ctrl = [];
      const fit = [];
      const knots = [];
      const weights = [];
      let cur = null;
      for (let i = 0; i < r.C.length; i++) {
        const c = r.C[i];
        const v = parseFloat(r.V[i]);
        if (c === 10) { cur = [v || 0, 0]; ctrl.push(cur); }
        else if (c === 11) { cur = [v || 0, 0]; fit.push(cur); }
        else if (c === 20 || c === 21) { if (cur) cur[1] = v || 0; }
        else if (c === 40) { if (Number.isFinite(v)) knots.push(v); }
        else if (c === 41) { if (Number.isFinite(v)) weights.push(v); }
        else if (c === 12 || c === 13) cur = null;
      }
      if (!ctrl.length && !fit.length) return null;
      const e = common({ type: 'spline', degree: gi(r, 71, 3), ctrl, knots, fit, closed: (flags & 1) === 1, pts: [] }, r);
      if ((flags & 4) && weights.length === ctrl.length && weights.some((w) => w !== 1)) e.weights = weights;
      e.pts = sampleSpline(e);
      return e;
    }
    case 'SOLID':
    case 'TRACE': {
      // filled quad / triangle -> closed outline so dimension arrowheads show up
      const p = [];
      for (let k = 0; k < 4; k++) {
        const x = gn(r, 10 + k, undefined);
        const y = gn(r, 20 + k, undefined);
        if (x !== undefined && y !== undefined) p.push([x, y]);
      }
      if (p.length < 3) return null;
      const order = p.length === 4 ? [p[0], p[1], p[3], p[2]] : p;
      const pts = [];
      for (const q of order) {
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      if (mirrored(r)) for (const q of pts) q[0] = -q[0];
      return common({ type: 'polyline', pts, closed: true, solid: true }, r);
    }
    case 'TEXT':
    case 'ATTRIB': {
      if (type === 'ATTRIB' && (gi(r, 70, 0) & 1)) return null; // invisible attribute
      const m = mirrored(r);
      const h72 = gi(r, 72, 0);
      const v73 = gi(r, type === 'ATTRIB' ? 74 : 73, 0);
      let x = gn(r, 10, 0);
      let y = gn(r, 20, 0);
      if ((h72 || v73) && h72 !== 3 && h72 !== 5 && r.C.indexOf(11) >= 0) {
        x = gn(r, 11, x);
        y = gn(r, 21, y);
      }
      let rot = gn(r, 50, 0);
      if (m) { x = -x; rot = norm360(180 - rot); }
      const raw = gv(r, 1) ?? '';
      const e = common({
        type: 'text', x, y, h: gn(r, 40, 2.5),
        text: decodePercentCodes(decodeUnicodeEscapes(raw)),
        rot,
        halign: h72 === 1 || h72 === 4 ? 'center' : h72 === 2 ? 'right' : 'left',
        valign: h72 === 4 ? 'middle' : VALIGN_TEXT[v73] || 'baseline',
        style: (gv(r, 7) || 'STANDARD').trim(),
        font: null,
      }, r);
      const wf = gn(r, 41, undefined);
      if (wf !== undefined && wf > 0 && wf !== 1) e.widthFactor = wf;
      return e;
    }
    case 'MTEXT': {
      let raw = '';
      for (let i = 0; i < r.C.length; i++) if (r.C[i] === 3 || r.C[i] === 1) raw += r.V[i];
      const dec = decodeMText(raw);
      const attach = Math.max(1, Math.min(9, gi(r, 71, 1)));
      let rot = 0;
      if (r.C.indexOf(11) >= 0) {
        const dx = gn(r, 11, 1);
        const dy = gn(r, 21, 0);
        if (Math.hypot(dx, dy) > 1e-14) rot = norm360(Math.atan2(dy, dx) / DEG);
      } else {
        rot = gn(r, 50, 0);
      }
      const e = common({
        type: 'text', x: gn(r, 10, 0), y: gn(r, 20, 0), h: gn(r, 40, 2.5),
        text: dec.text,
        rot,
        halign: HALIGN[(attach - 1) % 3],
        valign: attach <= 3 ? 'top' : attach <= 6 ? 'middle' : 'bottom',
        style: (gv(r, 7) || 'STANDARD').trim(),
        font: dec.font,
      }, r);
      const w = gn(r, 41, 0);
      if (w > 0) e.width = w;
      return e;
    }
    case 'INSERT': {
      const name = gv(r, 2);
      if (name === undefined) return null;
      return common({
        type: 'insert', name: name.trim(),
        x: gn(r, 10, 0), y: gn(r, 20, 0),
        sx: gn(r, 41, 1), sy: gn(r, 42, 1), rot: gn(r, 50, 0),
        cols: Math.max(1, gi(r, 70, 1)), rows: Math.max(1, gi(r, 71, 1)),
        dx: gn(r, 44, 0), dy: gn(r, 45, 0),
        _mirror: mirrored(r),
      }, r);
    }
    case 'DIMENSION': {
      const name = gv(r, 2);
      if (name === undefined) return null;
      return common({ type: 'dimension', name: name.trim() }, r);
    }
    default:
      return null;
  }
}

// Reader is positioned on a (0, type) pair. Reads entities until `endTag`
// (or ENDSEC / EOF) and leaves the reader on that terminating pair.
function readEntities(rd, endTag) {
  const list = [];
  let poly = null;
  while (!rd.eof) {
    if (rd.code !== 0) { if (!rd.skipToZero()) break; continue; }
    const type = rd.value.trim().toUpperCase();
    if (type === endTag || type === 'ENDSEC' || type === 'EOF') break;
    if (!KNOWN.has(type)) { poly = null; rd.skipToZero(); continue; }
    const rec = rd.collect(false); // leaves reader on the next code 0 pair (or EOF)
    try {
      if (type === 'VERTEX') {
        if (poly && !poly._mesh) {
          const vf = gi(rec, 70, 0);
          if (!(poly._splineFit && (vf & 16))) {
            const x = gn(rec, 10, 0);
            const b = gn(rec, 42, 0);
            const p = [poly._mirror ? -x : x, gn(rec, 20, 0)];
            if (b) p[2] = poly._mirror ? -b : b;
            poly.pts.push(p);
          }
        }
      } else if (type === 'SEQEND') {
        poly = null;
      } else {
        poly = null;
        const e = buildEntity(type, rec);
        if (e) {
          if (type === 'POLYLINE') {
            poly = e;
            if (!e._mesh) list.push(e);
          } else {
            list.push(e);
          }
        }
      }
    } catch {
      // malformed entity: skip
    }
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* block expansion                                                     */
/* ------------------------------------------------------------------ */

// matrix [a,b,c,d,tx,ty]: x' = a*x + c*y + tx ; y' = b*x + d*y + ty
function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function insertMatrix(ix, iy, sx, sy, rotDeg, bx, by, mirror) {
  const c = Math.cos(rotDeg * DEG);
  const s = Math.sin(rotDeg * DEG);
  let a = c * sx;
  const b = s * sx;
  let cc = -s * sy;
  const d = c * sy;
  let tx = ix - (a * bx + cc * by);
  const ty = iy - (b * bx + d * by);
  if (mirror) { a = -a; cc = -cc; tx = -tx; }
  return [a, b, cc, d, tx, ty];
}

function ap(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function dirAngleDeg(m, deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return norm360(Math.atan2(m[1] * c + m[3] * s, m[0] * c + m[2] * s) / DEG);
}

function copyProps(dst, src) {
  for (const k of Object.keys(src)) if (!(k in dst)) dst[k] = src[k];
  return dst;
}

function transformEntity(e, m) {
  const sxl = Math.hypot(m[0], m[1]);
  const syl = Math.hypot(m[2], m[3]);
  const det = m[0] * m[3] - m[1] * m[2];
  const big = Math.max(sxl, syl, 1e-300);
  const conformal = Math.abs(sxl - syl) <= 1e-9 * big && Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * big * big;
  const meta = { layer: e.layer };
  if (e.color !== undefined) meta.color = e.color;
  if (e.linetype !== undefined) meta.linetype = e.linetype;

  switch (e.type) {
    case 'line': {
      const p = ap(m, e.x1, e.y1);
      const q = ap(m, e.x2, e.y2);
      return { type: 'line', x1: p[0], y1: p[1], x2: q[0], y2: q[1], ...meta };
    }
    case 'point': {
      const p = ap(m, e.x, e.y);
      return { type: 'point', x: p[0], y: p[1], ...meta };
    }
    case 'circle':
    case 'arc':
    case 'ellipse': {
      if (!conformal) {
        const pts = entityToPoints(e).map((p) => ap(m, p[0], p[1]));
        const closed = e.type === 'circle' || (e.type === 'ellipse' && isFullEllipse(e));
        if (closed) pts.pop();
        return { type: 'polyline', pts, closed, ...meta };
      }
      const c = ap(m, e.cx, e.cy);
      if (e.type === 'circle') return { type: 'circle', cx: c[0], cy: c[1], r: e.r * sxl, ...meta };
      if (e.type === 'arc') {
        let a1 = dirAngleDeg(m, e.a1);
        let a2 = dirAngleDeg(m, e.a2);
        if (det < 0) [a1, a2] = [a2, a1];
        return { type: 'arc', cx: c[0], cy: c[1], r: e.r * sxl, a1, a2, ...meta };
      }
      let t1 = e.t1;
      let t2 = e.t2;
      if (det < 0) [t1, t2] = [-t2, -t1];
      return {
        type: 'ellipse', cx: c[0], cy: c[1],
        mx: m[0] * e.mx + m[2] * e.my, my: m[1] * e.mx + m[3] * e.my,
        ratio: e.ratio, t1, t2, ...meta,
      };
    }
    case 'polyline': {
      const hasBulge = (e.pts || []).some((p) => p[2]);
      let pts;
      if (hasBulge && !conformal) {
        const flat = polylineFlat(e);
        if (e.closed && flat.length > 1) flat.pop();
        pts = flat.map((p) => ap(m, p[0], p[1]));
      } else {
        pts = (e.pts || []).map((p) => {
          const q = ap(m, p[0], p[1]);
          if (p[2]) q[2] = det < 0 ? -p[2] : p[2];
          return q;
        });
      }
      const o = { type: 'polyline', pts, closed: !!e.closed, ...meta };
      if (e.solid) o.solid = true;
      return o;
    }
    case 'spline': {
      const o = {
        type: 'spline', degree: e.degree,
        ctrl: e.ctrl.map((p) => ap(m, p[0], p[1])),
        knots: e.knots.slice(),
        fit: e.fit.map((p) => ap(m, p[0], p[1])),
        closed: e.closed,
        pts: (e.pts || []).map((p) => ap(m, p[0], p[1])),
        ...meta,
      };
      if (e.weights) o.weights = e.weights.slice();
      return o;
    }
    case 'text': {
      const p = ap(m, e.x, e.y);
      const o = copyProps({ type: 'text', x: p[0], y: p[1], h: e.h * syl, rot: dirAngleDeg(m, e.rot) }, e);
      if (o.width) o.width = e.width * sxl;
      return o;
    }
    default:
      return null;
  }
}

function cloneEntity(e) {
  const o = { ...e };
  if (e.pts) o.pts = e.pts.map((p) => p.slice());
  if (e.ctrl) o.ctrl = e.ctrl.map((p) => p.slice());
  if (e.fit) o.fit = e.fit.map((p) => p.slice());
  if (e.knots) o.knots = e.knots.slice();
  return o;
}

function expandEntities(list, blocks, m, inherit, depth, stack, out) {
  for (const e of list) {
    if (!e) continue;
    // BYBLOCK / layer "0" inheritance from the enclosing INSERT
    let layer = e.layer;
    let color = e.color;
    if (inherit) {
      if (layer === '0') layer = inherit.layer;
      if (color === 0 && inherit.color !== undefined) color = inherit.color;
    }
    if (e.type === 'insert' || e.type === 'dimension') {
      const key = e.name.toUpperCase();
      const blk = blocks.get(key);
      if (!blk || depth >= MAX_BLOCK_DEPTH || stack.indexOf(key) >= 0) continue;
      const inh = { layer, color };
      const nstack = stack.concat(key);
      if (e.type === 'dimension') {
        expandEntities(blk.entities, blocks, m, inh, depth + 1, nstack, out);
        continue;
      }
      const c = Math.cos(e.rot * DEG);
      const s = Math.sin(e.rot * DEG);
      for (let row = 0; row < e.rows; row++) {
        for (let col = 0; col < e.cols; col++) {
          const ox = col * e.dx;
          const oy = row * e.dy;
          const local = insertMatrix(e.x + c * ox - s * oy, e.y + s * ox + c * oy, e.sx, e.sy, e.rot, blk.bx, blk.by, e._mirror);
          expandEntities(blk.entities, blocks, m ? matMul(m, local) : local, inh, depth + 1, nstack, out);
        }
      }
      continue;
    }
    let o;
    try {
      o = m ? transformEntity(e, m) : cloneEntity(e);
    } catch {
      o = null;
    }
    if (!o) continue;
    o.layer = layer;
    if (color !== undefined) o.color = color; else delete o.color;
    out.push(o);
  }
}

/* ------------------------------------------------------------------ */
/* parseDXF                                                            */
/* ------------------------------------------------------------------ */

const UNIT_NAMES = { 1: 'in', 4: 'mm', 5: 'cm', 6: 'm' };
const UNIT_CODES = { in: 1, mm: 4, cm: 5, m: 6 };

function fontFromStyle(st) {
  if (!st) return null;
  if (st.family) return st.family;
  if (st.font) {
    const base = st.font.replace(/^.*[\\/]/, '').replace(/\.(shx|ttf|ttc|otf|pfb)$/i, '');
    return base || null;
  }
  return null;
}

/**
 * Parse an ASCII DXF string.
 * @param {string} text
 * @returns {{units:string, extents:{min:number[],max:number[]}, layers:Object, entities:Object[], styles:Object, header:Object}}
 */
export function parseDXF(text) {
  const result = {
    units: 'mm',
    extents: { min: [0, 0], max: [0, 0] },
    layers: {},
    entities: [],
    styles: {},
    header: {},
  };
  let src = typeof text === 'string' ? text : String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.startsWith('AutoCAD Binary DXF')) return result; // binary DXF is not supported
  if (src.indexOf('\n') < 0 && src.indexOf('\r') >= 0) src = src.replace(/\r/g, '\n');

  const header = {};
  const blocks = new Map();
  const styles = {};
  let top = [];

  try {
    const rd = new Reader(src);
    rd.next();
    while (!rd.eof) {
      if (rd.code !== 0) { rd.skipToZero(); continue; }
      const tag = rd.value.trim().toUpperCase();
      if (tag === 'EOF') break;
      if (tag !== 'SECTION') { rd.skipToZero(); continue; }
      if (!rd.next()) break;
      const name = rd.code === 2 ? rd.value.trim().toUpperCase() : '';

      if (name === 'HEADER') {
        let cur = null;
        while (rd.next() && rd.code !== 0) {
          if (rd.code === 9) { cur = rd.value.trim().toUpperCase(); header[cur] = {}; }
          else if (cur && !(rd.code in header[cur])) header[cur][rd.code] = rd.value.trim();
        }
      } else if (name === 'TABLES') {
        rd.skipToZero();
        while (!rd.eof) {
          const t = rd.value.trim().toUpperCase();
          if (t === 'ENDSEC' || t === 'EOF') break;
          if (t === 'LAYER') {
            const rec = rd.collect(false);
            const nm = gv(rec, 2);
            if (nm !== undefined) {
              const col = gi(rec, 62, 7);
              const layer = { color: Math.abs(col), linetype: (gv(rec, 6) || 'CONTINUOUS').trim() };
              if (col < 0) layer.visible = false;
              if (gi(rec, 70, 0) & 1) layer.frozen = true;
              result.layers[decodeUnicodeEscapes(nm.trim())] = layer;
            }
          } else if (t === 'STYLE') {
            const rec = rd.collect(true);
            const nm = gv(rec, 2);
            if (nm !== undefined && nm.trim() !== '') {
              const st = { name: nm.trim(), font: (gv(rec, 3) || '').trim(), bigfont: (gv(rec, 4) || '').trim(), widthFactor: gn(rec, 41, 1), height: gn(rec, 40, 0) };
              const fam = gv(rec, 1000);
              if (fam !== undefined && fam.trim() !== '') st.family = decodeUnicodeEscapes(fam.trim());
              styles[st.name.toUpperCase()] = st;
            }
          } else {
            rd.skipToZero();
          }
        }
      } else if (name === 'BLOCKS') {
        rd.skipToZero();
        while (!rd.eof) {
          const t = rd.value.trim().toUpperCase();
          if (t === 'ENDSEC' || t === 'EOF') break;
          if (t === 'BLOCK') {
            const rec = rd.collect(false);
            const nm = (gv(rec, 2) ?? gv(rec, 3) ?? '').trim();
            const ents = readEntities(rd, 'ENDBLK');
            if (nm) blocks.set(nm.toUpperCase(), { name: nm, bx: gn(rec, 10, 0), by: gn(rec, 20, 0), entities: ents });
            if (!rd.eof && rd.value.trim().toUpperCase() === 'ENDBLK') rd.skipToZero();
          } else {
            rd.skipToZero();
          }
        }
      } else if (name === 'ENTITIES') {
        rd.skipToZero();
        top = top.concat(readEntities(rd, 'ENDSEC'));
      } else {
        // CLASSES, OBJECTS, THUMBNAILIMAGE, ...: skip to ENDSEC
        while (rd.skipToZero()) {
          const t = rd.value.trim().toUpperCase();
          if (t === 'ENDSEC' || t === 'EOF') break;
        }
      }
      if (!rd.eof && rd.code === 0 && rd.value.trim().toUpperCase() === 'ENDSEC') rd.skipToZero();
    }
  } catch (err) {
    result.error = String((err && err.message) || err);
  }

  // header values
  const hnum = (name, code) => {
    const h = header[name];
    const f = h ? parseFloat(h[code]) : NaN;
    return Number.isFinite(f) ? f : undefined;
  };
  const ins = hnum('$INSUNITS', 70);
  result.units = UNIT_NAMES[ins] || 'mm';
  result.header = {
    version: header.$ACADVER ? header.$ACADVER[1] : undefined,
    insunits: ins,
    codepage: header.$DWGCODEPAGE ? header.$DWGCODEPAGE[3] : undefined,
  };
  const exMin = [hnum('$EXTMIN', 10), hnum('$EXTMIN', 20)];
  const exMax = [hnum('$EXTMAX', 10), hnum('$EXTMAX', 20)];
  const headerExtOk = exMin.concat(exMax).every((v) => v !== undefined && Math.abs(v) < 1e19) && exMax[0] >= exMin[0] && exMax[1] >= exMin[1];
  if (headerExtOk) {
    result.header.extmin = exMin;
    result.header.extmax = exMax;
  }
  result.styles = styles;

  // expand blocks, drop paper space, finalise
  const flat = [];
  try {
    expandEntities(top.filter((e) => !e._paper), blocks, null, null, 0, [], flat);
  } catch (err) {
    result.error = String((err && err.message) || err);
  }
  for (const e of flat) {
    delete e._paper;
    delete e._mesh;
    delete e._splineFit;
    delete e._mirror;
    if (e.color !== undefined && !(e.color >= 1 && e.color <= 255)) delete e.color; // BYBLOCK / BYLAYER
    if (e.linetype !== undefined && /^by(layer|block)$/i.test(e.linetype)) delete e.linetype;
    if (e.type === 'text') {
      const st = styles[String(e.style || '').toUpperCase()];
      if (!e.font) e.font = fontFromStyle(st);
      if (e.widthFactor === undefined && st && st.widthFactor > 0 && st.widthFactor !== 1) e.widthFactor = st.widthFactor;
    }
  }
  result.entities = flat.filter((e) => e.type !== 'polyline' || (e.pts && e.pts.length > 0));

  const ext = computeExtents(result.entities);
  if (ext) result.extents = ext;
  else if (headerExtOk) result.extents = { min: exMin, max: exMax };
  return result;
}

/* ------------------------------------------------------------------ */
/* writeDXF (AC1009 / R12)                                             */
/* ------------------------------------------------------------------ */

function fmt(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 0;
  if (Math.abs(n) >= 1e21) n = Math.sign(n) * 1e20;
  let s = n.toFixed(6);
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s += '0';
  if (/^-0\.0$/.test(s)) s = '0.0';
  return s;
}

function escapeText(s) {
  let out = '';
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20) out += ' ';
    else if (c > 0x7e) out += '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += str[i];
  }
  return out;
}

function safeName(name) {
  let s = String(name ?? '').trim().replace(/[^A-Za-z0-9_$-]/g, '_').slice(0, 31);
  if (!s) s = '0';
  return s;
}

const LTYPES = [
  { name: 'CONTINUOUS', desc: 'Solid line', pattern: [] },
  { name: 'HIDDEN', desc: 'Hidden __ __ __ __ __ __ __', pattern: [6.35, -3.175] },
  { name: 'CENTER', desc: 'Center ____ _ ____ _ ____ _', pattern: [31.75, -6.35, 6.35, -6.35] },
  { name: 'PHANTOM', desc: 'Phantom ____ _ _ ____ _ _', pattern: [31.75, -6.35, 6.35, -6.35, 6.35, -6.35] },
];
const LTYPE_ALIAS = {
  CONTINUOUS: 'CONTINUOUS', SOLID: 'CONTINUOUS',
  HIDDEN: 'HIDDEN', DASHED: 'HIDDEN', DASH: 'HIDDEN',
  CENTER: 'CENTER', DASHDOT: 'CENTER', 'DASH-DOT': 'CENTER', CENTRE: 'CENTER',
  PHANTOM: 'PHANTOM', DASHDOTDOT: 'PHANTOM',
  BYLAYER: 'BYLAYER', BYBLOCK: 'BYBLOCK',
};

function mapLinetype(lt) {
  if (lt === undefined || lt === null) return null;
  return LTYPE_ALIAS[String(lt).trim().toUpperCase()] || null;
}

/**
 * Serialise entities to an ASCII DXF string (AC1009 / R12).
 * @param {{entities:Object[], layers?:Object|Array, units?:string}} doc
 * @returns {string}
 */
export function writeDXF(doc) {
  const { entities = [], layers = {}, units = 'mm' } = doc || {};
  const L = [];
  const g = (code, value) => {
    L.push(String(code).padStart(3, ' '));
    L.push(String(value));
  };

  // ---- layers ----
  const layerDefs = new Map();
  layerDefs.set('0', { color: 7, linetype: 'CONTINUOUS' });
  const addLayer = (name, def) => {
    const key = safeName(name);
    const prev = layerDefs.get(key);
    const color = def && Number.isFinite(+def.color) && +def.color !== 0 ? Math.round(+def.color) : prev ? prev.color : 7;
    const lt = (def && mapLinetype(def.linetype)) || (prev ? prev.linetype : 'CONTINUOUS');
    const o = { color: Math.max(1, Math.min(255, Math.abs(color))), linetype: /^BY/.test(lt) ? 'CONTINUOUS' : lt };
    if (def && (def.visible === false || +def.color < 0)) o.off = true;
    layerDefs.set(key, o);
  };
  if (Array.isArray(layers)) {
    for (const l of layers) if (l && l.name !== undefined) addLayer(l.name, l);
  } else if (layers && typeof layers === 'object') {
    for (const k of Object.keys(layers)) addLayer(k, layers[k]);
  }
  for (const e of entities) {
    if (e && e.layer !== undefined && !layerDefs.has(safeName(e.layer))) addLayer(e.layer, null);
  }

  const ext = computeExtents(entities) || { min: [0, 0], max: [0, 0] };

  // ---- HEADER ----
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
  g(9, '$EXTMIN'); g(10, fmt(ext.min[0])); g(20, fmt(ext.min[1])); g(30, '0.0');
  g(9, '$EXTMAX'); g(10, fmt(ext.max[0])); g(20, fmt(ext.max[1])); g(30, '0.0');
  g(9, '$LIMMIN'); g(10, fmt(ext.min[0])); g(20, fmt(ext.min[1]));
  g(9, '$LIMMAX'); g(10, fmt(ext.max[0])); g(20, fmt(ext.max[1]));
  g(9, '$INSUNITS'); g(70, UNIT_CODES[units] || 4);
  g(0, 'ENDSEC');

  // ---- TABLES ----
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, LTYPES.length);
  for (const lt of LTYPES) {
    g(0, 'LTYPE'); g(2, lt.name); g(70, 0); g(3, lt.desc); g(72, 65); g(73, lt.pattern.length);
    g(40, fmt(lt.pattern.reduce((s, v) => s + Math.abs(v), 0)));
    for (const v of lt.pattern) g(49, fmt(v));
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layerDefs.size);
  for (const [name, def] of layerDefs) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, def.off ? -def.color : def.color); g(6, def.linetype);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
  g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, '0.0'); g(41, '1.0'); g(50, '0.0'); g(71, 0); g(42, '2.5'); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // ---- BLOCKS (empty) ----
  g(0, 'SECTION'); g(2, 'BLOCKS'); g(0, 'ENDSEC');

  // ---- ENTITIES ----
  g(0, 'SECTION'); g(2, 'ENTITIES');

  const head = (type, e) => {
    g(0, type);
    g(8, safeName(e.layer ?? '0'));
    const lt = mapLinetype(e.linetype);
    if (lt) g(6, lt);
    const c = Number(e.color);
    if (Number.isInteger(c) && c >= 0 && c <= 256) g(62, c);
  };

  const polyline = (e, pts, closed) => {
    if (!pts || !pts.length) return;
    head('POLYLINE', e);
    g(66, 1); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(70, closed ? 1 : 0);
    for (const p of pts) {
      head('VERTEX', e);
      g(10, fmt(p[0])); g(20, fmt(p[1])); g(30, '0.0');
      if (p[2]) g(42, fmt(p[2]));
    }
    head('SEQEND', e);
  };

  for (const e of entities) {
    if (!e || typeof e !== 'object') continue;
    switch (e.type) {
      case 'line':
        head('LINE', e);
        g(10, fmt(e.x1)); g(20, fmt(e.y1)); g(30, '0.0');
        g(11, fmt(e.x2)); g(21, fmt(e.y2)); g(31, '0.0');
        break;
      case 'circle':
        head('CIRCLE', e);
        g(10, fmt(e.cx)); g(20, fmt(e.cy)); g(30, '0.0'); g(40, fmt(e.r));
        break;
      case 'arc':
        head('ARC', e);
        g(10, fmt(e.cx)); g(20, fmt(e.cy)); g(30, '0.0'); g(40, fmt(e.r));
        g(50, fmt(e.a1)); g(51, fmt(e.a2));
        break;
      case 'polyline':
        polyline(e, e.pts, !!e.closed);
        break;
      case 'ellipse': {
        const pts = ellipsePoints(e);
        const full = isFullEllipse(e);
        if (full) pts.pop();
        polyline(e, pts, full);
        break;
      }
      case 'spline': {
        let pts = e.pts && e.pts.length ? e.pts : sampleSpline(e);
        pts = pts.map((p) => [p[0], p[1]]);
        let closed = false;
        if (e.closed && pts.length > 2) {
          const a = pts[0];
          const b = pts[pts.length - 1];
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
          closed = true;
        }
        polyline(e, pts, closed);
        break;
      }
      case 'point':
        head('POINT', e);
        g(10, fmt(e.x)); g(20, fmt(e.y)); g(30, '0.0');
        break;
      case 'text': {
        const lines = String(e.text ?? '').replace(/\r\n?/g, '\n').split('\n');
        const h = Number.isFinite(+e.h) && +e.h > 0 ? +e.h : 2.5;
        const rot = Number.isFinite(+e.rot) ? +e.rot : 0;
        const step = 1.5 * h;
        // "down" direction for subsequent lines
        const dxn = Math.sin(rot * DEG);
        const dyn = -Math.cos(rot * DEG);
        let lift = 0;
        if (e.valign === 'bottom') lift = (lines.length - 1) * step;
        else if (e.valign === 'middle') lift = ((lines.length - 1) * step) / 2;
        const h72 = e.halign === 'center' ? 1 : e.halign === 'right' ? 2 : 0;
        const v73 = e.valign === 'bottom' ? 1 : e.valign === 'middle' ? 2 : e.valign === 'top' ? 3 : 0;
        lines.forEach((line, i) => {
          if (line === '' && lines.length > 1) return;
          const off = i * step - lift;
          const x = (+e.x || 0) + dxn * off;
          const y = (+e.y || 0) + dyn * off;
          head('TEXT', e);
          g(10, fmt(x)); g(20, fmt(y)); g(30, '0.0');
          g(40, fmt(h));
          g(1, escapeText(line));
          if (rot) g(50, fmt(rot));
          if (Number.isFinite(+e.widthFactor) && +e.widthFactor > 0 && +e.widthFactor !== 1) g(41, fmt(+e.widthFactor));
          g(7, 'STANDARD');
          if (h72 || v73) {
            if (h72) g(72, h72);
            g(11, fmt(x)); g(21, fmt(y)); g(31, '0.0');
            if (v73) g(73, v73);
          }
        });
        break;
      }
      default:
        break; // unsupported entity types are skipped
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

export default { parseDXF, writeDXF };
