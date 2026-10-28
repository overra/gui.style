// The scene behind the flat page. A camera looks straight at the page; its frustum, cut at the reference
// distance, is exactly the client viewport (CSS px), so the reference plane z = 0 is "the screen". The page is a
// background plane that can be pushed back along −z, and the goo sits on the reference plane or floats above it
// (scene.goo.hover; levitation.ts moves it when pressed). Lights hang on a rig around the goo.
//
// Normal mode still draws the flat page plus the goo overlay. The scene reaches it only through the glass
// uniforms (key light, softboxes, eye distance, depth terms). The default scene is built from look.ts, so those
// uniforms come out bit-identical and normal mode looks exactly as before. Config mode ray-traces the whole
// scene from an orbit camera (src/gpu/sceneView.ts).

import { d } from 'typegpu';
import type { Theme } from '../background.ts';
import type { GlassParams } from '../gpu/schemas.ts';
import type { Layout } from '../layout.ts';
import type { LevitationPose } from '../levitation.ts';
import { looks, type Look } from '../look.ts';
import { add, clamp, DEG, dot, fromSpherical, normalize, scale, sub, toSpherical, type Vec3 } from './math.ts';

export type GlassInput = d.InferInput<typeof GlassParams>;
export type LightKind = 'sun' | 'softbox';

export interface SceneLight {
  name: string;
  kind: LightKind;
  /** Direction from the rig target (the goo) toward the light. Kept verbatim from look.ts until the light moves. */
  dir: Vec3;
  /** Softbox frame: long and short axes, as in look.ts (gnomonic coordinates around `dir`). */
  t: Vec3;
  b: Vec3;
  /** Distance from the rig target (CSS px), and the distance at which the angular sizes below hold. */
  distance: number;
  refDistance: number;
  /** Angular sizes at `refDistance` (look.ts units): softbox half extents, corner and edge softness; sun radius. */
  halfSize: [number, number];
  round: number;
  soft: number;
  radius: number;
  /** Linear radiance per theme (the sun's is the irradiance it delivers at normal incidence). */
  radiance: Record<Theme, Vec3>;
}

export interface Scene {
  /** Eye height above the reference plane (CSS px). The vertical FOV follows the viewport height. */
  camera: { distance: number };
  page: {
    /** How far the page plane sits behind the reference plane (CSS px). */
    depth: number;
    /** Grow the plane with distance · tan(fov / 2) so it still fills the viewport. */
    fill: boolean;
    /** 0 = a self-lit screen (as today), 1 = matte paper lit by the scene lights. Config view only. */
    lit: number;
  };
  goo: {
    /**
     * How far the button's base floats above the reference plane at rest (CSS px); the air gap under it is this
     * plus the page depth. 0 = resting where it always did. Presses move it from there (levitation.ts).
     */
    hover: number;
  };
  lights: SceneLight[];
  /** Grey and chrome probe balls beside the viewport (config view only; outside the camera's frustum). */
  probes: boolean;
}

/** The look.ts lights are at infinity; the rig places them this far from the goo, keeping their angular sizes. */
export const RIG_DISTANCE = 1100;
/** Highest hover the controls offer (CSS px): normal mode's goo canvas can still fit the shadow (main.ts). */
export const MAX_HOVER = 150;
const SOFTBOX_NAMES = ['Overhead softbox', 'Key strip', 'Cool kicker'];

const v3 = (v: readonly number[]): Vec3 => [v[0], v[1], v[2]];

export function defaultScene(): Scene {
  const light = looks.light;
  const dark = looks.dark;
  const sun: SceneLight = {
    name: 'Sun (key)',
    kind: 'sun',
    dir: v3(light.lightDir),
    t: [1, 0, 0],
    b: [0, 1, 0],
    distance: RIG_DISTANCE,
    refDistance: RIG_DISTANCE,
    halfSize: [0, 0],
    round: 0,
    soft: 0,
    radius: light.sunRadius,
    radiance: { light: v3(light.lightColor), dark: v3(dark.lightColor) },
  };
  const boxes = light.softboxes.map(
    (sb, i): SceneLight => ({
      name: SOFTBOX_NAMES[i] ?? `Softbox ${i + 1}`,
      kind: 'softbox',
      dir: v3(sb.c),
      t: v3(sb.t),
      b: v3(sb.b),
      distance: RIG_DISTANCE,
      refDistance: RIG_DISTANCE,
      halfSize: [sb.halfSize[0], sb.halfSize[1]],
      round: sb.round,
      soft: sb.soft,
      radius: 0,
      radiance: { light: v3(sb.radiance), dark: v3(dark.softboxes[i]?.radiance ?? sb.radiance) },
    }),
  );
  return {
    camera: { distance: light.eyeDist },
    page: { depth: 0, fill: true, lit: 0 },
    goo: { hover: 0 },
    lights: [sun, ...boxes],
    probes: true,
  };
}

// ───────────────────────────── derived geometry ─────────────────────────────

/** Vertical field of view (degrees) that maps the viewport height onto the reference plane. */
export const cameraFov = (scene: Scene, viewportH: number) => (2 * Math.atan(viewportH / 2 / scene.camera.distance)) / DEG;

export const distanceForFov = (fovDeg: number, viewportH: number) => viewportH / 2 / Math.tan((fovDeg * DEG) / 2);

export const cameraEye = (scene: Scene): Vec3 => [0, 0, scene.camera.distance];

/** World units per page CSS px: (D + depth) / D when the plane fills the viewport, 1 when it keeps its size. */
export function planeScale(scene: Scene): number {
  const D = scene.camera.distance;
  return scene.page.fill ? (D + scene.page.depth) / D : 1;
}

/** Screen-space size of one world unit on the page plane, as seen by the camera: D / (D + depth). */
export function pageForeshortening(scene: Scene): number {
  const D = scene.camera.distance;
  return D / (D + scene.page.depth);
}

// ───────────────────────────── the goo's own frame ─────────────────────────────

/**
 * The goo's frame in the world: world = origin + scale·(x·axes.x + y·axes.y + h·axes.z) for goo-space (x, y)
 * (CSS px from the goo canvas' top-left) and height h above the goo's flat base.
 */
export interface GooFrame {
  origin: Vec3;
  scale: number;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/**
 * The putty's scale at height z above the reference plane. It is anchored to the screen: scaled about the camera
 * eye, so the camera sees it exactly on its DOM box at any height (normal mode, input and focus rings stay exact).
 * Only the gap below it gives the height away, and the parallax when the view orbits.
 */
const anchorScale = (scene: Scene, z: number) => {
  const D = scene.camera.distance;
  return Math.max(D - z, 0.2 * D) / D;
};

/** Axes of a base tilted by `slopes` (it sits slope·Δ lower Δ px along each axis): its normal leans that way. */
function tiltAxes(tx: number, ty: number): { x: Vec3; y: Vec3; z: Vec3 } {
  const s2 = tx * tx + ty * ty;
  if (s2 < 1e-14) return { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  // Rodrigues about the horizontal axis ẑ × n, n = (tx, ty, 1) normalized.
  const s = Math.sqrt(s2);
  const c = 1 / Math.sqrt(1 + s2);
  const sn = s * c;
  const ax = -ty / s;
  const ay = tx / s;
  const rot = (v: Vec3): Vec3 => {
    const along = (ax * v[0] + ay * v[1]) * (1 - c);
    return [v[0] * c + ay * v[2] * sn + ax * along, v[1] * c - ax * v[2] * sn + ay * along, v[2] * c + (ax * v[1] - ay * v[0]) * sn];
  };
  return { x: rot([1, 0, 0]), y: rot([0, 1, 0]), z: rot([0, 0, 1]) };
}

/** Where the levitating goo is: its pivot at height pose.z on the camera ray through the pivot's DOM position. */
export function gooFrame(scene: Scene, layout: Layout, pose: LevitationPose): GooFrame {
  const k = anchorScale(scene, pose.z);
  const [px, py] = pose.pivot;
  const axes = tiltAxes(pose.tilt[0], pose.tilt[1]);
  const pivot: Vec3 = [k * (layout.canvasX - layout.viewportW / 2 + px), k * (layout.canvasY - layout.viewportH / 2 + py), pose.z];
  return { origin: sub(pivot, scale(add(scale(axes.x, px), scale(axes.y, py)), k)), scale: k, ...axes };
}

/** World → goo space (x, y, height above the base). */
export const toGooFrame = (f: GooFrame, w: Vec3): Vec3 => {
  const r = sub(w, f.origin);
  return [dot(r, f.x) / f.scale, dot(r, f.y) / f.scale, dot(r, f.z) / f.scale];
};

/** A world direction in goo units; it keeps the ray parameter: toGooFrame(o + t·v) = toGooFrame(o) + t·this. */
export const gooFrameDir = (f: GooFrame, v: Vec3): Vec3 => [dot(v, f.x) / f.scale, dot(v, f.y) / f.scale, dot(v, f.z) / f.scale];

/** Goo space → world. */
export const fromGooFrame = (f: GooFrame, g: Vec3): Vec3 =>
  add(f.origin, scale(add(add(scale(f.x, g[0]), scale(f.y, g[1])), scale(f.z, g[2])), f.scale));

/** The goo center at its rest height (world), i.e. the rig target. Lights follow the hover, not the presses. */
export function rigTarget(layout: Layout | null, scene: Scene): Vec3 {
  const s = layout?.shapes[0];
  if (!layout || !s) return [0, 0, scene.goo.hover];
  const k = anchorScale(scene, scene.goo.hover);
  return [k * (layout.canvasX + s.cx - layout.viewportW / 2), k * (layout.canvasY + s.cy - layout.viewportH / 2), scene.goo.hover];
}

/** Angular-size factor: lights keep their physical size, so they shrink in the glass as they move away. */
export const sizeFactor = (l: SceneLight) => l.refDistance / l.distance;

export const lightPosition = (l: SceneLight, target: Vec3): Vec3 => add(target, scale(normalize(l.dir), l.distance));

/** Physical softbox half extents / sun radius (CSS px). */
export const physicalHalfSize = (l: SceneLight): [number, number] =>
  l.kind === 'sun' ? [l.radius * l.refDistance, l.radius * l.refDistance] : [l.halfSize[0] * l.refDistance, l.halfSize[1] * l.refDistance];

/**
 * Re-aims a light at the target from a new direction (look.ts's softbox frame convention: long axis horizontal,
 * short axis down the polar great circle). The light stays above the page and off the zenith.
 */
export function aimLight(l: SceneLight, dir: Vec3) {
  const { polar, azimuth } = toSpherical(dir);
  const p = clamp(polar, 1, 85);
  const be = p * DEG;
  const az = azimuth * DEG;
  l.dir = fromSpherical(p, azimuth);
  l.t = [-Math.sin(az), Math.cos(az), 0];
  l.b = [Math.cos(be) * Math.cos(az), Math.cos(be) * Math.sin(az), -Math.sin(be)];
}

// ───────────────────────────── what the glass sees ─────────────────────────────

const vec3f = (v: Vec3) => d.vec3f(v[0], v[1], v[2]);

/** The scene's lights and camera as glass uniforms. At the default scene every value equals look.ts's. */
export function glassLights(scene: Scene, theme: Theme): Partial<GlassInput> {
  const sun = scene.lights.find((l) => l.kind === 'sun');
  const boxes = scene.lights.filter((l) => l.kind === 'softbox');
  const look = looks[theme];
  const out: Partial<GlassInput> = { eyeDist: scene.camera.distance };
  if (sun) {
    out.lightDir = vec3f(sun.dir);
    out.lightColor = vec3f(sun.radiance[theme]);
    out.sunRadius = sun.radius * sizeFactor(sun);
  }
  out.softboxes = look.softboxes.map((fallback, i) => {
    const l = boxes[i];
    if (!l) return { ...fallback, c: vec3f(fallback.c), t: vec3f(fallback.t), b: vec3f(fallback.b), radiance: d.vec3f(0), halfSize: d.vec2f(...fallback.halfSize) };
    const k = sizeFactor(l);
    return {
      c: vec3f(l.dir),
      t: vec3f(l.t),
      b: vec3f(l.b),
      radiance: vec3f(l.radiance[theme]),
      halfSize: d.vec2f(l.halfSize[0] * k, l.halfSize[1] * k),
      round: l.round * k,
      soft: l.soft * k,
    };
  });
  return out;
}

/** Shadow reach follows the key light's elevation (look.ts's value is tuned for its default sun). */
function shadowReachFor(scene: Scene, look: Look): number {
  const sun = scene.lights.find((l) => l.kind === 'sun');
  if (!sun) return look.shadowReach;
  const tanNow = Math.hypot(sun.dir[0], sun.dir[1]) / Math.max(sun.dir[2], 1e-3);
  const tanRef = Math.hypot(look.lightDir[0], look.lightDir[1]) / look.lightDir[2];
  return tanNow === tanRef ? look.shadowReach : clamp(look.shadowReach * (tanNow / tanRef), 0, 30);
}

/** The air gap under the goo's pivot (CSS px): its base's height plus the page's depth. */
export const airGap = (scene: Scene, pose: LevitationPose) => Math.max(pose.z + scene.page.depth, 0);

/**
 * What an air gap under the glass does to the light on the page, in both modes: the key light's penumbra widens
 * with it and the big softboxes fill the shadow in (softer, larger, lighter); contact occlusion needs contact; the
 * caustic model assumes the page touches the glass. Dents and the rim focus within a few tens of px, so past
 * that their caustics blur out (they are evaluated unblurred, so they fade instead).
 */
export function gapSoftening(scene: Scene, look: Look, gap: number): Partial<GlassInput> {
  if (gap <= 0) return {};
  const sun = scene.lights.find((l) => l.kind === 'sun');
  const penumbra = sun ? sun.radius * sizeFactor(sun) : look.sunRadius;
  const blur = gap * (0.5 * penumbra + 0.06);
  return {
    gapBlur: blur,
    shadowSigma: look.shadowSigma + blur,
    shadowOpacity: look.shadowOpacity * Math.exp(-gap / 600),
    aoOpacity: look.aoOpacity * Math.exp(-gap / 6),
    causticC: look.causticC * Math.exp(-gap / 16),
    causticAdd: look.causticAdd * Math.exp(-gap / 16),
  };
}

/**
 * Normal mode: the flat overlay folds in the air gap under a floating goo or over a pushed-back page. Rays leave
 * the glass' base (Snell) and cross the gap to the page, which the camera sees foreshortened by D / (D + depth);
 * the shadow is looked up where the key light crossed the base (displaced toward the light, plus the camera's
 * parallax between page and goo), and spreads. The goo canvas grows to fit the shadow (host.ts: shadowReach), up
 * to a limit; the config view traces all of it. Normal mode always shows the page filling the view: an unscaled
 * ("fixed") page is only drawn smaller in the config view.
 */
export function glassDepthTerms(scene: Scene, look: Look, pose: LevitationPose): Partial<GlassInput> {
  const out: Partial<GlassInput> = {};
  const reach = shadowReachFor(scene, look);
  if (reach !== look.shadowReach) out.shadowReach = reach;
  const gap = airGap(scene, pose);
  if (gap <= 0 && pose.tilt[0] === 0 && pose.tilt[1] === 0) return out;
  const D = scene.camera.distance;
  const g = scene.page.depth;
  return {
    ...out,
    ...gapSoftening(scene, look, gap),
    gap,
    gapScale: pageForeshortening(scene),
    tilt: d.vec2f(pose.tilt[0], pose.tilt[1]),
    pivot: d.vec2f(pose.pivot[0], pose.pivot[1]),
    // A page point lines up with the goo point (D + g) / (D − z) times as far from the view center (the goo is
    // scaled about the eye, anchorScale).
    parallax: (D + g) / (anchorScale(scene, pose.z) * D) - 1,
  };
}

/** Config view: the gap is traced for real, so only what the flat terms can't express is adjusted. */
export function glassDepthTerms3d(scene: Scene, look: Look, pose: LevitationPose): Partial<GlassInput> {
  const out: Partial<GlassInput> = {};
  const reach = shadowReachFor(scene, look);
  if (reach !== look.shadowReach) out.shadowReach = reach;
  return { ...out, ...gapSoftening(scene, look, airGap(scene, pose)) };
}

/**
 * Luminance of the light a page point under the goo gets from `scene` (rig + sky), used to normalize page
 * lighting in the config view: with the default rig, "paper" at the goo is as bright as the self-lit page.
 */
export function referenceIrradiance(scene: Scene, theme: Theme): number {
  const sky = looks[theme].skyZenith;
  let e: Vec3 = scale([sky[0], sky[1], sky[2]], Math.PI);
  for (const l of scene.lights) e = add(e, irradianceAt(l, [0, 0, 0], [0, 0, 1], [0, 0, 0], theme));
  return Math.max(0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2], 1e-3);
}

/** Irradiance on a surface at `p` (normal `n`) from one light (point-like approximation for softboxes). */
export function irradianceAt(l: SceneLight, p: Vec3, n: Vec3, target: Vec3, theme: Theme): Vec3 {
  const rad = l.radiance[theme];
  if (l.kind === 'sun') {
    const cos = Math.max(0, n[0] * l.dir[0] + n[1] * l.dir[1] + n[2] * l.dir[2]) / Math.hypot(...l.dir);
    return scale(rad, cos);
  }
  const lp = lightPosition(l, target);
  const toL: Vec3 = [lp[0] - p[0], lp[1] - p[1], lp[2] - p[2]];
  const r2 = Math.max(toL[0] ** 2 + toL[1] ** 2 + toL[2] ** 2, 1);
  const r = Math.sqrt(r2);
  const [hx, hy] = physicalHalfSize(l);
  // The diffuser faces the rig target (its normal is −dir).
  const facing = Math.max(0, (toL[0] * l.dir[0] + toL[1] * l.dir[1] + toL[2] * l.dir[2]) / (r * Math.hypot(...l.dir)));
  const cos = Math.max(0, (n[0] * toL[0] + n[1] * toL[1] + n[2] * toL[2]) / r);
  return scale(rad, (4 * hx * hy * facing * cos) / r2);
}
