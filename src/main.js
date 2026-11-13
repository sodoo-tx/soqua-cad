// SOQUA design - entry point
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { initKernel } from './kernel.js';
import { app, initApp, attachDoc, loadAutosave, Document, run } from './app.js';
import { loadBundledFonts } from './fonts.js';
import './features/commands.js';
import { applyAppearance } from './features/tools.js';
import './io/files.js';
import './drawing/drawing.js';
import { toast } from './ui/ui.js';

const splash = document.getElementById('splash');
const msg = document.getElementById('splash-msg');

async function boot() {
  try {
    // download the kernel with a visible progress bar (it is the one large file: ~7 MB compressed)
    const bar = document.querySelector('#splash .bar');
    const fill = bar.querySelector('i');
    let wasmBinary;
    try {
      const res = await fetch(wasmUrl);
      const encoded = res.headers.get('content-encoding');
      const total = (!encoded && +res.headers.get('content-length')) || 22_950_000;
      if (res.ok && res.body) {
        bar.classList.add('det');
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          const pct = Math.min(99, Math.round((got / total) * 100));
          fill.style.width = pct + '%';
          msg.textContent = `Loading geometry kernel… ${pct}%`;
        }
        wasmBinary = new Uint8Array(got);
        let o = 0;
        for (const c of chunks) {
          wasmBinary.set(c, o);
          o += c.length;
        }
      }
    } catch (e) {
      wasmBinary = undefined; // fall back to the kernel's own loader
    }
    msg.textContent = 'Starting geometry kernel…';
    await initKernel(wasmBinary ? { wasmBinary, locateFile: () => wasmUrl } : { locateFile: () => wasmUrl });
    msg.textContent = 'Loading fonts…';
    await loadBundledFonts();
    initApp();
    const doc = loadAutosave() || new Document();
    applyAppearance(doc);
    attachDoc(doc);
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 400);
    window.soqua = app; // handy for debugging / scripting from the console
    if (!localStorage.getItem('soqua-seen')) {
      localStorage.setItem('soqua-seen', '1');
      run('help');
    }
  } catch (e) {
    console.error(e);
    msg.textContent = 'SOQUA design could not start: ' + (e && e.message ? e.message : e) + '. A browser with WebAssembly and WebGL is required.';
  }
}
boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
