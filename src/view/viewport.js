// 3D viewport: rendering, camera navigation (mouse + touch), picking and highlighting.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as K from '../kernel.js';
import { V, BASE_PLANES, toWorld, toLocal, planeY } from '../geom.js';
import { sketchSegments, segPoints } from '../sketch/profile.js';

const HOVER = 0xff8a00, SELECT = 0x1e8fff;
export const VIEWS = {
  // Z up: the front view looks along +Y
  front: { dir: [0, 1, 0], up: [0, 0, 1] }, back: { dir: [0, -1, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] }, right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, -1], up: [0, 1, 0] }, bottom: { dir: [0, 0, 1], up: [0, -1, 0] },
  iso: { dir: [-1, 1, -1], up: [0, 0, 1] }, dimetric: { dir: [-1, 1.6, -0.6], up: [0, 0, 1] }, trimetric: { dir: [-1.2, 2, -0.8], up: [0, 0, 1] },
};

export class Viewport {
  constructor(canvas, labels) {
    this.canvas = canvas;
    this.labels = labels;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.75;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200000);
    this.target = new THREE.Vector3(0, 0, 0);
    this.quat = new THREE.Quaternion();
    this.halfH = 120;
    this.light = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.light, this.light.target, new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.55));
    this.groups = {};
    for (const g of ['bodies', 'planes', 'sketches', 'active', 'overlay', 'extras', 'floor']) {
      this.groups[g] = new THREE.Group();
      this.scene.add(this.groups[g]);
    }
    this.display = 'shadedEdges';
    this.clip = null;
    this.pickables = [];
    this.edgeObjs = [];
    this.planeObjs = [];
    this.showPlanes = false;
    this.selection = [];
    this.hover = null;
    this.tool = null; // { down, move, up, dbl, key, cursor }
    this.onPick = null;
    this.onHover = null;
    this.onContext = null;
    this.onCamera = null;
    this.filter = null; // optional (hit) => boolean
    this.ray = new THREE.Raycaster();
    this.lineMats = new Set();
    this.animate = true; // motion effects (glow pulse, build flash, turntable); switched by the app
    this.turntable = false;
    this._tessCache = new WeakMap(); // shape -> tessellation, so unchanged bodies are never re-meshed
    this.modelSize = 200;
    this._buildTriad();
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.setView('iso', false);
  }

  // ------------------------------------------------------------ camera
  resize() {
    const p = this.canvas.parentElement;
    const w = Math.max(50, p.clientWidth), h = Math.max(50, p.clientHeight);
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.updateCamera();
  }
  updateCamera() {
    const a = this.w / this.h;
    const c = this.camera;
    c.left = -this.halfH * a;
    c.right = this.halfH * a;
    c.top = this.halfH;
    c.bottom = -this.halfH;
    const D = Math.max(5000, this.modelSize * 20);
    c.far = D * 2;
    c.near = 0.01;
    c.quaternion.copy(this.quat);
    c.position.copy(this.target).add(new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat).multiplyScalar(D));
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    this.light.position.copy(c.position).add(new THREE.Vector3(-0.5, 0.9, 0).applyQuaternion(this.quat).multiplyScalar(D * 0.6));
    this.light.target.position.copy(this.target);
    this.render();
    if (this.groups) this.updatePlaneLabels();
    if (this.onCamera) this.onCamera();
  }
  pxSize() {
    return (2 * this.halfH) / this.h;
  }
  setView(name, animate = true) {
    const v = VIEWS[name];
    if (!v) return;
    this.lookAlong(v.dir, v.up, animate);
  }
  lookAlong(dir, up, animate = true) {
    const z = new THREE.Vector3(...dir).normalize().negate();
    let y = new THREE.Vector3(...up);
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    y = new THREE.Vector3().crossVectors(z, x).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.animateTo(q, null, null, animate);
  }
  normalTo(pl) {
    this.lookAlong(V.neg(pl.n), planeY(pl));
  }
  animateTo(q, target, halfH, animate = true) {
    const q0 = this.quat.clone(), t0 = this.target.clone(), h0 = this.halfH;
    const t1 = target || t0, h1 = halfH || h0;
    this.qGoal = q.clone();
    if (!animate) {
      this.quat.copy(q);
      this.target.copy(t1);
      this.halfH = h1;
      this.updateCamera();
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 260), e = k * k * (3 - 2 * k);
      this.quat.copy(q0).slerp(q, e);
      this.target.copy(t0).lerp(t1, e);
      this.halfH = h0 + (h1 - h0) * e;
      this.updateCamera();
      if (k < 1 && this.qGoal && this.qGoal.equals(q)) requestAnimationFrame(step);
      else if (k >= 1) this.qGoal = null;
    };
    requestAnimationFrame(step);
  }
  fit(animate = true) {
    const box = new THREE.Box3();
    for (const g of [this.groups.bodies, this.groups.active, this.groups.sketches]) {
      g.updateMatrixWorld();
      const b = new THREE.Box3().setFromObject(g);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-95, -95, -95), new THREE.Vector3(95, 95, 95)); // empty part: frame the three default planes
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.modelSize = Math.max(10, sphere.radius * 2);
    const a = this.w / this.h;
    const hh = Math.max(1, (sphere.radius * 1.15) / Math.min(1, a));
    this.animateTo((this.qGoal || this.quat).clone(), sphere.center, hh, animate);
  }
  ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  setRay(e) {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    return this.ray;
  }
  // 2D point on a sketch plane under the pointer
  planePoint(e, pl) {
    const ray = this.setRay(e).ray;
    const n = new THREE.Vector3(...pl.n);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = new THREE.Vector3(...pl.o).sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    const l = toLocal(pl, [p.x, p.y, p.z]);
    return [l[0], l[1]];
  }
  project(p) {
    const v = new THREE.Vector3(...p).project(this.camera);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h];
  }

  // ------------------------------------------------------------ scene content
  fat(positions, color, width = 2, dashed = false) {
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions.length ? positions : [0, 0, 0, 0, 0, 0]);
    const mat = new LineMaterial({ color, linewidth: width, dashed, dashSize: 3, gapSize: 2, dashScale: 1 / Math.max(1e-6, this.pxSize()) / 3, depthTest: false, transparent: true });
    mat.resolution.set(this.w, this.h);
    this.lineMats.add(mat);
    const l = new LineSegments2(geo, mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 10;
    l.visible = positions.length > 0;
    return l;
  }
  disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        this.lineMats.delete(o.material);
        if (o.material.dispose) o.material.dispose();
      }
    });
    g.clear();
  }

  // state: doc.state, appearance: {color, material props, faces:{}}
  setState(doc) {
    const st = doc.state;
    this.doc = doc;
    this.disposeGroup(this.groups.bodies);
    this.pickables = [];
    this.edgeObjs = [];
    const ap = doc.appearance || {};
    const add = (body) => {
      let tess;
      try {
        const tol = Math.max(0.01, this.modelSize * 0.0004);
        const key = Math.round(Math.log2(tol) * 2); // re-mesh only when the required precision changes noticeably
        const hit = this._tessCache.get(body.shape);
        if (hit && hit.key === key) tess = hit.tess;
        else {
          tess = K.tessellate(body.shape, { tolerance: tol, angularTolerance: 0.2 });
          this._tessCache.set(body.shape, { key, tess });
        }
      } catch (e) {
        console.warn('tessellation failed', e);
        return;
      }
      body.tess = tess;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(tess.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(tess.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
      geo.setAttribute('uv', new THREE.BufferAttribute(boxUV(tess.positions, tess.normals), 2));
      const base = new THREE.Color(body.kind === 'surface' ? '#d9a441' : ap.color || '#aeb6bf');
      const colors = new Float32Array(tess.positions.length);
      for (let i = 0; i < colors.length; i += 3) base.toArray(colors, i);
      if (body.kind === 'solid' && ap.faces) {
        for (const fc of Object.values(ap.faces)) {
          const [f] = K.matchFaces(body.shape, [fc.sig]);
          if (!f) continue;
          const idx = body.shape.faces.findIndex((x) => x.isSame(f));
          const g = tess.faceGroups.find((x) => x.face === idx);
          if (!g) continue;
          const c = new THREE.Color(fc.color);
          for (let k = g.start; k < g.start + g.count; k++) c.toArray(colors, tess.indices[k] * 3);
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = this.makeMaterial(ap, body.kind);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { body };
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(tess.lines, 3));
      const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: 0x15191e }));
      lines.userData = { body };
      this.groups.bodies.add(mesh, lines);
      this.pickables.push(mesh);
      this.edgeObjs.push(lines);
    };
    this.bodies = [];
    if (st.solid) this.bodies.push({ id: 'solid', kind: 'solid', name: 'Solid body', shape: st.solid });
    for (const s of st.surfaces) this.bodies.push({ id: s.id, kind: 'surface', name: s.name, shape: s.shape });
    for (const b of this.bodies) add(b);
    for (const m of st.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.data.positions, 3));
      if (m.data.indices) geo.setIndex(new THREE.BufferAttribute(m.data.indices, 1));
      if (m.data.colors) geo.setAttribute('color', new THREE.BufferAttribute(m.data.colors, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: m.color || '#8fb0c9', roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide, flatShading: !m.data.indices, vertexColors: !!m.data.colors });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      const body = { id: m.id, kind: 'mesh', name: m.name, data: m.data };
      mesh.userData = { body };
      this.bodies.push(body);
      this.groups.bodies.add(mesh);
      this.pickables.push(mesh);
    }
    this.applyDisplay();
    this.applyClip();
    this.buildSketches(doc);
    this.buildPlanes(doc);
    this.setSelection([]);
    const box = new THREE.Box3().setFromObject(this.groups.bodies);
    if (!box.isEmpty()) this.modelSize = Math.max(10, box.getSize(new THREE.Vector3()).length());
    this.updateFloor(box);
    // a short glow sweeps over the body whenever its geometry has just changed
    const solid = st.solid || null;
    this._flash = null;
    if (this.animate && this._lastSolid !== undefined && solid && solid !== this._lastSolid && this.display !== 'hidden') {
      this._flash = { t0: performance.now(), dur: 560, mats: this.pickables.filter((m) => m.userData.body.kind !== 'mesh').map((m) => m.material) };
      this.startFx();
    }
    this._lastSolid = solid;
    this.render();
  }

  // ------------------------------------------------------------ motion effects
  // One shared animation loop that only runs while something is actually animating.
  startFx() {
    if (this._fx) return;
    const loop = (t) => {
      this._fx = 0;
      let alive = false;
      if (this.animate && this.groups.overlay.children.length) {
        const k = 0.5 + 0.5 * Math.sin(t * 0.0055);
        this.groups.overlay.traverse((o) => {
          const p = o.userData.pulse;
          if (p && o.material) o.material.opacity = p[0] + p[1] * k;
        });
        alive = true;
      }
      if (this._flash) {
        const u = Math.max(0, (t - this._flash.t0) / this._flash.dur);
        if (u >= 1 || !this.animate) {
          this._flash = null;
          this.applyDisplay();
        } else {
          const e = (1 - u) * (1 - u);
          for (const m of this._flash.mats) {
            m.emissive.setHex(0x2fc4ff);
            m.emissiveIntensity = 0.5 * e;
          }
          alive = true;
        }
      }
      if (this.turntable) {
        const dt = this._ttLast ? Math.min(60, t - this._ttLast) : 16;
        this._ttLast = t;
        this.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dt * 0.00055)).normalize();
        this.updateCamera();
        alive = true;
      } else this._ttLast = 0;
      this.render();
      if (alive) this._fx = requestAnimationFrame(loop);
    };
    this._fx = requestAnimationFrame(loop);
  }
  setTurntable(on) {
    this.turntable = on;
    if (on) this.startFx();
  }
  setAnimate(on) {
    this.animate = on;
    if (!on) this.turntable = false;
    this.refreshOverlay();
  }

  makeMaterial(ap, kind) {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, metalness: ap.metalness ?? 0.55, roughness: ap.roughness ?? 0.42,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: (ap.opacity ?? 1) < 1 || kind === 'surface', opacity: kind === 'surface' ? 0.85 : ap.opacity ?? 1,
    });
    if (ap.map && kind === 'solid') {
      m.map = ap.map;
      m.needsUpdate = true;
    }
    return m;
  }

  applyDisplay() {
    const d = this.display;
    for (const m of this.pickables) {
      const mat = m.material;
      m.visible = true;
      mat.wireframe = false;
      mat.colorWrite = true;
      if (d === 'wireframe') mat.colorWrite = false; // faces still pickable + hide nothing
      if (d === 'hidden') {
        mat.colorWrite = true;
      }
      mat.needsUpdate = true;
      if (m.userData.body.kind !== 'mesh') {
        m.material.emissive = new THREE.Color(d === 'hidden' ? 0xffffff : 0x000000);
        m.material.emissiveIntensity = d === 'hidden' ? 1 : 0;
      } else if (d === 'wireframe') {
        mat.colorWrite = true;
        mat.wireframe = true;
      }
    }
    for (const l of this.edgeObjs) {
      l.visible = d !== 'shaded';
      l.material.depthTest = d !== 'wireframe';
    }
    this.render();
  }
  setDisplay(d) {
    this.display = d;
    this.applyDisplay();
  }
  setClip(clip) {
    this.clip = clip; // {n:[..], o:[..]} or null
    this.applyClip();
  }
  applyClip() {
    const planes = [];
    if (this.clip) {
      const n = new THREE.Vector3(...this.clip.n).normalize().negate();
      planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...this.clip.o)));
    }
    this.groups.bodies.traverse((o) => {
      if (o.material) {
        o.material.clippingPlanes = planes;
        o.material.needsUpdate = true;
      }
    });
    this.render();
  }

  updateFloor(box) {
    this.disposeGroup(this.groups.floor);
    if (!this.floorOn || !box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()).length() * 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: 0.28 }));
    const c = box.getCenter(new THREE.Vector3());
    floor.position.set(c.x, c.y, box.min.z - 0.01);
    floor.receiveShadow = true;
    this.groups.floor.add(floor);
    const s = size / 3;
    const cam = this.light.shadow.camera;
    Object.assign(cam, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 1e6 });
    cam.updateProjectionMatrix();
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0005;
  }
  setFloor(on) {
    this.floorOn = on;
    this.light.castShadow = on;
    this.updateFloor(new THREE.Box3().setFromObject(this.groups.bodies));
    this.render();
  }

  // inactive sketches (grey) -- sketches not consumed by a feature, or explicitly shown
  buildSketches(doc) {
    this.disposeGroup(this.groups.sketches);
    const used = new Set();
    for (const f of doc.features) {
      const p = f.params || {};
      for (const k of ['sketch', 'profile', 'path']) if (typeof p[k] === 'string') used.add(p[k]);
      if (Array.isArray(p.profiles)) p.profiles.forEach((x) => used.add(x));
    }
    for (const f of doc.features) {
      if (f.rolledBack || f.suppressed) continue;
      if (f.id === this.hiddenSketch) continue;
      const s = doc.state.sketches[f.id];
      if (!s) continue;
      const show = f.params.visible ?? !used.has(f.id);
      if (!show && !this.selection.some((x) => x.kind === 'feature' && x.id === f.id)) continue;
      const obj = s.kind === '3d' ? this.sketch3dObject(s, 0x4a5f78) : this.sketchObject(f.params.sketch, s.plane, 0x4a5f78, 0x8c97a3);
      obj.userData = { sketchFeature: f.id };
      this.groups.sketches.add(obj);
    }
  }
  sketchObject(sk, pl, color, cColor, width = 1.6) {
    const g = new THREE.Group();
    const solid = [], cons = [];
    for (const construction of [false, true]) {
      for (const s of sketchSegments(sk, { construction })) {
        const pts = segPoints(s).map((p) => toWorld(pl, p));
        const arr = construction ? cons : solid;
        for (let i = 0; i < pts.length - 1; i++) arr.push(...pts[i], ...pts[i + 1]);
      }
    }
    g.add(this.fat(solid, color, width), this.fat(cons, cColor ?? color, 1.2, true));
    return g;
  }
  sketch3dObject(s, color) {
    const arr = [];
    for (const g of s.segs) arr.push(...g.a, ...g.b);
    const grp = new THREE.Group();
    grp.add(this.fat(arr, color, 1.8));
    return grp;
  }

  buildPlanes(doc) {
    for (const old of this.groups.planes.children) if (old.userData.label) old.userData.label.remove();
    this.disposeGroup(this.groups.planes);
    this.planeObjs = [];
    const size = Math.max(60, this.modelSize * 0.6);
    this.planeSize = size;
    const add = (name, pl, spec, color) => {
      const y = planeY(pl);
      const c = (a, b) => V.add(pl.o, V.add(V.mul(pl.x, a * size), V.mul(y, b * size)));
      const p = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]], 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      const outline = this.fat([...p[0], ...p[1], ...p[1], ...p[2], ...p[2], ...p[3], ...p[3], ...p[0]], color, 1.2);
      outline.material.depthTest = true;
      const g = new THREE.Group();
      g.add(mesh, outline);
      const label = document.createElement('div');
      label.className = 'planelabel';
      label.textContent = name;
      this.labels.append(label);
      g.userData = { plane: pl, spec, name, corner: p[3], ring: [...p[0], ...p[1], ...p[1], ...p[2], ...p[2], ...p[3], ...p[3], ...p[0]], label, color };
      mesh.userData = g.userData;
      this.groups.planes.add(g);
      this.planeObjs.push(mesh);
    };
    add('Front Plane', BASE_PLANES.Front, { type: 'base', name: 'Front' }, 0x3b6fd4);
    add('Top Plane', BASE_PLANES.Top, { type: 'base', name: 'Top' }, 0x3b6fd4);
    add('Right Plane', BASE_PLANES.Right, { type: 'base', name: 'Right' }, 0x3b6fd4);
    for (const f of doc.features) if (f.type === 'plane' && doc.state.planes[f.id]) add(f.name, doc.state.planes[f.id], { type: 'feature', id: f.id }, 0xc27a1a);
    this.refreshPlaneVisibility();
  }
  refreshPlaneVisibility() {
    const empty = !this.doc || (!this.doc.state.solid && !this.doc.state.surfaces.length && !this.doc.state.meshes.length);
    for (const g of this.groups.planes.children) {
      const isRef = g.userData.spec.type === 'feature';
      const sel = this.selection.some((s) => s.kind === 'plane' && s.name === g.userData.name);
      const hot = !!this.hover && this.hover.kind === 'plane' && this.hover.name === g.userData.name;
      g.visible = this.showPlanes || sel || hot || isRef || (empty && !this.tool);
      const lab = g.userData.label;
      if (lab) {
        lab.style.display = g.visible ? '' : 'none';
        lab.classList.toggle('hot', hot);
        lab.classList.toggle('sel', sel);
      }
    }
    this.updatePlaneLabels();
    this.render();
  }
  // plane names sit at the top-left corner of each visible plane, like in the reference CAD systems
  updatePlaneLabels() {
    for (const g of this.groups.planes.children) {
      const lab = g.userData.label;
      if (!lab || !g.visible) continue;
      const s = this.project(g.userData.corner);
      lab.style.left = s[0] + 'px';
      lab.style.top = s[1] + 'px';
    }
  }
  setShowPlanes(v) {
    this.showPlanes = v;
    this.refreshPlaneVisibility();
  }

  // ------------------------------------------------------------ picking
  pick(e, opts = {}) {
    const ray = this.setRay(e);
    const px = this.pxSize();
    let best = null;
    const meshHits = ray.intersectObjects(this.pickables.filter((m) => m.visible), false).filter((h) => this.notClipped(h.point));
    const fh = meshHits[0];
    if (fh) {
      const body = fh.object.userData.body;
      if (body.kind === 'mesh') best = { kind: 'mesh', body, point: fh.point.toArray(), dist: fh.distance };
      else {
        const tri = fh.faceIndex * 3;
        const g = body.tess.faceGroups.find((x) => tri >= x.start && tri < x.start + x.count);
        if (g) best = { kind: 'face', body, index: g.face, point: fh.point.toArray(), dist: fh.distance };
      }
    }
    // edges: nearest segment in screen space, must not be behind the face hit
    ray.params.Line = { threshold: px * 7 };
    const eh = ray.intersectObjects(this.edgeObjs.filter((l) => l.visible), false).filter((h) => this.notClipped(h.point));
    let bestEdge = null;
    for (const h of eh) {
      if (fh && h.distance > fh.distance + px * 8 + this.modelSize * 1e-3) continue;
      const d = h.distanceToRay ?? ray.ray.distanceToPoint(h.point);
      if (!bestEdge || d < bestEdge.d) bestEdge = { h, d };
    }
    if (bestEdge && opts.edges !== false) {
      const h = bestEdge.h;
      const body = h.object.userData.body;
      const g = body.tess.edgeGroups.find((x) => h.index >= x.start && h.index < x.start + x.count);
      if (g) {
        const hit = { kind: 'edge', body, index: g.edge, point: h.point.toArray(), dist: h.distance };
        // vertex if close to an end of this edge
        const pos = body.tess.lines;
        const a = [pos[g.start * 3], pos[g.start * 3 + 1], pos[g.start * 3 + 2]];
        const k = (g.start + g.count - 1) * 3;
        const b = [pos[k], pos[k + 1], pos[k + 2]];
        for (const v of [a, b]) if (V.dist(v, hit.point) < px * 9) best = { kind: 'vertex', body, point: v, dist: h.distance };
        if (!best || best.kind !== 'vertex') best = hit;
      }
    }
    if (!best || opts.planesFirst) {
      const ph = ray.intersectObjects(this.planeObjs.filter((m) => m.parent.visible), false)[0];
      if (ph && (!best || opts.planesFirst)) best = { kind: 'plane', ...ph.object.userData, point: ph.point.toArray() };
    }
    if (!best) {
      // sketches
      let bd = px * 8, sid = null;
      for (const g of this.groups.sketches.children) {
        for (const l of g.children) {
          const arr = l.geometry.attributes.instanceStart;
          if (!arr || !l.visible) continue;
          const a = new THREE.Vector3(), b = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
          const data = arr.data.array;
          for (let i = 0; i < arr.count; i++) {
            a.set(data[i * 6], data[i * 6 + 1], data[i * 6 + 2]);
            b.set(data[i * 6 + 3], data[i * 6 + 4], data[i * 6 + 5]);
            const d = Math.sqrt(ray.ray.distanceSqToSegment(a, b, c1, c2));
            if (d < bd) {
              bd = d;
              sid = g.userData.sketchFeature;
            }
          }
        }
      }
      if (sid) best = { kind: 'sketch', id: sid };
    }
    if (best && this.filter && !this.filter(best)) return null;
    return best;
  }
  notClipped(p) {
    if (!this.clip) return true;
    return V.dot(V.sub(p.toArray(), this.clip.o), this.clip.n) <= 1e-6;
  }

  hitKey(h) {
    if (!h) return '';
    if (h.kind === 'vertex') return 'v' + h.point.map((x) => x.toFixed(4)).join(',');
    if (h.kind === 'plane') return 'p' + h.name;
    if (h.kind === 'sketch' || h.kind === 'feature') return 's' + h.id;
    return h.kind + ':' + h.body.id + ':' + (h.index ?? '');
  }
  info(h) {
    if (!h.info) {
      if (h.kind === 'face') h.info = K.faceInfo(h.body.shape, h.index);
      else if (h.kind === 'edge') h.info = K.edgeInfo(h.body.shape, h.index);
    }
    return h.info;
  }

  highlightObject(h, color) {
    if (!h) return null;
    if (h.kind === 'face') {
      const t = h.body.tess, g = t.faceGroups.find((x) => x.face === h.index);
      if (!g) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(t.indices.subarray(g.start, g.start + g.count), 1));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.renderOrder = 5;
      m.userData.pulse = [0.34, 0.26];
      return m;
    }
    if (h.kind === 'edge') {
      const t = h.body.tess, g = t.edgeGroups.find((x) => x.edge === h.index);
      if (!g) return null;
      // a wide soft halo under a crisp core line reads as a glow without any post-processing cost
      const seg = Array.from(t.lines.subarray(g.start * 3, (g.start + g.count) * 3));
      const grp = new THREE.Group();
      const halo = this.fat(seg, color, 13);
      halo.material.opacity = 0.2;
      halo.userData.pulse = [0.1, 0.22];
      halo.renderOrder = 9;
      const core = this.fat(seg, color, 3.6);
      grp.add(halo, core);
      return grp;
    }
    if (h.kind === 'vertex') {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(h.point, 3));
      const p = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, depthTest: false }));
      p.renderOrder = 11;
      return p;
    }
    if (h.kind === 'plane') {
      // glowing plane: brighter fill plus a soft halo around its border
      const src = this.groups.planes.children.find((p) => p.userData.name === h.name);
      if (!src) return null;
      const grp = new THREE.Group();
      const fill = new THREE.Mesh(src.children[0].geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      fill.userData.shared = true;
      fill.userData.pulse = [0.12, 0.2];
      fill.renderOrder = 4;
      const halo = this.fat(src.userData.ring, color, 12);
      halo.material.opacity = 0.2;
      halo.userData.pulse = [0.1, 0.24];
      const core = this.fat(src.userData.ring, color, 2.6);
      grp.add(fill, halo, core);
      return grp;
    }
    if (h.kind === 'mesh') {
      const src = this.pickables.find((m) => m.userData.body === h.body);
      if (!src) return null;
      const m = new THREE.Mesh(src.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1 }));
      m.userData.shared = true;
      return m;
    }
    return null;
  }
  refreshOverlay() {
    const g = this.groups.overlay;
    g.children.slice().forEach((o) => {
      g.remove(o);
      o.traverse((c) => {
        if (c.geometry && !c.userData.shared) c.geometry.dispose();
        if (c.material) {
          this.lineMats.delete(c.material);
          c.material.dispose();
        }
      });
    });
    for (const s of this.selection) {
      const o = this.highlightObject(s, SELECT);
      if (o) g.add(o);
    }
    if (this.hover && !this.selection.some((s) => this.hitKey(s) === this.hitKey(this.hover))) {
      const o = this.highlightObject(this.hover, HOVER);
      if (o) g.add(o);
    }
    if (g.children.length && this.animate) this.startFx();
    this.refreshPlaneVisibility();
  }
  setSelection(list) {
    this.selection = list;
    this.refreshOverlay();
  }
  setHover(h) {
    if (this.hitKey(h) === this.hitKey(this.hover)) return;
    this.hover = h;
    this.refreshOverlay();
  }

  // ------------------------------------------------------------ input
  _bind() {
    const c = this.canvas;
    const ptrs = new Map();
    let drag = null, moved = false, pinch = null, downAt = null;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, e);
      moved = false;
      downAt = [e.clientX, e.clientY];
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
        drag = null;
        if (this.tool && this.tool.cancelStroke) this.tool.cancelStroke();
        return;
      }
      const touch = e.pointerType === 'touch';
      const nav = e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey);
      if (nav) {
        drag = { mode: e.button === 2 || e.ctrlKey ? 'pan' : e.shiftKey ? 'zoom' : 'rotate', x: e.clientX, y: e.clientY, btn: e.button };
        return;
      }
      if (this.tool && this.tool.down) {
        const used = this.tool.down(e, this);
        if (used !== false) {
          drag = { mode: 'tool' };
          return;
        }
      }
      drag = { mode: touch || !this.pick(e) ? 'rotate' : 'maybe', x: e.clientX, y: e.clientY, btn: 0 };
    });
    c.addEventListener('pointermove', (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, e);
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
        this.pan(cx - pinch.cx, cy - pinch.cy);
        this.zoomAt(pinch.d / Math.max(1, d), { clientX: cx, clientY: cy });
        pinch = { d, cx, cy };
        moved = true;
        return;
      }
      if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) moved = true;
      if (drag && drag.mode === 'tool') {
        if (this.tool && this.tool.move) this.tool.move(e, this);
        return;
      }
      if (drag && drag.mode !== 'maybe') {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.mode === 'rotate') this.rotate(dx, dy);
        else if (drag.mode === 'pan') this.pan(dx, dy);
        else this.zoomAt(Math.exp(dy * 0.01), e);
        return;
      }
      if (drag && drag.mode === 'maybe' && moved) {
        drag.mode = 'rotate';
        return;
      }
      if (this.tool && this.tool.move) {
        this.tool.move(e, this);
        if (this.tool.noHover) return;
      }
      if (e.pointerType !== 'touch') {
        // ray-casting is the expensive part of hovering: do it at most once per rendered frame
        this._hoverEv = e;
        if (!this._hoverRaf) {
          this._hoverRaf = requestAnimationFrame(() => {
            this._hoverRaf = 0;
            const ev = this._hoverEv;
            if (!ev || this.tool && this.tool.noHover) return;
            const h = this.pick(ev);
            this.setHover(h);
            if (this.onHover) this.onHover(h, ev);
          });
        }
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.mode === 'tool') {
        if (this.tool && this.tool.up) this.tool.up(e, this);
        return;
      }
      if (!moved) {
        if (d.btn === 2) {
          if (this.onContext) this.onContext(this.pick(e), e);
        } else if (d.btn === 0) {
          if (this.tool && this.tool.click) {
            if (this.tool.click(e, this) !== false) return;
          }
          const h = this.pick(e);
          if (this.onPick) this.onPick(h, e);
        }
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => {
      if (this.tool && this.tool.dbl) this.tool.dbl(e, this);
      else if (this.onDbl) this.onDbl(this.pick(e), e);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(Math.exp(Math.sign(e.deltaY) * Math.min(0.35, Math.abs(e.deltaY) * 0.0015)), e);
    }, { passive: false });
  }
  rotate(dx, dy) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-dy * 0.008, -dx * 0.008, 0, 'XYZ'));
    this.quat.multiply(q).normalize();
    this.qGoal = null;
    this.turntable = false; // grabbing the model stops the turntable
    this.updateCamera();
  }
  pan(dx, dy) {
    const px = this.pxSize();
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat), u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.target.addScaledVector(r, -dx * px).addScaledVector(u, dy * px);
    this.updateCamera();
  }
  zoomAt(f, e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2, my = e.clientY - rect.top - rect.height / 2;
    const px0 = this.pxSize();
    this.halfH = Math.min(1e6, Math.max(1e-3, this.halfH * f));
    const px1 = this.pxSize();
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat), u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    this.target.addScaledVector(r, mx * (px0 - px1)).addScaledVector(u, -my * (px0 - px1));
    this.updateCamera();
  }

  // ------------------------------------------------------------ render
  _buildTriad() {
    this.triadScene = new THREE.Scene();
    this.triadCam = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
    const ax = (dir, color) => {
      const g = new THREE.Group();
      const m = new THREE.MeshBasicMaterial({ color });
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.8, 10), m);
      cyl.position.y = 0.4;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 14), m);
      cone.position.y = 0.95;
      g.add(cyl, cone);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir));
      return g;
    };
    this.triadScene.add(ax([1, 0, 0], 0xd0312d), ax([0, 1, 0], 0x2e9e3a), ax([0, 0, 1], 0x2a62d4));
  }
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderNow();
    });
  }
  renderNow() {
    const r = this.renderer;
    r.setViewport(0, 0, this.w, this.h);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    if (!this.hideTriad) {
      r.clearDepth();
      r.setScissorTest(true);
      r.setScissor(4, 16, 84, 84);
      r.setViewport(4, 16, 84, 84);
      this.triadCam.position.set(0, 0, 4).applyQuaternion(this.quat);
      this.triadCam.quaternion.copy(this.quat);
      r.autoClear = false; // draw the triad over the scene instead of wiping its corner
      r.render(this.triadScene, this.triadCam);
      r.autoClear = true;
      r.setScissorTest(false);
    }
  }
  // PNG snapshot at a multiple of the current resolution
  snapshot(mult = 2, { transparent = false, background = '#ffffff' } = {}) {
    const pr = this.renderer.getPixelRatio();
    const helpers = [this.groups.planes, this.groups.overlay, this.groups.sketches, this.groups.active];
    const vis = helpers.map((g) => g.visible);
    helpers.forEach((g) => (g.visible = false));
    this.hideTriad = true;
    this.renderer.setPixelRatio(mult);
    for (const m of this.lineMats) m.resolution.set(this.w, this.h);
    if (!transparent) this.scene.background = new THREE.Color(background);
    this.renderNow();
    const url = this.canvas.toDataURL('image/png');
    this.scene.background = null;
    this.renderer.setPixelRatio(pr);
    helpers.forEach((g, i) => (g.visible = vis[i]));
    this.hideTriad = false;
    this.renderNow();
    return url;
  }
}

// box-projected UVs so textures work on any body (1 texture tile = 50 mm)
function boxUV(pos, nor, tile = 50) {
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const ax = Math.abs(nor[i]), ay = Math.abs(nor[i + 1]), az = Math.abs(nor[i + 2]);
    if (ax >= ay && ax >= az) {
      uv[j] = pos[i + 2] / tile;
      uv[j + 1] = pos[i + 1] / tile;
    } else if (ay >= az) {
      uv[j] = pos[i] / tile;
      uv[j + 1] = pos[i + 2] / tile;
    } else {
      uv[j] = pos[i] / tile;
      uv[j + 1] = pos[i + 1] / tile;
    }
  }
  return uv;
}

export { THREE, toWorld };
