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
    // The kernel is the one large file (~7 MB compressed, 23 MB raw). Compile it WHILE it downloads
    // (streaming) instead of buffering it all first: faster start and half the peak memory, which
    // matters most on phones. A progress bar follows the download.
    const bar = document.querySelector('#splash .bar');
    const fill = bar.querySelector('i');
    let started = false;
    try {
      if (!WebAssembly.instantiateStreaming || typeof ReadableStream === 'undefined') throw new Error('streaming not supported');
      const res = await fetch(wasmUrl);
      if (!res.ok || !res.body) throw new Error('kernel download failed');
      const encoded = res.headers.get('content-encoding');
      const total = (!encoded && +res.headers.get('content-length')) || 22_950_000;
      bar.classList.add('det');
      const reader = res.body.getReader();
      let got = 0;
      const tracked = new ReadableStream({
        async pull(ctrl) {
          const { done, value } = await reader.read();
          if (done) {
            msg.textContent = 'Starting geometry kernel…';
            fill.style.width = '100%';
            return ctrl.close();
          }
          got += value.length;
          const pct = Math.min(99, Math.round((got / total) * 100));
          fill.style.width = pct + '%';
          msg.textContent = `Loading geometry kernel… ${pct}%`;
          ctrl.enqueue(value);
        },
        cancel(reason) {
          reader.cancel(reason);
        },
      });
      const response = new Response(tracked, { headers: { 'Content-Type': 'application/wasm' } });
      let fail;
      const failed = new Promise((_, rej) => (fail = rej));
      await Promise.race([
        initKernel({
          locateFile: () => wasmUrl,
          instantiateWasm: (imports, done) => {
            WebAssembly.instantiateStreaming(response, imports).then((r) => done(r.instance, r.module), fail);
            return {};
          },
        }),
        failed,
      ]);
      started = true;
    } catch (e) {
      console.warn('Streamed kernel start failed, using the standard loader:', e);
    }
    if (!started) {
      bar.classList.remove('det');
      fill.style.width = '';
      msg.textContent = 'Loading geometry kernel…';
      await initKernel({ locateFile: () => wasmUrl });
    }
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
