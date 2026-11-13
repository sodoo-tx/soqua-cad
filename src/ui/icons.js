// Original icon set for SOQUA design (simple 24x24 SVG glyphs).
const s = 'fill="none" stroke="#27496d" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"';
const y = 'fill="#f3c654" stroke="#8a6a12" stroke-width="1.2" stroke-linejoin="round"';
const b = 'fill="#8ec1ee" stroke="#27496d" stroke-width="1.2" stroke-linejoin="round"';
const g = 'fill="#bfc7d1" stroke="#4c5a69" stroke-width="1.2" stroke-linejoin="round"';
const r = 'fill="none" stroke="#c62828" stroke-width="1.6" stroke-linecap="round"';
const box = `<path ${y} d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path ${s} d="M4 9l8 4 8-4M12 13v8"/>`;
const sheet = `<path ${g} d="M5 3h10l4 4v14H5z"/><path ${s} d="M15 3v4h4"/>`;

const I = {
  new: sheet,
  open: `<path ${y} d="M3 7h6l2 2h10v10H3z"/>`,
  save: `<path ${b} d="M4 4h13l3 3v13H4z"/><path ${s} d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  undo: `<path ${s} d="M9 7L4 11l5 4M4 11h10a5 5 0 010 10h-3"/>`,
  redo: `<path ${s} d="M15 7l5 4-5 4M20 11H10a5 5 0 000 10h3"/>`,
  rebuild: `<circle cx="12" cy="8" r="3.4" fill="#e23b2e"/><circle cx="12" cy="16" r="3.4" fill="#3aa845"/><rect x="9.5" y="2.5" width="5" height="19" rx="2.5" ${s}/>`,
  import: `<path ${s} d="M12 3v11M8 10l4 4 4-4M4 16v4h16v-4"/>`,
  export: `<path ${s} d="M12 14V3M8 7l4-4 4 4M4 16v4h16v-4"/>`,
  options: `<circle cx="12" cy="12" r="3" ${s}/><path ${s} d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>`,
  // sketch
  sketch: `<path ${g} d="M3 17l14-5 4 3-14 5z"/><path ${s} d="M7 16l5-8 5 5"/><circle cx="7" cy="16" r="1.3" fill="#27496d"/><circle cx="12" cy="8" r="1.3" fill="#27496d"/>`,
  sketch3d: `<path ${s} d="M4 18l6-3v-9M10 15l9 3"/><circle cx="10" cy="6" r="1.4" fill="#27496d"/><circle cx="19" cy="18" r="1.4" fill="#27496d"/><circle cx="4" cy="18" r="1.4" fill="#27496d"/><text x="14" y="10" font-size="7" fill="#27496d" font-family="Arial">3D</text>`,
  exit: `<path ${s} d="M4 12h11M11 8l4 4-4 4"/><path ${s} d="M14 4h6v16h-6"/>`,
  select: `<path d="M6 3l12 9-5 1 3 6-2.4 1.2-3-6L6 18z" fill="#fff" stroke="#27496d" stroke-width="1.4" stroke-linejoin="round"/>`,
  line: `<path ${s} d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6" fill="#27496d"/><circle cx="19" cy="5" r="1.6" fill="#27496d"/>`,
  centerline: `<path ${s} stroke-dasharray="6 2 1.5 2" d="M4 20L20 4"/>`,
  rect: `<rect x="4" y="6" width="16" height="12" ${s}/><circle cx="4" cy="18" r="1.5" fill="#27496d"/><circle cx="20" cy="6" r="1.5" fill="#27496d"/>`,
  crect: `<rect x="4" y="6" width="16" height="12" ${s}/><circle cx="12" cy="12" r="1.5" fill="#27496d"/>`,
  circle: `<circle cx="12" cy="12" r="8" ${s}/><circle cx="12" cy="12" r="1.4" fill="#27496d"/>`,
  arc3: `<path ${s} d="M4 17A9 9 0 0120 17"/><circle cx="4" cy="17" r="1.5" fill="#27496d"/><circle cx="20" cy="17" r="1.5" fill="#27496d"/><circle cx="12" cy="8" r="1.5" fill="#27496d"/>`,
  arcc: `<path ${s} d="M5 18A12 12 0 0118 6"/><circle cx="18" cy="19" r="1.5" fill="#27496d"/><path ${s} stroke-dasharray="2 2" d="M18 19L5 18M18 19V6"/>`,
  polygon: `<path ${s} d="M12 3l8 5v8l-8 5-8-5V8z"/>`,
  slot: `<rect x="3" y="8" width="18" height="8" rx="4" ${s}/>`,
  spline: `<path ${s} d="M3 16c4-12 7 6 10-3s5-7 8-4"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="9" ry="5.5" ${s}/>`,
  point: `<path ${s} d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="2" fill="#27496d"/>`,
  text: `<path ${s} d="M5 6h14M12 6v13M9 19h6"/>`,
  dimension: `<path ${s} d="M4 5v14M20 5v14M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3"/>`,
  trim: `<path ${s} d="M4 12h6M14 12h6"/><path ${r} d="M10 9l4 6M14 9l-4 6"/>`,
  offset: `<path ${s} d="M4 18V8a4 4 0 014-4h10"/><path ${s} stroke-dasharray="2 2" d="M9 18v-7a2 2 0 012-2h7"/>`,
  mirror: `<path ${s} stroke-dasharray="3 2" d="M12 3v18"/><path ${b} d="M9 7v10l-6-5z"/><path ${s} d="M15 7v10l6-5z"/>`,
  sfillet: `<path ${s} d="M4 4v8a8 8 0 008 8h8"/>`,
  lpattern: `<rect x="3" y="3" width="6" height="6" ${b}/><rect x="15" y="3" width="6" height="6" ${s}/><rect x="3" y="15" width="6" height="6" ${s}/><rect x="15" y="15" width="6" height="6" ${s}/>`,
  cpattern: `<circle cx="12" cy="4.5" r="2.3" ${b}/><circle cx="19" cy="14" r="2.3" ${s}/><circle cx="5" cy="14" r="2.3" ${s}/><circle cx="12" cy="13" r="1" fill="#27496d"/>`,
  convert: `<path ${y} d="M4 4h10v10H4z"/><path ${s} d="M10 20h10V10"/><path ${s} d="M14 14l5 5"/>`,
  relation: `<path ${s} d="M4 18h10M18 4v10"/><path ${s} d="M14 14h4v4h-4z"/>`,
  construction: `<path ${s} stroke-dasharray="3 2.5" d="M4 20L20 4"/><circle cx="12" cy="12" r="2.4" ${s}/>`,
  // features
  extrude: `<path ${g} d="M3 17l9-4 9 4-9 4z"/><path ${y} d="M7 15V6l5-2 5 2v9l-5 2z"/><path ${s} d="M7 6l5 2 5-2M12 8v9"/>`,
  cut: `<path ${y} d="M3 9l9-4 9 4v8l-9 4-9-4z"/><path d="M8 10l4-1.8 4 1.8v4l-4 1.8-4-1.8z" fill="#fff" stroke="#8a6a12" stroke-width="1.2"/>`,
  revolve: `<path ${s} stroke-dasharray="3 2" d="M6 2v20"/><path ${y} d="M6 6h8c4 0 4 12 0 12H6z"/><path ${s} d="M17 4a8 5 0 013 3M20 7l-.2-2.6M20 7l-2.5.3"/>`,
  revolvecut: `<path ${s} stroke-dasharray="3 2" d="M6 2v20"/><path d="M6 6h8c4 0 4 12 0 12H6z" fill="#fff" stroke="#8a6a12" stroke-width="1.2"/><path ${s} d="M17 4a8 5 0 013 3"/>`,
  sweep: `<path ${s} d="M4 19c0-9 6-13 15-13"/><circle cx="4.5" cy="19" r="3" ${y}/><circle cx="19" cy="6" r="3" ${y}/>`,
  loft: `<path ${y} d="M5 20h14l-3-16H9z"/><ellipse cx="12" cy="20" rx="7" ry="2" ${s}/><ellipse cx="12.5" cy="4" rx="3.5" ry="1.4" ${s}/>`,
  fillet: `<path ${y} d="M4 20V4h6a10 10 0 0110 10v6z"/><path ${s} d="M10 4a10 10 0 0110 10"/>`,
  chamfer: `<path ${y} d="M4 20V4h8l8 8v8z"/><path ${s} d="M12 4l8 8"/>`,
  shell: `<path ${y} d="M4 8l8-4 8 4v9l-8 4-8-4z"/><path d="M7 9.5l5-2.5 5 2.5-5 2.5z" fill="#fff" stroke="#8a6a12" stroke-width="1.1"/>`,
  draft: `<path ${y} d="M5 20l3-15h8l3 15z"/><path ${s} stroke-dasharray="2 2" d="M5 20V5"/>`,
  hole: `<path ${y} d="M3 8h18v10H3z"/><path d="M8 8h8v3h-2v5h-4v-5H8z" fill="#fff" stroke="#8a6a12" stroke-width="1.1"/>`,
  rib: `<path ${y} d="M3 20V6h4v8l10 6z"/>`,
  plane: `<path ${b} d="M3 15l12-6 6 4-12 6z" fill-opacity=".6"/><path ${s} d="M12 14V4"/>`,
  mirror3d: `<path ${s} stroke-dasharray="3 2" d="M12 2v20"/><path ${y} d="M3 8l6-2v10l-6 2z"/><path ${g} d="M21 8l-6-2v10l6 2z"/>`,
  scale: `<rect x="3" y="11" width="10" height="10" ${y}/><path ${s} d="M9 3h12v12M21 3l-7 7"/>`,
  move: `<path ${s} d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>`,
  primitive: box,
  combine: `<circle cx="9" cy="12" r="6" ${y}/><circle cx="15" cy="12" r="6" ${b} fill-opacity=".7"/>`,
  // surfaces
  surfExtrude: `<path ${b} fill-opacity=".7" d="M4 18c3-5 6 3 9-2V5c-3 5-6-3-9 2z"/><path ${s} d="M17 8v9M14 14l3 3 3-3"/>`,
  surfRevolve: `<path ${s} stroke-dasharray="3 2" d="M6 2v20"/><path ${b} fill-opacity=".6" d="M6 6c9 0 9 12 0 12"/>`,
  surfPlanar: `<path ${b} fill-opacity=".7" d="M3 15l8-7 10 3-8 8z"/>`,
  surfLoft: `<path ${b} fill-opacity=".6" d="M4 20c4-3 12-3 16 0L16 4c-3-2-6-2-8 0z"/>`,
  surfSweep: `<path ${b} fill-opacity=".6" d="M3 20c0-9 5-13 13-14l4 3C13 10 9 14 8 21z"/>`,
  surfOffset: `<path ${b} fill-opacity=".7" d="M3 14l9-5 9 5-9 5z"/><path ${s} stroke-dasharray="2 2" d="M3 8l9-5 9 5-9 5z"/>`,
  thicken: `<path ${b} d="M3 12l9-5 9 5-9 5z"/><path ${y} d="M3 12v4l9 5 9-5v-4l-9 5z"/>`,
  knit: `<path ${b} fill-opacity=".7" d="M3 6h8v12H3z"/><path ${b} fill-opacity=".4" d="M13 6h8v12h-8z"/><path ${s} d="M10 9h4M10 12h4M10 15h4"/>`,
  deleteBody: `<path ${g} d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path ${r} d="M8 9l8 8M16 9l-8 8"/>`,
  // sheet metal
  baseFlange: `<path ${g} d="M3 14l10-5 8 4-10 5z"/><path ${g} d="M3 14v2l8 4v-2z"/>`,
  edgeFlange: `<path ${g} d="M3 16l10-5 5 2.5-10 5z"/><path ${y} d="M18 13.5V5l-10 5v8.5"/>`,
  flat: `<path ${g} d="M3 8h18v10H3z"/><path ${s} stroke-dasharray="3 2" d="M9 8v10M15 8v10"/>`,
  // weldments
  member: `<path ${g} d="M3 17L17 5l4 3L7 20z"/><path ${s} d="M3 17l4 3M5 15.3l4 3"/>`,
  cutlist: `<path ${s} d="M4 5h16M4 10h16M4 15h16M4 20h16M9 5v15"/>`,
  // mesh
  mesh: `<path ${s} d="M12 3l9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8M3 16l9-3 9 3M12 3v10"/>`,
  decimate: `<path ${s} d="M3 20L12 4l9 16zM7.5 12h9M12 4v16"/><path ${r} d="M17 4l4 4M21 4l-4 4"/>`,
  smooth: `<path ${s} d="M3 16c3-9 6-9 9-4s6 3 9-6"/><path ${s} stroke-dasharray="2 2" d="M3 16l3-6 3 6 3-8 3 6 3-4 3-4"/>`,
  tosolid: `<path ${s} d="M2 12l5-3v6zM7 9v6"/><path ${y} d="M12 9l5-2.5L22 9v6l-5 2.5-5-2.5z"/><path ${s} d="M8 12h3"/>`,
  tomesh: `<path ${y} d="M2 9l4-2 4 2v6l-4 2-4-2z"/><path ${s} d="M11 12h2M15 8l6 3v6l-6-3zM15 8v6M21 11l-6 3"/>`,
  // evaluate
  measure: `<path ${g} d="M3 15L15 3l6 6L9 21z"/><path ${s} d="M7 13l2 2M10 10l2 2M13 7l2 2"/>`,
  mass: `<path ${g} d="M5 21l2-11h10l2 11z"/><circle cx="12" cy="7" r="3" ${s}/>`,
  section: `<path ${y} d="M4 9l8-4v16l-8-4z"/><path ${s} d="M12 5l8 4v8l-8 4"/><path ${r} d="M12 2v20"/>`,
  check: `<path fill="none" stroke="#2e7d32" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4 10-11"/>`,
  bbox: `<path ${s} stroke-dasharray="3 2" d="M4 9l8-4 8 4v8l-8 4-8-4zM4 9l8 4 8-4M12 13v8"/>`,
  // simulation
  sim: `<path ${g} d="M3 18h12v3H3z"/><path fill="#e23b2e" d="M5 18c0-6 2-9 4-9s4 3 4 9z" opacity=".8"/><path ${s} d="M19 4v8M16 9l3 3 3-3"/>`,
  fixture: `<path ${s} d="M6 4v12M6 16l-3 4M6 16l3 4M6 16h0"/><path fill="#2e7d32" d="M10 6l8 4-8 4z"/>`,
  force: `<path fill="none" stroke="#7b2fbf" stroke-width="2" stroke-linecap="round" d="M12 3v14M7 12l5 5 5-5"/><path ${s} d="M4 21h16"/>`,
  run: `<path fill="#2e7d32" d="M7 4l12 8-12 8z"/>`,
  // render
  appearance: `<circle cx="12" cy="12" r="9" fill="#e23b2e"/><path d="M12 3a9 9 0 010 18z" fill="#f3c654"/><path d="M12 12L4.2 7.5A9 9 0 0112 3z" fill="#3aa845"/><path d="M12 12L4.2 16.5a9 9 0 010-9z" fill="#2a62d4"/>`,
  scene: `<path ${b} d="M3 5h18v14H3z"/><path fill="#3aa845" d="M3 19l6-7 4 4 3-3 5 6z"/><circle cx="16" cy="9" r="2" fill="#f3c654"/>`,
  render: `<path ${g} d="M3 8h18v12H3z"/><path ${g} d="M8 8l2-3h4l2 3"/><circle cx="12" cy="14" r="3.5" ${s}/>`,
  texture: `<path fill="#bfc7d1" d="M3 3h18v18H3z"/><path fill="#4c5a69" d="M3 3h6v6H3zM15 3h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zM15 15h6v6h-6z"/>`,
  turntable: `<ellipse cx="12" cy="17" rx="9" ry="3.4" ${s}/><path ${y} d="M8 9l4-2 4 2v5l-4 2-4-2z"/><path ${s} d="M19 6a8 4 0 00-11-2M8 4l-.6 2.6M8 4l2.6.4"/>`,
  // view
  fit: `<path ${s} d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="9" y="9" width="6" height="6" ${y}/>`,
  views: box,
  normal: `<path ${b} d="M4 8h16v12H4z" fill-opacity=".6"/><path ${s} d="M12 14V3M9 6l3-3 3 3"/>`,
  shadedEdges: `<path ${y} d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path ${s} d="M4 9l8 4 8-4M12 13v8"/>`,
  shaded: `<path fill="#f3c654" d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path fill="#d9a92f" d="M12 13l8-4v8l-8 4z"/>`,
  hidden: `<path fill="#fff" stroke="#27496d" stroke-width="1.5" stroke-linejoin="round" d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path ${s} d="M4 9l8 4 8-4M12 13v8"/>`,
  wireframe: `<path ${s} d="M4 9l8-4 8 4v8l-8 4-8-4zM4 9l8 4 8-4M12 13v8"/><path ${s} stroke-dasharray="2 2" d="M12 5v8M4 17l8-4 8 4"/>`,
  planes: `<path ${b} fill-opacity=".5" d="M3 14l10-4 8 3-10 4z"/><path ${b} fill-opacity=".5" d="M9 5l5-2v14l-5 2z"/>`,
  // drawing
  drawing: `${sheet}<path ${s} d="M8 11h8v6H8z"/>`,
  stdviews: `<rect x="3" y="12" width="8" height="8" ${s}/><rect x="13" y="12" width="8" height="8" ${s}/><rect x="3" y="3" width="8" height="7" ${s}/>`,
  view: `<rect x="4" y="5" width="16" height="14" ${s}/><path ${s} d="M8 15l3-4 3 3 2-2"/>`,
  note: `<path ${s} d="M4 20l3-8L17 2l3 3-10 10zM13 6l3 3"/><text x="13" y="21" font-size="8" fill="#27496d" font-family="Arial">A</text>`,
  template: `${sheet}<path ${s} d="M8 16h8M12 16v3"/>`,
  pdf: `${sheet}<text x="6.5" y="17" font-size="6.5" font-weight="bold" fill="#c62828" font-family="Arial">PDF</text>`,
  dxf: `${sheet}<text x="6.5" y="17" font-size="6.5" font-weight="bold" fill="#1f6fb5" font-family="Arial">DXF</text>`,
  font: `<text x="3" y="19" font-size="19" fill="#27496d" font-family="Georgia">A</text><text x="14" y="19" font-size="12" fill="#27496d" font-family="Georgia">a</text>`,
  centermark: `<circle cx="12" cy="12" r="7" ${s}/><path ${s} d="M12 2v20M2 12h20" stroke-dasharray="5 2 1 2"/>`,
  delete: `<path ${r} d="M6 6l12 12M18 6L6 18"/>`,
  edit: `<path ${s} d="M4 20l3-8L17 2l3 3-10 10zM13 6l3 3"/>`,
  eye: `<path ${s} d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" ${s}/>`,
  suppress: `<path ${g} d="M4 9l8-4 8 4v8l-8 4-8-4z" opacity=".5"/><path ${s} d="M12 8v6M9 11l3 3 3-3"/>`,
  material: `<path ${g} d="M4 7l8-4 8 4-8 4z"/><path ${y} d="M4 12l8 4 8-4M4 17l8 4 8-4"/>`,
  origin: `<path d="M12 12V3" stroke="#2e9e3a" stroke-width="2"/><path d="M12 12h9" stroke="#d0312d" stroke-width="2"/><path d="M12 12l-6 6" stroke="#2a62d4" stroke-width="2"/>`,
  body: box,
  folder: `<path ${y} d="M3 7h6l2 2h10v10H3z"/>`,
  help: `<circle cx="12" cy="12" r="9" ${s}/><path ${s} d="M9 9.5a3 3 0 115 2.2c-1 .8-2 1.3-2 2.8"/><circle cx="12" cy="17.5" r="1" fill="#27496d"/>`,
  part: box,
};

const alias = {
  sketch_: 'sketch', linearPattern: 'lpattern', circularPattern: 'cpattern', structuralMember: 'member', moveBody: 'move', import_: 'import',
  surfExtrude: 'surfExtrude', mirrorF: 'mirror3d', mirror: 'mirror3d', sketch3d: 'sketch3d', text: 'text', mesh: 'mesh',
};

export function icon(name) {
  const body = I[name] || I[alias[name]];
  if (body) return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const t = (name || '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="4" fill="#dfe6ee" stroke="#27496d" stroke-width="1.2"/><text x="12" y="16" text-anchor="middle" font-size="9" font-family="Arial" fill="#27496d">${t}</text></svg>`;
}

export const featureIcon = (type, f) => {
  if (type === 'extrude') return icon(f && f.params.op === 'cut' ? 'cut' : 'extrude');
  if (type === 'revolve') return icon(f && f.params.op === 'cut' ? 'revolvecut' : 'revolve');
  return icon(I[type] ? type : alias[type] || type);
};
