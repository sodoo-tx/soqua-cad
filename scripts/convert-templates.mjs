// Converts every sheet-format DXF in user-assets/templates/*.dxf into
// public/templates/<id>.json (+ index.json). The id and display name come from the file name.
//
//   node scripts/convert-templates.mjs              lines and texts only
//   node scripts/convert-templates.mjs --with-logo  also recover the title-block logo from <id>.pdf
//
// user-assets/ is git-ignored: your own templates stay on your machine. Everything this script
// writes to public/templates IS published with the site, so check the output for names, company
// details and logos before committing it.
//
// No dependencies: uses src/io/dxf.js, node:fs, node:zlib.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseDXF, entityToPoints } from '../src/io/dxf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'user-assets', 'templates');
const OUT_DIR = path.join(ROOT, 'public', 'templates');

const WITH_LOGO = process.argv.includes('--with-logo');
const TEMPLATES = fs.existsSync(SRC_DIR)
  ? fs.readdirSync(SRC_DIR).filter((f) => /\.dxf$/i.test(f)).sort().map((f) => {
      const id = f.replace(/\.dxf$/i, '');
      return { id, name: id.replace(/[_-]+/g, ' ').trim() };
    })
  : [];

const UNIT_TO_MM = { mm: 1, in: 25.4, cm: 10, m: 1000 };
const ISO_SIZES = [[841, 1189], [594, 841], [420, 594], [297, 420], [210, 297]];

const r3 = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

function matchIso(w, h, tol = 1.5) {
  for (const [a, b] of ISO_SIZES) {
    if (Math.abs(w - a) <= tol && Math.abs(h - b) <= tol) return [a, b];
    if (Math.abs(w - b) <= tol && Math.abs(h - a) <= tol) return [b, a];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* field detection                                                     */
/* ------------------------------------------------------------------ */

function detectField(text) {
  const t = String(text).trim();
  if (/^Draw\d+$/.test(t)) return 'title';
  if (/^SCALE\s*:?/i.test(t)) return 'scale';
  if (/^SHEET \d+ OF \d+$/i.test(t)) return 'sheet';
  if (/^A[0-5]$/.test(t)) return 'size';
  return null;
}

/* ------------------------------------------------------------------ */
/* minimal PDF reader (classic xref-less object scan, no object streams) */
/* ------------------------------------------------------------------ */

class PdfLexer {
  constructor(str, pos = 0) { this.s = str; this.p = pos; }

  skipWs() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.p);
      if (c === 0x25) { // % comment
        while (this.p < s.length && s[this.p] !== '\n' && s[this.p] !== '\r') this.p++;
      } else if (c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32) {
        this.p++;
      } else break;
    }
  }

  // Parse one PDF object (dict, array, name, number, string, ref, keyword).
  parse() {
    this.skipWs();
    const s = this.s;
    const c = s[this.p];
    if (c === undefined) return undefined;
    if (c === '<' && s[this.p + 1] === '<') {
      this.p += 2;
      const d = {};
      for (;;) {
        this.skipWs();
        if (s[this.p] === '>' && s[this.p + 1] === '>') { this.p += 2; break; }
        if (this.p >= s.length) break;
        const k = this.parse();
        if (!k || k.name === undefined) break;
        d[k.name] = this.parse();
      }
      return d;
    }
    if (c === '[') {
      this.p++;
      const a = [];
      for (;;) {
        this.skipWs();
        if (s[this.p] === ']') { this.p++; break; }
        if (this.p >= s.length) break;
        a.push(this.parse());
      }
      return a;
    }
    if (c === '/') {
      let e = this.p + 1;
      while (e < s.length && !/[\s/<>[\]()%{}]/.test(s[e])) e++;
      const name = s.slice(this.p + 1, e).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.p = e;
      return { name };
    }
    if (c === '(') {
      let depth = 1;
      let e = this.p + 1;
      let out = '';
      while (e < s.length && depth > 0) {
        const ch = s[e];
        if (ch === '\\') { out += s[e + 1]; e += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) break; }
        out += ch;
        e++;
      }
      this.p = e + 1;
      return { str: out };
    }
    if (c === '<') {
      const e = s.indexOf('>', this.p);
      const hex = s.slice(this.p + 1, e).replace(/\s+/g, '');
      this.p = e + 1;
      let out = '';
      for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2).padEnd(2, '0'), 16));
      return { str: out };
    }
    // number / reference / keyword
    let e = this.p;
    while (e < s.length && !/[\s/<>[\]()%{}]/.test(s[e])) e++;
    if (e === this.p) { this.p++; return { op: c }; }
    const tok = s.slice(this.p, e);
    this.p = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) {
        const m = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(this.p, this.p + 24));
        if (m) { this.p += m[0].length; return { ref: +tok }; }
      }
      return parseFloat(tok);
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { op: tok };
  }
}

function readPdf(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1];
    const lex = new PdfLexer(s, m.index + m[0].length);
    let value;
    try { value = lex.parse(); } catch { continue; }
    const obj = { num, value, streamStart: -1 };
    lex.skipWs();
    if (s.startsWith('stream', lex.p)) {
      let ds = lex.p + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      obj.streamStart = ds;
    }
    objs.set(num, obj);
    if (obj.streamStart >= 0) {
      // jump past the stream so binary data is never scanned for "n n obj"
      const len = value && typeof value.Length === 'number' ? value.Length : -1;
      let end = len >= 0 ? obj.streamStart + len : -1;
      if (end < 0 || !/^\s*endstream/.test(s.slice(end, end + 16))) end = s.indexOf('endstream', obj.streamStart);
      if (end < 0) end = s.length;
      obj.streamEnd = end;
      re.lastIndex = end;
    } else {
      re.lastIndex = lex.p;
    }
  }
  const deref = (v) => {
    let guard = 0;
    while (v && typeof v === 'object' && v.ref !== undefined && guard++ < 20) {
      const o = objs.get(v.ref);
      v = o ? o.value : undefined;
    }
    return v;
  };
  const streamBytes = (obj) => {
    if (!obj || obj.streamStart < 0) return null;
    let end = obj.streamEnd;
    const len = deref(obj.value.Length);
    if (typeof len === 'number' && obj.streamStart + len <= buf.length) end = obj.streamStart + len;
    return buf.subarray(obj.streamStart, end);
  };
  return { objs, deref, streamBytes };
}

function filterNames(pdf, dict) {
  let f = pdf.deref(dict.Filter);
  if (!f) return [];
  if (!Array.isArray(f)) f = [f];
  return f.map((x) => pdf.deref(x)).map((x) => (x && x.name) || '');
}

function undoPredictor(data, parms, defaults) {
  const predictor = (parms && parms.Predictor) || 1;
  if (predictor < 10) return data; // TIFF predictor 2 is not handled (not used by these files)
  const colors = (parms && parms.Colors) || defaults.colors;
  const bpc = (parms && parms.BitsPerComponent) || defaults.bpc;
  const columns = (parms && parms.Columns) || defaults.width;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let y = 0; y < rows; y++) {
    const ft = data[y * (rowLen + 1)];
    const src = y * (rowLen + 1) + 1;
    const dst = y * rowLen;
    for (let x = 0; x < rowLen; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - rowLen + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - rowLen + x - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = raw;
      }
      out[dst + x] = v & 255;
    }
  }
  return out;
}

function decodeStream(pdf, obj, imgDefaults) {
  let data = pdf.streamBytes(obj);
  const filters = filterNames(pdf, obj.value);
  let parms = pdf.deref(obj.value.DecodeParms);
  if (Array.isArray(parms)) parms = pdf.deref(parms[0]);
  for (const f of filters) {
    if (f === 'FlateDecode' || f === 'Fl') {
      data = zlib.inflateSync(data);
      if (parms && imgDefaults) data = undoPredictor(data, parms, imgDefaults);
      else if (parms && parms.Predictor >= 10) data = undoPredictor(data, parms, { colors: 1, bpc: 8, width: parms.Columns || 1 });
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      data = Buffer.from(data.toString('latin1').replace(/[^0-9A-Fa-f]/g, ''), 'hex');
    } else {
      throw new Error('unsupported stream filter ' + f);
    }
  }
  return data;
}

// Resolve a /ColorSpace into { kind:'gray'|'rgb'|'cmyk'|'indexed', n, palette?, base? }
function resolveColorSpace(pdf, cs) {
  cs = pdf.deref(cs);
  if (!cs) return { kind: 'rgb', n: 3 };
  if (cs.name) {
    if (cs.name === 'DeviceGray' || cs.name === 'G' || cs.name === 'CalGray') return { kind: 'gray', n: 1 };
    if (cs.name === 'DeviceCMYK' || cs.name === 'CMYK') return { kind: 'cmyk', n: 4 };
    return { kind: 'rgb', n: 3 };
  }
  if (Array.isArray(cs)) {
    const head = pdf.deref(cs[0]);
    const kind = head && head.name;
    if (kind === 'ICCBased') {
      const ref = cs[1];
      const o = ref && ref.ref !== undefined ? pdf.objs.get(ref.ref) : null;
      const n = o && o.value && o.value.N;
      return n === 1 ? { kind: 'gray', n: 1 } : n === 4 ? { kind: 'cmyk', n: 4 } : { kind: 'rgb', n: 3 };
    }
    if (kind === 'CalRGB' || kind === 'Lab') return { kind: 'rgb', n: 3 };
    if (kind === 'CalGray') return { kind: 'gray', n: 1 };
    if (kind === 'Indexed' || kind === 'I') {
      const base = resolveColorSpace(pdf, cs[1]);
      let lut = cs[3];
      let bytes;
      if (lut && lut.ref !== undefined) {
        const o = pdf.objs.get(lut.ref);
        if (o && o.streamStart >= 0) bytes = decodeStream(pdf, o, null);
        else lut = o ? o.value : null;
      }
      if (!bytes && lut && lut.str !== undefined) bytes = Buffer.from(lut.str, 'latin1');
      return { kind: 'indexed', n: 1, base, palette: bytes || Buffer.alloc(0) };
    }
  }
  return { kind: 'rgb', n: 3 };
}

function sampleReader(data, bpc) {
  if (bpc === 8) return (i) => data[i];
  if (bpc === 16) return (i) => data[i * 2];
  const max = (1 << bpc) - 1;
  return (i, rowBitStart) => {
    const bit = rowBitStart + i * bpc;
    const v = (data[bit >> 3] >> (8 - bpc - (bit & 7))) & max;
    return v;
  };
}

// Decode an image XObject into { width, height, rgba:Buffer, hasAlpha } or { jpeg:Buffer }.
function decodeImage(pdf, obj) {
  const d = obj.value;
  const width = pdf.deref(d.Width);
  const height = pdf.deref(d.Height);
  const filters = filterNames(pdf, d);
  if (filters.includes('DCTDecode') || filters.includes('DCT')) {
    if (filters.length !== 1) throw new Error('chained DCTDecode not supported');
    return { width, height, jpeg: Buffer.from(pdf.streamBytes(obj)) };
  }
  const isMask = pdf.deref(d.ImageMask) === true;
  const bpc = isMask ? 1 : pdf.deref(d.BitsPerComponent) || 8;
  const cs = isMask ? { kind: 'gray', n: 1 } : resolveColorSpace(pdf, d.ColorSpace);
  const data = decodeStream(pdf, obj, { colors: cs.n, bpc, width });
  const rowBits = width * cs.n * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  if (data.length < rowBytes * height) throw new Error(`image data too short (${data.length} < ${rowBytes * height})`);
  const read = sampleReader(data, bpc);
  const scale = bpc >= 8 ? 1 : 255 / ((1 << bpc) - 1);
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const get = (k) => (bpc >= 8 ? read(rowStart / (bpc / 8) + x * cs.n + k) : read(x * cs.n + k, rowStart * 8));
      if (cs.kind === 'gray') {
        const v = Math.round(get(0) * scale);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      } else if (cs.kind === 'rgb') {
        rgba[o] = Math.round(get(0) * scale);
        rgba[o + 1] = Math.round(get(1) * scale);
        rgba[o + 2] = Math.round(get(2) * scale);
      } else if (cs.kind === 'cmyk') {
        const k = 255 - get(3);
        rgba[o] = ((255 - get(0)) * k) / 255;
        rgba[o + 1] = ((255 - get(1)) * k) / 255;
        rgba[o + 2] = ((255 - get(2)) * k) / 255;
      } else {
        const idx = get(0);
        const bn = cs.base.n;
        const p = cs.palette;
        if (bn === 1) rgba[o] = rgba[o + 1] = rgba[o + 2] = p[idx] ?? 0;
        else if (bn === 4) {
          const k = 255 - (p[idx * 4 + 3] ?? 0);
          rgba[o] = ((255 - (p[idx * 4] ?? 0)) * k) / 255;
          rgba[o + 1] = ((255 - (p[idx * 4 + 1] ?? 0)) * k) / 255;
          rgba[o + 2] = ((255 - (p[idx * 4 + 2] ?? 0)) * k) / 255;
        } else {
          rgba[o] = p[idx * 3] ?? 0;
          rgba[o + 1] = p[idx * 3 + 1] ?? 0;
          rgba[o + 2] = p[idx * 3 + 2] ?? 0;
        }
      }
    }
  }
  // soft mask -> alpha
  let hasAlpha = false;
  const sm = d.SMask;
  if (sm && sm.ref !== undefined && pdf.objs.get(sm.ref)) {
    try {
      const mask = decodeImage(pdf, pdf.objs.get(sm.ref));
      if (mask.rgba && mask.width === width && mask.height === height) {
        for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = mask.rgba[i * 4];
        hasAlpha = true;
      }
    } catch (err) {
      console.warn('  (soft mask ignored: ' + err.message + ')');
    }
  }
  return { width, height, rgba, hasAlpha };
}

/* ---- tiny PNG encoder ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(width, height, rgba, withAlpha) {
  const ch = withAlpha ? 4 : 3;
  const raw = Buffer.alloc((width * ch + 1) * height);
  for (let y = 0; y < height; y++) {
    const ro = y * (width * ch + 1);
    raw[ro] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const o = ro + 1 + x * ch;
      raw[o] = rgba[s];
      raw[o + 1] = rgba[s + 1];
      raw[o + 2] = rgba[s + 2];
      if (withAlpha) raw[o + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = withAlpha ? 6 : 2; // RGBA / RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function flipImage(img, flipX, flipY) {
  if (!img.rgba || (!flipX && !flipY)) return;
  const { width: w, height: h, rgba } = img;
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((flipY ? h - 1 - y : y) * w + (flipX ? w - 1 - x : x)) * 4;
      rgba.copy(out, (y * w + x) * 4, s, s + 4);
    }
  }
  img.rgba = out;
}

/* ---- page content: find image placements ---- */

function matMul(m, n) { // n applied first
  return [
    n[0] * m[0] + n[1] * m[2], n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2], n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4], n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function findImagePlacements(pdf) {
  const pages = [];
  for (const o of pdf.objs.values()) {
    const t = o.value && typeof o.value === 'object' && pdf.deref(o.value.Type);
    if (t && t.name === 'Page') pages.push(o);
  }
  if (!pages.length) return null;
  const page = pages[0].value;
  const inherited = (key) => {
    let node = page;
    for (let i = 0; node && i < 10; i++) {
      if (node[key] !== undefined) return pdf.deref(node[key]);
      node = pdf.deref(node.Parent);
    }
    return undefined;
  };
  const box = inherited('CropBox') || inherited('MediaBox') || [0, 0, 595.276, 841.89];
  const mediaBox = box.map((v) => pdf.deref(v));
  const rotate = inherited('Rotate') || 0;
  const resources = inherited('Resources') || {};
  const xobjects = pdf.deref(resources.XObject) || {};

  let contents = page.Contents;
  let refs = [];
  if (contents && contents.ref !== undefined) {
    const o = pdf.objs.get(contents.ref);
    if (o && Array.isArray(o.value)) refs = o.value; else refs = [contents];
  } else if (Array.isArray(contents)) refs = contents;
  let stream = '';
  for (const r of refs) {
    const o = r && r.ref !== undefined ? pdf.objs.get(r.ref) : null;
    if (o && o.streamStart >= 0) stream += decodeStream(pdf, o, null).toString('latin1') + '\n';
  }

  const placements = [];
  const lex = new PdfLexer(stream);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let operands = [];
  for (;;) {
    lex.skipWs();
    if (lex.p >= stream.length) break;
    let tok;
    try { tok = lex.parse(); } catch { break; }
    if (tok === undefined) break;
    if (tok && typeof tok === 'object' && tok.op !== undefined) {
      const op = tok.op;
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') ctm = stack.pop() || ctm;
      else if (op === 'cm' && operands.length >= 6) ctm = matMul(ctm, operands.slice(-6));
      else if (op === 'Do' && operands.length && operands[operands.length - 1].name !== undefined) {
        const name = operands[operands.length - 1].name;
        const ref = xobjects[name];
        const obj = ref && ref.ref !== undefined ? pdf.objs.get(ref.ref) : null;
        const sub = obj && pdf.deref(obj.value.Subtype);
        if (sub && sub.name === 'Image') placements.push({ name, obj, ctm: ctm.slice() });
      } else if (op === 'BI') {
        // inline image: skip to EI
        const e = stream.indexOf('EI', lex.p);
        if (e < 0) break;
        lex.p = e + 2;
      }
      operands = [];
    } else {
      operands.push(tok);
    }
  }
  return { mediaBox, rotate, placements };
}

/**
 * Extract the raster images drawn on the first page of a PDF.
 * Returns [{ file, x, y, w, h, pxWidth, pxHeight }] with placement in sheet mm.
 */
function extractPdfImages(pdfPath, id, sheetW, sheetH) {
  const pdf = readPdf(fs.readFileSync(pdfPath));
  const info = findImagePlacements(pdf);
  if (!info) throw new Error('no page found');
  if (info.rotate % 360 !== 0) throw new Error('rotated pages are not supported (/Rotate ' + info.rotate + ')');
  const [bx0, by0, bx1, by1] = info.mediaBox;
  const pageWmm = ((bx1 - bx0) * 25.4) / 72;
  const pageHmm = ((by1 - by0) * 25.4) / 72;
  // map page -> sheet (1:1 when the PDF page equals the sheet size)
  const kx = sheetW / pageWmm;
  const ky = sheetH / pageHmm;
  const note = Math.abs(kx - 1) > 0.002 || Math.abs(ky - 1) > 0.002
    ? `page ${pageWmm.toFixed(2)}x${pageHmm.toFixed(2)} mm scaled onto sheet (kx=${kx.toFixed(4)}, ky=${ky.toFixed(4)})`
    : `page ${pageWmm.toFixed(2)}x${pageHmm.toFixed(2)} mm == sheet (1:1)`;

  const images = [];
  info.placements.forEach((pl, i) => {
    const m = pl.ctm;
    // unit square corners through the CTM
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    const img = decodeImage(pdf, pl.obj);
    const suffix = i === 0 ? '_logo' : `_logo${i + 1}`;
    let file;
    if (img.jpeg) {
      file = `${id}${suffix}.jpg`;
      fs.writeFileSync(path.join(OUT_DIR, file), img.jpeg);
    } else {
      flipImage(img, m[0] < 0, m[3] < 0);
      file = `${id}${suffix}.png`;
      fs.writeFileSync(path.join(OUT_DIR, file), encodePNG(img.width, img.height, img.rgba, img.hasAlpha));
    }
    images.push({
      src: file,
      x: r3((((x0 - bx0) * 25.4) / 72) * kx),
      y: r3((((y0 - by0) * 25.4) / 72) * ky),
      w: r3(((w * 25.4) / 72) * kx),
      h: r3(((h * 25.4) / 72) * ky),
      _px: `${img.width}x${img.height}px ${img.jpeg ? 'jpeg' : img.hasAlpha ? 'rgba png' : 'rgb png'}`,
    });
  });
  return { images, note };
}

/* ------------------------------------------------------------------ */
/* DXF -> template JSON                                                */
/* ------------------------------------------------------------------ */

function convertTemplate({ id, name }) {
  const dxfPath = path.join(SRC_DIR, id + '.dxf');
  // SolidWorks writes ANSI_1252 with \U+XXXX escapes; latin1 keeps every byte intact
  const doc = parseDXF(fs.readFileSync(dxfPath, 'latin1'));
  if (doc.error) console.warn(`  parse warning: ${doc.error}`);

  // ---- sheet box + unit scale ----
  let scale = UNIT_TO_MM[doc.units] || 1;
  const hdr = doc.header.extmin && doc.header.extmax ? { min: doc.header.extmin, max: doc.header.extmax } : null;
  const box = hdr || doc.extents;
  let rawW = box.max[0] - box.min[0];
  let rawH = box.max[1] - box.min[1];
  let iso = matchIso(rawW * scale, rawH * scale);
  let scaleNote = `units=${doc.units}, 1:1`;
  if (!iso) {
    // header units lie? try the usual suspects
    for (const k of [1, 25.4, 10, 1000, 0.1, 1 / 25.4, 0.001]) {
      const hit = matchIso(rawW * k, rawH * k);
      if (hit) { iso = hit; scale = k; scaleNote = `units=${doc.units} but geometry needs x${k} to be mm`; break; }
    }
    if (!iso) scaleNote = `units=${doc.units}, x${scale}; sheet is not an ISO size`;
  } else if (scale !== 1) {
    scaleNote = `units=${doc.units}, scaled x${scale} to mm`;
  }
  // the entity extents must fit inside the sheet box; otherwise use the union
  let ox = box.min[0];
  let oy = box.min[1];
  const ee = doc.extents;
  if (hdr && (ee.min[0] < ox - 1e-6 || ee.min[1] < oy - 1e-6 || ee.max[0] > box.max[0] + 1e-6 || ee.max[1] > box.max[1] + 1e-6)) {
    console.warn('  entities extend beyond $EXTMIN/$EXTMAX; using the union as the sheet box');
    ox = Math.min(ox, ee.min[0]);
    oy = Math.min(oy, ee.min[1]);
    rawW = Math.max(box.max[0], ee.max[0]) - ox;
    rawH = Math.max(box.max[1], ee.max[1]) - oy;
    iso = matchIso(rawW * scale, rawH * scale);
  }
  const width = iso ? iso[0] : r3(rawW * scale);
  const height = iso ? iso[1] : r3(rawH * scale);
  const X = (x) => r3((x - ox) * scale);
  const Y = (y) => r3((y - oy) * scale);

  // ---- geometry -> line segments ----
  const lines = [];
  const seen = new Set();
  const addSeg = (x1, y1, x2, y2) => {
    const s = [X(x1), Y(y1), X(x2), Y(y2)];
    if (s[0] === s[2] && s[1] === s[3]) return;
    const key = s[0] < s[2] || (s[0] === s[2] && s[1] <= s[3]) ? s.join(',') : [s[2], s[3], s[0], s[1]].join(',');
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(s);
  };
  const texts = [];
  const skipped = {};
  for (const e of doc.entities) {
    if (e.type === 'text') {
      if (!String(e.text).trim()) continue;
      texts.push({
        x: X(e.x), y: Y(e.y), h: r3(e.h * scale), text: e.text,
        halign: e.halign, valign: e.valign, rot: r3(e.rot || 0),
        field: detectField(e.text),
      });
      continue;
    }
    const pts = entityToPoints(e);
    if (!pts) { skipped[e.type] = (skipped[e.type] || 0) + 1; continue; }
    for (let i = 1; i < pts.length; i++) addSeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }

  // ---- logo from the reference PDF ----
  let images = [];
  let logoNote = WITH_LOGO ? 'no reference PDF' : 'skipped (run with --with-logo to include it)';
  const pdfPath = path.join(SRC_DIR, id + '.pdf');
  if (WITH_LOGO && fs.existsSync(pdfPath)) {
    try {
      const res = extractPdfImages(pdfPath, id, width, height);
      images = res.images;
      logoNote = images.length ? res.note : 'no image XObject drawn on the PDF page';
    } catch (err) {
      logoNote = 'logo extraction failed: ' + err.message;
      images = [];
    }
  }

  const template = {
    id, name, width, height, units: 'mm',
    lines,
    texts,
    images: images.map(({ _px, ...im }) => im),
  };
  fs.writeFileSync(path.join(OUT_DIR, id + '.json'), JSON.stringify(template) + '\n');

  // ---- summary ----
  const types = {};
  for (const e of doc.entities) types[e.type] = (types[e.type] || 0) + 1;
  console.log(`\n== ${id}  "${name}"`);
  console.log(`  sheet ${width} x ${height} mm  (${scaleNote}; $EXT ${hdr ? `${hdr.min}..${hdr.max}` : 'n/a'}; entity extents ${ee.min.map(r3)}..${ee.max.map(r3)})`);
  console.log(`  entities ${JSON.stringify(types)} -> ${lines.length} lines, ${texts.length} texts${Object.keys(skipped).length ? ', skipped ' + JSON.stringify(skipped) : ''}`);
  console.log(`  logo: ${logoNote}`);
  for (const im of images) console.log(`    ${im.src}  ${im._px}  at x=${im.x} y=${im.y} w=${im.w} h=${im.h} mm`);
  console.log('  texts:');
  for (const t of texts) {
    console.log(`    [${String(t.field).padEnd(5)}] (${String(t.x).padStart(8)}, ${String(t.y).padStart(8)}) h=${String(t.h).padEnd(5)} ${t.halign}/${t.valign}  ${JSON.stringify(t.text)}`);
  }
  return { id, name, width, height };
}

function main() {
  if (!TEMPLATES.length) {
    console.log('No DXF files in user-assets/templates – nothing to convert (the bundled sheet formats are left as they are).');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = [];
  for (const t of TEMPLATES) {
    const dxfPath = path.join(SRC_DIR, t.id + '.dxf');
    if (!fs.existsSync(dxfPath)) {
      console.warn(`\n== ${t.id}: ${dxfPath} not found, skipped`);
      continue;
    }
    index.push(convertTemplate(t));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`\nwrote ${index.length} templates + index.json to ${path.relative(ROOT, OUT_DIR)}`);
}

main();
