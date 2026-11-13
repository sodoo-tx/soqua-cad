// Modeling commands: every feature's PropertyManager dialog, with live preview.
import { app, register, run, setSelection, syncHighlight, enterSketch, exitSketch, startSketchOn, buildRibbon, buildTree, hitToItem, resolveItem } from '../app.js';
import { openPM, closePM, pmActive, toast, setHint, el, modal, promptDlg, popup, esc } from '../ui/ui.js';
import { V, BASE_PLANES, fmt, toLocal } from '../geom.js';
import { SECTIONS } from './weldments.js';
import { flatPattern } from './sheetmetal.js';
import { emptySketch } from '../doc.js';
import * as K from '../kernel.js';

const END = [['blind', 'Blind'], ['mid', 'Mid Plane'], ['through', 'Through All'], ['throughBoth', 'Through All - Both'], ['twoDir', 'Two Directions']];
const sketchItem = (id) => {
  const f = app.doc.get(id);
  return f ? { kind: 'sketch', key: 's' + id, label: f.name, id, hit: { kind: 'feature', id } } : null;
};
const featItem = (id) => {
  const f = app.doc.get(id);
  return f ? { kind: 'feature', key: 's' + id, label: f.name, id, hit: { kind: 'feature', id } } : null;
};
const sigItems = (kind, sigs) => (sigs || []).map((sig, i) => resolveItem({ kind, key: kind + i + JSON.stringify(sig.m || sig.c), label: (kind === 'face' ? 'Face' : 'Edge') + `<${i + 1}>`, sig, bodyId: 'solid', hit: { body: app.vp.bodies.find((b) => b.id === 'solid') } }));
const planeItem = (spec) => {
  if (!spec) return [];
  if (spec.type === 'base') return [{ kind: 'plane', key: 'p' + spec.name + ' Plane', label: spec.name + ' Plane', planeSpec: spec, plane: BASE_PLANES[spec.name] }];
  if (spec.type === 'feature') {
    const f = app.doc.get(spec.id);
    return f ? [{ kind: 'plane', key: 's' + spec.id, label: f.name, planeSpec: spec, plane: app.doc.state.planes[spec.id] }] : [];
  }
  return [{ kind: 'face', key: 'facePlane', label: 'Face', planeSpec: spec, plane: spec.plane }];
};
const ids = (list) => (list || []).map((i) => i.id).filter(Boolean);
const sel = (kind) => app.selection.filter((i) => i.kind === kind);
const selPlane = () => app.selection.find((i) => i.planeSpec);
// most recent sketch that no feature uses yet
function freeSketch(types = ['sketch']) {
  const used = new Set();
  for (const f of app.doc.features) for (const k of ['sketch', 'profile', 'path']) if (f.params && typeof f.params[k] === 'string') used.add(f.params[k]);
  const list = app.doc.features.filter((f) => types.includes(f.type) && !used.has(f.id) && !f.rolledBack);
  return list.length ? list[list.length - 1].id : null;
}
function initialSketch(types) {
  const s = app.selection.find((i) => i.kind === 'sketch' && (!types || types.includes(i.featureType)));
  if (s) return [sketchItem(s.id)];
  const id = freeSketch(types);
  return id ? [sketchItem(id)] : [];
}
const SK = (key = 'sketch', label = 'Sketch', group = 'From') => ({ key, label, group, type: 'sel', accept: ['sketch'], multi: false, placeholder: 'Select a sketch (graphics area or tree)' });

// ---------------------------------------------------------------- dialog definitions
const D = {};

function extrudeDef(op, surface = false) {
  return {
    title: surface ? 'Surface-Extrude' : op === 'cut' ? 'Cut-Extrude' : 'Boss-Extrude', icon: surface ? 'surfExtrude' : op === 'cut' ? 'cut' : 'extrude',
    fields: [
      SK(),
      { key: 'end', label: 'End condition', group: 'Direction 1', type: 'select', options: END },
      { key: 'depth', label: 'Depth (mm)', group: 'Direction 1', type: 'number', min: 0, show: (v) => !['through', 'throughBoth'].includes(v.end) },
      { key: 'depth2', label: 'Depth 2 (mm)', group: 'Direction 1', type: 'number', min: 0, show: (v) => v.end === 'twoDir' },
      { key: 'flip', label: 'Reverse direction', group: 'Direction 1', type: 'check' },
      !surface && { key: 'draft', label: 'Draft (°)', group: 'Options', type: 'number' },
      !surface && { key: 'thin', label: 'Thin wall (mm)', group: 'Options', type: 'number', min: 0 },
    ].filter(Boolean),
    init: () => ({ sketch: initialSketch(['sketch']), end: op === 'cut' ? 'through' : 'blind', depth: 10, depth2: 10, flip: false, draft: 0, thin: 0 }),
    fromParams: (p) => ({ sketch: [sketchItem(p.sketch)].filter(Boolean), end: p.end || 'blind', depth: p.depth ?? 10, depth2: p.depth2 ?? 10, flip: !!p.flip, draft: p.draft || 0, thin: p.thin || 0 }),
    toParams: (v) => (v.sketch.length ? { sketch: v.sketch[0].id, op, end: v.end, depth: v.depth, depth2: v.depth2, flip: v.flip, draft: v.draft, thin: v.thin } : null),
    message: 'Select a sketch with a closed profile. Open profiles can be extruded as a thin wall.',
  };
}
D.extrude = extrudeDef('add');
D.surfExtrude = { ...extrudeDef('add', true), message: 'Open or closed sketch contours are extruded into a surface body.' };

function revolveDef(op, surface = false) {
  return {
    title: surface ? 'Surface-Revolve' : op === 'cut' ? 'Cut-Revolve' : 'Revolve', icon: surface ? 'surfRevolve' : op === 'cut' ? 'revolvecut' : 'revolve',
    fields: [SK(), { key: 'angle', label: 'Angle (°)', group: 'Direction 1', type: 'number', min: 0, max: 360 }],
    init: () => ({ sketch: initialSketch(['sketch']), angle: 360 }),
    fromParams: (p) => ({ sketch: [sketchItem(p.sketch)].filter(Boolean), angle: p.angle ?? 360 }),
    toParams: (v) => (v.sketch.length ? { sketch: v.sketch[0].id, op, angle: v.angle } : null),
    message: 'The sketch is revolved about its centerline (a construction line in the sketch).',
  };
}
D.revolve = revolveDef('add');
D.surfRevolve = revolveDef('add', true);

function sweepDef(op, surface = false) {
  return {
    title: surface ? 'Surface-Sweep' : op === 'cut' ? 'Cut-Sweep' : 'Sweep', icon: surface ? 'surfSweep' : 'sweep',
    fields: [SK('profile', 'Profile', 'Profile and Path'), SK('path', 'Path', 'Profile and Path')],
    init: () => {
      const s = sel('sketch');
      return { profile: s[0] ? [sketchItem(s[0].id)] : [], path: s[1] ? [sketchItem(s[1].id)] : [] };
    },
    fromParams: (p) => ({ profile: [sketchItem(p.profile)].filter(Boolean), path: [sketchItem(p.path)].filter(Boolean) }),
    toParams: (v) => (v.profile.length && v.path.length ? { profile: v.profile[0].id, path: v.path[0].id, op } : null),
    message: 'Pick a closed profile sketch and a path sketch (2D or 3D). The profile plane should be perpendicular to the start of the path.',
  };
}
D.sweep = sweepDef('add');
D.surfSweep = sweepDef('add', true);

function loftDef(op, surface = false) {
  return {
    title: surface ? 'Surface-Loft' : op === 'cut' ? 'Cut-Loft' : 'Loft', icon: surface ? 'surfLoft' : 'loft',
    fields: [{ ...SK('profiles', 'Profiles', 'Profiles'), multi: true, placeholder: 'Select two or more profile sketches in order' }, { key: 'ruled', label: 'Straight (ruled) sections', group: 'Options', type: 'check' }],
    init: () => ({ profiles: sel('sketch').map((s) => sketchItem(s.id)), ruled: false }),
    fromParams: (p) => ({ profiles: (p.profiles || []).map(sketchItem).filter(Boolean), ruled: !!p.ruled }),
    toParams: (v) => (v.profiles.length >= 2 ? { profiles: ids(v.profiles), op, ruled: v.ruled } : null),
    message: 'Select profile sketches on different planes, in order.',
  };
}
D.loft = loftDef('add');
D.surfLoft = loftDef('add', true);

D.surfPlanar = {
  title: 'Surface-Plane', icon: 'surfPlanar', fields: [SK()], init: () => ({ sketch: initialSketch(['sketch']) }),
  fromParams: (p) => ({ sketch: [sketchItem(p.sketch)].filter(Boolean) }), toParams: (v) => (v.sketch.length ? { sketch: v.sketch[0].id } : null),
};

D.fillet = {
  title: 'Fillet', icon: 'fillet',
  fields: [{ key: 'edges', label: 'Edges', group: 'Items To Fillet', type: 'sel', accept: ['edge'], placeholder: 'Select edges' }, { key: 'radius', label: 'Radius (mm)', group: 'Fillet Parameters', type: 'number', min: 0 }],
  init: () => ({ edges: sel('edge'), radius: 5 }),
  fromParams: (p) => ({ edges: sigItems('edge', p.edges), radius: p.radius }),
  toParams: (v) => (v.edges.length && v.radius > 0 ? { edges: v.edges.map((e) => e.sig), radius: v.radius } : null),
};
D.chamfer = {
  title: 'Chamfer', icon: 'chamfer',
  fields: [{ key: 'edges', label: 'Edges', group: 'Items To Chamfer', type: 'sel', accept: ['edge'], placeholder: 'Select edges' }, { key: 'distance', label: 'Distance (mm)', group: 'Chamfer Parameters', type: 'number', min: 0 }],
  init: () => ({ edges: sel('edge'), distance: 2 }),
  fromParams: (p) => ({ edges: sigItems('edge', p.edges), distance: p.distance }),
  toParams: (v) => (v.edges.length && v.distance > 0 ? { edges: v.edges.map((e) => e.sig), distance: v.distance } : null),
};
D.shell = {
  title: 'Shell', icon: 'shell',
  fields: [{ key: 'faces', label: 'Faces to remove', group: 'Parameters', type: 'sel', accept: ['face'], placeholder: 'Select faces to open' }, { key: 'thickness', label: 'Thickness (mm)', group: 'Parameters', type: 'number', min: 0 }],
  init: () => ({ faces: sel('face'), thickness: 2 }),
  fromParams: (p) => ({ faces: sigItems('face', p.faces), thickness: p.thickness }),
  toParams: (v) => (v.faces.length && v.thickness > 0 ? { faces: v.faces.map((e) => e.sig), thickness: v.thickness } : null),
};
D.draft = {
  title: 'Draft', icon: 'draft',
  fields: [
    { key: 'plane', label: 'Neutral plane', group: 'Neutral Plane', type: 'sel', accept: ['plane', 'face'], multi: false },
    { key: 'faces', label: 'Faces to draft', group: 'Faces', type: 'sel', accept: ['face'] },
    { key: 'angle', label: 'Draft angle (°)', group: 'Faces', type: 'number' },
  ],
  init: () => ({ plane: [], faces: [], angle: 3 }),
  fromParams: (p) => ({ plane: planeItem(p.plane), faces: sigItems('face', p.faces), angle: p.angle }),
  toParams: (v) => (v.plane.length && v.plane[0].planeSpec && v.faces.length ? { plane: v.plane[0].planeSpec, faces: v.faces.map((e) => e.sig), angle: v.angle } : null),
};
D.surfOffset = {
  title: 'Surface-Offset', icon: 'surfOffset',
  fields: [{ key: 'faces', label: 'Faces', group: 'Offset Parameters', type: 'sel', accept: ['face'] }, { key: 'distance', label: 'Distance (mm)', group: 'Offset Parameters', type: 'number' }],
  init: () => ({ faces: sel('face'), distance: 2 }),
  fromParams: (p) => ({ faces: sigItems('face', p.faces), distance: p.distance }),
  toParams: (v) => (v.faces.length ? { faces: v.faces.map((e) => e.sig), distance: v.distance } : null),
};

const dirOf = (it) => {
  if (!it) return null;
  if (it.kind === 'edge' && it.info.dir) return it.info.dir;
  if (it.kind === 'edge' && it.info.axis) return it.info.axis;
  if (it.plane) return it.plane.n;
  if (it.kind === 'face') return it.info.normal;
  return null;
};
const FEATS = { key: 'features', label: 'Features', group: 'Features to Pattern', type: 'sel', accept: ['feature'], autoFocus: false, placeholder: 'Pick features in the tree (empty = whole body)' };
D.linearPattern = {
  title: 'Linear Pattern', icon: 'lpattern',
  fields: [
    { key: 'dirSel', label: 'Direction', group: 'Direction 1', type: 'sel', accept: ['edge', 'face', 'plane'], multi: false, placeholder: 'Edge / face (or use the axis below)' },
    { key: 'axis', label: 'Axis', group: 'Direction 1', type: 'select', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['-x', '-X'], ['-y', '-Y'], ['-z', '-Z']], show: (v) => !v.dirSel.length },
    { key: 'spacing', label: 'Spacing (mm)', group: 'Direction 1', type: 'number' }, { key: 'count', label: 'Instances', group: 'Direction 1', type: 'number', min: 1, step: 1 },
    { key: 'axis2', label: 'Axis', group: 'Direction 2', type: 'select', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['-x', '-X'], ['-y', '-Y'], ['-z', '-Z']] },
    { key: 'spacing2', label: 'Spacing (mm)', group: 'Direction 2', type: 'number' }, { key: 'count2', label: 'Instances', group: 'Direction 2', type: 'number', min: 1, step: 1 },
    FEATS,
  ],
  init: () => ({ dirSel: sel('edge').slice(0, 1), axis: 'x', spacing: 20, count: 3, axis2: 'y', spacing2: 20, count2: 1, features: app.selection.filter((i) => i.kind === 'feature').map((i) => featItem(i.id)) }),
  fromParams: (p) => ({ dirSel: [], axis: axisName(p.dir), spacing: p.spacing, count: p.count, axis2: axisName(p.dir2), spacing2: p.spacing2 || 20, count2: p.count2 || 1, features: (p.features || []).map(featItem).filter(Boolean), keepDir: p.dir }),
  toParams: (v) => ({ dir: dirOf(v.dirSel[0]) || (v.keepDir && axisName(v.keepDir) === v.axis ? v.keepDir : axisVec(v.axis)), spacing: v.spacing, count: Math.round(v.count), dir2: axisVec(v.axis2), spacing2: v.spacing2, count2: Math.round(v.count2), features: ids(v.features) }),
};
const axisVec = (a) => ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] }[a] || [1, 0, 0]);
const axisName = (d) => {
  if (!d) return 'x';
  for (const n of ['x', 'y', 'z', '-x', '-y', '-z']) if (V.dist(axisVec(n), d) < 1e-6) return n;
  return 'x';
};
D.circularPattern = {
  title: 'Circular Pattern', icon: 'cpattern',
  fields: [
    { key: 'axisSel', label: 'Pattern axis', group: 'Parameters', type: 'sel', accept: ['edge'], multi: false, placeholder: 'Circular edge or straight edge (or use the axis below)' },
    { key: 'axis', label: 'Axis through origin', group: 'Parameters', type: 'select', options: [['z', 'Z'], ['x', 'X'], ['y', 'Y']], show: (v) => !v.axisSel.length },
    { key: 'angle', label: 'Total angle (°)', group: 'Parameters', type: 'number' }, { key: 'count', label: 'Instances', group: 'Parameters', type: 'number', min: 1, step: 1 },
    FEATS,
  ],
  init: () => ({ axisSel: sel('edge').slice(0, 1), axis: 'z', angle: 360, count: 6, features: app.selection.filter((i) => i.kind === 'feature').map((i) => featItem(i.id)) }),
  fromParams: (p) => ({ axisSel: [], axis: axisName(p.axisD), angle: p.angle, count: p.count, features: (p.features || []).map(featItem).filter(Boolean), keep: { o: p.axisO, d: p.axisD } }),
  toParams: (v) => {
    const e = v.axisSel[0];
    let o = [0, 0, 0], d = axisVec(v.axis);
    if (e && e.info.axis) (o = e.info.center), (d = e.info.axis);
    else if (e && e.info.dir) (o = e.info.a), (d = e.info.dir);
    else if (v.keep && axisName(v.keep.d) === v.axis && v.keep.o) (o = v.keep.o), (d = v.keep.d);
    return { axisO: o, axisD: d, angle: v.angle, count: Math.round(v.count), features: ids(v.features) };
  },
};
D.mirror = {
  title: 'Mirror', icon: 'mirror3d',
  fields: [{ key: 'plane', label: 'Mirror face/plane', group: 'Mirror Face/Plane', type: 'sel', accept: ['plane', 'face'], multi: false }, { ...FEATS, group: 'Features to Mirror' }],
  init: () => ({ plane: selPlane() ? [selPlane()] : [], features: app.selection.filter((i) => i.kind === 'feature').map((i) => featItem(i.id)) }),
  fromParams: (p) => ({ plane: planeItem(p.plane), features: (p.features || []).map(featItem).filter(Boolean) }),
  toParams: (v) => (v.plane.length && v.plane[0].planeSpec ? { plane: v.plane[0].planeSpec, features: ids(v.features) } : null),
  message: 'Select a plane or flat face. Leave the feature list empty to mirror the whole body.',
};
D.plane = {
  title: 'Plane', icon: 'plane',
  fields: [
    { key: 'base', label: 'First reference', group: 'References', type: 'sel', accept: ['plane', 'face'], multi: false },
    { key: 'offset', label: 'Offset (mm)', group: 'References', type: 'number' },
    { key: 'angle', label: 'Angle (°)', group: 'References', type: 'number' },
    { key: 'about', label: 'Rotate about', group: 'References', type: 'select', options: [['x', 'Plane X axis'], ['y', 'Plane Y axis']], show: (v) => !!v.angle },
    { key: 'flip', label: 'Flip normal', group: 'References', type: 'check' },
  ],
  init: () => ({ base: selPlane() ? [selPlane()] : [], offset: 20, angle: 0, about: 'x', flip: false }),
  fromParams: (p) => ({ base: planeItem(p.base), offset: p.offset || 0, angle: p.angle || 0, about: p.about || 'x', flip: !!p.flip }),
  toParams: (v) => (v.base.length && v.base[0].planeSpec ? { base: v.base[0].planeSpec, offset: v.offset, angle: v.angle, about: v.about, flip: v.flip } : null),
};
D.scale = {
  title: 'Scale', icon: 'scale', fields: [{ key: 'factor', label: 'Scale factor', group: 'Scale Parameters', type: 'number', min: 0 }],
  init: () => ({ factor: 2 }), fromParams: (p) => ({ factor: p.factor }), toParams: (v) => (v.factor > 0 ? { factor: v.factor, center: [0, 0, 0] } : null),
};
D.moveBody = {
  title: 'Move/Copy Body', icon: 'move',
  fields: [
    { key: 'translate', label: 'Translate ΔX ΔY ΔZ', group: 'Translate', type: 'vec', wide: true },
    { key: 'axis', label: 'Rotation axis', group: 'Rotate', type: 'select', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']] }, { key: 'angle', label: 'Angle (°)', group: 'Rotate', type: 'number' },
    { key: 'copy', label: 'Copy (keep the original and merge)', group: 'Options', type: 'check' },
  ],
  init: () => ({ translate: [0, 0, 0], axis: 'z', angle: 0, copy: false }),
  fromParams: (p) => ({ translate: [...(p.translate || [0, 0, 0])], axis: axisName(p.axis), angle: p.angle || 0, copy: !!p.copy }),
  toParams: (v) => ({ translate: [...v.translate], axis: axisVec(v.axis), angle: v.angle, copy: v.copy }),
};
D.primitive = {
  title: 'Primitive', icon: 'primitive',
  fields: [
    { key: 'kind', label: 'Shape', group: 'Shape', type: 'select', options: [['box', 'Box'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere']] },
    { key: 'x', label: 'Size X (mm)', group: 'Shape', type: 'number', show: (v) => v.kind === 'box' }, { key: 'y', label: 'Size Y (mm)', group: 'Shape', type: 'number', show: (v) => v.kind === 'box' }, { key: 'z', label: 'Size Z (mm)', group: 'Shape', type: 'number', show: (v) => v.kind === 'box' },
    { key: 'r', label: 'Radius (mm)', group: 'Shape', type: 'number', show: (v) => v.kind !== 'box' }, { key: 'h', label: 'Height (mm)', group: 'Shape', type: 'number', show: (v) => v.kind === 'cylinder' },
    { key: 'origin', label: 'Position X Y Z', group: 'Position', type: 'vec', wide: true },
    { key: 'op', label: 'Operation', group: 'Position', type: 'select', options: [['add', 'Add (merge)'], ['cut', 'Cut'], ['intersect', 'Intersect']] },
  ],
  init: () => ({ kind: 'box', x: 100, y: 50, z: 60, r: 25, h: 60, origin: [0, 0, 0], op: 'add' }),
  fromParams: (p) => ({ kind: p.kind, x: p.x ?? 100, y: p.y ?? 50, z: p.z ?? 60, r: p.r ?? 25, h: p.h ?? 60, origin: [...(p.origin || [0, 0, 0])], op: p.op || 'add' }),
  toParams: (v) => ({ kind: v.kind, x: v.x, y: v.y, z: v.z, r: v.r, h: v.h, origin: [...v.origin], op: v.op }),
};
D.thicken = {
  title: 'Thicken', icon: 'thicken',
  fields: [
    { key: 'surface', label: 'Surface body', group: 'Thicken Parameters', type: 'sel', accept: ['surface', 'face'], multi: false, placeholder: 'Select a surface body (tree or graphics)' },
    { key: 'thickness', label: 'Thickness (mm)', group: 'Thicken Parameters', type: 'number', min: 0 }, { key: 'flip', label: 'Thicken other side', group: 'Thicken Parameters', type: 'check' },
  ],
  init: () => ({ surface: surfaceFromSelection(), thickness: 2, flip: false }),
  fromParams: (p) => ({ surface: [{ kind: 'surface', key: 'b' + p.surface, label: 'Surface', id: p.surface }], thickness: p.thickness, flip: !!p.flip }),
  toParams: (v) => {
    const s = v.surface[0];
    const id = s && (s.kind === 'surface' ? s.id : s.bodyKind === 'surface' ? s.bodyId : null);
    return id && v.thickness > 0 ? { surface: id, thickness: v.thickness, flip: v.flip, op: 'add' } : null;
  },
};
function surfaceFromSelection() {
  const s = app.selection.find((i) => i.kind === 'surface' || i.bodyKind === 'surface');
  if (s) return [s];
  const st = app.doc.state.surfaces;
  return st.length === 1 ? [{ kind: 'surface', key: 'b' + st[0].id, label: st[0].name, id: st[0].id }] : [];
}
D.knit = {
  title: 'Surface-Knit', icon: 'knit',
  fields: [
    { key: 'surfaces', label: 'Surfaces', group: 'Selections', type: 'sel', accept: ['surface', 'face'], placeholder: 'Select surface bodies' },
    { key: 'solid', label: 'Create solid if closed', group: 'Selections', type: 'check' }, { key: 'tolerance', label: 'Gap tolerance (mm)', group: 'Selections', type: 'number', min: 0 },
  ],
  init: () => ({ surfaces: app.doc.state.surfaces.map((s) => ({ kind: 'surface', key: 'b' + s.id, label: s.name, id: s.id })), solid: true, tolerance: 0.01 }),
  fromParams: (p) => ({ surfaces: (p.surfaces || []).map((id) => ({ kind: 'surface', key: 'b' + id, label: 'Surface', id })), solid: !!p.solid, tolerance: p.tolerance }),
  toParams: (v) => {
    const list = [...new Set(v.surfaces.map((s) => (s.kind === 'surface' ? s.id : s.bodyKind === 'surface' ? s.bodyId : null)).filter(Boolean))];
    return list.length >= 2 ? { surfaces: list, solid: v.solid, tolerance: v.tolerance } : null;
  },
};
D.baseFlange = {
  title: 'Base Flange', icon: 'baseFlange',
  fields: [
    SK(), { key: 'thickness', label: 'Thickness (mm)', group: 'Sheet Metal Parameters', type: 'number', min: 0 }, { key: 'radius', label: 'Bend radius (mm)', group: 'Sheet Metal Parameters', type: 'number', min: 0 },
    { key: 'kFactor', label: 'K-Factor', group: 'Bend Allowance', type: 'number', min: 0, max: 1 }, { key: 'depth', label: 'Depth (open profile)', group: 'Sheet Metal Parameters', type: 'number', min: 0 }, { key: 'flip', label: 'Reverse direction', group: 'Sheet Metal Parameters', type: 'check' },
  ],
  init: () => ({ sketch: initialSketch(['sketch']), thickness: 2, radius: 2, kFactor: 0.44, depth: 50, flip: false }),
  fromParams: (p) => ({ sketch: [sketchItem(p.sketch)].filter(Boolean), thickness: p.thickness, radius: p.radius, kFactor: p.kFactor, depth: p.depth ?? 50, flip: !!p.flip }),
  toParams: (v) => (v.sketch.length && v.thickness > 0 ? { sketch: v.sketch[0].id, thickness: v.thickness, radius: v.radius, kFactor: v.kFactor, depth: v.depth, flip: v.flip } : null),
  message: 'A closed sketch becomes a flat plate; an open sketch is extruded with the sheet thickness.',
};
D.edgeFlange = {
  title: 'Edge Flange', icon: 'edgeFlange',
  fields: [
    { key: 'edge', label: 'Edge', group: 'Flange Parameters', type: 'sel', accept: ['edge'], multi: false, placeholder: 'Select a straight outer edge of the sheet' },
    { key: 'length', label: 'Flange length (mm)', group: 'Flange Length', type: 'number', min: 0 }, { key: 'angle', label: 'Angle (°)', group: 'Angle', type: 'number', min: 1, max: 179 },
  ],
  init: () => ({ edge: sel('edge').slice(0, 1), length: 25, angle: 90 }),
  fromParams: (p) => ({ edge: sigItems('edge', [p.edge]), length: p.length, angle: p.angle }),
  toParams: (v) => (v.edge.length ? { edge: v.edge[0].sig, length: v.length, angle: v.angle } : null),
  message: 'Pick the edge on the side the flange should rise towards (the top edge to bend up, the bottom edge to bend down).',
};
D.structuralMember = {
  title: 'Structural Member', icon: 'member',
  fields: [
    { ...SK('sketch', 'Path sketch', 'Path'), placeholder: 'Select a 2D or 3D sketch made of lines' },
    { key: 'ptype', label: 'Type', group: 'Selections', type: 'select', options: Object.keys(SECTIONS) },
    { key: 'w', label: 'Width / Ø (mm)', group: 'Selections', type: 'number', min: 0 },
    { key: 'h', label: 'Height (mm)', group: 'Selections', type: 'number', min: 0, show: (v) => SECTIONS[v.ptype].fields.includes('h') },
    { key: 't', label: 'Wall (mm)', group: 'Selections', type: 'number', min: 0, show: (v) => SECTIONS[v.ptype].fields.includes('t') },
    { key: 'miter', label: 'Mitre corners where two members meet', group: 'Settings', type: 'check' },
  ],
  init: () => ({ sketch: initialSketch(['sketch', 'sketch3d']), ptype: 'Square tube', w: 40, h: 40, t: 3, miter: true }),
  fromParams: (p) => ({ sketch: [sketchItem(p.sketch)].filter(Boolean), ptype: p.profile.type, w: p.profile.w, h: p.profile.h ?? p.profile.w, t: p.profile.t ?? 3, miter: p.miter !== false }),
  toParams: (v) => {
    if (!v.sketch.length) return null;
    const f = SECTIONS[v.ptype].fields;
    const profile = { type: v.ptype, w: v.w };
    if (f.includes('h')) profile.h = v.h;
    if (f.includes('t')) profile.t = v.t;
    return { sketch: v.sketch[0].id, profile, miter: v.miter };
  },
  onChange: (v, key, pm) => {
    if (key === 'ptype') {
      Object.assign(v, SECTIONS[v.ptype].def);
      pm.refresh();
    }
  },
};
D.deleteBody = {
  title: 'Delete Body', icon: 'deleteBody',
  fields: [{ key: 'body', label: 'Body', group: 'Bodies to Delete', type: 'select', options: [] }],
  init: () => ({ body: 'solid' }), fromParams: (p) => ({ body: p.body }), toParams: (v) => ({ body: v.body }),
  prepare: (def) => {
    const st = app.doc.state;
    def.fields[0].options = [...(st.solid ? [['solid', 'Solid body']] : []), ...st.surfaces.map((s) => [s.id, s.name]), ...st.meshes.map((s) => [s.id, s.name])];
  },
};

// ---- helix / thread / cut with plane
const AX = [['z', 'Z'], ['x', 'X'], ['y', 'Y'], ['-z', '-Z'], ['-x', '-X'], ['-y', '-Y']];
const circEdge = () => sel('edge').filter((e) => e.info && e.info.radius).slice(0, 1);
const axisOpt = (d) => (['x', 'y', 'z', '-x', '-y', '-z'].find((n) => V.dist(axisVec(n), V.norm(d)) < 1e-6) || 'custom');
D.helix = {
  title: 'Helix/Spiral', icon: 'helix',
  message: 'Creates a helical path for Swept Boss/Cut (springs, threads, coils). Pick a circular edge to wrap around it, or type the axis and radius. The helix starts on the +X side of the axis: sketch the sweep profile there.',
  fields: [
    { key: 'edge', label: 'Circular edge', group: 'Defined By', type: 'sel', accept: ['edge'], multi: false, autoFocus: false, placeholder: 'Optional: circular edge to wrap around' },
    { key: 'axis', label: 'Axis', group: 'Defined By', type: 'select', options: [...AX, ['custom', 'As picked']], show: (v) => !v.edge.length },
    { key: 'origin', label: 'Start X Y Z', group: 'Defined By', type: 'vec', wide: true, show: (v) => !v.edge.length },
    { key: 'radius', label: 'Radius (mm)', group: 'Parameters', type: 'number', min: 0, show: (v) => !v.edge.length },
    { key: 'pitch', label: 'Pitch (mm)', group: 'Parameters', type: 'number', min: 0 },
    { key: 'height', label: 'Height (mm)', group: 'Parameters', type: 'number', min: 0 },
    { key: 'reverse', label: 'Reverse direction', group: 'Parameters', type: 'check', show: (v) => !!v.edge.length },
    { key: 'lefthand', label: 'Counter-clockwise (left hand)', group: 'Parameters', type: 'check' },
  ],
  init: () => ({ edge: circEdge(), axis: 'z', origin: [0, 0, 0], radius: 10, pitch: 5, height: 30, reverse: false, lefthand: false }),
  fromParams: (p) => ({ edge: [], axis: axisOpt(p.axis), keepAxis: p.axis, origin: [...p.origin], radius: p.radius, pitch: p.pitch, height: p.height, reverse: false, lefthand: !!p.lefthand }),
  toParams: (v) => {
    const e = v.edge[0];
    if (e && !e.info.radius) return null;
    const axis = e ? (v.reverse ? V.neg(e.info.axis) : e.info.axis) : v.axis === 'custom' ? v.keepAxis || [0, 0, 1] : axisVec(v.axis);
    return { origin: e ? e.info.center : [...v.origin], axis, radius: e ? e.info.radius : v.radius, pitch: v.pitch, height: v.height, lefthand: v.lefthand };
  },
};
D.thread = {
  title: 'Thread', icon: 'thread',
  message: 'Cuts a real helical V-thread. Pick the circular edge where the thread starts (end of a shaft, or the mouth of a hole) and tick "Internal" for a hole.',
  fields: [
    { key: 'edge', label: 'Start edge', group: 'Thread Location', type: 'sel', accept: ['edge'], multi: false, placeholder: 'Circular edge of the shaft or hole' },
    { key: 'internal', label: 'Internal thread (in a hole)', group: 'Thread Location', type: 'check' },
    { key: 'reverse', label: 'Reverse direction', group: 'Thread Location', type: 'check' },
    { key: 'pitch', label: 'Pitch (mm)', group: 'Specification', type: 'number', min: 0 },
    { key: 'length', label: 'Thread length (mm)', group: 'Specification', type: 'number', min: 0 },
    { key: 'depth', label: 'Thread depth (mm)', group: 'Specification', type: 'number', min: 0 },
    { key: 'lefthand', label: 'Left-hand thread', group: 'Specification', type: 'check' },
  ],
  init: () => ({ edge: circEdge(), internal: false, reverse: false, pitch: 1.5, length: 15, depth: 0.9, lefthand: false }),
  fromParams: (p) => ({ edge: [], keep: { origin: p.origin, axis: p.axis, radius: p.radius }, internal: !!p.internal, reverse: false, pitch: p.pitch, length: p.length, depth: p.depth, lefthand: !!p.lefthand }),
  toParams: (v) => {
    const e = v.edge[0];
    let o, a, r;
    if (e && e.info.radius) (o = e.info.center), (a = e.info.axis), (r = e.info.radius);
    else if (v.keep) (o = v.keep.origin), (a = v.keep.axis), (r = v.keep.radius);
    else return null;
    // the thread must run into the material: aim the axis from the edge towards the body
    if (e && app.doc.state.solid) {
      const b = K.bbox(app.doc.state.solid);
      const mid = V.lerp(b.min, b.max, 0.5);
      if (V.dot(V.sub(mid, o), a) < 0) a = V.neg(a);
    }
    if (v.reverse) a = V.neg(a);
    return { origin: o, axis: a, radius: r, pitch: v.pitch, length: v.length, depth: v.depth, internal: v.internal, lefthand: v.lefthand };
  },
};
D.cutPlane = {
  title: 'Cut With Plane', icon: 'section',
  message: 'Removes everything on one side of a plane or flat face.',
  fields: [
    { key: 'plane', label: 'Cutting plane', group: 'Selections', type: 'sel', accept: ['plane', 'face'], multi: false },
    { key: 'offset', label: 'Offset (mm)', group: 'Selections', type: 'number' },
    { key: 'flip', label: 'Flip cut (remove the other side)', group: 'Selections', type: 'check' },
  ],
  init: () => ({ plane: selPlane() ? [selPlane()] : [], offset: 0, flip: false }),
  fromParams: (p) => ({ plane: planeItem(p.plane), offset: p.offset || 0, flip: !!p.flip }),
  toParams: (v) => (v.plane.length && v.plane[0].planeSpec ? { plane: v.plane[0].planeSpec, offset: v.offset, flip: v.flip } : null),
  onOpen: () => app.vp.setShowPlanes(true),
};

// 3D sketch: table of points joined into a polyline
D.sketch3d = {
  title: '3DSketch', icon: 'sketch3d', message: 'Type coordinates or click model vertices to add points. Consecutive points are joined by lines (use it for sweep paths and weldment frames).',
  fields: [
    { key: 'pick', label: 'Add from model', group: 'Points', type: 'sel', accept: ['vertex'], placeholder: 'Click vertices to append them' },
    { key: 'table', group: 'Points', type: 'custom', render: (pm) => pointsTable(pm) },
    { key: 'closed', label: 'Close the loop', group: 'Points', type: 'check' },
  ],
  init: () => ({ pick: [], pts: [[0, 0, 0], [0, 0, 100], [100, 0, 100]], closed: false }),
  fromParams: (p) => ({ pick: [], pts: p.pts.map((q) => [...q]), closed: p.lines.length === p.pts.length && p.pts.length > 2 }),
  toParams: (v) => {
    const pts = v.pts.filter((q) => q.every(Number.isFinite));
    if (pts.length < 2) return null;
    const lines = pts.slice(1).map((_, i) => [i, i + 1]);
    if (v.closed && pts.length > 2) lines.push([pts.length - 1, 0]);
    return { pts, lines };
  },
  onChange: (v, key, pm) => {
    if (key === 'pick' && v.pick.length) {
      for (const it of v.pick) v.pts.push([...it.point]);
      v.pick = [];
      pm.refresh();
    }
  },
};
function pointsTable(pm) {
  const v = pm.vals;
  const wrap = el('div');
  const tbl = el('table', { class: 'grid' }, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'X' }), el('th', { text: 'Y' }), el('th', { text: 'Z' }), el('th', {})));
  v.pts.forEach((p, i) => {
    const tr = el('tr', {}, el('td', { text: String(i + 1) }));
    p.forEach((c, k) => {
      const inp = el('input', { type: 'number', value: c, step: 'any' });
      inp.addEventListener('input', () => {
        const x = parseFloat(inp.value);
        if (Number.isFinite(x)) {
          p[k] = x;
          pm.spec.onChange(v, 'table', pm);
        }
      });
      tr.append(el('td', {}, inp));
    });
    tr.append(el('td', {}, el('button', { class: 'btn', text: '×', style: { minHeight: '20px', padding: '0 6px' }, onclick: () => {
      v.pts.splice(i, 1);
      pm.refresh();
      pm.spec.onChange(v, 'table', pm);
    } })));
    tbl.append(tr);
  });
  wrap.append(tbl, el('div', { class: 'btnrow' }, el('button', { class: 'btn', text: '+ Add point', onclick: () => {
    const last = v.pts[v.pts.length - 1] || [0, 0, 0];
    v.pts.push([last[0] + 50, last[1], last[2]]);
    pm.refresh();
    pm.spec.onChange(v, 'table', pm);
  } })));
  return wrap;
}

// ---------------------------------------------------------------- generic live-preview dialog
function openFeature(type, defKey, editId) {
  const def = { ...D[defKey || type] };
  if (!def.title) return toast('No dialog for ' + type, true);
  const doc = app.doc;
  if (def.prepare) def.prepare(def);
  if (def.onOpen) def.onOpen();
  const before = doc.snapshot();
  const undoLen = doc._undo.length;
  let fid = editId || null;
  let created = false;
  let timer = 0;
  const editing = !!editId;
  const vals = editing ? def.fromParams(doc.get(editId).params) : def.init();
  if (!editing) setSelection([]);
  const apply = (pm) => {
    const params = def.toParams(pm.vals);
    if (!params) {
      if (created) {
        doc.restore(before);
        doc._undo.length = undoLen;
        created = false;
        fid = null;
        doc.rebuild();
      }
      pm.setError('');
      return;
    }
    if (!fid) {
      const f = doc.addFeature(type, params);
      fid = f.id;
      created = true;
    } else {
      if (editing && doc._undo.length === undoLen) doc.checkpoint();
      doc.updateFeature(fid, params, { checkpoint: false });
    }
    const f = doc.get(fid);
    pm.setError(f && f.error ? f.error : '');
    syncHighlight();
  };
  const pm = openPM({
    title: editing ? doc.get(editId).name : def.title, icon: def.icon, message: def.message, fields: def.fields,
    onChange: (v, key, p) => {
      if (def.onChange) def.onChange(v, key, p);
      clearTimeout(timer);
      timer = setTimeout(() => pmActive() === p && apply(p), 160);
    },
    onOK: () => {
      clearTimeout(timer);
      const params = def.toParams(vals);
      if (!params) {
        if (created) {
          doc.restore(before);
          doc._undo.length = undoLen;
          doc.rebuild();
        }
        toast('Nothing was created: required selections are missing.', true);
        return;
      }
      if (!fid) doc.addFeature(type, params);
      else if (JSON.stringify(doc.get(fid).params) !== JSON.stringify(params)) doc.updateFeature(fid, params, { checkpoint: false });
      const f = doc.get(fid || doc.features[doc.features.length - 1].id);
      if (f && f.error) toast(`${f.name}: ${f.error}`, true);
      setSelection([]);
    },
    onClose: () => def.onOpen && app.vp.setShowPlanes(false),
    onCancel: () => {
      clearTimeout(timer);
      if (created || (editing && doc._undo.length !== undoLen)) {
        doc.restore(before);
        doc._undo.length = undoLen;
        doc.rebuild();
      }
      setSelection([]);
    },
  }, vals);
  apply(pm);
  return pm;
}

// commands that consume the sketch being edited: leave the sketch first
function fromSketch() {
  if (app.sketcher) {
    const id = exitSketch(true);
    if (id) setSelection([hitToItem({ kind: 'feature', id })]);
  }
}
const feat = (name, type, defKey) => register(name, () => {
  fromSketch();
  return openFeature(type, defKey);
});
D.extrudeCut = extrudeDef('cut');
D.revolveCut = revolveDef('cut');
D.sweepCut = sweepDef('cut');
D.loftCut = loftDef('cut');
feat('extrude', 'extrude');
feat('extrudeCut', 'extrude', 'extrudeCut');
feat('revolve', 'revolve');
feat('revolveCut', 'revolve', 'revolveCut');
feat('sweep', 'sweep');
feat('sweepCut', 'sweep', 'sweepCut');
feat('loft', 'loft');
feat('loftCut', 'loft', 'loftCut');
for (const t of ['fillet', 'chamfer', 'shell', 'draft', 'linearPattern', 'circularPattern', 'mirror', 'plane', 'scale', 'moveBody', 'primitive', 'surfExtrude', 'surfRevolve', 'surfSweep', 'surfLoft', 'surfPlanar', 'surfOffset', 'thicken', 'knit', 'baseFlange', 'edgeFlange', 'structuralMember', 'deleteBody', 'sketch3d', 'helix', 'thread', 'cutPlane']) feat(t, t);

const DEF_FOR = (f) => {
  const p = f.params;
  if (f.type === 'extrude' && p.op === 'cut') return 'extrudeCut';
  if (f.type === 'revolve' && p.op === 'cut') return 'revolveCut';
  if (f.type === 'sweep' && p.op === 'cut') return 'sweepCut';
  if (f.type === 'loft' && p.op === 'cut') return 'loftCut';
  return f.type;
};
register('editFeature', (id) => {
  const f = app.doc.get(id);
  if (!f) return;
  if (app.sketcher) exitSketch(true);
  if (f.type === 'sketch') return enterSketch(id);
  if (f.type === 'hole') return holeDialog(f);
  if (f.type === 'mesh' || f.type === 'import') return toast('Imported bodies have no parameters to edit. Use the Mesh / Features tools on them.');
  if (!D[DEF_FOR(f)]) return toast('This feature has no editable parameters.');
  openFeature(f.type, DEF_FOR(f), id);
});
register('deleteFeature', (id) => {
  if (app.sketcher) exitSketch(true);
  app.doc.removeFeature(id);
  setSelection([]);
});
register('deleteSel', () => {
  const f = app.selection.filter((i) => i.id && app.doc.get(i.id));
  if (!f.length) return;
  for (const i of f) app.doc.removeFeature(i.id);
  setSelection([]);
});
register('suppressSel', () => {
  for (const i of app.selection) {
    const f = i.id && app.doc.get(i.id);
    if (f) app.doc.setSuppressed(f.id, !f.suppressed);
  }
});
register('toggleSketchVisible', (id) => {
  const f = app.doc.get(id);
  const used = app.doc.features.some((g) => ['sketch', 'profile', 'path'].some((k) => g.params && g.params[k] === id));
  const cur = f.params.visible ?? !used;
  f.params.visible = !cur;
  app.vp.buildSketches(app.doc);
  app.vp.render();
  buildTree();
});
register('editSketchPlane', (id) => {
  const f = app.doc.get(id);
  openPM({
    title: 'Sketch Plane', icon: 'plane', message: 'Select the new plane or flat face for this sketch.',
    fields: [{ key: 'plane', label: 'Plane / face', type: 'sel', accept: ['plane', 'face'], multi: false }],
    onOK: (v) => {
      const it = v.plane[0];
      if (it && it.planeSpec) app.doc.updateFeature(id, { ...f.params, plane: it.planeSpec });
    },
    onClose: () => app.vp.setShowPlanes(false),
  }, { plane: [] });
  app.vp.setShowPlanes(true);
});

// ---------------------------------------------------------------- sketch commands
register('sketch', () => {
  if (app.sketcher) return;
  const s = selPlane();
  if (s) return startSketchOn(s.planeSpec);
  const picked = app.selection.find((i) => i.kind === 'sketch' && i.featureType === 'sketch');
  if (picked) return enterSketch(picked.id);
  app.vp.setShowPlanes(true);
  openPM({
    title: 'Edit Sketch', icon: 'sketch', noOK: true, message: 'Select a plane or a flat face on which to create the sketch.',
    fields: [{ key: 'plane', label: 'Sketch plane', type: 'sel', accept: ['plane', 'face'], multi: false, placeholder: 'Front / Top / Right plane, a reference plane or a flat face' }],
    onChange: (v) => {
      const it = v.plane[0];
      if (!it) return;
      if (!it.planeSpec) {
        v.plane = [];
        return toast('That face is not flat. Pick a flat face or a plane.', true);
      }
      closePM(false);
      startSketchOn(it.planeSpec);
    },
    onClose: () => app.vp.setShowPlanes(false),
  }, { plane: [] });
});
register('exitSketch', () => exitSketch(true));
register('skTool', (t) => {
  if (!app.sketcher) return;
  if (t === 'polygon') {
    promptDlg('Polygon', 'Number of sides:', String(app.sketcher.polygonSides || 6)).then((n) => {
      if (!n) return;
      app.sketcher.polygonSides = Math.max(3, parseInt(n) || 6);
      app.sketcher.setTool('polygon');
      buildRibbon();
    });
    return;
  }
  app.sketcher.setTool(t);
  buildRibbon();
});
register('skOffset', async () => {
  const d = parseFloat(await promptDlg('Offset Entities', 'Offset distance in mm (negative = other side):', '5'));
  if (Number.isFinite(d) && d) app.sketcher.offsetSelection(d);
});
register('skMirror', () => app.sketcher.mirrorSelection());
register('skConvert', () => {
  const sk = app.sketcher;
  const hits = app.selection.map((i) => i.hit).filter((h) => h && (h.kind === 'face' || h.kind === 'edge'));
  if (hits.length) {
    sk.convertEntities(hits);
    return setSelection([]);
  }
  toast('Click the model faces/edges to convert (Esc to stop).');
  setHint('Convert Entities: click model faces or edges to project them into the sketch. Press Esc when done.');
  const vp = app.vp;
  const saved = vp.tool;
  vp.tool = {
    noHover: false,
    click: (e) => {
      const h = vp.pick(e);
      if (h && (h.kind === 'face' || h.kind === 'edge')) sk.convertEntities([h]);
      return true;
    },
  };
  const done = (e) => {
    if (e.key !== 'Escape') return;
    window.removeEventListener('keydown', done, true);
    vp.tool = saved;
    vp.setHover(null);
    setHint('Ready');
  };
  window.addEventListener('keydown', done, true);
});
register('skLinear', async () => {
  const body = el('div', { class: 'pm-group', html: `<div class="fld"><label>Instances</label><input id="n" type="number" value="3" min="2"></div><div class="fld"><label>ΔX (mm)</label><input id="dx" type="number" value="20"></div><div class="fld"><label>ΔY (mm)</label><input id="dy" type="number" value="0"></div>` });
  const ok = await modal({ title: 'Linear Sketch Pattern', body, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }] });
  if (ok) app.sketcher.patternSelection({ kind: 'linear', count: +body.querySelector('#n').value, dx: +body.querySelector('#dx').value, dy: +body.querySelector('#dy').value });
});
register('skCircular', async () => {
  const body = el('div', { class: 'pm-group', html: `<div class="fld"><label>Instances</label><input id="n" type="number" value="6" min="2"></div><div class="fld"><label>Total angle (°)</label><input id="a" type="number" value="360"></div><p style="color:#5d6b7a">The pattern is centred on the sketch origin.</p>` });
  const ok = await modal({ title: 'Circular Sketch Pattern', body, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }] });
  if (ok) app.sketcher.patternSelection({ kind: 'circular', count: +body.querySelector('#n').value, angle: +body.querySelector('#a').value });
});
register('skRelation', () => {
  const sk = app.sketcher;
  const rel = sk.availableRelations();
  if (!rel.length) return toast('Select sketch entities or points first (Ctrl+click for several), then add a relation.');
  const names = { horizontal: 'Horizontal', vertical: 'Vertical', coincident: 'Coincident', parallel: 'Parallel', perpendicular: 'Perpendicular', equal: 'Equal', collinear: 'Collinear', concentric: 'Concentric', tangent: 'Tangent', midpoint: 'Midpoint', symmetric: 'Symmetric', fix: 'Fix' };
  const r = document.querySelector('#ribbon').getBoundingClientRect();
  popup(rel.map((t) => ({ label: names[t], icon: 'relation', action: () => sk.addRelation(t) })), Math.min(innerWidth - 220, r.left + r.width / 2), r.bottom);
});
register('skConstruction', () => app.sketcher.toggleConstruction());

// ---------------------------------------------------------------- hole wizard
function holeDialog(existing) {
  const p = existing ? existing.params : null;
  const vals = p ? { ...p, faces: [] } : { faces: [], kind: 'simple', diameter: 6, end: 'through', depth: 10, cboreDia: 11, cboreDepth: 6, csinkDia: 12, csinkAngle: 90 };
  if (!existing) setSelection([]);
  openPM({
    title: existing ? existing.name : 'Hole Wizard', icon: 'hole',
    message: existing ? 'Change the hole specification. To move the holes, edit the position sketch under this feature in the tree.' : 'Click on a flat face where each hole should go. Exact positions can be dimensioned afterwards by editing the position sketch.',
    fields: [
      !existing && { key: 'faces', label: 'Positions', group: 'Positions', type: 'sel', accept: ['face'], placeholder: 'Click on a flat face to place holes' },
      { key: 'kind', label: 'Hole type', group: 'Hole Specification', type: 'select', options: [['simple', 'Simple hole'], ['cbore', 'Counterbore'], ['csink', 'Countersink']] },
      { key: 'diameter', label: 'Diameter (mm)', group: 'Hole Specification', type: 'number', min: 0 },
      { key: 'cboreDia', label: 'C-bore Ø (mm)', group: 'Hole Specification', type: 'number', show: (v) => v.kind === 'cbore' },
      { key: 'cboreDepth', label: 'C-bore depth', group: 'Hole Specification', type: 'number', show: (v) => v.kind === 'cbore' },
      { key: 'csinkDia', label: 'C-sink Ø (mm)', group: 'Hole Specification', type: 'number', show: (v) => v.kind === 'csink' },
      { key: 'csinkAngle', label: 'C-sink angle (°)', group: 'Hole Specification', type: 'number', show: (v) => v.kind === 'csink' },
      { key: 'end', label: 'End condition', group: 'End Condition', type: 'select', options: [['through', 'Through All'], ['blind', 'Blind']] },
      { key: 'depth', label: 'Depth (mm)', group: 'End Condition', type: 'number', show: (v) => v.end === 'blind' },
    ].filter(Boolean),
    onOK: (v) => {
      const spec = { kind: v.kind, diameter: v.diameter, end: v.end, depth: v.depth, cboreDia: v.cboreDia, cboreDepth: v.cboreDepth, csinkDia: v.csinkDia, csinkAngle: v.csinkAngle };
      if (existing) return app.doc.updateFeature(existing.id, { ...existing.params, ...spec });
      const picks = v.faces.filter((f) => f.planeSpec && f.hit && f.hit.point);
      if (!picks.length) return toast('No hole was created: click on a flat face to place it.', true);
      const first = picks[0];
      const sk = emptySketch();
      sk.pts.origin = { x: 0, y: 0, fixed: true };
      picks.forEach((f, i) => {
        const l = toLocal(first.plane, f.hit.point);
        sk.pts['h' + i] = { x: l[0], y: l[1] };
        sk.ents.push({ id: 'hp' + i, type: 'point', p: 'h' + i });
      });
      const s = app.doc.addFeature('sketch', { plane: first.planeSpec, sketch: sk }, { silent: true });
      app.doc.addFeature('hole', { sketch: s.id, ...spec });
      app.doc._undo.splice(app.doc._undo.length - 1, 1);
      setSelection([]);
    },
    onCancel: () => setSelection([]),
  }, vals);
}
register('hole', () => {
  fromSketch();
  holeDialog(null);
});

// ---------------------------------------------------------------- sheet metal / weldment outputs
register('flatPattern', () => {
  const st = app.doc.state;
  let ents;
  try {
    ents = flatPattern(st.sheetMetal, st.flanges);
  } catch (e) {
    return toast(e.message, true);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of ents) {
    x0 = Math.min(x0, e.x1, e.x2);
    x1 = Math.max(x1, e.x1, e.x2);
    y0 = Math.min(y0, e.y1, e.y2);
    y1 = Math.max(y1, e.y1, e.y2);
  }
  const pad = 10, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
  const svg = `<svg viewBox="${x0 - pad} ${-y1 - pad} ${w} ${h}" style="width:100%;max-height:52vh;background:#fff;border:1px solid #ccd">${ents.map((e) => `<line x1="${e.x1}" y1="${-e.y1}" x2="${e.x2}" y2="${-e.y2}" stroke="${e.layer === 'BEND' ? '#c62828' : '#111'}" stroke-width="${Math.max(w, h) / 500}" ${e.layer === 'BEND' ? `stroke-dasharray="${Math.max(w, h) / 80} ${Math.max(w, h) / 160}"` : ''}/>`).join('')}</svg>`;
  modal({
    title: 'Flat Pattern', wide: true,
    body: `${svg}<p>Blank size: <b>${fmt(x1 - x0, 2)} × ${fmt(y1 - y0, 2)} mm</b> · thickness ${fmt(st.sheetMetal.thickness)} mm · bend radius ${fmt(st.sheetMetal.radius)} mm · K-factor ${st.sheetMetal.kFactor}. Red dashed lines are bend centre lines.</p><p style="color:#5d6b7a">Covers the base plate and edge flanges attached directly to it.</p>`,
    buttons: [{ label: 'Export DXF', action: () => (run('flatDXF'), true) }, { label: 'Close', primary: true }],
  });
});
register('cutlist', () => {
  const list = app.doc.state.cutlist;
  if (!list.length) return toast('The cut list is empty: add Structural Members first.');
  const groups = {};
  for (const c of list) {
    const k = c.description + '|' + c.length.toFixed(2);
    groups[k] = groups[k] || { ...c, qty: 0 };
    groups[k].qty++;
  }
  const rows = Object.values(groups);
  const total = list.reduce((s, c) => s + c.length, 0);
  const csv = 'Item,Qty,Description,Length (mm)\n' + rows.map((r, i) => `${i + 1},${r.qty},"${r.description}",${r.length.toFixed(1)}`).join('\n');
  modal({
    title: 'Weldment Cut List', wide: true,
    body: `<table class="grid"><tr><th>Item</th><th>Qty</th><th>Description</th><th>Length (mm)</th></tr>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.qty}</td><td>${esc(r.description)}</td><td>${r.length.toFixed(1)}</td></tr>`).join('')}</table><p>Total length: <b>${(total / 1000).toFixed(3)} m</b> (centre-line lengths)</p>`,
    buttons: [{ label: 'Save CSV', action: () => (run('download', new Blob([csv], { type: 'text/csv' }), `${app.doc.name}-cutlist.csv`), true) }, { label: 'Close', primary: true }],
  });
});

export { openFeature, D };
