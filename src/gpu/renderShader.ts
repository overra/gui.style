// The goo rendered as liquid glass, into a transparent overlay canvas around the button ("goo space": CSS px
// from the canvas' top-left). The page itself is a 2D canvas behind it; the same pixels are uploaded as `page`
// so the glass can refract them, and the button label is a separate mask printed on the page under the glass.
//
// Surface height = steep putty wall from the SDF (analytic) + simulated displacement (B-spline) + fingerprint
// detail. Shading is in linear light: dispersive refraction with a small apparent-depth lens term, Fresnel
// reflection of a procedural studio seen from a perspective eye, a GGX sun glint, Beer–Lambert body tint,
// vibrancy, and light on the page below (soft shadow, contact occlusion, caustics) evaluated where it lands.
// Output is premultiplied: opaque glass, shadow as black-with-alpha, nothing elsewhere.

import { sdRoundedBox2d } from '@typegpu/sdf';
import { tgpu, d, std } from 'typegpu';
import { GlassParams, MAX_SHAPES, Shape, Softbox } from './schemas.ts';

export const LabelParams = d.struct({
  plateColor: d.vec3f,
  plateAlpha: d.f32,
  inkColor: d.vec3f,
  inkAlpha: d.f32,
});

export const renderLayout = tgpu.bindGroupLayout({
  params: { uniform: GlassParams },
  shapes: { uniform: d.arrayOf(Shape, MAX_SHAPES) },
  label: { uniform: LabelParams },
  page: { texture: d.texture2d(d.f32) },
  labelMask: { texture: d.texture2d(d.f32) },
  sim: { texture: d.texture2d(d.f32) },
  cover: { texture: d.texture2d(d.f32) },
  detail: { texture: d.texture2d(d.f32) },
  smp: { sampler: 'filtering' },
});
const L = renderLayout;

const PI = Math.PI;
const LUMA = tgpu.const(d.vec3f, d.vec3f(0.2126, 0.7152, 0.0722));

// ───────────────────────────── geometry ─────────────────────────────

/** Rounded-box SDF with analytic gradient and iso-line curvature: (s, ∂s/∂x, ∂s/∂y, ∇²s), s < 0 inside. */
const sdgRoundedBox = (p: d.v2f, hs: d.v2f, r: number) => {
  'use gpu';
  const sx = std.select(d.f32(-1), d.f32(1), p.x >= 0);
  const sy = std.select(d.f32(-1), d.f32(1), p.y >= 0);
  const q = std.abs(p).sub(hs).add(r);
  let s = d.f32(0);
  let gx = d.f32(0);
  let gy = d.f32(0);
  let lap = d.f32(0);
  if (q.x > 0 && q.y > 0) {
    const l = std.length(q);
    s = l - r;
    gx = q.x / l;
    gy = q.y / l;
    lap = 1 / l;
  } else if (q.x > q.y) {
    s = q.x - r;
    gx = d.f32(1);
  } else {
    s = q.y - r;
    gy = d.f32(1);
  }
  return d.vec4f(s, gx * sx, gy * sy, lap);
};

/** Polynomial smooth union that carries (s, gradient, Laplacian). */
const sminG = (a: d.v4f, b: d.v4f, k: number) => {
  'use gpu';
  const h = std.max(k - std.abs(a.x - b.x), 0) / k;
  const m = std.select(1 - h * 0.5, h * 0.5, a.x < b.x);
  const dg = a.yz.sub(b.yz);
  const s = std.min(a.x, b.x) - h * h * k * 0.25;
  const g = std.mix(a.yz, b.yz, m);
  const neck = std.select(d.f32(0), std.dot(dg, dg) / (2 * k), h > 0);
  return d.vec4f(s, g.x, g.y, std.mix(a.w, b.w, m) - neck);
};

/** The goo footprint: union of all shapes. */
const footprint = (p: d.v2f) => {
  'use gpu';
  const P = L.$.params;
  let acc = d.vec4f(1e6, 0, 0, 0);
  for (let i = d.u32(0); i < P.shapeCount; i++) {
    const sh = L.$.shapes[i];
    const sg = sdgRoundedBox(p.sub(sh.center), sh.halfSize, sh.radius);
    if (i === 0) {
      acc = d.vec4f(sg);
    } else {
      acc = sminG(acc, sg, P.blend);
    }
  }
  return acc;
};

/**
 * Resting thickness H0 (1 - (1 - t)³)^(1/B), t = clamp(u / w), u = -s; returns (r, ∂r/∂x, ∂r/∂y, ∇²r).
 * B = 2 gives a vertical, non-wetting wall that still joins the flat top smoothly. `uFloor` keeps the contact
 * slope for anti-aliased pixels just outside the footprint (shading only).
 */
const restProfile = (sg: d.v4f, uFloor: number) => {
  'use gpu';
  const P = L.$.params;
  const u = -sg.x;
  const uc = std.max(u, uFloor);
  const t = std.clamp(uc / P.bezel, 1e-3, 1);
  const om = 1 - t;
  const gc = 1 - om * om * om;
  const gp = 3 * om * om;
  const gpp = -6 * om;
  const invB = 1 / P.steepness;
  const gb = std.pow(gc, invB);
  const r = std.select(d.f32(0), P.plateau * gb, u > 0);
  const band = std.select(d.f32(0), d.f32(1), uc > 0);
  const rt = P.plateau * invB * (gb / gc) * gp;
  const rtt = P.plateau * invB * ((invB - 1) * (gb / (gc * gc)) * gp * gp + (gb / gc) * gpp);
  const r1 = (rt / P.bezel) * band;
  const r2 = (rtt / (P.bezel * P.bezel)) * band;
  const g = sg.yz.mul(-r1);
  const lap = r2 * std.dot(sg.yz, sg.yz) - r1 * sg.w;
  return d.vec4f(r, g.x, g.y, lap);
};

/** Cubic B-spline (C2) of all four channels from 4 bilinear taps. `x` is in texels (centers at i + 0.5). */
const sampleBSpline = (tex: d.texture2d<d.F32>, x: d.v2f) => {
  'use gpu';
  const size = d.vec2f(std.textureDimensions(tex, 0));
  const xs = x.sub(0.5);
  const i = std.floor(xs);
  const f = xs.sub(i);
  const f2 = f.mul(f);
  const f3 = f2.mul(f);
  const omf = d.vec2f(1).sub(f);
  const w0 = omf.mul(omf).mul(omf).div(6);
  const w1 = f3.mul(0.5).sub(f2).add(2 / 3);
  const w3 = f3.div(6);
  const g0 = w0.add(w1);
  const g1 = d.vec2f(1).sub(g0);
  const inv = d.vec2f(1).div(size);
  const a = i.sub(0.5).add(w1.div(g0)).mul(inv);
  const b = i.add(1.5).add(w3.div(g1)).mul(inv);
  return std
    .textureSampleLevel(tex, L.$.smp, a, 0)
    .mul(g0.x * g0.y)
    .add(std.textureSampleLevel(tex, L.$.smp, d.vec2f(b.x, a.y), 0).mul(g1.x * g0.y))
    .add(std.textureSampleLevel(tex, L.$.smp, d.vec2f(a.x, b.y), 0).mul(g0.x * g1.y))
    .add(std.textureSampleLevel(tex, L.$.smp, b, 0).mul(g1.x * g1.y));
};

// ───────────────────────────── page ─────────────────────────────

/** The page alone at goo-space point q (linear light). */
const pageOnly = (q: d.v2f, lod: number) => {
  'use gpu';
  const P = L.$.params;
  return std.textureSampleLevel(L.$.page, L.$.smp, P.canvasOrigin.add(q).div(P.viewport), lod).xyz;
};

/** The page with the button label printed on it (only ever seen through the glass). */
const pageTap = (q: d.v2f, lod: number) => {
  'use gpu';
  const P = L.$.params;
  const lp = L.$.label;
  let col = pageOnly(q, lod);
  const uv = q.sub(P.labelOrigin).div(P.labelSize);
  if (uv.x > 0 && uv.y > 0 && uv.x < 1 && uv.y < 1) {
    const mask = std.textureSampleLevel(L.$.labelMask, L.$.smp, uv, lod);
    col = std.mix(col, lp.plateColor, mask.x * lp.plateAlpha);
    col = std.mix(col, lp.inkColor, mask.y * lp.inkAlpha);
  }
  return col;
};

// ───────────────────────────── refraction ─────────────────────────────

/** Transmitted direction for the view ray (0,0,-1) entering the glass; eta = 1/ior. */
const refractDir = (n: d.v3f, eta: number) => {
  'use gpu';
  const cosi = n.z;
  const k = 1 - eta * eta * (1 - cosi * cosi);
  const a = eta * cosi - std.sqrt(std.max(k, 0));
  return d.vec3f(n.x * a, n.y * a, n.z * a - eta);
};

/** How far a transmitted ray travels before meeting the page, ramped in as the dropped goo sets into glass. */
const lensDepth = (H: number) => {
  'use gpu';
  const P = L.$.params;
  return H * std.mix(0.4, 1, P.materialize) + P.depthLens * P.materialize;
};

/** Where the transmitted ray lands on the page after `depth` px (points up-slope, into the goo). */
const refractOffset = (n: d.v3f, eta: number, depth: number) => {
  'use gpu';
  const t = refractDir(n, eta);
  return t.xy.mul(depth / std.max(-t.z, 0.05));
};

/**
 * Three-tap dispersion (per-channel IOR). Where the red–blue split is far below a device pixel it fades to a
 * single tap — smoothly, since a hard switch shows up as a seam across high-contrast text.
 */
const sampleRefracted = (p: d.v2f, n: d.v3f, depth: number, lod: number) => {
  'use gpu';
  const P = L.$.params;
  const oR = refractOffset(n, 1 / std.mix(P.iorG, P.iorR, P.materialize), depth);
  const oG = refractOffset(n, 1 / P.iorG, depth);
  const oB = refractOffset(n, 1 / std.mix(P.iorG, P.iorB, P.materialize), depth);
  const cG = pageTap(p.add(oG), lod);
  let col = d.vec3f(cG);
  const spread = std.smoothstep(0.05, 0.25, std.length(oB.sub(oR)) / P.pxCss);
  if (spread > 0) {
    const split = d.vec3f(pageTap(p.add(oR), lod).x, cG.y, pageTap(p.add(oB), lod).z);
    col = std.mix(cG, split, spread);
  }
  return col;
};

// ───────────────────────────── environment / BRDF ─────────────────────────────

const softboxRadiance = (dir: d.v3f, sb: d.Infer<typeof Softbox>, fw: number) => {
  'use gpu';
  const cosA = std.dot(dir, sb.c);
  let out = d.vec3f(0);
  if (cosA > 0.1) {
    const xy = d.vec2f(std.dot(dir, sb.t), std.dot(dir, sb.b)).div(cosA);
    const s = sdRoundedBox2d(xy, sb.halfSize, sb.round);
    const e = sb.soft + fw / (cosA * cosA);
    const mask = 1 - std.smoothstep(-e, e, s);
    const hot = 1 - 0.25 * std.saturate(std.length(xy.div(sb.halfSize)));
    out = sb.radiance.mul(mask * hot);
  }
  return out;
};

/**
 * Procedural studio: sky gradient, a horizon ring brightest toward the key light and its opposite, three
 * softboxes; the lower hemisphere is the blurred page around the goo (what a downward reflection sees).
 */
const env = (dir: d.v3f, p: d.v2f, H: number, fw: number) => {
  'use gpu';
  const P = L.$.params;
  let col = std.mix(P.skyHorizon, P.skyZenith, std.sqrt(std.saturate(dir.z)));
  const az = std.normalize(dir.xy.add(d.vec2f(1e-5, 0)));
  const cphi = std.dot(az, std.normalize(P.lightDir.xy));
  const lobe = 0.3 + 0.7 * std.max(cphi, 0) ** 2 + 0.385 * std.max(-cphi, 0) ** 2;
  col = col.add(d.vec3f(std.exp(-((dir.z / 0.06) ** 2)) * P.horizonGain * lobe));
  col = col.add(softboxRadiance(dir, P.softboxes[0], fw));
  col = col.add(softboxRadiance(dir, P.softboxes[1], fw));
  col = col.add(softboxRadiance(dir, P.softboxes[2], fw));
  if (dir.z < 0.02) {
    const lat = std.min((std.length(dir.xy) * std.max(H, 1)) / std.max(-dir.z, 0.05), 60);
    const floorCol = pageOnly(p.add(az.mul(lat)), d.f32(4)).mul(P.groundGain);
    col = std.mix(col, floorCol, 1 - std.smoothstep(-0.12, 0.02, dir.z));
  }
  return col;
};

const fresnelSchlick = (cosT: number, f0: number) => {
  'use gpu';
  const m = 1 - std.saturate(cosT);
  const m2 = m * m;
  return f0 + (1 - f0) * m2 * m2 * m;
};

/** GGX with height-correlated Smith; widened by the sun's angular size and by pixel normal variance. */
const ggxSpecular = (n: d.v3f, v: d.v3f, l: d.v3f, rough: number, a2Filter: number, sunRadius: number) => {
  'use gpu';
  const a0 = std.max(rough * rough, 0.002);
  const a = std.min(a0 + 0.5 * sunRadius, 1);
  const a2 = std.min(a * a + a2Filter, 1);
  const h = std.normalize(v.add(l));
  const nh = std.saturate(std.dot(n, h));
  const nv = std.max(std.dot(n, v), 1e-4);
  const nl = std.saturate(std.dot(n, l));
  const dd = nh * nh * (a2 - 1) + 1;
  const D = a2 / (PI * dd * dd);
  const vis = 0.5 / std.max(nl * std.sqrt(nv * nv * (1 - a2) + a2) + nv * std.sqrt(nl * nl * (1 - a2) + a2), 1e-5);
  const F = fresnelSchlick(std.saturate(std.dot(v, h)), 0.04);
  return D * vis * F * nl * ((a0 * a0) / (a * a));
};

// ───────────────────────────── ground: shadow + caustics ─────────────────────────────

/** Logistic stand-in for a Gaussian-blurred step: ~1 inside (s << 0), ~0 outside. */
const softMask = (s: number, sigma: number) => {
  'use gpu';
  return 1 / (1 + std.exp(std.clamp((1.702 * s) / sigma, -30, 30)));
};

/** Macro thickness (rest + sim, no ridges) with one bilinear sim tap: (H, ∂H/∂x, ∂H/∂y, ∇²H). */
const macroAt = (q: d.v2f) => {
  'use gpu';
  const P = L.$.params;
  const size = d.vec2f(std.textureDimensions(L.$.sim, 0));
  const rest = restProfile(footprint(q), d.f32(0));
  return rest.add(std.textureSampleLevel(L.$.sim, L.$.smp, q.div(P.simCell).div(size), 0));
};

/**
 * Light reaching the page at q: soft directional shadow (the clear interior transmits), contact occlusion,
 * and caustics as the paraxial flux ratio, evaluated where the light landing at q entered the glass. Used at
 * the refracted landing point for covered pixels and at the pixel itself otherwise, so there is no seam.
 */
const groundLight = (q: d.v2f) => {
  'use gpu';
  const P = L.$.params;
  const fp = footprint(q);
  const s0 = fp.x;
  let gl = d.vec3f(1);
  if (s0 < P.shadowReach + 4 * P.shadowSigma + 8) {
    const lh = std.normalize(P.lightDir.xy);
    const toLight = q.add(lh.mul(P.shadowReach));
    const sSh = footprint(toLight).x;
    // Shadow and contact occlusion come from putty that is actually there (the dropped blob starts narrower
    // than its resting footprint).
    const caster = std.smoothstep(0.3, 2.5, macroAt(toLight.sub(footprint(toLight).yz.mul(std.max(sSh, 0) + 4))).x);
    const edge = std.smoothstep(0.3, 2.5, macroAt(q.sub(fp.yz.mul(std.max(s0, 0) + 2))).x);
    const under = softMask(s0 + 1, 1.5);
    const shadow = P.shadowOpacity * softMask(sSh, P.shadowSigma) * (1 - under) * caster;
    const ao = P.aoOpacity * std.exp(-std.max(s0, 0) / P.aoWidth) * std.smoothstep(-0.5, 0.5, s0) * edge;
    const sinT = std.length(P.lightDir.xy) / P.iorG;
    const tanT = sinT / std.sqrt(1 - sinT * sinT);
    const Hq = std.max(macroAt(q).x, 0);
    const m = macroAt(q.add(lh.mul(Hq * tanT)));
    const det = 1 + P.causticC * (std.dot(m.yz, m.yz) + std.max(m.x, 0) * m.w);
    const gain = std.clamp(1 / std.max(det, 0.2), P.causticMin, P.causticMax);
    const caustic = std.mix(1, gain, std.saturate(m.x / 0.75));
    gl = d.vec3f((1 - shadow) * (1 - ao) * caustic + P.causticAdd * std.max(caustic - 1, 0));
  }
  return gl;
};

// ───────────────────────────── output transforms ─────────────────────────────

/** Identity below 0.8, smooth roll-off to 1 above, so HDR highlights don't clip and the page is untouched. */
const highlightShoulder = (c: d.v3f) => {
  'use gpu';
  const k = d.f32(0.8);
  const rolled = std
    .exp(std.max(c.sub(k), d.vec3f(0)).mul(-1 / (1 - k)))
    .mul(-(1 - k))
    .add(1);
  return std.select(rolled, c, std.le(c, d.vec3f(k)));
};

const linearToSrgb = (c: d.v3f) => {
  'use gpu';
  const lo = c.mul(12.92);
  const hi = std.pow(std.max(c, d.vec3f(0)), d.vec3f(1 / 2.4)).mul(1.055).sub(0.055);
  return std.select(hi, lo, std.le(c, d.vec3f(0.0031308)));
};

const ign = (px: d.v2f) => {
  'use gpu';
  return std.fract(52.9829189 * std.fract(0.06711056 * px.x + 0.00583715 * px.y));
};

/** Triangular-PDF dither, ±1 LSB of 8-bit output (gradients and glows don't band). */
const ditherTPDF = (px: d.v2f) => {
  'use gpu';
  return (ign(px) + ign(px.add(d.vec2f(5.588238, 5.588238))) - 1) / 255;
};

// ───────────────────────────── surface ─────────────────────────────

const Surface = d.struct({
  n: d.vec3f,
  cov: d.f32,
  sg: d.vec4f,
  H: d.f32,
  haze: d.f32,
});

const surfaceAt = (p: d.v2f) => {
  'use gpu';
  const P = L.$.params;
  const sg = footprint(p);
  const rest = restProfile(sg, d.f32(0));
  const restS = restProfile(sg, 0.5 * P.pxCss);
  const sim = sampleBSpline(L.$.sim, p.div(P.simCell));
  const det = sampleBSpline(L.$.detail, p.div(P.detailTexel));
  const Hm = rest.x + sim.x;
  // Ridges only exist where there is goo to carry them.
  const carry = std.smoothstep(0.2, 2, Hm);
  // Outside the rest footprint a bulge uses its own slope, not the extrapolated contact slope.
  const bulge = std.saturate(sim.x) * std.select(d.f32(0), d.f32(1), sg.x > 0);
  const gS = std.mix(restS.yz, rest.yz, bulge).add(sim.yz).add(det.yz.mul(carry));
  // Coverage: the resting silhouette comes from the SDF (exact even for a vertical wall); material pushed past
  // it comes from the simulated height. While the dropped blob is still liquid and narrower than its footprint,
  // the total height at grid resolution decides where there is goo (the bicubic sim can't cancel the analytic
  // wall exactly, which would leave a sliver of glass along the resting outline).
  const covRest = std.saturate(0.5 - sg.x / P.pxCss);
  const hc = sampleBSpline(L.$.cover, p.div(P.simCell)).x;
  const thin = std.mix(std.smoothstep(P.filmEps, P.filmEps + 0.8, hc), 1, std.smoothstep(0.6, 0.95, P.materialize));
  const covBulge = std.saturate(0.5 + (sim.x - P.filmEps) / (std.clamp(std.length(sim.yz), 1, 8) * P.pxCss));
  const cov = std.max(covRest * thin, covBulge * std.select(d.f32(0), d.f32(1), sg.x > -1));
  return Surface({
    n: std.normalize(d.vec3f(gS.mul(-1), 1)),
    cov,
    sg,
    H: std.max(Hm + det.x * carry, 0),
    haze: det.w * carry,
  });
};

/** Everything about a covered pixel that doesn't need screen-space derivatives. */
const shadeGoo = (
  p: d.v2f,
  sg: d.v4f,
  n: d.v3f,
  v: d.v3f,
  r: d.v3f,
  H: number,
  haze: number,
  q: d.v2f,
  lod: number,
  fwR: number,
  a2Filter: number,
) => {
  'use gpu';
  const P = L.$.params;
  // Transmitted: the page where the ray lands, lit by the light reaching it there, two-way Beer–Lambert, vibrancy.
  // While the dropped goo is still liquid it lenses less; the glass "materializes" as it sets.
  let trans = sampleRefracted(p, n, lensDepth(H), lod).mul(groundLight(q));
  const tz = std.max(-refractDir(n, 1 / P.iorG).z, 0.2);
  trans = trans.mul(std.exp(P.absorb.mul(-H * (1 / tz + 1))));
  const Y = std.dot(trans, LUMA.$);
  trans = std.max(std.mix(d.vec3f(Y), trans, P.saturation), d.vec3f(0));
  trans = std.mix(trans, d.vec3f(1), P.lift + 0.035 * haze);
  // Reflection, fading in as the dropped goo sets into glass.
  const shine = 0.35 + 0.65 * P.materialize;
  const F = fresnelSchlick(std.dot(n, v), 0.04);
  const refl = env(r, p, H, fwR).mul(F * shine);
  const spec = P.lightColor.mul(
    ggxSpecular(n, v, P.lightDir, P.roughness + P.hazeRoughness * haze, a2Filter, P.sunRadius) * shine,
  );
  // Edge glint: thin and light-facing, weaker on the far side (an internal-reflection cue).
  const cL = std.dot(std.normalize(sg.yz.add(d.vec2f(1e-6, 0))), std.normalize(P.lightDir.xy));
  const lobe = std.max(cL, 0) ** 2 + P.glintOpposite * std.max(-cL, 0) ** 2;
  const glint = P.glint * lobe * std.exp(-std.max(-sg.x, 0) / P.glintWidth) * shine;
  // Touch glow: the glass lights up from within under the finger.
  const gd = p.sub(P.glowCenter);
  const glow = P.glowAmount * std.exp(-std.dot(gd, gd) / (2 * P.glowRadius * P.glowRadius));
  return trans
    .mul(1 - F)
    .add(refl)
    .add(spec)
    .add(d.vec3f(glint + glow));
};

export const gooFragment = tgpu.fragmentFn({
  in: { pos: d.builtin.position },
  out: d.vec4f,
})(({ pos }) => {
  'use gpu';
  const P = L.$.params;
  const p = pos.xy.mul(P.pxCss);
  const S = surfaceAt(p);

  // Derivative-dependent terms, in uniform control flow (no data-dependent branches above this line).
  const q = p.add(refractOffset(S.n, 1 / P.iorG, lensDepth(S.H)));
  const fq = std.fwidth(q).div(P.pxCss);
  const lodLens = std.clamp(std.log2(std.max(std.max(fq.x, fq.y), 1)), 0, P.lodMax);
  const lod = lodLens + P.rimLod * (1 - std.smoothstep(0, 6, -S.sg.x)) + P.hazeLod * S.haze;
  const eye = P.viewport.mul(0.5).sub(P.canvasOrigin.add(p));
  const v = std.normalize(d.vec3f(eye.div(P.eyeDist), 1));
  const r = std.reflect(v.mul(-1), S.n);
  const fwR = std.length(std.fwidth(r));
  const dndx = std.dpdx(S.n);
  const dndy = std.dpdy(S.n);
  const a2Filter = std.min(0.5 * (std.dot(dndx, dndx) + std.dot(dndy, dndy)), 0.18);

  // Backdrop: express the light reaching the page as an over-operation on the page canvas behind us.
  let outA = d.f32(0);
  let outW = d.f32(0);
  if (S.cov < 1) {
    const g = std.dot(groundLight(p), LUMA.$);
    const bgY = std.dot(pageOnly(p, d.f32(0)), LUMA.$);
    const eNow = std.pow(std.max(bgY, 1e-5), 1 / 2.2);
    const eWant = std.pow(std.min(bgY * g, 1), 1 / 2.2);
    const kLite = std.saturate((eWant - eNow) / std.max(1 - eNow, 0.02));
    const aDark = 1 - std.pow(std.min(g, 1), 1 / 2.2);
    outA = std.select(aDark, kLite, g > 1);
    outW = std.select(d.f32(0), kLite, g > 1);
  }
  let enc = d.vec3f(0);
  if (S.cov > 0) {
    const inside = shadeGoo(p, S.sg, S.n, v, r, S.H, S.haze, q, lod, fwR, a2Filter);
    enc = std.saturate(linearToSrgb(highlightShoulder(inside)).add(d.vec3f(ditherTPDF(pos.xy))));
  }
  const a = S.cov + outA * (1 - S.cov);
  const rgb = enc.mul(S.cov).add(d.vec3f(outW * (1 - S.cov)));
  return d.vec4f(std.min(rgb, d.vec3f(a)), a);
});
