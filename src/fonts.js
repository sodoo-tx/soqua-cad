// Font registry: the bundled Mongolian ISOCPEUR fonts plus any TTF/OTF the user imports.
// A font is registered three ways at once: CSS (@font-face, for the drawing sheet and labels),
// opentype.js (glyph outlines for sketch text preview) and the kernel (text -> solid geometry).
import opentype from 'opentype.js';
import * as K from './kernel.js';

export const fonts = {}; // name -> { name, buffer:ArrayBuffer, ot, italic }
export const DEFAULT_FONT = 'ISOCPEUR MN';
const DB = 'soqua-fonts';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('fonts');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function registerFont(name, buffer, { persist = false, css = true } = {}) {
  const ot = opentype.parse(buffer);
  fonts[name] = { name, buffer, ot };
  if (css && typeof FontFace !== 'undefined') {
    try {
      const ff = new FontFace(name, buffer.slice(0));
      await ff.load();
      document.fonts.add(ff);
    } catch (e) {
      console.warn('CSS font registration failed', e);
    }
  }
  try {
    await K.loadKernelFont(buffer.slice(0), name);
  } catch (e) {
    console.warn('kernel font registration failed', e);
  }
  if (persist) {
    try {
      const db = await idb();
      db.transaction('fonts', 'readwrite').objectStore('fonts').put(buffer, name);
    } catch (e) {
      /* storage unavailable */
    }
  }
  return fonts[name];
}

export async function loadBundledFonts() {
  const base = import.meta.env.BASE_URL;
  for (const [name, file] of [[DEFAULT_FONT, 'isocpeu_mon.ttf'], ['ISOCPEUR MN Italic', 'isocpeui_mon.ttf']]) {
    try {
      const r = await fetch(`${base}fonts/${file}`);
      if (r.ok) await registerFont(name, await r.arrayBuffer(), {});
    } catch (e) {
      console.warn('font not available', file);
    }
  }
  try {
    const db = await idb();
    const store = db.transaction('fonts').objectStore('fonts');
    const keys = await new Promise((res) => {
      const r = store.getAllKeys();
      r.onsuccess = () => res(r.result);
      r.onerror = () => res([]);
    });
    for (const k of keys) {
      const buf = await new Promise((res) => {
        const r = db.transaction('fonts').objectStore('fonts').get(k);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      if (buf) await registerFont(k, buf);
    }
  } catch (e) {
    /* ignore */
  }
}

// glyph outlines of a text as polylines [[x,y],...] (y up), for sketch display
export function textPolylines(text, fontName, size, x = 0, y = 0) {
  const f = fonts[fontName] || fonts[DEFAULT_FONT] || Object.values(fonts)[0];
  if (!f) return [];
  const path = f.ot.getPath(text, 0, 0, size);
  const out = [];
  let cur = null, start = null, last = [0, 0];
  const P = (px, py) => [x + px, y - py];
  for (const c of path.commands) {
    if (c.type === 'M') {
      cur = [P(c.x, c.y)];
      start = cur[0];
      out.push(cur);
      last = [c.x, c.y];
    } else if (c.type === 'L') {
      cur.push(P(c.x, c.y));
      last = [c.x, c.y];
    } else if (c.type === 'Q' || c.type === 'C') {
      const n = 6;
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        let px, py;
        if (c.type === 'Q') {
          px = u * u * last[0] + 2 * u * t * c.x1 + t * t * c.x;
          py = u * u * last[1] + 2 * u * t * c.y1 + t * t * c.y;
        } else {
          px = u * u * u * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x;
          py = u * u * u * last[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y;
        }
        cur.push(P(px, py));
      }
      last = [c.x, c.y];
    } else if (c.type === 'Z' && cur && start) cur.push(start);
  }
  return out;
}

export function textWidth(text, fontName, size) {
  const f = fonts[fontName] || fonts[DEFAULT_FONT] || Object.values(fonts)[0];
  return f ? f.ot.getAdvanceWidth(text, size) : text.length * size * 0.6;
}
