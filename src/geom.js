// Small vector / plane helpers shared by the whole app. Model units are millimetres, Y is up
// (Front = XY, Top = XZ, Right = YZ), the same convention SolidWorks users are used to.

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  neg: (a) => [-a[0], -a[1], -a[2]],
  // rotate vector v about unit axis k by angle (radians)
  rot: (v, k, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const kxv = V.cross(k, v), kv = V.dot(k, v);
    return [
      v[0] * c + kxv[0] * s + k[0] * kv * (1 - c),
      v[1] * c + kxv[1] * s + k[1] * kv * (1 - c),
      v[2] * c + kxv[2] * s + k[2] * kv * (1 - c),
    ];
  },
};

export const BASE_PLANES = {
  Front: { o: [0, 0, 0], x: [1, 0, 0], n: [0, 0, 1] },
  Top: { o: [0, 0, 0], x: [1, 0, 0], n: [0, 1, 0] },
  Right: { o: [0, 0, 0], x: [0, 0, -1], n: [1, 0, 0] },
};

export const planeY = (pl) => V.cross(pl.n, pl.x);

export function toWorld(pl, p) {
  const y = planeY(pl);
  const w = p[2] || 0;
  return [
    pl.o[0] + pl.x[0] * p[0] + y[0] * p[1] + pl.n[0] * w,
    pl.o[1] + pl.x[1] * p[0] + y[1] * p[1] + pl.n[1] * w,
    pl.o[2] + pl.x[2] * p[0] + y[2] * p[1] + pl.n[2] * w,
  ];
}

export function toLocal(pl, p) {
  const d = V.sub(p, pl.o);
  return [V.dot(d, pl.x), V.dot(d, planeY(pl)), V.dot(d, pl.n)];
}

// Build a plane from an origin and a normal, choosing a stable in-plane X direction.
export function planeFromNormal(o, n) {
  n = V.norm(n);
  // up cross n -> for n = +Z gives +X (Front), for n = +X gives -Z (Right)
  const x = Math.abs(n[1]) > 0.999
    ? V.norm(V.sub([1, 0, 0], V.mul(n, n[0])))
    : V.norm(V.cross([0, 1, 0], n));
  return { o: [...o], x, n };
}

export function offsetPlane(pl, d) {
  return { o: V.add(pl.o, V.mul(pl.n, d)), x: [...pl.x], n: [...pl.n] };
}

export const fmt = (v, d = 2) => {
  const s = (+v).toFixed(d);
  return s.replace(/\.?0+$/, '') || '0';
};

let _id = 0;
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(_id++).toString(36)}`;

// circle through 3 2D points -> {c:[x,y], r} or null when collinear
export function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

// angle of b relative to a going counter-clockwise, in [0, 2pi)
export function ccwSweep(a1, a2) {
  let s = (a2 - a1) % (Math.PI * 2);
  if (s <= 1e-12) s += Math.PI * 2;
  return s;
}
