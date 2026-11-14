// Interactive 3D sketching: click points in space to draw connected lines.
// Points land on a working plane (XY / XZ / YZ through the previous point, Tab cycles), lock onto
// the X / Y / Z axes when close, and snap to model vertices, edge ends, edge midpoints and
// existing sketch points. Typing a number sets the length of the segment being drawn.
import * as THREE from 'three';
import { V, fmt } from '../geom.js';
import { el, toast, setHint } from '../ui/ui.js';

const PLANES = ['XY', 'XZ', 'YZ'];
const NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const AXES = [['X', [1, 0, 0], 0xd0312d], ['Y', [0, 1, 0], 0x2e9e3a], ['Z', [0, 0, 1], 0x2a62d4]];

// data = { pts: [[x,y,z]...], lines: [[i,j]...] } (edited in place); changed() is called after every edit
export function start3DSketch(vp, data, changed) {
  let plane = 'XY';
  let last = null; // index of the point the next segment starts from
  let cur = null; // { p, snap, axis }
  let numEl = null;
  const grp = new THREE.Group();
  vp.groups.active.add(grp);
  const live = el('div', { class: 'livelabel' });
  live.style.display = 'none';
  vp.labels.append(live);

  const hint = () => setHint(`3D Sketch – working plane ${plane} (Tab to change). Click to place points; they snap to the model and lock to X / Y / Z. Type a number for an exact length. Esc or double-click ends the chain.`);
  hint();

  const px = () => vp.pxSize();
  const screenDist = (a, e) => {
    const s = vp.project(a), r = vp.canvas.getBoundingClientRect();
    return Math.hypot(s[0] - (e.clientX - r.left), s[1] - (e.clientY - r.top));
  };

  function locate(e) {
    // 1. existing sketch points
    let best = null, bd = 11;
    data.pts.forEach((p, i) => {
      const d = screenDist(p, e);
      if (d < bd) (bd = d), (best = { p: [...p], snap: 'point', index: i });
    });
    if (best) return best;
    // 2. model: vertices, edge ends and midpoints, then anywhere on an edge / face
    const h = vp.pick(e);
    if (h && h.kind === 'vertex') return { p: [...h.point], snap: 'vertex' };
    if (h && h.kind === 'edge') {
      const info = vp.info(h);
      for (const [q, name] of [[info.a, 'endpoint'], [info.b, 'endpoint'], [info.mid, 'midpoint'], [info.center, 'center']]) if (q && screenDist(q, e) < 11) return { p: [...q], snap: name };
      return { p: [...h.point], snap: 'on edge' };
    }
    // 3. working plane through the previous point (or the origin)
    const base = last !== null ? data.pts[last] : [0, 0, 0];
    const ray = vp.setRay(e).ray;
    const ro = ray.origin.toArray(), rd = ray.direction.toArray();
    let nrm = NORMAL[plane];
    if (Math.abs(V.dot(rd, nrm)) < 0.08) nrm = V.neg(rd); // plane seen edge-on: fall back to the screen plane
    const t = V.dot(V.sub(base, ro), nrm) / V.dot(rd, nrm);
    let p = V.add(ro, V.mul(rd, t));
    if (h && h.kind === 'face' && last === null) p = [...h.point];
    let axis = null;
    if (last !== null) {
      const d = V.sub(p, base), L = V.len(d);
      if (L > 1e-9) {
        for (const [name, ax] of AXES) {
          const along = V.dot(d, ax);
          const off = V.len(V.sub(d, V.mul(ax, along)));
          if (off < Math.max(px() * 9, Math.abs(along) * 0.07)) {
            p = V.add(base, V.mul(ax, along));
            axis = name;
            break;
          }
        }
      }
    }
    // tidy coordinates: snap to 3 decimals so typed-looking values stay clean
    return { p: p.map((x) => Math.round(x * 1000) / 1000), snap: axis ? 'along ' + axis : 'plane ' + plane, axis };
  }

  function addPoint(p, index) {
    let i = index;
    if (i === undefined) {
      i = data.pts.findIndex((q) => V.dist(q, p) < 1e-6);
      if (i < 0) {
        data.pts.push([...p]);
        i = data.pts.length - 1;
      }
    }
    if (last !== null && last !== i && !data.lines.some(([a, b]) => (a === last && b === i) || (a === i && b === last))) data.lines.push([last, i]);
    last = i;
    changed();
    redraw();
  }

  function redraw() {
    vp.disposeGroup(grp);
    const pos = [];
    for (const p of data.pts) pos.push(...p);
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x1b4fd8, size: 8, sizeAttenuation: false, depthTest: false }));
      pts.renderOrder = 12;
      grp.add(pts);
    }
    const seg = [];
    for (const [a, b] of data.lines) if (data.pts[a] && data.pts[b]) seg.push(...data.pts[a], ...data.pts[b]);
    grp.add(vp.fat(seg, 0x1b4fd8, 2.4));
    if (cur && last !== null && data.pts[last]) {
      const base = data.pts[last];
      const color = cur.axis ? AXES.find((a) => a[0] === cur.axis)[2] : 0x1b4fd8;
      grp.add(vp.fat([...base, ...cur.p], color, 2));
      // faint axis guides through the previous point
      const L = Math.max(30, vp.halfH * 0.5);
      for (const [, ax, c] of AXES) {
        const gl = vp.fat([...V.add(base, V.mul(ax, -L)), ...V.add(base, V.mul(ax, L))], c, 0.8, true);
        gl.material.opacity = 0.45;
        grp.add(gl);
      }
    }
    if (cur) {
      const m = px() * 6, p = cur.p;
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(vp.quat).toArray(), u = new THREE.Vector3(0, 1, 0).applyQuaternion(vp.quat).toArray();
      const c = (a, b) => V.add(p, V.add(V.mul(r, a * m), V.mul(u, b * m)));
      grp.add(vp.fat([...c(-1, -1), ...c(1, -1), ...c(1, -1), ...c(1, 1), ...c(1, 1), ...c(-1, 1), ...c(-1, 1), ...c(-1, -1)], 0xf0a000, 1.6));
      const s = vp.project(p);
      live.style.display = '';
      live.style.left = s[0] + 16 + 'px';
      live.style.top = s[1] - 28 + 'px';
      const len = last !== null && data.pts[last] ? fmt(V.dist(data.pts[last], p), 2) + ' mm · ' : '';
      live.textContent = `${len}${cur.snap}`;
    } else live.style.display = 'none';
    vp.render();
  }

  function endChain() {
    last = null;
    cur = null;
    redraw();
  }

  function numeric(ch) {
    if (numEl || last === null || !cur) return false;
    const base = data.pts[last];
    const dir = V.sub(cur.p, base);
    if (V.len(dir) < 1e-9) return false;
    const s = vp.project(cur.p);
    const inp = el('input', { type: 'text', value: ch, inputmode: 'decimal' });
    const wrap = el('div', { class: 'numbox', style: { left: s[0] + 16 + 'px', top: s[1] + 14 + 'px' } }, el('span', { text: 'L' }), inp, el('small', { text: 'Enter' }));
    vp.labels.append(wrap);
    numEl = wrap;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    const close = () => {
      wrap.remove();
      if (numEl === wrap) numEl = null;
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') return close();
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = parseFloat(inp.value.replace(',', '.'));
      if (!(v > 0)) return toast('Type a positive length.', true);
      close();
      addPoint(V.add(base, V.mul(V.norm(dir), v)).map((x) => Math.round(x * 1e6) / 1e6));
    });
    inp.addEventListener('blur', () => setTimeout(close, 0));
    return true;
  }

  const tool = {
    noHover: false,
    down: () => false, // dragging still rotates the view
    move(e) {
      cur = locate(e);
      redraw();
    },
    click(e) {
      const hit = locate(e);
      addPoint(hit.p, hit.index);
      return true;
    },
    dbl: endChain,
  };
  const onKey = (e) => {
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      plane = PLANES[(PLANES.indexOf(plane) + 1) % 3];
      hint();
      toast('Working plane: ' + plane, false, 1200);
    } else if (e.key === 'Escape' && last !== null) {
      e.stopImmediatePropagation();
      endChain();
    } else if (/^[0-9.]$/.test(e.key) && numeric(e.key)) e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  const prevTool = vp.tool;
  vp.tool = tool;
  redraw();

  return {
    refresh: redraw,
    // table edits can remove points: keep the chain start valid
    reset() {
      if (last !== null && !data.pts[last]) last = null;
      redraw();
    },
    stop() {
      window.removeEventListener('keydown', onKey, true);
      vp.tool = prevTool || null;
      vp.groups.active.remove(grp);
      vp.disposeGroup(grp);
      live.remove();
      if (numEl) numEl.remove();
      vp.setHover(null);
      setHint('Ready');
      vp.render();
    },
  };
}
