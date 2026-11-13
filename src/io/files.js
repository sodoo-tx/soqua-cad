// File commands: new / open / save, import and export of CAD, mesh and 2D formats.
import * as THREE from 'three';
import { app, register, run, attachDoc, Document, setSelection, startSketchOn, enterSketch, refreshTitle, buildTree } from '../app.js';
import { toast, modal, el, esc, $, promptDlg, confirmDlg } from '../ui/ui.js';
import { parseDXF, writeDXF } from './dxf.js';
import { parseIGES } from './iges.js';
import { addMeshBody, soup, meshGeometry, applyAppearance } from '../features/tools.js';
import { flatPattern } from '../features/sheetmetal.js';
import { sketchSegments, segPoints } from '../sketch/profile.js';
import { emptySketch } from '../doc.js';
import { fonts, registerFont, DEFAULT_FONT } from '../fonts.js';
import { uid, fmt, V } from '../geom.js';
import * as K from '../kernel.js';

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
register('download', download);

function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const inp = $('#file');
    inp.value = '';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.onchange = () => res([...inp.files]);
    inp.click();
  });
}

const CAD_EXT = '.soqua,.step,.stp,.iges,.igs,.brep,.stl,.obj,.ply,.3mf,.glb,.gltf,.dae,.fbx,.dxf,.svg,.sldprt,.sldasm,.prt,.dwg,.skp,.ipt,.x_t,.3dm,.f3d';
const UNSUPPORTED = {
  sldprt: 'SOLIDWORKS part files (.sldprt) are a closed, proprietary format. In SOLIDWORKS use File ▸ Save As ▸ STEP (.step) and import that file here – all the solid geometry comes across exactly.',
  sldasm: 'SOLIDWORKS assemblies are a closed format. Save the assembly as STEP in SOLIDWORKS and import the STEP file.',
  prt: 'Creo / NX part files (.prt) are closed, proprietary formats. Export STEP from Creo or NX and import the STEP file here.',
  dwg: 'DWG is a closed AutoCAD format. In AutoCAD (or the free ODA File Converter / LibreCAD) save the drawing as DXF and import the DXF here.',
  skp: 'SketchUp (.skp) is a closed format. In SketchUp use File ▸ Export ▸ 3D Model and choose COLLADA (.dae), OBJ or STL, then import that file here.',
  ipt: 'Inventor part files are a closed format. Export STEP from Inventor and import the STEP file.',
  x_t: 'Parasolid files cannot be read by the open-source kernel. Export STEP instead.',
  '3dm': 'Rhino 3DM import is not available yet. Export STEP (solids) or OBJ/STL (meshes) from Rhino.',
  f3d: 'Fusion archives are a closed format. Export STEP from Fusion and import the STEP file.',
};

// ---------------------------------------------------------------- document
register('newDoc', async () => {
  if (app.doc.features.length && !(await confirmDlg('New document', 'Start a new part? Unsaved changes to the current document will be lost.'))) return;
  if (app.mode === 'drawing') run('toModel');
  attachDoc(new Document());
});
register('save', () => {
  download(new Blob([app.doc.serialize()], { type: 'application/json' }), `${app.doc.name}.soqua`);
  app.markClean();
  toast('Saved. (The document is also auto-saved in this browser.)');
});
register('open', async () => {
  const files = await pickFiles(CAD_EXT, false);
  if (files.length) await importFiles(files, true);
});
register('import', async () => {
  const files = await pickFiles(CAD_EXT, true);
  if (files.length) await importFiles(files, false);
});
register('skImportDXF', async () => {
  const files = await pickFiles('.dxf,.svg', false);
  if (files.length) await importFiles(files, false);
});

export async function importFiles(files, replace) {
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const base = file.name.replace(/\.[^.]+$/, '');
    try {
      if (UNSUPPORTED[ext]) {
        await modal({ title: `Cannot open .${ext} directly`, body: `<p>${UNSUPPORTED[ext]}</p>` });
        continue;
      }
      if (ext === 'soqua' || ext === 'json') {
        const doc = Document.deserialize(await file.text());
        if (app.mode === 'drawing') run('toModel');
        attachDoc(doc);
        applyAppearance(doc);
        app.vp.setState(doc);
        continue;
      }
      if (ext === 'ttf' || ext === 'otf') {
        await registerFont(base, await file.arrayBuffer(), { persist: true });
        toast(`Font "${base}" imported.`);
        continue;
      }
      if (replace && app.doc.features.length === 0) app.doc.name = base;
      else if (replace) {
        attachDoc(new Document());
        app.doc.name = base;
      }
      refreshTitle();
      toast(`Importing ${file.name}…`);
      await new Promise((r) => setTimeout(r, 30));
      if (ext === 'iges' || ext === 'igs') {
        const { polylines, counts } = parseIGES(await file.text());
        if (!polylines.length) throw new Error('no curve entities found. This IGES reader handles curves (lines, arcs, splines); for surfaces and solids please export STEP from the source CAD system');
        const pts = [], lines = [], index = new Map();
        const pid = (p) => {
          const key = p.map((x) => x.toFixed(4)).join(',');
          if (!index.has(key)) {
            index.set(key, pts.length);
            pts.push(p);
          }
          return index.get(key);
        };
        for (const pl of polylines) for (let i = 0; i < pl.length - 1; i++) {
          const p1 = pid(pl[i]), p2 = pid(pl[i + 1]);
          if (p1 !== p2) lines.push([p1, p2]);
        }
        app.doc.addFeature('sketch3d', { pts, lines, source: file.name }, { name: base });
        const surf = Object.entries(counts).filter(([t]) => ['128', '144', '143', '186', '120', '122', '118', '108'].includes(t)).reduce((s, [, n]) => s + n, 0);
        toast(file.name + ': imported ' + polylines.length + ' curves as a 3D sketch' + (surf ? ' (' + surf + ' surface/solid entities were skipped – use STEP for exact solids).' : '.'), surf > 0);
      } else if (['step', 'stp', 'brep'].includes(ext)) {
        let shape;
        if (ext === 'brep') shape = K.R.deserializeShape(await file.text());
        else shape = await K.importSTEP(file);
        const mp = K.massProps(shape);
        const asSolid = mp.volume > 1e-9;
        app.doc.addFeature('import', { brep: shape.serialize(), as: asSolid ? 'solid' : 'surface', source: file.name }, { name: base });
        toast(`${file.name}: imported as ${asSolid ? 'a solid body' : 'a surface body'} (${shape.faces.length} faces). Features like fillet, shell, cut and patterns work on it.`);
      } else if (ext === 'dxf' || ext === 'svg') {
        await import2D(file, ext, base);
      } else {
        const n = await importMesh(file, ext, base);
        toast(`${file.name}: imported ${n.toLocaleString()} triangles as a mesh body.`);
      }
      app.vp.fit();
    } catch (e) {
      console.error(e);
      toast(`Could not import ${file.name}: ${e && e.message && !/WebAssembly/.test(String(e.message)) ? e.message : 'the file could not be read'}`, true);
    }
  }
}

async function importMesh(file, ext, base) {
  const buf = await file.arrayBuffer();
  let object = null, geometry = null;
  // loaders are fetched on demand so they do not slow down start-up
  if (ext === 'stl') geometry = new (await import('three/examples/jsm/loaders/STLLoader.js')).STLLoader().parse(buf);
  else if (ext === 'ply') geometry = new (await import('three/examples/jsm/loaders/PLYLoader.js')).PLYLoader().parse(buf);
  else if (ext === 'obj') object = new (await import('three/examples/jsm/loaders/OBJLoader.js')).OBJLoader().parse(new TextDecoder().decode(buf));
  else if (ext === '3mf') object = new (await import('three/examples/jsm/loaders/3MFLoader.js')).ThreeMFLoader().parse(buf);
  else if (ext === 'dae') object = new (await import('three/examples/jsm/loaders/ColladaLoader.js')).ColladaLoader().parse(new TextDecoder().decode(buf), '').scene;
  else if (ext === 'fbx') object = new (await import('three/examples/jsm/loaders/FBXLoader.js')).FBXLoader().parse(buf, '');
  else if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    object = (await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej))).scene;
  } else throw new Error(`.${ext} files are not supported`);
  const positions = [];
  const add = (g, matrix) => {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (matrix) v.applyMatrix4(matrix);
      positions.push(v.x, v.y, v.z);
    }
  };
  if (geometry) add(geometry, null);
  else {
    object.updateMatrixWorld(true);
    object.traverse((o) => o.isMesh && o.geometry && add(o.geometry, o.matrixWorld));
  }
  if (!positions.length) throw new Error('no mesh geometry found in the file');
  let arr = new Float32Array(positions);
  // CAD-style files are usually Z-up; this app is Y-up like SOLIDWORKS. STL/3MF/PLY/OBJ: ask only when it clearly looks Z-up is not possible, so keep as authored.
  addMeshBody(base, arr, null);
  return arr.length / 9;
}

// DXF / SVG -> sketch entities
async function import2D(file, ext, base) {
  const sk = app.sketcher ? app.sketcher.sk : emptySketch();
  if (!sk.pts.origin) sk.pts.origin = { x: 0, y: 0, fixed: true };
  const P = (x, y) => {
    const id = uid('p');
    sk.pts[id] = { x, y };
    return id;
  };
  let count = 0;
  const addLine = (a, b) => {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) return;
    sk.ents.push({ id: uid('e'), type: 'line', a: P(a[0], a[1]), b: P(b[0], b[1]) });
    count++;
  };
  const addPoly = (pts, closed) => {
    for (let i = 0; i < pts.length - 1; i++) addLine(pts[i], pts[i + 1]);
    if (closed && pts.length > 2) addLine(pts[pts.length - 1], pts[0]);
  };
  const addArc = (cx, cy, r, a1, a2) => {
    const c = P(cx, cy);
    sk.ents.push({ id: uid('e'), type: 'arc', c, a: P(cx + r * Math.cos(a1), cy + r * Math.sin(a1)), b: P(cx + r * Math.cos(a2), cy + r * Math.sin(a2)) });
    count++;
  };
  if (ext === 'dxf') {
    const d = parseDXF(await file.text());
    const k = { in: 25.4, cm: 10, m: 1000 }[d.units] || 1;
    for (const e of d.entities) {
      if (e.type === 'line') addLine([e.x1 * k, e.y1 * k], [e.x2 * k, e.y2 * k]);
      else if (e.type === 'circle') {
        sk.ents.push({ id: uid('e'), type: 'circle', c: P(e.cx * k, e.cy * k), r: e.r * k });
        count++;
      } else if (e.type === 'arc') addArc(e.cx * k, e.cy * k, e.r * k, (e.a1 * Math.PI) / 180, (e.a2 * Math.PI) / 180);
      else if (e.type === 'polyline') {
        const pts = e.pts, n = pts.length;
        for (let i = 0; i < (e.closed ? n : n - 1); i++) {
          const a = pts[i], b = pts[(i + 1) % n], bulge = a[2] || 0;
          if (Math.abs(bulge) < 1e-9) addLine([a[0] * k, a[1] * k], [b[0] * k, b[1] * k]);
          else {
            const dx = b[0] - a[0], dy = b[1] - a[1], ch = Math.hypot(dx, dy), th = 4 * Math.atan(bulge);
            const r = ch / (2 * Math.sin(Math.abs(th) / 2));
            const h = r * Math.cos(th / 2) * Math.sign(bulge);
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
            const cx = mx - (dy / ch) * h, cy = my + (dx / ch) * h;
            const s = bulge > 0 ? a : b, t = bulge > 0 ? b : a;
            addArc(cx * k, cy * k, Math.abs(r) * k, Math.atan2(s[1] - cy, s[0] - cx), Math.atan2(t[1] - cy, t[0] - cx));
          }
        }
      } else if ((e.type === 'spline' || e.type === 'ellipse') && e.pts) addPoly(e.pts.map((p) => [p[0] * k, p[1] * k]), e.closed);
      else if (e.type === 'ellipse') {
        const pts = [];
        const rx = Math.hypot(e.mx, e.my), rot = Math.atan2(e.my, e.mx), ry = rx * e.ratio;
        let t2 = e.t2 <= e.t1 ? e.t2 + 2 * Math.PI : e.t2;
        for (let i = 0; i <= 64; i++) {
          const t = e.t1 + ((t2 - e.t1) * i) / 64;
          pts.push([(e.cx + rx * Math.cos(t) * Math.cos(rot) - ry * Math.sin(t) * Math.sin(rot)) * k, (e.cy + rx * Math.cos(t) * Math.sin(rot) + ry * Math.sin(t) * Math.cos(rot)) * k]);
        }
        addPoly(pts, false);
      }
    }
  } else {
    const { SVGLoader } = await import('three/examples/jsm/loaders/SVGLoader.js');
    const data = new SVGLoader().parse(await file.text());
    for (const path of data.paths) for (const sp of path.subPaths) {
      const pts = sp.getPoints(24).map((p) => [p.x, -p.y]);
      addPoly(pts, false);
    }
  }
  if (!count) throw new Error('no supported 2D geometry found');
  if (app.sketcher) {
    app.sketcher.mergeCoincident(1e-4);
    app.sketcher.changed(false);
  } else {
    const selPlane = app.selection.find((i) => i.planeSpec);
    const f = app.doc.addFeature('sketch', { plane: selPlane ? selPlane.planeSpec : { type: 'base', name: 'Front' }, sketch: sk }, { name: base });
    enterSketch(f.id);
    app.sketcher.mergeCoincident(1e-4);
    app.sketcher.changed(false);
  }
  toast(`${file.name}: ${count} entities inserted into the sketch. Extrude it or keep editing.`);
}

// ---------------------------------------------------------------- export
function displayGroup() {
  // three.js meshes of everything visible, for mesh exporters
  const g = new THREE.Group();
  for (const b of app.vp.bodies) {
    if (b.tess) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.tess.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(b.tess.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(b.tess.indices, 1));
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: app.doc.appearance.color, metalness: app.doc.appearance.metalness ?? 0.5, roughness: app.doc.appearance.roughness ?? 0.5 }));
      m.name = b.name;
      g.add(m);
    } else if (b.data) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.data.positions, 3));
      if (b.data.indices) geo.setIndex(new THREE.BufferAttribute(b.data.indices, 1));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#8fb0c9' }));
      m.name = b.name;
      g.add(m);
    }
  }
  return g;
}
function allTriangles() {
  const parts = [];
  for (const b of app.vp.bodies) {
    if (b.tess) parts.push(soup(b.tess));
    else if (b.data) parts.push(b.data.indices ? new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(b.data.positions, 3)).setIndex(new THREE.BufferAttribute(b.data.indices, 1)).toNonIndexed().attributes.position.array : b.data.positions);
  }
  const n = parts.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function binarySTL(tris) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('SOQUA design binary STL'.padEnd(80, ' ')).subarray(0, 80));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < n; i++) {
    const a = [tris[i * 9], tris[i * 9 + 1], tris[i * 9 + 2]], b = [tris[i * 9 + 3], tris[i * 9 + 4], tris[i * 9 + 5]], c = [tris[i * 9 + 6], tris[i * 9 + 7], tris[i * 9 + 8]];
    const nn = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
    for (const v of [nn, a, b, c]) for (const x of v) {
      dv.setFloat32(o, x, true);
      o += 4;
    }
    o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}
async function export3MF(tris) {
  const { zipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js');
  // weld vertices so slicers get a manifold mesh
  const map = new Map(), verts = [], idx = [];
  for (let i = 0; i < tris.length; i += 3) {
    const key = `${tris[i].toFixed(5)},${tris[i + 1].toFixed(5)},${tris[i + 2].toFixed(5)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = verts.length / 3;
      map.set(key, k);
      verts.push(tris[i], tris[i + 1], tris[i + 2]);
    }
    idx.push(k);
  }
  let v = '', t = '';
  for (let i = 0; i < verts.length; i += 3) v += `<vertex x="${+verts[i].toFixed(5)}" y="${+verts[i + 1].toFixed(5)}" z="${+verts[i + 2].toFixed(5)}"/>`;
  for (let i = 0; i < idx.length; i += 3) if (idx[i] !== idx[i + 1] && idx[i + 1] !== idx[i + 2] && idx[i] !== idx[i + 2]) t += `<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">SOQUA design</metadata><resources><object id="1" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  });
  return new Blob([zip], { type: 'model/3mf' });
}
// IGES wireframe: every model edge as a line (110) or a polyline (106 form 12)
function exportIGES() {
  const ents = [];
  for (const b of app.vp.bodies) {
    if (!b.shape) continue;
    for (const e of b.shape.edges) {
      try {
        const v3 = (p) => [p.x, p.y, p.z];
        if (e.geomType === 'LINE') ents.push({ type: 110, params: [...v3(e.startPoint), ...v3(e.endPoint)] });
        else {
          const n = 32, pts = [];
          for (let k = 0; k <= n; k++) pts.push(...v3(e.pointAt(k / n)));
          ents.push({ type: 106, form: 12, params: [2, n + 1, ...pts] });
        }
      } catch (err) {
        /* skip */
      }
    }
  }
  const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
  const num = (s, n) => String(s).padStart(n, ' ');
  const line = (body, sec, i) => pad(body, 72) + sec + num(i, 7);
  const S = [line('SOQUA design IGES wireframe export (model edges)', 'S', 1)];
  const H = (s) => `${s.length}H${s}`;
  const gtext = [H(','), H(';'), H(app.doc.name), H(app.doc.name + '.igs'), H('SOQUA design'), H('0.1'), 32, 38, 6, 308, 15, H(app.doc.name), '1.0', 2, H('MM'), 1, '0.01', H(new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.000000'), '0.001', '10000.0', H(''), H(''), 11, 0, H('')].join(',') + ';';
  const G = [];
  for (let i = 0; i < gtext.length; i += 72) G.push(line(gtext.slice(i, i + 72), 'G', G.length + 1));
  const D = [], Pl = [];
  ents.forEach((en, i) => {
    const de = i * 2 + 1;
    const txt = [en.type, ...en.params.map((x) => (Number.isInteger(x) ? String(x) : (+x.toFixed(6)).toString().replace(/^(-?\d+)$/, '$1.')))].join(',') + ';';
    const first = Pl.length + 1;
    let cur = '';
    for (const tok of txt.split(/(?<=,)/)) {
      if (cur.length + tok.length > 64) {
        Pl.push(pad(cur, 64) + num(de, 8) + 'P' + num(Pl.length + 1, 7));
        cur = '';
      }
      cur += tok;
    }
    if (cur) Pl.push(pad(cur, 64) + num(de, 8) + 'P' + num(Pl.length + 1, 7));
    const count = Pl.length + 1 - first;
    D.push([num(en.type, 8), num(first, 8), num(0, 8), num(0, 8), num(0, 8), num(0, 8), num(0, 8), num(0, 8), '00000000'].join('') + 'D' + num(de, 7));
    D.push([num(en.type, 8), num(0, 8), num(0, 8), num(count, 8), num(en.form || 0, 8), pad('', 8), pad('', 8), pad('', 8), num(0, 8)].join('') + 'D' + num(de + 1, 7));
  });
  const T = line(`S${num(S.length, 7)}G${num(G.length, 7)}D${num(D.length, 7)}P${num(Pl.length, 7)}`, 'T', 1);
  return new Blob([[...S, ...G, ...D, ...Pl, T].join('\n') + '\n'], { type: 'model/iges' });
}
function sketchDXF() {
  const ents = [];
  const st = app.doc.state;
  const targets = app.selection.filter((i) => i.kind === 'sketch').map((i) => i.id);
  const list = targets.length ? targets : app.doc.features.filter((f) => f.type === 'sketch' && !f.suppressed).map((f) => f.id);
  for (const id of list) {
    const f = app.doc.get(id);
    if (!f || f.type !== 'sketch') continue;
    for (const construction of [false, true])
      for (const s of sketchSegments(f.params.sketch, { construction })) {
        const layer = construction ? 'CONSTRUCTION' : f.name;
        const lt = construction ? 'CENTER' : undefined;
        if (s.type === 'line') ents.push({ type: 'line', x1: s.a[0], y1: s.a[1], x2: s.b[0], y2: s.b[1], layer, linetype: lt });
        else if (s.type === 'circle') ents.push({ type: 'circle', cx: s.c[0], cy: s.c[1], r: s.r, layer, linetype: lt });
        else if (s.type === 'arc') ents.push({ type: 'arc', cx: s.c[0], cy: s.c[1], r: s.r, a1: (s.a1 * 180) / Math.PI, a2: ((s.a1 + s.sweep) * 180) / Math.PI, layer, linetype: lt });
        else ents.push({ type: 'polyline', pts: segPoints(s).map((p) => [p[0], p[1]]), closed: false, layer, linetype: lt });
      }
  }
  if (!ents.length) throw new Error('There is no sketch to export. Select a sketch in the tree first.');
  return new Blob([writeDXF({ entities: ents, layers: {}, units: 'mm' })], { type: 'image/vnd.dxf' });
}
// outline of the selected flat face (handy for laser / plasma cutting)
function faceDXF() {
  const f = app.selection.find((i) => i.kind === 'face' && i.plane);
  if (!f) throw new Error('Select a flat face first.');
  const face = f.hit.body.shape.faces[f.hit.index];
  const pl = f.plane;
  const y = V.cross(pl.n, pl.x);
  const L = (p) => {
    const d = V.sub([p.x, p.y, p.z], pl.o);
    return [V.dot(d, pl.x), V.dot(d, y)];
  };
  const ents = [];
  for (const e of face.edges) {
    if (e.geomType === 'LINE') {
      const a = L(e.startPoint), b = L(e.endPoint);
      ents.push({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], layer: 'OUTLINE' });
    } else {
      const pts = [];
      for (let k = 0; k <= 48; k++) pts.push(L(e.pointAt(k / 48)));
      ents.push({ type: 'polyline', pts, closed: false, layer: 'OUTLINE' });
    }
  }
  return new Blob([writeDXF({ entities: ents, layers: {}, units: 'mm' })], { type: 'image/vnd.dxf' });
}
register('flatDXF', () => {
  try {
    const st = app.doc.state;
    download(new Blob([writeDXF({ entities: flatPattern(st.sheetMetal, st.flanges), layers: { OUTLINE: { color: 7 }, BEND: { color: 1, linetype: 'CENTER' } }, units: 'mm' })]), `${app.doc.name}-flat.dxf`);
  } catch (e) {
    toast(e.message, true);
  }
});

const EXPORTS = [
  ['step', 'STEP AP214 (.step)', 'Exact solids/surfaces. Opens in SOLIDWORKS, Creo, NX, Inventor, Fusion, FreeCAD, Onshape, CATIA…', 'B-rep'],
  ['brep', 'OpenCascade BREP (.brep)', 'Exact geometry for FreeCAD / OpenCascade tools.', 'B-rep'],
  ['iges', 'IGES wireframe (.igs)', 'Model edges as 3D curves. For exact faces use STEP.', 'B-rep'],
  ['stl', 'STL binary (.stl)', '3D printing, CAM.', 'Mesh'],
  ['3mf', '3MF (.3mf)', 'Modern 3D-printing format (units included).', 'Mesh'],
  ['obj', 'Wavefront OBJ (.obj)', 'SketchUp, Blender, 3ds Max, game engines.', 'Mesh'],
  ['glb', 'glTF binary (.glb)', 'Web, AR, Blender, PowerPoint – with colours.', 'Mesh'],
  ['ply', 'Stanford PLY (.ply)', 'Scanning / point-cloud tools.', 'Mesh'],
  ['dxfSketch', 'DXF – sketches (.dxf)', 'Selected sketch (or all sketches). AutoCAD, laser, plasma, CNC.', '2D'],
  ['dxfFace', 'DXF – selected flat face (.dxf)', 'Outline of the selected face incl. holes.', '2D'],
  ['dxfFlat', 'DXF – sheet-metal flat pattern (.dxf)', 'Flat pattern with bend lines.', '2D'],
  ['png', 'Image (.png)', 'Screenshot of the current view.', 'Image'],
  ['soqua', 'SOQUA design document (.soqua)', 'Full feature history – editable later.', 'Native'],
  ['sldprt', 'SOLIDWORKS / Creo native (.sldprt, .prt)', 'Not possible – see note.', 'Closed formats'],
];
export async function exportAs(kind) {
  const name = app.doc.name;
  const st = app.doc.state;
  const breps = () => {
    const list = [];
    if (st.solid) list.push({ shape: st.solid, name, color: app.doc.appearance.color });
    for (const s of st.surfaces) list.push({ shape: s.shape, name: s.name, color: '#d9a441' });
    if (!list.length) throw new Error('There is no solid or surface body to export. Mesh bodies can be exported as STL / OBJ / 3MF / GLB / PLY, or converted to a solid first.');
    return list;
  };
  const tris = () => {
    const t = allTriangles();
    if (!t.length) throw new Error('There is nothing to export yet.');
    return t;
  };
  switch (kind) {
    case 'step': return download(K.exportSTEP(breps()), name + '.step');
    case 'brep': return download(new Blob([K.compound(breps().map((b) => b.shape)).serialize()]), name + '.brep');
    case 'iges': breps(); return download(exportIGES(), name + '.igs');
    case 'stl': return download(binarySTL(tris()), name + '.stl');
    case '3mf': return download(await export3MF(tris()), name + '.3mf');
    case 'obj': {
      tris();
      const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
      return download(new Blob([new OBJExporter().parse(displayGroup())]), name + '.obj');
    }
    case 'ply': {
      tris();
      const { PLYExporter } = await import('three/examples/jsm/exporters/PLYExporter.js');
      return download(new Blob([new PLYExporter().parse(displayGroup(), null, { binary: true })]), name + '.ply');
    }
    case 'glb': {
      tris();
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const buf = await new GLTFExporter().parseAsync(displayGroup(), { binary: true });
      return download(new Blob([buf]), name + '.glb');
    }
    case 'dxfSketch': return download(sketchDXF(), name + '.dxf');
    case 'dxfFace': return download(faceDXF(), name + '-face.dxf');
    case 'dxfFlat': return run('flatDXF');
    case 'png': return run('screenshot');
    case 'soqua': return run('save');
    case 'sldprt':
      return modal({ title: 'Native SOLIDWORKS / Creo files', body: '<p><b>.sldprt</b> (SOLIDWORKS) and <b>.prt</b> (Creo, NX) are closed, proprietary formats. No open-source program can legally or reliably write them – the files contain an encrypted-format Parasolid/Granite body plus undocumented feature data.</p><p>The way every CAD system exchanges exact geometry is <b>STEP</b>: export STEP here, then in SOLIDWORKS/Creo use <i>File ▸ Open</i> on the .step file and save it as a native part. The solid is identical (not a mesh).</p>', buttons: [{ label: 'Export STEP instead', primary: true, action: () => (exportAs('step'), true) }, { label: 'Close' }] });
  }
}
register('export', async () => {
  if (app.mode === 'drawing') return run('drwExportMenu');
  const body = el('div');
  let group = '';
  const tbl = el('table', { class: 'grid' });
  for (const [k, label, note, g] of EXPORTS) {
    if (g !== group) {
      group = g;
      tbl.append(el('tr', {}, el('th', { colspan: 3, text: g })));
    }
    tbl.append(el('tr', {}, el('td', {}, el('b', { text: label })), el('td', { text: note }), el('td', {}, el('button', { class: 'btn primary', text: k === 'sldprt' ? 'Why?' : 'Export', onclick: async () => {
      try {
        await exportAs(k);
      } catch (e) {
        console.error(e);
        toast(e.message || 'Export failed', true);
      }
    } }))));
  }
  body.append(tbl);
  modal({ title: 'Export', body, wide: true, buttons: [{ label: 'Close', primary: true }] });
});

// ---------------------------------------------------------------- fonts / properties / help
register('fonts', async () => {
  const body = el('div');
  const render = () => {
    body.innerHTML = '';
    body.append(el('p', { html: 'Fonts are used for drawing annotations, title blocks, dimensions and sketch text. The bundled default is <b>ISOCPEUR MN</b> (Mongolian Cyrillic). Imported fonts are kept in this browser.' }));
    const tbl = el('table', { class: 'grid' }, el('tr', {}, el('th', { text: 'Font' }), el('th', { text: 'Sample' }), el('th', { text: '' })));
    for (const n of Object.keys(fonts)) tbl.append(el('tr', {}, el('td', { text: n }), el('td', { text: 'ABC abc 123 Зурсан Шалгасан Өө Үү', style: { fontFamily: `'${n}'`, fontSize: '16px' } }), el('td', {}, el('button', { class: 'btn', text: app.doc.custom.font === n || (!app.doc.custom.font && n === DEFAULT_FONT) ? 'Default ✓' : 'Use as default', onclick: () => {
      app.doc.custom.font = n;
      if (app.drawing) app.drawing.render();
      render();
    } }))));
    body.append(tbl);
  };
  render();
  modal({ title: 'Fonts', body, wide: true, buttons: [{ label: 'Import TTF / OTF…', action: async () => {
    const files = await pickFiles('.ttf,.otf', true);
    for (const f of files) {
      try {
        await registerFont(f.name.replace(/\.[^.]+$/, ''), await f.arrayBuffer(), { persist: true });
      } catch (e) {
        toast(`Could not read ${f.name}`, true);
      }
    }
    render();
    return false;
  } }, { label: 'Close', primary: true }] });
});
register('docProps', async () => {
  const c = app.doc.custom;
  const F = [['title', 'Drawing name (Зургийн нэр)'], ['drawnBy', 'Drawn by (Зурсан)'], ['checkedBy', 'Checked by (Шалгасан)'], ['customer', 'Customer (Захиалагч)'], ['material', 'Material (Материал)'], ['weight', 'Weight (Жин)'], ['date', 'Date (Огноо)'], ['paint', 'Paint (Будаг)'], ['deadline', 'Deadline (Хугацаа)'], ['qty', 'Quantity (Тоо/ш)'], ['extra', 'Additional (Нэмэлт)']];
  const body = el('div', { class: 'pm-group' });
  body.append(el('div', { class: 'fld' }, el('label', { text: 'Document name' }), el('input', { id: 'dn', type: 'text', value: app.doc.name })));
  for (const [k, l] of F) body.append(el('div', { class: 'fld', style: { gridTemplateColumns: '190px 1fr' } }, el('label', { text: l }), el('input', { type: 'text', 'data-k': k, value: c[k] || '' })));
  const ok = await modal({ title: 'Properties (used by the drawing title block)', body, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }] });
  if (!ok) return;
  app.doc.name = body.querySelector('#dn').value || app.doc.name;
  for (const inp of body.querySelectorAll('input[data-k]')) c[inp.dataset.k] = inp.value;
  refreshTitle();
  buildTree();
  if (app.drawing) app.drawing.render();
});
register('drwTitle', () => run('docProps'));
register('help', () => modal({ title: 'Quick Start', wide: true, body: `
<ol style="padding-left:18px">
<li><b>Sketch</b> – click <i>Sketch</i>, pick the Front/Top/Right plane or a flat face. Draw with Line, Rectangle, Circle, Arc… Endpoints snap together; closed shapes become profiles. Add sizes with <i>Smart Dimension</i> and relations (horizontal, equal, tangent…) with <i>Add Relation</i>. Blue = under defined, black = fully defined.</li>
<li><b>Features</b> – <i>Extruded Boss/Base</i>, <i>Revolved</i> (needs a centerline), <i>Swept</i>, <i>Lofted</i>, cuts, <i>Hole Wizard</i>, <i>Fillet</i>, <i>Chamfer</i>, <i>Shell</i>, <i>Draft</i>, patterns and <i>Mirror</i>. Every feature stays editable: double-click it in the tree.</li>
<li><b>Tree</b> – right-click a feature to edit, suppress, roll back or delete it. Sketches sit under the feature that uses them.</li>
<li><b>Surfaces, Sheet Metal, Weldments, Mesh Modeling</b> – each has its own tab.</li>
<li><b>Evaluate / Simulation / Render</b> – measure, mass properties, section view, static stress study, appearances and image rendering.</li>
<li><b>Drawing</b> – click the <i>Drawing</i> tab at the bottom: choose your sheet format, add standard views, dimensions and notes, export PDF or DXF.</li>
<li><b>Files</b> – <i>File ▸ Import</i> / <i>Export</i>. Work is auto-saved in the browser; use <i>Save</i> for a .soqua file.</li>
</ol>` }));
register('helpKeys', () => modal({ title: 'Keyboard & Mouse', body: `<div class="kv">
<b>Rotate</b><span>Middle-button drag · drag on empty space · one finger</span><b>Pan</b><span>Right-button drag · Ctrl + middle drag · two fingers</span><b>Zoom</b><span>Wheel · pinch</span>
<b>Select</b><span>Click (Ctrl/Shift+click adds)</span><b>Context menu</b><span>Right-click</span><b>Zoom to fit</b><span>F</span><b>Standard views</b><span>Ctrl+1 … Ctrl+7, Normal To: Ctrl+8</span>
<b>Undo / Redo</b><span>Ctrl+Z / Ctrl+Y</span><b>Rebuild</b><span>Ctrl+B</span><b>Save / Open</b><span>Ctrl+S / Ctrl+O</span><b>OK / Cancel dialog</b><span>Enter / Esc</span>
<b>Sketch tools</b><span>L line · R rectangle · C circle · A arc · S spline · P point · D dimension · T trim · Del delete · Esc end</span></div>` }));
register('helpFormats', () => modal({ title: 'File Format Support', wide: true, body: `
<table class="grid"><tr><th>Format</th><th>Import</th><th>Export</th><th>Notes</th></tr>
<tr><td>STEP (.step .stp)</td><td>✔ exact</td><td>✔ exact</td><td>The exchange format for SOLIDWORKS, Creo, NX, Inventor, Fusion, CATIA, FreeCAD, Onshape.</td></tr>
<tr><td>IGES (.igs .iges)</td><td>curves only</td><td>wireframe</td><td>Lines, arcs and splines (import as a 3D sketch; export writes model edges). Use STEP for faces and solids.</td></tr>
<tr><td>BREP (.brep)</td><td>✔</td><td>✔</td><td>OpenCascade native.</td></tr>
<tr><td>STL, 3MF, OBJ, PLY, glTF/GLB</td><td>✔ mesh</td><td>✔</td><td>3D printing, SketchUp, Blender, web.</td></tr>
<tr><td>COLLADA (.dae), FBX</td><td>✔ mesh</td><td>–</td><td>DAE is the best route from SketchUp.</td></tr>
<tr><td>DXF</td><td>✔ into sketch / drawing</td><td>✔ sketches, faces, flat patterns, drawings</td><td>AutoCAD, LibreCAD, laser/plasma/CNC.</td></tr>
<tr><td>SVG</td><td>✔ into sketch</td><td>✔ drawings</td><td></td></tr>
<tr><td>PDF</td><td>–</td><td>✔ drawings (vector, embedded font)</td><td></td></tr>
<tr><td>TTF / OTF fonts</td><td>✔</td><td>–</td><td>Used in drawings and sketch text.</td></tr>
<tr><td>SLDPRT, SLDASM, Creo/NX PRT, DWG, SKP, IPT, X_T</td><td>✘</td><td>✘</td><td>Closed proprietary formats – exchange through STEP / DXF / DAE instead.</td></tr></table>` }));
register('about', () => modal({ title: 'About SOQUA design', body: `<p><b>SOQUA design</b> 0.1 – open-source parametric CAD that runs entirely in the browser (nothing is uploaded; all geometry is computed on your device).</p><p>Geometry kernel: OpenCascade (LGPL) through replicad (MIT). Rendering: three.js (MIT). PDF: jsPDF (MIT). Fonts: opentype.js (MIT).</p><p>SOQUA design is an independent project. It is not affiliated with, endorsed by, or derived from the code of Dassault Systèmes SOLIDWORKS, Autodesk, PTC or Trimble; those names are trademarks of their owners and are mentioned only to describe file compatibility.</p>` }));

// drag & drop files anywhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) importFiles([...e.dataTransfer.files], false);
});
