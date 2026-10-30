// The scene behind the flat page. A camera looks straight at the page; its frustum, cut at the reference
// distance, is exactly the client viewport (CSS px), so the reference plane z = 0 is "the screen". The page is a
// background plane that can be pushed back along −z, and the goo sits on the reference plane or floats in front of
// it (scene.goo.hover; levitation.ts moves it when pressed). Lights keep their positions in the world. The page stands
// upright like a screen on a wall: world up is screen-up (−y), and the scene camera is a level camera facing it.
//
// Normal mode still draws the flat page plus the goo overlay. The scene reaches it through the glass uniforms (key
// light, softboxes, eye distance, depth terms), which the default scene builds from look.ts bit for bit, and
// through gravity (gooGravity), which the putty feels. Config mode ray-traces the whole scene from an orbit camera
// (src/gpu/sceneView.ts).

import { d } from 'typegpu';
import type { Theme } from '../background.ts';
import type { GooGravity } from '../feel.ts';
import type { GlassParams } from '../gpu/schemas.ts';
import type { Layout } from '../layout.ts';
import type { LevitationPose } from '../levitation.ts';
import { looks, type Look } from '../look.ts';
import { add, clamp, DEG, dot, fromSpherical, length, normalize, scale, sub, toSpherical, type OrbitPose, type Vec3 } from './math.ts';

export type GlassInput = d.InferInput<typeof GlassParams>;
export type LightKind = 'sun' | 'softbox';

export interface SceneLight {
  id: string;
  name: string;
  kind: LightKind;
  /** Authoritative world position (CSS px); page, element and camera changes leave it in place. */
  position: Vec3;
  /** The emitter's fixed world direction, pointing out from its illuminated side toward the emitter. */
  dir: Vec3;
  /** Softbox frame: long and short axes, as in look.ts (gnomonic coordinates around `dir`). */
  t: Vec3;
  b: Vec3;
  /** Authored aiming distance (CSS px), and the distance at which the angular sizes below hold. */
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
  /** Eye distance in front of the reference plane (CSS px). The vertical FOV follows the viewport height. */
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
     * How far the button's base floats in front of the reference plane at rest (CSS px); the air gap behind it is
     * this plus the page depth. 0 = resting where it always did. Presses move it from there (levitation.ts).
     */
    hover: number;
  };
  lights: SceneLight[];
  /** Grey and chrome probe balls beside the viewport (config view only; outside the camera's frustum). */
  probes: boolean;
  /**
   * Global gravity in the world frame (x right, y down the screen, z toward the viewer), in g. Screen-down by
   * default: the page is a wall. Materials follow it through their weight; rigid bodies and particles (none yet)
   * through G_PX.
   */
  gravity: Vec3;
}

/** CSS px per metre (96 per inch) and 1 g in CSS px/s², for rigid bodies and particles. */
export const PX_PER_M = 96 / 0.0254;
export const G_PX = 9.80665 * PX_PER_M;

/**
 * Gravity in the goo's rest frame, whose base is parallel to the screen (presses tilt it only for a moment, and
 * the putty ignores that): along goo x and y, and into the base. `0 - z` keeps a weightless scene at +0.
 */
export const gooGravity = (scene: Scene): GooGravity => ({ x: scene.gravity[0], y: scene.gravity[1], n: 0 - scene.gravity[2] });

/** Gravity in words, for labels: "1.0 g down the page", "0.5 g into the page", "weightless". */
export function describeGravity(g: Vec3): string {
  const s = Math.hypot(g[0], g[1], g[2]);
  if (s < 0.005) return 'weightless';
  const into = -g[2] / s;
  const amount = `${s.toFixed(1)} g`;
  if (into > 0.94) return `${amount} into the page`;
  if (into < -0.94) return `${amount} out of the page`;
  // Eight ways around the screen, from atan2(y_down, x): 0 = right, 90 = down.
  const ways = ['to the right', 'down and right', 'down the page', 'down and left', 'to the left', 'up and left', 'up the page', 'up and right'];
  const way = ways[(Math.round(Math.atan2(g[1], g[0]) / DEG / 45) + 8) % 8];
  const tilt = into > 0.17 ? ', into the page' : into < -0.17 ? ', out of the page' : '';
  return `${amount} ${way}${tilt}`;
}

/** The look.ts lights are at infinity; the rig places them this far from the goo, keeping their angular sizes. */
export const RIG_DISTANCE = 1100;
/** Highest hover the controls offer (CSS px): normal mode's goo canvas can still fit the shadow (main.ts). */
export const MAX_HOVER = 150;
// On a wall the first softbox hangs in front of the screen, 16° off the camera's axis.
const SOFTBOX_NAMES = ['Front softbox', 'Key strip', 'Cool kicker'];

const v3 = (v: readonly number[]): Vec3 => [v[0], v[1], v[2]];

export function defaultScene(): Scene {
  const light = looks.light;
  const dark = looks.dark;
  const sun: SceneLight = {
    id: 'sun',
    name: 'Sun (key)',
    kind: 'sun',
    position: scale(normalize(v3(light.lightDir)), RIG_DISTANCE),
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
      id: ['front-softbox', 'key-strip', 'cool-kicker'][i] ?? `softbox-${i + 1}`,
      name: SOFTBOX_NAMES[i] ?? `Softbox ${i + 1}`,
      kind: 'softbox',
      position: scale(normalize(v3(sb.c)), RIG_DISTANCE),
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
    gravity: [0, 1, 0],
  };
}

// ───────────────────────────── derived geometry ─────────────────────────────

/** Vertical field of view (degrees) that maps the viewport height onto the reference plane. */
export const cameraFov = (scene: Scene, viewportH: number) => (2 * Math.atan(viewportH / 2 / scene.camera.distance)) / DEG;

export const distanceForFov = (fovDeg: number, viewportH: number) => viewportH / 2 / Math.tan((fovDeg * DEG) / 2);

/**
 * The point on the reference plane on the scene camera's axis. The origin today; a camera that scrolls down a tall
 * page will move it, and everything placed relative to the scene camera goes through here.
 */
export const cameraOrigin = (_scene: Scene): Vec3 => [0, 0, 0];

export const cameraEye = (scene: Scene): Vec3 => add(cameraOrigin(scene), [0, 0, scene.camera.distance]);

/** The scene camera as an orbit pose (yaw 0, pitch 0): what normal mode shows. */
export const sceneCameraPose = (scene: Scene, viewportH: number): OrbitPose => ({
  pivot: cameraOrigin(scene),
  yaw: 0,
  pitch: 0,
  distance: scene.camera.distance,
  fov: cameraFov(scene, viewportH),
});

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
 * The putty's scale at distance z in front of the reference plane. It is anchored to the screen: scaled about the
 * camera eye, so the camera sees it exactly on its DOM box at any distance (normal mode, input and focus rings stay
 * exact). Only the gap behind it gives the distance away, and the parallax when the view orbits.
 */
const anchorScale = (scene: Scene, z: number) => {
  const D = scene.camera.distance;
  return Math.max(D - z, 0.2 * D) / D;
};

/** Axes of a base tilted by `slopes` (it sits slope·Δ nearer the page Δ px along each axis): its normal leans over. */
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

/** Where the levitating goo is: its pivot pose.z in front of the reference plane, on the camera ray through its DOM position. */
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

/** The goo center in the world, used to aim edited lights and to sample their angular appearance. */
export function rigTarget(layout: Layout | null, scene: Scene, pose?: LevitationPose): Vec3 {
  const s = layout?.shapes[0];
  const z = pose?.z ?? scene.goo.hover;
  if (!layout || !s) return [0, 0, z];
  const k = anchorScale(scene, z);
  return [k * (layout.canvasX + s.cx - layout.viewportW / 2), k * (layout.canvasY + s.cy - layout.viewportH / 2), z];
}

/**
 * Places a fresh default rig once, around the unlifted button. The host calls this after the first layout;
 * imported documents already contain world positions and must not be initialized again.
 */
export function initializeWorldLights(scene: Scene, layout: Layout): void {
  const s = layout.shapes[0];
  if (!s) return;
  const target: Vec3 = [layout.canvasX + s.cx - layout.viewportW / 2, layout.canvasY + s.cy - layout.viewportH / 2, 0];
  for (const l of scene.lights) l.position = add(target, scale(normalize(l.dir), l.distance));
}

/** A light's world position. The optional target keeps older callers source-compatible; it is never a parent. */
export const lightPosition = (l: SceneLight, _target?: Vec3): Vec3 => l.position;

/**
 * The calibration axis keeps look.ts's exact vectors and distance at the default composition. Everywhere else
 * the position supplies the direction and distance; moving the observer never rewrites the light.
 */
function onCalibrationAxis(l: SceneLight, target: Vec3): boolean {
  const off = sub(l.position, target);
  const expected = scale(normalize(l.dir), l.distance);
  return off.every((v, i) => Math.abs(v - expected[i]) <= 1e-9);
}

export const lightDistance = (l: SceneLight, target: Vec3): number =>
  onCalibrationAxis(l, target) ? l.distance : Math.max(length(sub(l.position, target)), 1);

export function lightDirection(l: SceneLight, target: Vec3): Vec3 {
  const off = sub(l.position, target);
  if (onCalibrationAxis(l, target) || length(off) < 1e-6) return l.dir;
  return scale(normalize(off), length(l.dir));
}

/** Angular-size factor: lights keep their physical size, so they shrink in the glass as they move away. */
export const sizeFactor = (l: SceneLight, target?: Vec3) => l.refDistance / (target ? lightDistance(l, target) : l.distance);

/** Physical softbox half extents / sun radius (CSS px). */
export const physicalHalfSize = (l: SceneLight): [number, number] =>
  l.kind === 'sun' ? [l.radius * l.refDistance, l.radius * l.refDistance] : [l.halfSize[0] * l.refDistance, l.halfSize[1] * l.refDistance];

/**
 * Re-aims a light at the target from a new direction (look.ts's softbox frame convention: the long axis stays
 * tangential around the page's axis, the short axis runs along the great circle through it). The light stays
 * between 1° and 85° off the page's axis, in front of the page.
 */
export function aimLight(l: SceneLight, dir: Vec3, target?: Vec3) {
  const origin = target ?? sub(l.position, scale(normalize(l.dir), l.distance));
  if (target) l.distance = clamp(lightDistance(l, target), 150, 8000);
  const { polar, azimuth } = toSpherical(dir);
  const p = clamp(polar, 1, 85);
  const be = p * DEG;
  const az = azimuth * DEG;
  l.dir = fromSpherical(p, azimuth);
  l.t = [-Math.sin(az), Math.cos(az), 0];
  l.b = [Math.cos(be) * Math.cos(az), Math.cos(be) * Math.sin(az), -Math.sin(be)];
  l.position = add(origin, scale(normalize(l.dir), l.distance));
}

/** An explicit distance edit moves the world light along the ray from the chosen aiming point. */
export function setLightDistance(l: SceneLight, distance: number, target: Vec3): void {
  const direction = normalize(lightDirection(l, target));
  l.distance = clamp(distance, 150, 8000);
  l.position = add(target, scale(direction, l.distance));
}

/** Moves a light through the editor, preserving the existing aiming constraints. */
export function moveWorldLight(l: SceneLight, position: Vec3, target: Vec3, distanceOnly = false): void {
  const off = sub(position, target);
  if (distanceOnly) {
    setLightDistance(l, dot(off, normalize(lightDirection(l, target))), target);
  } else {
    l.position = position;
    l.distance = clamp(length(off), 150, 8000);
    aimLight(l, off, target);
  }
}

// ───────────────────────────── what the glass sees ─────────────────────────────

const vec3f = (v: Vec3) => d.vec3f(v[0], v[1], v[2]);

/** The scene's lights and camera as glass uniforms. At the default scene every value equals look.ts's. */
export function glassLights(scene: Scene, theme: Theme, target: Vec3 = [0, 0, 0]): Partial<GlassInput> {
  const sun = scene.lights.find((l) => l.kind === 'sun');
  const boxes = scene.lights.filter((l) => l.kind === 'softbox');
  const look = looks[theme];
  const out: Partial<GlassInput> = { eyeDist: scene.camera.distance };
  if (sun) {
    out.lightDir = vec3f(lightDirection(sun, target));
    out.lightColor = vec3f(sun.radiance[theme]);
    out.sunRadius = sun.radius * sizeFactor(sun, target);
  }
  out.softboxes = look.softboxes.map((fallback, i) => {
    const l = boxes[i];
    if (!l) return { ...fallback, c: vec3f(fallback.c), t: vec3f(fallback.t), b: vec3f(fallback.b), radiance: d.vec3f(0), halfSize: d.vec2f(...fallback.halfSize) };
    const k = sizeFactor(l, target);
    return {
      c: vec3f(lightDirection(l, target)),
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

/** Shadow reach follows the tangent of the key light's angle off the page's axis (look.ts's value suits its sun). */
function shadowReachFor(scene: Scene, look: Look, target?: Vec3): number {
  const sun = scene.lights.find((l) => l.kind === 'sun');
  if (!sun) return look.shadowReach;
  const dir = target ? lightDirection(sun, target) : sun.dir;
  const tanNow = Math.hypot(dir[0], dir[1]) / Math.max(dir[2], 1e-3);
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
export function gapSoftening(scene: Scene, look: Look, gap: number, target?: Vec3): Partial<GlassInput> {
  if (gap <= 0) return {};
  const sun = scene.lights.find((l) => l.kind === 'sun');
  const penumbra = sun ? sun.radius * sizeFactor(sun, target) : look.sunRadius;
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
export function glassDepthTerms(scene: Scene, look: Look, pose: LevitationPose, target?: Vec3): Partial<GlassInput> {
  const out: Partial<GlassInput> = {};
  const reach = shadowReachFor(scene, look, target);
  if (reach !== look.shadowReach) out.shadowReach = reach;
  const gap = airGap(scene, pose);
  if (gap <= 0 && pose.tilt[0] === 0 && pose.tilt[1] === 0) return out;
  const D = scene.camera.distance;
  const g = scene.page.depth;
  return {
    ...out,
    ...gapSoftening(scene, look, gap, target),
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
export function glassDepthTerms3d(scene: Scene, look: Look, pose: LevitationPose, target?: Vec3): Partial<GlassInput> {
  const out: Partial<GlassInput> = {};
  const reach = shadowReachFor(scene, look, target);
  if (reach !== look.shadowReach) out.shadowReach = reach;
  return { ...out, ...gapSoftening(scene, look, airGap(scene, pose), target) };
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
  // The diffuser keeps its world orientation (its normal is −dir).
  const facing = Math.max(0, (toL[0] * l.dir[0] + toL[1] * l.dir[1] + toL[2] * l.dir[2]) / (r * Math.hypot(...l.dir)));
  const cos = Math.max(0, (n[0] * toL[0] + n[1] * toL[1] + n[2] * toL[2]) / r);
  return scale(rad, (4 * hx * hy * facing * cos) / r2);
}
