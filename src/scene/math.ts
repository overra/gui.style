// Tiny 3D vector helpers for the scene model (CPU side). World frame = the existing screen frame: x right,
// y down, z toward the viewer (left-handed), in CSS px. Cameras are explicit bases (right, up, forward) rather
// than matrices, so the shaders, picking and the CSS 3D fallback all share one projection.

export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.max(length(a), 1e-12));
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const DEG = Math.PI / 180;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Unit direction from a polar angle off +z and a screen azimuth atan2(y_down, x), both in degrees. */
export function fromSpherical(polarDeg: number, azDeg: number): Vec3 {
  const be = polarDeg * DEG;
  const az = azDeg * DEG;
  return [Math.sin(be) * Math.cos(az), Math.sin(be) * Math.sin(az), Math.cos(be)];
}

export function toSpherical(v: Vec3): { polar: number; azimuth: number } {
  const n = normalize(v);
  return { polar: Math.acos(clamp(n[2], -1, 1)) / DEG, azimuth: Math.atan2(n[1], n[0]) / DEG };
}

/** A pinhole camera: position, orthonormal basis (forward = viewing direction) and vertical half-FOV tangent. */
export interface CameraBasis {
  eye: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  tanY: number;
}

/**
 * An orbit pose around `pivot`. polar 0 looks straight down −z at the page with screen-up = −y (exactly the
 * scene camera); raising it tilts the camera toward +y (the bottom of the page), then azimuth spins the rig
 * about the page normal. The screen-up vector turns toward +z as it tilts, so the page reads as a floor.
 */
export interface OrbitPose {
  pivot: Vec3;
  polar: number;
  azimuth: number;
  distance: number;
  /** Vertical field of view, degrees. */
  fov: number;
}

export function orbitBasis(p: OrbitPose): CameraBasis {
  const th = p.polar * DEG;
  const ph = p.azimuth * DEG;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const cp = Math.cos(ph);
  const sp = Math.sin(ph);
  // R = Rz(φ)·Rx(θ), applied to the scene camera's basis: right (1,0,0), up (0,−1,0), back (0,0,1).
  const rz = (v: Vec3): Vec3 => [v[0] * cp - v[1] * sp, v[0] * sp + v[1] * cp, v[2]];
  const back = rz([0, st, ct]);
  return {
    eye: add(p.pivot, scale(back, p.distance)),
    right: rz([1, 0, 0]),
    up: rz([0, -ct, st]),
    fwd: scale(back, -1),
    tanY: Math.tan((p.fov * DEG) / 2),
  };
}

/** Projects a world point to viewport CSS px; z is the view depth (≤ 0 means behind the camera). */
export function project(cam: CameraBasis, w: number, h: number, p: Vec3): { x: number; y: number; z: number } {
  const v = sub(p, cam.eye);
  const z = dot(v, cam.fwd);
  const tanX = (cam.tanY * w) / h;
  const sz = Math.max(z, 1e-6);
  return {
    x: w / 2 + ((dot(v, cam.right) / (sz * tanX)) * w) / 2,
    y: h / 2 - ((dot(v, cam.up) / (sz * cam.tanY)) * h) / 2,
    z,
  };
}

/** World-space ray through viewport CSS px (x, y). */
export function rayThrough(cam: CameraBasis, w: number, h: number, x: number, y: number): { o: Vec3; d: Vec3 } {
  const tanX = (cam.tanY * w) / h;
  const nx = (x / w) * 2 - 1;
  const ny = 1 - (y / h) * 2;
  return {
    o: cam.eye,
    d: normalize(add(cam.fwd, add(scale(cam.right, nx * tanX), scale(cam.up, ny * cam.tanY)))),
  };
}

/** Ray parameter where o + t·d meets the plane z = z0 (Infinity when parallel or behind). */
export function rayZ(o: Vec3, d: Vec3, z0: number): number {
  if (Math.abs(d[2]) < 1e-9) return Infinity;
  const t = (z0 - o[2]) / d[2];
  return t > 0 ? t : Infinity;
}

/** Ray parameter where o + t·d meets the plane through `p` with normal `n` (Infinity when parallel or behind). */
export function rayPlane(o: Vec3, d: Vec3, p: Vec3, n: Vec3): number {
  const den = dot(d, n);
  if (Math.abs(den) < 1e-9) return Infinity;
  const t = dot(sub(p, o), n) / den;
  return t > 0 ? t : Infinity;
}

/**
 * CSS `matrix3d()` (with `transform-origin: 0 0`) that draws an element laid out at viewport px (ox, oy) as if
 * its local px (x, y) sat on the reference plane z = 0, seen by `cam`. Rows are screen x·w and y·w relative to
 * the element's own box, a pass-through z (keeps the matrix invertible, which CSS requires) and w = view depth;
 * CSS lists the 16 values column by column.
 */
export function cssMatrixForPlane(cam: CameraBasis, w: number, h: number, ox: number, oy: number): string {
  const tanX = (cam.tanY * w) / h;
  // Affine maps from element px to view-space x / y / depth.
  const lin = (axis: Vec3): [number, number, number, number] => {
    const c = -dot(axis, [w / 2 - ox + cam.eye[0], h / 2 - oy + cam.eye[1], cam.eye[2]]);
    return [axis[0], axis[1], axis[2], c];
  };
  const X = lin(cam.right);
  const Y = lin(cam.up);
  const Z = lin(cam.fwd);
  const kx = w / (2 * tanX);
  const ky = h / (2 * cam.tanY);
  const rows = [
    X.map((v, i) => kx * v + (w / 2 - ox) * Z[i]),
    Y.map((v, i) => -ky * v + (h / 2 - oy) * Z[i]),
    [0, 0, 1, 0],
    Z,
  ];
  const cols: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) cols.push(rows[r][c]);
  return `matrix3d(${cols.map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toPrecision(9))).join(',')})`;
}
