import * as K from '../../src/kernel.js';
import { BASE_PLANES, V } from '../../src/geom.js';
import { evalSketchProfile } from '../../src/sketch/profile.js';
const t0 = Date.now();
await K.initKernel();
console.log('init ms', Date.now() - t0);
const sk = { pts: { a:{x:0,y:0}, b:{x:100,y:0}, c:{x:100,y:60}, d:{x:0,y:60}, h:{x:50,y:30}, s1:{x:10,y:10}, s2:{x:20,y:25}, s3:{x:35,y:12} },
  ents: [ {id:'l1',type:'line',a:'a',b:'b'},{id:'l2',type:'line',a:'b',b:'c'},{id:'l3',type:'line',a:'c',b:'d'},{id:'l4',type:'line',a:'d',b:'a'},{id:'c1',type:'circle',c:'h',r:12} ], cons: [] };
const prof = evalSketchProfile(sk);
console.log('loops', prof.loops.length, 'regions', prof.regions.length, 'holes', prof.regions[0].holes.length);
const pl = BASE_PLANES.Front;
const face = K.regionFace(prof.regions[0], pl);
let solid = K.extrudeFaces([face], V.mul(pl.n, 20));
let mp = K.massProps(solid);
console.log('volume', mp.volume, 'expected', (100*60 - Math.PI*144)*20, 'area', mp.area, 'com', mp.com, 'bbox', JSON.stringify(mp.bbox));
const tess = K.tessellate(solid);
console.log('tess', tess.positions.length/3, 'verts', tess.indices.length/3, 'tris', tess.nFaces, 'faces', tess.nEdges, 'edges', tess.edgeGroups.length);
// fillet one vertical edge
const ei = solid.edges.findIndex(e => { const i = K.edgeSig(e); return Math.abs(i.a[0])<1e-6 && Math.abs(i.b[0])<1e-6 && Math.abs(i.a[1])<1e-6 && Math.abs(i.b[1])<1e-6; });
console.log('edge', ei, JSON.stringify(K.edgeInfo(solid, ei)));
solid = K.filletEdges(solid, [K.edgeSig(solid.edges[ei])], 5);
console.log('after fillet vol', K.massProps(solid).volume, 'faces', solid.faces.length);
// shell removing top face (z=20)
const fi = solid.faces.findIndex(f => Math.abs(K.faceSig(f).c[2]-20)<1e-6);
console.log('face', JSON.stringify(K.faceInfo(solid, fi)));
const shelled = K.shellFaces(solid, [K.faceSig(solid.faces[fi])], 2);
console.log('shell vol', K.massProps(shelled).volume, JSON.stringify(K.bbox(shelled)));
// cut
const cutTool = K.makeCylinder(8, 50, [20, 20, -10], [0, 0, 1]);
const cut = K.applyOp(solid, cutTool, 'cut');
console.log('cut vol', K.massProps(cut).volume, 'valid', K.isValid(cut));
// chamfer
// projection
const pr = K.projectShape(cut, [0, 0, -1], [1, 0, 0]);
console.log('proj visible', pr.visible.length, 'hidden', pr.hidden.length, JSON.stringify(pr.visible.slice(0, 3)));
const pr2 = K.projectShape(cut, [0, -1, 0], [1, 0, 0]);
console.log('top proj', JSON.stringify(pr2.visible.slice(0, 4)));
// step
const step = K.exportSTEP([{ shape: cut, name: 'Part1', color: '#8899aa' }]);
const txt = await step.text();
console.log('step bytes', txt.length, txt.slice(0, 60).replace(/\n/g, ' '));
const back = await K.importSTEP(new Blob([txt]));
console.log('reimport vol', K.massProps(back).volume);
const stl = K.exportSTL(cut);
console.log('stl bytes', (await stl.arrayBuffer()).byteLength);
// revolve
const rsk = { pts: { a:{x:10,y:0}, b:{x:30,y:0}, c:{x:30,y:40}, d:{x:10,y:40} }, ents: [ {id:'l1',type:'line',a:'a',b:'b'},{id:'l2',type:'line',a:'b',b:'c'},{id:'l3',type:'line',a:'c',b:'d'},{id:'l4',type:'line',a:'d',b:'a'} ] };
const rp = evalSketchProfile(rsk);
const rev = K.revolveFaces([K.regionFace(rp.regions[0], pl)], [0,0,0], [0,1,0], 360);
console.log('revolve vol', K.massProps(rev).volume, 'expected', Math.PI*(900-100)*40);
// spline loop
const ssk = { pts: { a:{x:0,y:0}, b:{x:40,y:0}, c:{x:50,y:30}, d:{x:20,y:45}, e:{x:-5,y:25} }, ents: [ {id:'l1',type:'line',a:'a',b:'b'}, {id:'s',type:'spline',pts:['b','c','d','e','a']} ] };
const sp = evalSketchProfile(ssk);
console.log('spline loops', sp.loops.length, sp.open.length);
const sf = K.extrudeFaces([K.regionFace(sp.regions[0], pl)], [0,0,10]);
console.log('spline vol', K.massProps(sf).volume, sp.loops[0].area*10);
// sweep: circle profile on Top plane swept along line+arc path in front plane
const pathSk = { pts:{a:{x:0,y:0},b:{x:0,y:50},c:{x:20,y:50},d:{x:20,y:70}}, ents:[{id:'l',type:'line',a:'a',b:'b'},{id:'ar',type:'arc',c:'c',a:'d',b:'b'}] };
const pp = evalSketchProfile(pathSk);
console.log('path open', pp.open.length, pp.open[0].items.length);
const spine = K.chainToWire(pp.open[0], pl);
const profSk = { pts:{c:{x:0,y:0}}, ents:[{id:'c',type:'circle',c:'c',r:4}] };
const pf = K.regionFace(evalSketchProfile(profSk).regions[0], BASE_PLANES.Top);
const sw = K.sweepProfile(pf, spine);
console.log('sweep vol', K.massProps(sw).volume, 'expected ~', Math.PI*16*(50+Math.PI*20/2));
// loft
const w1 = K.chainToWire(evalSketchProfile(profSk).loops[0], BASE_PLANES.Top);
const w2 = K.chainToWire(rp.loops[0], { o:[0,50,0], x:[1,0,0], n:[0,1,0] });
const lf = K.loftWires([w1, w2]);
console.log('loft vol', K.massProps(lf).volume);
// thicken / surface
const surf = K.extrudeWire(spine, [0,0,30]);
console.log('surface area', K.massProps(surf).area, 'faces', surf.faces.length);
try { const th = K.thicken(surf, 2); console.log('thicken vol', K.massProps(th).volume); } catch (e) { console.log('thicken FAIL', e.message || e); }
// text
const knit = K.sew([surf, K.extrudeWire(K.chainToWire(rp.loops[0], pl), [0,0,5])]);
console.log('sew faces', knit.faces.length);
const big = K.transformShape(cut, { translate: [10, 0, 0], rotate: { angle: 90, origin: [0,0,0], axis: [0,0,1] } });
console.log('transformed bbox', JSON.stringify(K.bbox(big)));
const mir = K.transformShape(cut, { mirror: { normal: [1,0,0], origin: [0,0,0] } });
console.log('mirror bbox', JSON.stringify(K.bbox(mir)));
const tri = new Float32Array([0,0,0, 10,0,0, 0,10,0,  0,0,0, 0,10,0, 0,0,10,  0,0,0, 0,0,10, 10,0,0,  10,0,0, 0,0,10, 0,10,0]);
const ms = K.solidFromTriangles(tri);
console.log('tet solid vol', K.massProps(ms).volume, 'expected', 1000/6);
const dr = K.draftFaces(K.makeBox([0,0,0],[20,20,20]), [{c:[20,10,10],n:[1,0,0]}], 5, {o:[0,0,0],x:[1,0,0],n:[0,1,0]});
console.log('draft vol', K.massProps(dr).volume);
