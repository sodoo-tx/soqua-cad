import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDXF, writeDXF } from '../src/io/dxf.js';
import { parseIGES } from '../src/io/iges.js';

const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

test('line / circle / arc / polyline round-trip', () => {
  const ents = [
    { type: 'line', x1: 0, y1: 0, x2: 10.5, y2: -3.25, layer: 'A' },
    { type: 'circle', cx: 5, cy: 5, r: 2.5, layer: 'A' },
    { type: 'arc', cx: 1, cy: 2, r: 3, a1: 30, a2: 200, layer: 'B' },
    { type: 'polyline', pts: [[0, 0], [10, 0, 0.5], [10, 10]], closed: true, layer: 'B' },
  ];
  const d = parseDXF(writeDXF({ entities: ents, layers: {}, units: 'mm' }));
  assert.equal(d.units, 'mm');
  assert.equal(d.entities.length, 4);
  const [l, c, a, p] = d.entities;
  assert.ok(near(l.x2, 10.5) && near(l.y2, -3.25));
  assert.ok(near(c.r, 2.5) && near(c.cx, 5));
  assert.ok(near(a.a1, 30) && near(a.a2, 200) && near(a.r, 3));
  assert.equal(p.pts.length, 3);
  assert.ok(p.closed);
  assert.ok(near(p.pts[1][2], 0.5));
});

test('Cyrillic text survives the round-trip as \U+ escapes', () => {
  const s = writeDXF({ entities: [{ type: 'text', x: 1, y: 2, h: 3.5, text: 'Зурсан Өү' }], layers: {}, units: 'mm' });
  assert.match(s, /\U\+0417/);
  assert.ok(/^[\x00-\x7f]*$/.test(s), 'file is pure ASCII');
  const t = parseDXF(s).entities.find((e) => e.type === 'text');
  assert.equal(t.text, 'Зурсан Өү');
  assert.ok(near(t.h, 3.5));
});

test('converted sheet formats are present and plausible', () => {
  const idx = JSON.parse(fs.readFileSync(new URL('../public/templates/index.json', import.meta.url)));
  assert.ok(idx.length >= 1);
  for (const t of idx) {
    const j = JSON.parse(fs.readFileSync(new URL(`../public/templates/${t.id}.json`, import.meta.url)));
    assert.ok(j.width > 100 && j.height > 100);
    assert.ok(j.lines.length > 20, `${t.id} has border / title block lines`);
    assert.ok(j.texts.length > 5);
  }
});

test('IGES reader: line, arc and copious data', () => {
  const pad = (s, sec, n) => s.padEnd(72, ' ') + sec + String(n).padStart(7, ' ');
  const P = (s, de, n) => s.padEnd(64, ' ') + String(de).padStart(8, ' ') + 'P' + String(n).padStart(7, ' ');
  const D = (type, ptr, form, de) => [
    [type, ptr, 0, 0, 0, 0, 0, 0].map((x) => String(x).padStart(8, ' ')).join('') + '00000000D' + String(de).padStart(7, ' '),
    [type, 0, 0, 1, form].map((x) => String(x).padStart(8, ' ')).join('') + ' '.repeat(24) + String(0).padStart(8, ' ') + 'D' + String(de + 1).padStart(7, ' '),
  ];
  const text = [
    pad('test', 'S', 1), pad('1H,,1H;;', 'G', 1),
    ...D(110, 1, 0, 1), ...D(100, 2, 0, 3), ...D(106, 3, 12, 5),
    P('110,0.,0.,0.,10.,0.,5.;', 1, 1), P('100,2.,0.,0.,5.,0.,0.,5.;', 3, 2), P('106,2,3,0.,0.,0.,1.,1.,1.,2.,0.,2.;', 5, 3),
    pad('S      1G      1D      6P      3', 'T', 1),
  ].join('\n');
  const { polylines } = parseIGES(text);
  assert.equal(polylines.length, 3);
  assert.deepEqual(polylines[0], [[0, 0, 0], [10, 0, 5]]);
  const arc = polylines[1];
  assert.ok(near(arc[0][0], 5) && near(arc[arc.length - 1][1], 5) && near(arc[0][2], 2));
  assert.equal(polylines[2].length, 3);
});
