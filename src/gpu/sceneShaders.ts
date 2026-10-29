// Config mode: the scene ray-traced from an orbit camera into a full-viewport canvas. World frame = the flat
// shader's screen frame (x right, y down, z toward the viewer, CSS px), origin at the viewport center on the
// reference plane z = 0, where the goo sits. The page plane lies at z = planeZ ≤ 0. The page stands upright: world
// up is screen-up (−y), so the backdrop is lighter above eye level and the page plane's extension is a gridded wall.
// The glass's studio stays page-relative (its zenith is the page's axis, +z), as a screen reflects the room in
// front of it.
//
// One full-screen pass finds the nearest of: the goo height field (marched at grid resolution, then bisected),
// the page plane (seen from either side), the light emitters and two probe balls. The goo reuses the flat shader's
// surface and glass terms (renderShader.ts), generalized from the fixed straight-on view ray to the real one:
// refraction through the curved top, out of the flat bottom (Snell again) and across the air gap to the page. A
// second pass draws gizmo lines and dots, dimmed where the scene hides them (it reads the first pass's view depth).
//
// The goo has its own frame (scene.ts: gooFrame): it floats, sinks and tilts with the levitation pose. Rays are
// marched in that frame, so the height field and its lookups stay exactly the flat shader's.
//
// Derivatives (LOD, normal filtering) are taken in uniform control flow: every pixel evaluates the surface at
// its goo hit or, failing that, at its page-plane point; loops have fixed trip counts and sample with explicit
// LOD inside their branches.

import { sdRoundedBox2d } from '@typegpu/sdf';
import { tgpu, d, std } from 'typegpu';
import {
  ditherTPDF,
  env,
  footprint,
  fresnelSchlick,
  ggxSpecular,
  groundLight,
  highlightShoulder,
  labelOver,
  linearToSrgb,
  LUMA,
  pageOnly,
  renderLayout,
  restProfile,
  surfaceAt,
} from './renderShader.ts';

const L = renderLayout;

export const MAX_LIGHTS = 4;
export const MAX_SEGMENTS = 768;
export const MAX_DOTS = 64;

const BIG = 1e9;
const MARCH = 96;
const PI = Math.PI;
/** Screen-up, the 3D view's world up. */
const WORLD_UP = tgpu.const(d.vec3f, d.vec3f(0, -1, 0));
/** The page seen from behind: a dark, unprinted back. */
const PAGE_BACK = tgpu.const(d.vec3f, d.vec3f(0.03, 0.032, 0.036));

export const SceneLight = d.struct({
  /** Emitter center (world). */
  pos: d.vec3f,
  /** 0 = sun (a sphere; directional for shading), 1 = softbox (rounded rectangle facing the rig target). */
  kind: d.f32,
  /** Unit direction from the rig target toward the light. */
  dir: d.vec3f,
  /** Sun: physical radius (CSS px). */
  radius: d.f32,
  axisT: d.vec3f,
  halfT: d.f32,
  axisB: d.vec3f,
  halfB: d.f32,
  /** Softbox radiance, or the sun's irradiance at normal incidence (linear). */
  radiance: d.vec3f,
  corner: d.f32,
  /** What an eye ray sees on the emitter (the sun's radiance is E / (π α²)). */
  glow: d.vec3f,
  pad0: d.f32,
});

export const SceneParams = d.struct({
  /** Orbit camera: eye, orthonormal basis, half-FOV tangents. */
  eye: d.vec3f,
  tanY: d.f32,
  rightV: d.vec3f,
  tanX: d.f32,
  upV: d.vec3f,
  near: d.f32,
  fwd: d.vec3f,
  /** Device px per CSS px of the scene canvas. */
  dpr: d.f32,
  resolution: d.vec2f,
  /** The client viewport (CSS px) = the reference plane's extent. */
  viewportCss: d.vec2f,
  /** The goo canvas' size (CSS px): the extent of goo space. */
  gooSize: d.vec2f,
  /**
   * The goo's own frame: world = gooOrigin + gooScale·(x·gooX + y·gooY + h·gooZ) for goo-space (x, y) and height
   * h above its flat base (scene.ts: gooFrame).
   */
  gooOrigin: d.vec3f,
  gooScale: d.f32,
  gooX: d.vec3f,
  gooY: d.vec3f,
  gooZ: d.vec3f,
  planeZ: d.f32,
  /** World units per page CSS px. */
  planeScale: d.f32,
  /** 0 = self-lit page (as in normal mode), 1 = matte paper lit by the scene lights. */
  pageLit: d.f32,
  gooTop: d.f32,
  /** Probe balls (center, radius); radius 0 hides them. */
  probeA: d.vec4f,
  probeB: d.vec4f,
  voidTop: d.vec3f,
  gridAlpha: d.f32,
  voidBottom: d.vec3f,
  /** Opacity of the html-in-canvas UI plane (0 when the CSS 3D fallback draws the UI). */
  uiAlpha: d.f32,
  irradianceRef: d.f32,
  lightCount: d.u32,
  /**
   * 0 looking through the scene camera → 1 in the orbit view: light emitters, gizmos and the studio backdrop
   * fade in with it, so the camera's own view matches normal mode (lights are invisible to camera rays there,
   * as in a studio render; reflections still see them).
   */
  overlay: d.f32,
  pad1: d.f32,
  /** Where the UI texture sits on the reference plane: viewport CSS px (x, y, w, h). */
  uiRect: d.vec4f,
  lights: d.arrayOf(SceneLight, MAX_LIGHTS),
});

/** A gizmo line segment (world endpoints, width in CSS px, dash period in world px, straight RGBA). */
export const Segment = d.struct({
  a: d.vec3f,
  width: d.f32,
  b: d.vec3f,
  dash: d.f32,
  color: d.vec4f,
});

/** A camera-facing dot (world center, radius in CSS px, straight RGBA; ring > 0 draws a ring that wide). */
export const Dot = d.struct({
  center: d.vec3f,
  radius: d.f32,
  color: d.vec4f,
  ring: d.f32,
  pad0: d.f32,
  pad1: d.f32,
  pad2: d.f32,
});

export const sceneLayout = tgpu.bindGroupLayout({
  scene: { uniform: SceneParams },
  /** The live DOM UI (html-in-canvas), premultiplied; 1×1 transparent when unused. */
  ui: { texture: d.texture2d(d.f32) },
});

export const gizmoLayout = tgpu.bindGroupLayout({
  scene: { uniform: SceneParams },
  depth: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
  segments: { storage: d.arrayOf(Segment, MAX_SEGMENTS) },
  dots: { storage: d.arrayOf(Dot, MAX_DOTS) },
});

// ───────────────────────────── ray helpers ─────────────────────────────

/** Ray / axis-aligned box: (t entry, t exit). */
const rayBox = (o: d.v3f, invD: d.v3f, lo: d.v3f, hi: d.v3f) => {
  'use gpu';
  const t0 = lo.sub(o).mul(invD);
  const t1 = hi.sub(o).mul(invD);
  const tn = std.min(t0, t1);
  const tf = std.max(t0, t1);
  return d.vec2f(std.max(std.max(tn.x, tn.y), tn.z), std.min(std.min(tf.x, tf.y), tf.z));
};

/** Nearest positive hit of a ray with a sphere (center, radius), or BIG. */
const raySphere = (o: d.v3f, dir: d.v3f, sph: d.v4f) => {
  'use gpu';
  const oc = o.sub(sph.xyz);
  const b = std.dot(oc, dir);
  const h = b * b - (std.dot(oc, oc) - sph.w * sph.w);
  let t = d.f32(BIG);
  if (h > 0 && sph.w > 0) {
    const t0 = -b - std.sqrt(h);
    if (t0 > 0) {
      t = t0;
    }
  }
  return t;
};

/** Ray parameter on the plane z = z0 from its front (+z) side only (BIG otherwise). */
const rayToZFront = (o: d.v3f, dir: d.v3f, z0: number) => {
  'use gpu';
  return std.select(d.f32(BIG), (z0 - o.z) / std.min(dir.z, -1e-6), dir.z < -1e-6 && o.z > z0);
};

/** Ray parameter on the plane z = z0 from either side (BIG when parallel or behind the origin). */
const rayToZ = (o: d.v3f, dir: d.v3f, z0: number) => {
  'use gpu';
  const ok = std.abs(dir.z) >= 1e-6;
  const t = (z0 - o.z) / std.select(d.f32(1e-6), dir.z, ok);
  return std.select(d.f32(BIG), t, ok && t > 0);
};

/**
 * Goo thickness at goo-space point g for ray marching: the exact resting profile (so silhouettes follow the
 * SDF, not the 3 px grid) plus one bilinear tap of the simulated displacement.
 */
const heightAt = (g: d.v2f) => {
  'use gpu';
  const P = L.$.params;
  const size = d.vec2f(std.textureDimensions(L.$.sim, 0));
  const tap = g.div(P.simCell).div(size);
  const disp = std.textureSampleLevel(L.$.sim, L.$.smp, tap, 0).x * P.imprintGain;
  // Plus the settled sag (cover .y), drawn as is, inside the resting outline (its lip past it isn't drawn, as in
  // the flat shader's coverage).
  const sg = footprint(g);
  const settled = std.textureSampleLevel(L.$.cover, L.$.smp, tap, 0).y * std.select(d.f32(1), d.f32(0), sg.x > 0);
  return restProfile(sg, d.f32(0)).x + disp + settled;
};

/** World → goo space: (x, y, height above the goo's base). */
const toGoo = (w: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  const r = w.sub(S.gooOrigin);
  return d.vec3f(std.dot(r, S.gooX), std.dot(r, S.gooY), std.dot(r, S.gooZ)).div(S.gooScale);
};

/** A world direction in goo units. It keeps the world ray parameter: toGoo(o + t·v) = toGoo(o) + t·toGooDir(v). */
const toGooDir = (v: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  return d.vec3f(std.dot(v, S.gooX), std.dot(v, S.gooY), std.dot(v, S.gooZ)).div(S.gooScale);
};

/** Goo space → world. */
const fromGoo = (g: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  return S.gooOrigin.add(S.gooX.mul(g.x).add(S.gooY.mul(g.y)).add(S.gooZ.mul(g.z)).mul(S.gooScale));
};

/** A goo-frame direction or normal in the world. */
const gooToWorldDir = (v: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  return S.gooX.mul(v.x).add(S.gooY.mul(v.y)).add(S.gooZ.mul(v.z));
};

/** Page canvas CSS px − the goo canvas origin (the space pageTap / pageOnly take) for a page-plane point. */
const pageQ = (wxy: d.v2f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  return wxy.div(S.planeScale).add(S.viewportCss.mul(0.5)).sub(L.$.params.canvasOrigin);
};

/** Where the key light crossed the goo's (floating, tilted) base on its way to page-plane point wxy, in goo space. */
const shadowQ = (wxy: d.v2f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  const ld = L.$.params.lightDir;
  const p = d.vec3f(wxy, S.planeZ);
  const t = std.dot(S.gooOrigin.sub(p), S.gooZ) / std.max(std.dot(ld, S.gooZ), 0.05);
  return toGoo(p.add(ld.mul(t))).xy;
};

/** Where a transmitted ray meets the glass' base (goo space; the label is printed there) and the page (world xy). */
const Landing = d.struct({ base: d.vec2f, page: d.vec2f });

/**
 * A ray entering the goo top at goo-space point g (height h) along dir, normal n (both world). Snell into the
 * glass, straight down to the flat base in the goo's own frame (the liquid intro blob lenses less, and look.ts's
 * apparent-depth standoff is kept), Snell out through the base, then across the air gap to the page plane.
 */
const landing = (g: d.v2f, h: number, dir: d.v3f, n: d.v3f, eta: number) => {
  'use gpu';
  const P = L.$.params;
  const S = sceneLayout.$.scene;
  const tg = std.refract(dir, n, eta);
  const tb = d.vec3f(std.dot(tg, S.gooX), std.dot(tg, S.gooY), std.dot(tg, S.gooZ));
  const depth = h * std.mix(0.4, 1, P.materialize) + P.depthLens * P.materialize;
  const onBase = g.add(tb.xy.mul(depth / std.max(-tb.z, 0.05)));
  const wBase = fromGoo(d.vec3f(onBase, 0));
  const ta = std.refract(tg, S.gooZ, 1 / eta);
  const exit = std.select(tg, ta, std.dot(ta, ta) > 0.25);
  const onPage = wBase.xy.add(exit.xy.mul(std.max(wBase.z - S.planeZ, 0) / std.max(-exit.z, 0.05)));
  return Landing({ base: onBase, page: onPage });
};

// ───────────────────────────── lighting for matte things ─────────────────────────────

/** Irradiance from the scene lights at p with normal n (softboxes as small area lights). */
const irradiance = (p: d.v3f, n: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  let e = d.vec3f(0);
  for (let i = d.u32(0); i < S.lightCount; i++) {
    const l = S.lights[i];
    if (l.kind < 0.5) {
      e = e.add(l.radiance.mul(std.max(std.dot(n, l.dir), 0)));
    } else {
      const toL = l.pos.sub(p);
      const r2 = std.max(std.dot(toL, toL), 1);
      const r = std.sqrt(r2);
      const facing = std.max(std.dot(toL, l.dir) / r, 0);
      const cosR = std.max(std.dot(n, toL) / r, 0);
      e = e.add(l.radiance.mul((4 * l.halfT * l.halfB * facing * cosR) / r2));
    }
  }
  return e;
};

/** Sky light on a surface facing n. Its zenith is the page's axis (+z): the glass's studio, which the probes see. */
const ambient = (n: d.v3f) => {
  'use gpu';
  const P = L.$.params;
  return std.mix(P.skyHorizon, P.skyZenith, std.saturate(n.z * 0.5 + 0.5)).mul(PI);
};

/** Page lighting: 1 for the self-lit page, scene irradiance (normalized at the goo) for paper. */
const paperLight = (p: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  let k = d.vec3f(1);
  if (S.pageLit > 0) {
    const n = d.vec3f(0, 0, 1);
    const e = irradiance(p, n).add(ambient(n));
    k = std.mix(d.vec3f(1), e.div(S.irradianceRef), S.pageLit);
  }
  return k;
};

/** Nearest emitter along a ray: (t, what it shows). */
const EmitterHit = d.struct({ t: d.f32, col: d.vec3f });

const traceEmitters = (o: d.v3f, dir: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  let tBest = d.f32(BIG);
  let col = d.vec3f(0);
  for (let i = d.u32(0); i < S.lightCount; i++) {
    const l = S.lights[i];
    if (l.kind < 0.5) {
      const t = raySphere(o, dir, d.vec4f(l.pos, l.radius));
      if (t < tBest) {
        tBest = t;
        col = d.vec3f(l.glow);
      }
    } else {
      const nl = l.dir.mul(-1);
      const den = std.dot(dir, nl);
      if (std.abs(den) > 1e-5) {
        const t = std.dot(l.pos.sub(o), nl) / den;
        const w = o.add(dir.mul(t)).sub(l.pos);
        const s = sdRoundedBox2d(d.vec2f(std.dot(w, l.axisT), std.dot(w, l.axisB)), d.vec2f(l.halfT, l.halfB), l.corner);
        if (t > 0 && t < tBest && s < 0) {
          tBest = t;
          // The diffuser faces the rig target; the back is a dark panel.
          col = std.select(d.vec3f(0.012, 0.013, 0.016), l.glow, den < 0);
        }
      }
    }
  }
  return EmitterHit({ t: tBest, col: col });
};

/** Backdrop: a soft gradient, lighter above eye level, and a grid on the page plane's endless extension (a wall). */
const backdrop = (dir: d.v3f, grid: number) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  const sky = std.mix(S.voidBottom, S.voidTop, std.saturate(std.dot(dir, WORLD_UP.$) * 0.7 + 0.5));
  return sky.add(d.vec3f(grid * S.gridAlpha));
};

/** What the chrome probe reflects: emitters, the page plane, the backdrop. */
const chromeEnv = (o: d.v3f, r: d.v3f) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  let col = backdrop(r, d.f32(0));
  let tBest = d.f32(BIG);
  const tp = rayToZFront(o, r, S.planeZ);
  if (tp < BIG * 0.5) {
    const w = o.add(r.mul(tp));
    const px = w.xy.div(S.planeScale).add(S.viewportCss.mul(0.5));
    if (px.x > 0 && px.y > 0 && px.x < S.viewportCss.x && px.y < S.viewportCss.y) {
      col = pageOnly(pageQ(w.xy), d.f32(1.5)).mul(paperLight(w));
      tBest = tp;
    }
  }
  const em = traceEmitters(o, r);
  if (em.t < tBest) {
    col = d.vec3f(em.col);
  }
  return col;
};

// ───────────────────────────── the goo along a real view ray ─────────────────────────────

/** shadeGoo from renderShader.ts, with the view ray `dir` instead of (0, 0, −1); g, h: the hit in goo space. */
const shadeGoo3d = (
  g: d.v2f,
  h: number,
  dir: d.v3f,
  n: d.v3f,
  sg: d.v4f,
  H: number,
  haze: number,
  lod: number,
  fwR: number,
  a2Filter: number,
) => {
  'use gpu';
  const P = L.$.params;
  const S = sceneLayout.$.scene;
  const v = dir.mul(-1);
  // Transmitted: each channel's ray picks up the label on the glass' base, then the page where it lands across the
  // air gap, lit by the light reaching it there.
  const lG = landing(g, h, dir, n, 1 / P.iorG);
  const lR = landing(g, h, dir, n, 1 / std.mix(P.iorG, P.iorR, P.materialize));
  const lB = landing(g, h, dir, n, 1 / std.mix(P.iorG, P.iorB, P.materialize));
  const cG = labelOver(pageOnly(pageQ(lG.page), lod), lG.base, lod);
  let col = d.vec3f(cG);
  const spread = std.smoothstep(0.05, 0.25, (std.length(lB.page.sub(lR.page)) / S.planeScale) * S.dpr);
  if (spread > 0) {
    const split = d.vec3f(
      labelOver(pageOnly(pageQ(lR.page), lod), lR.base, lod).x,
      cG.y,
      labelOver(pageOnly(pageQ(lB.page), lod), lB.base, lod).z,
    );
    col = std.mix(cG, split, spread);
  }
  let trans = col.mul(groundLight(shadowQ(lG.page))).mul(paperLight(d.vec3f(lG.page, S.planeZ)));
  const tz = std.max(-std.refract(dir, n, 1 / P.iorG).z, 0.2);
  trans = trans.mul(std.exp(P.absorb.mul(-H * (1 / tz + 1))));
  const Y = std.dot(trans, LUMA.$);
  trans = std.max(std.mix(d.vec3f(Y), trans, P.saturation), d.vec3f(0));
  trans = std.mix(trans, d.vec3f(1), P.lift + 0.035 * haze);
  // Reflection and the sun glint (the studio as seen from the goo, exactly as in the flat shader). A downward
  // reflection sees the page past the glass and the air gap under its base.
  const shine = 0.35 + 0.65 * P.materialize;
  const F = fresnelSchlick(std.dot(n, v), 0.04);
  const gap = std.max(fromGoo(d.vec3f(g, 0)).z - S.planeZ, 0);
  const refl = env(std.reflect(dir, n), g, H + gap, fwR).mul(F * shine);
  const spec = P.lightColor.mul(
    ggxSpecular(n, v, P.lightDir, P.roughness + P.hazeRoughness * haze, a2Filter, P.sunRadius) * shine,
  );
  const cL = std.dot(std.normalize(sg.yz.add(d.vec2f(1e-6, 0))), std.normalize(P.lightDir.xy));
  const lobe = std.max(cL, 0) ** 2 + P.glintOpposite * std.max(-cL, 0) ** 2;
  const glint = P.glint * lobe * std.exp(-std.abs(sg.x) / P.glintWidth) * shine;
  const gd = g.sub(P.glowCenter);
  const glow = P.glowAmount * std.exp(-std.dot(gd, gd) / (2 * P.glowRadius * P.glowRadius));
  return trans
    .mul(1 - F)
    .add(refl)
    .add(spec)
    .add(d.vec3f(glint + glow));
};

export const sceneFragment = tgpu.fragmentFn({
  in: { pos: d.builtin.position },
  // View depth goes to an r32float target (only .x is stored).
  out: { color: d.vec4f, depth: d.vec4f },
})(({ pos }) => {
  'use gpu';
  const S = sceneLayout.$.scene;
  const P = L.$.params;
  const ndc = d.vec2f((pos.x / S.resolution.x) * 2 - 1, 1 - (pos.y / S.resolution.y) * 2);
  const dir = std.normalize(S.fwd.add(S.rightV.mul(ndc.x * S.tanX)).add(S.upV.mul(ndc.y * S.tanY)));
  const eye = S.eye;

  // Page plane (from either side: the orbit can go behind the wall), and its endless extension for the grid.
  const tPlane = rayToZ(eye, dir, S.planeZ);
  const pageFront = eye.z > S.planeZ;
  const wPlane = eye.add(dir.mul(std.min(tPlane, 1e6)));
  const pagePx = wPlane.xy.div(S.planeScale).add(S.viewportCss.mul(0.5));
  const texPerCss = d.f32(std.textureDimensions(L.$.page, 0).x) / S.viewportCss.x;
  const fp = std.fwidth(pagePx).mul(texPerCss);
  const lodPlane = std.clamp(std.log2(std.max(std.max(fp.x, fp.y), 1)), 0, 8);
  const onPage =
    tPlane < BIG * 0.5 && pagePx.x >= 0 && pagePx.y >= 0 && pagePx.x <= S.viewportCss.x && pagePx.y <= S.viewportCss.y;
  const gp = wPlane.xy.div(120);
  const gw = std.max(std.fwidth(gp), d.vec2f(1e-4));
  const gl = std.abs(std.fract(gp.add(0.5)).sub(0.5)).div(gw);
  // Only where the ray meets the plane: looking away from it, wPlane is a far point on the ray, not the wall.
  const fade =
    std.exp(-std.length(wPlane.xy) / (2.5 * S.viewportCss.x)) *
    std.saturate(std.abs(dir.z) * 4) *
    std.select(d.f32(0), d.f32(1), tPlane < BIG * 0.5);
  const grid = (1 - std.saturate(std.min(gl.x, gl.y))) * fade;

  // Goo: march its thickness through its bounding box, in its own frame (it may float, sink and tilt), then bisect.
  // The world ray parameter t carries over to goo space unchanged.
  const ob = toGoo(eye);
  const db = toGooDir(dir);
  const safe = std.select(db, d.vec3f(1e-6), std.lt(std.abs(db), d.vec3f(1e-6)));
  const span = rayBox(ob, d.vec3f(1).div(safe), d.vec3f(0), d.vec3f(S.gooSize, S.gooTop));
  const ta = std.max(span.x, 0);
  const tb = std.max(span.y, ta);
  const inBox = span.y > ta;
  let found = false;
  let tLo = ta;
  let tHi = ta;
  for (let i = 1; i <= MARCH; i++) {
    if (inBox && !found) {
      const t = std.mix(ta, tb, d.f32(i) / d.f32(MARCH));
      const b = ob.add(db.mul(t));
      const h = heightAt(b.xy);
      if (b.z <= h && h > P.filmEps) {
        found = true;
        tHi = t;
      } else {
        tLo = t;
      }
    }
  }
  for (let i = 0; i < 6; i++) {
    if (found) {
      const t = (tLo + tHi) * 0.5;
      const b = ob.add(db.mul(t));
      const h = heightAt(b.xy);
      if (b.z <= h && h > P.filmEps) {
        tHi = t;
      } else {
        tLo = t;
      }
    }
  }
  const tGoo = std.select(d.f32(BIG), tHi, found);

  // Surface terms that need derivatives, for every pixel (at its goo hit, else below its page-plane point).
  const bHit = std.select(toGoo(wPlane), ob.add(db.mul(tHi)), found);
  const g = bHit.xy;
  const hHit = std.max(bHit.z, 0);
  const surf = surfaceAt(g);
  const nW = gooToWorldDir(surf.n);
  const qG = pageQ(landing(g, hHit, dir, nW, 1 / P.iorG).page);
  const fq = std.fwidth(qG).mul(texPerCss);
  const lodLens = std.clamp(std.log2(std.max(std.max(fq.x, fq.y), 1)), 0, P.lodMax);
  const lod = lodLens + P.rimLod * (1 - std.smoothstep(0, 6, -surf.sg.x)) + P.hazeLod * surf.haze;
  const fwR = std.length(std.fwidth(std.reflect(dir, nW)));
  const dndx = std.dpdx(nW);
  const dndy = std.dpdy(nW);
  const a2Filter = std.min(0.5 * (std.dot(dndx, dndx) + std.dot(dndy, dndy)), 0.18);

  // Everything else, nearest first.
  const tA = raySphere(eye, dir, S.probeA);
  const tB = raySphere(eye, dir, S.probeB);
  const em = traceEmitters(eye, dir);
  const tPage = std.select(d.f32(BIG), tPlane, onPage);
  const tSolid = std.min(std.min(tGoo, tPage), std.min(tA, tB));

  let col = backdrop(dir, grid);
  if (tSolid < BIG * 0.5) {
    if (tGoo <= tSolid) {
      col = highlightShoulder(shadeGoo3d(g, hHit, dir, nW, surf.sg, surf.H, surf.haze, lod, fwR, a2Filter));
    } else if (tPage <= tSolid) {
      // From behind, the page shows its dark, unprinted back.
      const front = pageOnly(pageQ(wPlane.xy), lodPlane).mul(groundLight(shadowQ(wPlane.xy))).mul(paperLight(wPlane));
      col = std.select(PAGE_BACK.$, front, pageFront);
    } else if (tA <= tSolid) {
      const p = eye.add(dir.mul(tA));
      const n = std.normalize(p.sub(S.probeA.xyz));
      col = highlightShoulder(irradiance(p, n).add(ambient(n)).mul(0.45 / PI));
    } else {
      const p = eye.add(dir.mul(tB));
      const n = std.normalize(p.sub(S.probeB.xyz));
      col = highlightShoulder(chromeEnv(p, std.reflect(dir, n)).mul(d.vec3f(0.92, 0.9, 0.86)));
    }
  }
  // Emitters in front, faded by the overlay amount.
  const emitterFront = em.t < tSolid;
  if (emitterFront) {
    col = std.mix(col, highlightShoulder(em.col), S.overlay);
  }
  const tMin = std.select(tSolid, em.t, emitterFront && S.overlay > 0.5);

  // The live DOM UI on the reference plane (html-in-canvas), in front of whatever it covers; front side only.
  const tUi = rayToZFront(eye, dir, d.f32(0));
  const wUi = eye.add(dir.mul(std.min(tUi, 1e6)));
  const uv = wUi.xy.add(S.viewportCss.mul(0.5)).sub(S.uiRect.xy).div(S.uiRect.zw);
  const fu = std.fwidth(uv.mul(d.vec2f(std.textureDimensions(sceneLayout.$.ui, 0))));
  const lodUi = std.clamp(std.log2(std.max(std.max(fu.x, fu.y), 1)), 0, 10);
  if (S.uiAlpha > 0) {
    if (tUi <= tMin + 0.5 && uv.x > 0 && uv.y > 0 && uv.x < 1 && uv.y < 1) {
      const ui = std.textureSampleLevel(sceneLayout.$.ui, L.$.smp, uv, lodUi).mul(S.uiAlpha);
      col = ui.xyz.mul(paperLight(wUi)).add(col.mul(1 - ui.w));
    }
  }

  // HDR content went through the flat shader's highlight shoulder above; the page itself is never tone-mapped.
  const enc = std.saturate(linearToSrgb(std.saturate(col)).add(d.vec3f(ditherTPDF(pos.xy))));
  const viewDepth = std.select(d.f32(BIG), tMin * std.dot(dir, S.fwd), tMin < BIG * 0.5);
  return { color: d.vec4f(enc, 1), depth: d.vec4f(viewDepth, 0, 0, 1) };
});

// ───────────────────────────── gizmos ─────────────────────────────

/** World → view space (x right, y up, z = depth along the view direction). */
const toView = (p: d.v3f) => {
  'use gpu';
  const S = gizmoLayout.$.scene;
  const v = p.sub(S.eye);
  return d.vec3f(std.dot(v, S.rightV), std.dot(v, S.upV), std.dot(v, S.fwd));
};

/** View space → device px (y down). */
const toPx = (v: d.v3f) => {
  'use gpu';
  const S = gizmoLayout.$.scene;
  const z = std.max(v.z, 1e-4);
  return d.vec2f((0.5 + (0.5 * v.x) / (z * S.tanX)) * S.resolution.x, (0.5 - (0.5 * v.y) / (z * S.tanY)) * S.resolution.y);
};

/** Device px + view depth → clip space (w = depth keeps varyings perspective-correct). */
const toClip = (px: d.v2f, z: number) => {
  'use gpu';
  const S = gizmoLayout.$.scene;
  return d.vec4f(((px.x / S.resolution.x) * 2 - 1) * z, (1 - (px.y / S.resolution.y) * 2) * z, 0.5 * z, z);
};

export const lineVertex = tgpu.vertexFn({
  in: { vid: d.builtin.vertexIndex, iid: d.builtin.instanceIndex },
  out: {
    pos: d.builtin.position,
    color: d.vec4f,
    across: d.f32,
    along: d.f32,
    depth: d.f32,
    halfW: d.f32,
    dash: d.f32,
  },
})(({ vid, iid }) => {
  'use gpu';
  const S = gizmoLayout.$.scene;
  const seg = gizmoLayout.$.segments[iid];
  let a = toView(seg.a);
  let b = toView(seg.b);
  let ua = d.f32(0);
  let ub = d.f32(1);
  // Clip to the near plane; a segment entirely behind it collapses.
  if (a.z < S.near && b.z >= S.near) {
    const ka = (S.near - a.z) / (b.z - a.z);
    a = std.mix(a, b, ka);
    ua = ka;
  }
  if (b.z < S.near && a.z >= S.near) {
    const kb = (S.near - b.z) / (a.z - b.z);
    b = std.mix(b, a, kb);
    ub = 1 - kb;
  }
  const keep = std.select(d.f32(0), d.f32(1), a.z >= S.near && b.z >= S.near);
  const pa = toPx(a);
  const pb = toPx(b);
  const dv = pb.sub(pa);
  const len = std.max(std.length(dv), 1e-4);
  const tdir = dv.div(len);
  const nrm = d.vec2f(-tdir.y, tdir.x);
  const halfW = (seg.width * 0.5 * S.dpr + 1) * keep;
  // Two triangles: corners (end, side) = (0,−)(0,+)(1,+) (0,−)(1,+)(1,−); caps extend by halfW.
  const corner = d.i32(vid);
  const end = std.select(d.f32(0), d.f32(1), corner === 2 || corner === 4 || corner === 5);
  const side = std.select(d.f32(-1), d.f32(1), corner === 1 || corner === 2 || corner === 4);
  const px = std
    .mix(pa, pb, end)
    .add(tdir.mul((end * 2 - 1) * halfW))
    .add(nrm.mul(side * halfW));
  const z = std.mix(a.z, b.z, end);
  return {
    pos: toClip(px, z),
    color: seg.color,
    across: side,
    along: std.mix(ua, ub, end) * std.length(seg.b.sub(seg.a)),
    depth: z,
    halfW: halfW,
    dash: seg.dash,
  };
});

/** 1 where the scene is in front of this gizmo fragment (it is then drawn faded). */
const hiddenAt = (pos: d.v4f, depth: number) => {
  'use gpu';
  const sceneDepth = std.textureLoad(gizmoLayout.$.depth, d.vec2i(pos.xy), 0).x;
  return std.select(d.f32(0), d.f32(1), depth > sceneDepth * 1.001 + 2);
};

export const lineFragment = tgpu.fragmentFn({
  in: {
    pos: d.builtin.position,
    color: d.vec4f,
    across: d.f32,
    along: d.f32,
    depth: d.f32,
    halfW: d.f32,
    dash: d.f32,
  },
  out: d.vec4f,
})((input) => {
  'use gpu';
  const dist = std.abs(input.across) * input.halfW;
  let a = input.color.w * std.saturate(input.halfW - dist);
  if (input.dash > 0) {
    a = a * std.select(d.f32(0.18), d.f32(1), std.fract(input.along / input.dash) < 0.55);
  }
  a = a * (1 - 0.72 * hiddenAt(input.pos, input.depth)) * gizmoLayout.$.scene.overlay;
  return d.vec4f(input.color.xyz.mul(a), a);
});

export const dotVertex = tgpu.vertexFn({
  in: { vid: d.builtin.vertexIndex, iid: d.builtin.instanceIndex },
  out: { pos: d.builtin.position, color: d.vec4f, uv: d.vec2f, depth: d.f32, ring: d.f32, rPx: d.f32 },
})(({ vid, iid }) => {
  'use gpu';
  const S = gizmoLayout.$.scene;
  const dot = gizmoLayout.$.dots[iid];
  const v = toView(dot.center);
  const keep = std.select(d.f32(0), d.f32(1), v.z >= S.near);
  const r = (dot.radius * S.dpr + 1) * keep;
  const corner = d.i32(vid);
  const cx = std.select(d.f32(-1), d.f32(1), corner === 1 || corner === 2 || corner === 4);
  const cy = std.select(d.f32(-1), d.f32(1), corner === 2 || corner === 4 || corner === 5);
  const uv = d.vec2f(cx, cy);
  return {
    pos: toClip(toPx(v).add(uv.mul(r)), std.max(v.z, S.near)),
    color: dot.color,
    uv: uv,
    depth: v.z,
    ring: dot.ring * S.dpr,
    rPx: r,
  };
});

export const dotFragment = tgpu.fragmentFn({
  in: { pos: d.builtin.position, color: d.vec4f, uv: d.vec2f, depth: d.f32, ring: d.f32, rPx: d.f32 },
  out: d.vec4f,
})((input) => {
  'use gpu';
  const dist = std.length(input.uv) * input.rPx;
  const outer = std.saturate(input.rPx - 1 - dist + 0.5);
  const inner = std.select(d.f32(0), std.saturate(input.rPx - 1 - input.ring - dist + 0.5), input.ring > 0);
  let a = input.color.w * (outer - inner);
  a = a * (1 - 0.6 * hiddenAt(input.pos, input.depth)) * gizmoLayout.$.scene.overlay;
  return d.vec4f(input.color.xyz.mul(a), a);
});
