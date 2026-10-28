// Fingerprint detail layer (0.5 CSS px per texel): (ridge height, ∂/∂x, ∂/∂y, touch haze).
// While a finger presses, its ridge pattern — with an exact analytic gradient — is printed into the surface.
// Every frame the layer fades and is smoothed with a biharmonic stencil, which flattens fine ridges and their
// sharp crests first (like capillary leveling). Height and gradient channels get the same linear treatment.

import { perlin2d } from '@typegpu/noise';
import { tgpu, d, std } from 'typegpu';
import { DetailParams, Finger, MAX_FINGERS } from './schemas.ts';
import { toFinger } from './simKernels.ts';

const PI = Math.PI;
const TAU = Math.PI * 2;

export const detailLayout = tgpu.bindGroupLayout({
  params: { uniform: DetailParams },
  fingers: { uniform: d.arrayOf(Finger, MAX_FINGERS) },
  src: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
  dst: { storageTexture: d.textureStorage2d('rgba32float', 'write-only') },
});

export const detailPackLayout = tgpu.bindGroupLayout({
  src: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
  packOut: { storageTexture: d.textureStorage2d('rgba16float', 'write-only') },
});

const hash11 = (x: number) => {
  'use gpu';
  return std.fract(std.sin(x * 12.9898 + 4.1414) * 43758.5453);
};

/** Rotates a finger-frame vector back to goo space (inverse of `toFinger`). */
const fromFinger = (v: d.v2f, rot: d.v2f) => {
  'use gpu';
  return d.vec2f(v.x * rot.x - v.y * rot.y, v.x * rot.y + v.y * rot.x);
};

/**
 * Zero-mean ridge relief and its gradient at `l` (CSS px, finger frame; -y points to the fingertip):
 * vec3(h, ∂h/∂x, ∂h/∂y) with h in [-0.5, 0.5]-ish units. The phase is a loop (U-shaped ridges recurving over a
 * core) or a whorl (closed ellipses), with a low-frequency wobble and four phase vortices (ridge endings and
 * bifurcations). Ridges fade analytically before they would alias at `pxCss` CSS px per device pixel.
 */
export const fingerprint = (l: d.v2f, axes: d.v2f, period: number, seed: number, pxCss: number) => {
  'use gpu';
  const whorl = std.select(d.f32(0), d.f32(1), std.fract(seed * 0.1337) > 0.62);
  const kE = d.f32(1.3);
  const v = l.sub(d.vec2f(0, axes.y * -0.15));
  const above = std.select(d.f32(0), d.f32(1), v.y > 0);
  const dvy = std.mix(above, 1, whorl) * kE;
  const vy = std.mix(std.max(v.y, 0), v.y, whorl) * kE;
  const rr = std.max(std.sqrt(v.x * v.x + vy * vy), 1e-3);
  let psi = rr;
  let g = d.vec2f(v.x / rr, (vy * dvy) / rr);
  // Low-frequency wobble.
  const lam = period * 5;
  const nz = perlin2d.sampleWithGradient(l.div(lam).add(d.vec2f(seed * 7.31, seed * 3.17)));
  psi = psi + period * 0.45 * nz.x;
  g = g.add(nz.yz.mul((period * 0.45) / lam));
  // Minutiae: ±1 phase windings.
  for (let k = d.u32(0); k < 4; k++) {
    const kk = d.f32(k);
    const m = d
      .vec2f(hash11(seed + kk * 1.37), hash11(seed + kk * 2.91 + 7))
      .mul(1.4)
      .sub(0.7)
      .mul(axes);
    const sk = std.select(d.f32(-1), d.f32(1), hash11(seed + kk * 5.17 + 3) > 0.5);
    const dm = l.sub(m);
    const r2 = std.max(std.dot(dm, dm), 0.25);
    psi = psi + (sk * period * std.atan2(dm.y, dm.x)) / TAU;
    g = g.add(d.vec2f(-dm.y, dm.x).mul((sk * period) / (TAU * r2)));
  }
  // Fresh ridges have sharp crests: ((1 + cos)/2)^p, zero-mean; relaxed to a sinusoid near the pixel limit.
  const phi = psi / period;
  const gphi = g.div(period);
  const fw = std.length(gphi) * pxCss * 1.2;
  const aa = 1 - std.smoothstep(0.2, 0.45, fw);
  const pe = std.mix(1, 3, 1 - std.smoothstep(0.08, 0.2, fw));
  const c = std.max(0.5 + 0.5 * std.cos(TAU * phi), 1e-4);
  const cp = std.pow(c, pe);
  const prof = cp - 1 / std.sqrt(PI * (pe + 0.25));
  const dprof = -pe * (cp / c) * PI * std.sin(TAU * phi);
  const gh = gphi.mul(dprof * aa);
  return d.vec3f(prof * aa, gh.x, gh.y);
};

const loadDetail = (p: d.v2i, dims: d.v2u) => {
  'use gpu';
  return std.textureLoad(detailLayout.$.src, std.clamp(p, d.vec2i(0), d.vec2i(dims).sub(1)), 0).xyz;
};

export const detailKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(detailLayout.$.src);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const dp = detailLayout.$.params;
  const p = d.vec2i(gid.xy);
  const c = std.textureLoad(detailLayout.$.src, p, 0);

  // 13-point biharmonic stencil, applied alike to the height and its gradient.
  const near = loadDetail(p.add(d.vec2i(-1, 0)), dims)
    .add(loadDetail(p.add(d.vec2i(1, 0)), dims))
    .add(loadDetail(p.add(d.vec2i(0, -1)), dims))
    .add(loadDetail(p.add(d.vec2i(0, 1)), dims));
  const diag = loadDetail(p.add(d.vec2i(-1, -1)), dims)
    .add(loadDetail(p.add(d.vec2i(1, -1)), dims))
    .add(loadDetail(p.add(d.vec2i(-1, 1)), dims))
    .add(loadDetail(p.add(d.vec2i(1, 1)), dims));
  const far = loadDetail(p.add(d.vec2i(-2, 0)), dims)
    .add(loadDetail(p.add(d.vec2i(2, 0)), dims))
    .add(loadDetail(p.add(d.vec2i(0, -2)), dims))
    .add(loadDetail(p.add(d.vec2i(0, 2)), dims));
  const biharmonic = c.xyz.mul(20).sub(near.mul(8)).add(diag.mul(2)).add(far);

  let ridge = c.xyz.mul(dp.fade).sub(biharmonic.mul(dp.smoothing));
  let haze = c.w * dp.hazeFade;

  const x = d.vec2f(gid.xy).add(0.5).mul(dp.texel);
  for (let i = d.u32(0); i < dp.fingerCount; i++) {
    const f = detailLayout.$.fingers[i];
    if (f.contact > 0) {
      const q = toFinger(x.sub(f.pos), f.rot);
      const rho = std.length(q.div(std.max(f.reach, d.vec2f(1e-3))));
      if (rho < 1) {
        const mask = (1 - std.smoothstep(0.72, 1, rho)) * f.contact * f.skin;
        // Skin ridges press grooves (zero-mean, so the dent itself stays the simulation's job).
        const fp = fingerprint(q, f.axes, dp.period, f.seed, dp.pxCss);
        const grad = fromFinger(fp.yz, f.rot);
        const print = d.vec3f(fp.x, grad.x, grad.y).mul(-dp.depth);
        ridge = std.mix(ridge, print, mask * dp.stamp);
        haze = std.max(haze, mask);
      }
    }
  }
  std.textureStore(detailLayout.$.dst, gid.xy, d.vec4f(ridge, haze));
});

/** Copies the detail state into a filterable texture for rendering. */
export const detailPackKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(detailPackLayout.$.src);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  std.textureStore(detailPackLayout.$.packOut, gid.xy, std.textureLoad(detailPackLayout.$.src, d.vec2i(gid.xy), 0));
});
