// Config mode. The view detaches from the scene camera and flies to a 3/4 orbit view of the scene: the page plane,
// the camera's frustum and viewport rectangle (the reference plane), the goo, the light rig and two probe balls.
// gpu/sceneView.ts ray-traces it into a full-viewport canvas that fades in over the flat page.
//
// Drag to orbit, right- or shift-drag to pan, wheel or pinch to zoom. Drag a light (its dot or its panel) or the
// page's blue depth handle. Press the goo to dent it from any angle. C or Esc flies back to the camera.
//
// The page UI (.stage) follows the camera. With html-in-canvas it is drawn into the scene as a texture on the
// reference plane. Without it, a CSS matrix3d that matches the WebGPU projection carries the live DOM along.

import GUI from 'lil-gui';
import { d, type TgpuRoot } from 'typegpu';
import type { Goo } from '../gpu/goo.ts';
import { MAX_LIGHTS } from '../gpu/sceneShaders.ts';
import {
  createSceneView,
  type DotInput,
  type SceneParamsInput,
  type SceneView,
  type SceneViewFrame,
  type SegmentInput,
} from '../gpu/sceneView.ts';
import { sceneSdf, type Layout } from '../layout.ts';
import { looks } from '../look.ts';
import { params, restHeightCpu } from '../params.ts';
import type { SceneHostDeps } from './host.ts';
import { createUiPlane, htmlInCanvasSupport } from './htmlInCanvas.ts';
import {
  add,
  clamp,
  cssMatrixForPlane,
  DEG,
  dot,
  fromSpherical,
  length,
  lerp3,
  normalize,
  orbitBasis,
  project,
  rayPlane,
  rayThrough,
  rayZ,
  scale,
  sub,
  toSpherical,
  type CameraBasis,
  type OrbitPose,
  type Vec3,
} from './math.ts';
import {
  aimLight,
  cameraEye,
  cameraFov,
  defaultScene,
  distanceForFov,
  glassDepthTerms3d,
  glassLights,
  lightPosition,
  physicalHalfSize,
  planeScale,
  referenceIrradiance,
  rigTarget,
  sizeFactor,
  type Scene,
  type SceneLight,
} from './scene.ts';

export interface ConfigDeps extends SceneHostDeps {
  scene: Scene;
  sceneChanged: () => void;
  onActiveChange: (active: boolean) => void;
}

type Phase = 'off' | 'entering' | 'on' | 'exiting';
type RGBA = [number, number, number, number];
type Handle = { kind: 'light'; index: number } | { kind: 'depth' } | { kind: 'goo' };
type Drag =
  | { kind: 'orbit' | 'pan'; x0: number; y0: number; pose0: OrbitPose }
  | { kind: 'light'; index: number; planePoint: Vec3; offset: Vec3 }
  | { kind: 'depth'; y0: number; depth0: number; perPx: number }
  | { kind: 'press'; id: number; z: number };

const ENTER_S = 1.15;
const EXIT_S = 0.9;
const FLY_S = 0.7;
/** The scene canvas fades in over the flat page (CSS, 0.16 s) before the camera starts to move. */
const FADE_S = 0.2;
const PIXEL_BUDGET = 3.2e6;

const COLORS = {
  camera: [1, 0.78, 0.18, 0.95] as RGBA,
  cameraSoft: [1, 0.78, 0.18, 0.5] as RGBA,
  page: [0.47, 0.78, 1, 0.95] as RGBA,
  pageSoft: [0.47, 0.78, 1, 0.45] as RGBA,
  target: [1, 1, 1, 0.8] as RGBA,
};

/** The page's own background (html { background: var(--page) }), linear: what the camera sees past the page. */
const PAGE_BACKGROUND: Record<'light' | 'dark', Vec3> = {
  light: [0.905, 0.888, 0.855],
  dark: [0.0034, 0.0042, 0.0062],
};

/** Linear backdrop colors and grid strength per theme. */
const BACKDROP = {
  light: { top: [0.42, 0.45, 0.5] as Vec3, bottom: [0.2, 0.215, 0.24] as Vec3, grid: 0.045 },
  dark: { top: [0.075, 0.08, 0.1] as Vec3, bottom: [0.02, 0.022, 0.03] as Vec3, grid: 0.035 },
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (a: number, b: number, t: number) => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const vec = (p: Vec3) => d.vec3f(p[0], p[1], p[2]);
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const maxc = (c: Vec3) => Math.max(c[0], c[1], c[2]);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const fromSrgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Pose blend. At polar 0 (the straight-down camera) azimuth is a roll, so it waits until the view has tilted on
 * the way out, and finishes before the view is flat on the way back. Distance blends geometrically.
 */
function lerpPose(a: OrbitPose, b: OrbitPose, t: number): OrbitPose {
  const ta = b.polar < 1 ? smooth(0, 0.8, t) : a.polar < 1 ? smooth(0.15, 1, t) : t;
  return {
    pivot: lerp3(a.pivot, b.pivot, t),
    polar: a.polar + (b.polar - a.polar) * t,
    azimuth: a.azimuth + wrap180(b.azimuth - a.azimuth) * ta,
    distance: a.distance * (b.distance / a.distance) ** t,
    fov: a.fov + (b.fov - a.fov) * t,
  };
}

const copyPose = (p: OrbitPose): OrbitPose => ({ ...p, pivot: [...p.pivot] });

export function createConfigMode(deps: ConfigDeps) {
  const { scene } = deps;
  const html = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hic = htmlInCanvasSupport();
  const hicAllowed = new URLSearchParams(location.search).get('hic') !== '0';
  const defaults = defaultScene();
  const irradianceRef = { light: referenceIrradiance(defaults, 'light'), dark: referenceIrradiance(defaults, 'dark') };

  let root: TgpuRoot | null = null;
  let goo: Goo | null = null;
  let view: SceneView | null = null;
  let phase: Phase = 'off';
  let wanted = false;
  let pose = cameraPose();
  /** Where the user left the orbit view, to come back to it next time. */
  let userPose: OrbitPose | null = null;
  let anim: { from: OrbitPose; to: OrbitPose; t0: number; dur: number; done?: () => void } | null = null;
  let selected = 2;
  let hover: Handle | null = null;
  let drag: Drag | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; distance0: number } | null = null;
  let gui: GUI | null = null;
  let capturing = false;
  let captured: HTMLCanvasElement | null = null;

  // The page UI: CSS 3D (live DOM, transformed) or html-in-canvas (live DOM, drawn into the scene).
  let uiMode: 'none' | 'css' | 'html' = 'none';
  let uiPlane: ReturnType<typeof createUiPlane> | null = null;
  let uiRect: [number, number, number, number] = [0, 0, 1, 1];
  let uiReady = false;
  let stageBox = { x: 0, y: 0 };

  // ---- DOM ----
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  deps.pageBg.after(canvas);
  const labelLayer = document.createElement('div');
  labelLayer.className = 'scene-labels';
  labelLayer.setAttribute('aria-hidden', 'true');
  document.body.append(labelLayer);
  const labels = new Map<string, HTMLElement>();
  const hint = document.createElement('p');
  hint.className = 'scene-hint';
  hint.hidden = true;
  hint.textContent =
    'Drag to orbit · right- or shift-drag to pan · scroll or pinch to zoom · drag a light or the blue depth handle · press the goo · F focus · O overview · V camera · Esc back';
  document.body.append(hint);

  // ---- poses ----
  function cameraPose(): OrbitPose {
    return { pivot: [0, 0, 0], polar: 0, azimuth: 0, distance: scene.camera.distance, fov: cameraFov(scene, window.innerHeight) };
  }

  function overviewPose(): OrbitPose {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const target = rigTarget(deps.layout());
    const s = planeScale(scene);
    const pts: Vec3[] = [cameraEye(scene), target];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push([(sx * w * s) / 2, (sy * h * s) / 2, -scene.page.depth]);
    for (const l of scene.lights) pts.push(lightPosition(l, target));
    const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
    const hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
    const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const r = Math.max(...pts.map((p) => length(sub(p, c))));
    const fov = 34;
    return { pivot: c, polar: 58, azimuth: 36, distance: (r / Math.sin((fov / 2) * DEG)) * 0.88, fov };
  }

  function focusPose(): OrbitPose {
    const layout = deps.layout();
    const target = rigTarget(layout);
    const s = layout?.shapes[0];
    const span = s ? Math.max(s.hx, s.hy) * 2 : 240;
    return { pivot: [target[0], target[1], 4], polar: 56, azimuth: 30, distance: span * 2.2, fov: 34 };
  }

  function flyTo(to: OrbitPose) {
    if (phase !== 'on') return;
    anim = { from: copyPose(pose), to, t0: deps.clock(), dur: reducedMotion.matches ? 0 : FLY_S };
    deps.wake();
  }

  // ---- lifecycle ----
  function setGpu(nextRoot: TgpuRoot | null, nextGoo: Goo | null) {
    if (nextRoot !== root) {
      view?.destroy();
      view = null;
      if (uiMode === 'html') uiEnd();
      uiPlane = null;
    }
    root = nextRoot;
    goo = nextGoo;
    if (!root || !goo) forceOff();
  }

  function ensureView() {
    if (!view && root && goo) view = createSceneView(root, canvas, goo);
    return view;
  }

  function enter() {
    wanted = true;
    deps.onActiveChange(true);
    if (!root || !goo || phase === 'entering' || phase === 'on') return;
    if (!ensureView()) return;
    const from = phase === 'exiting' ? copyPose(pose) : cameraPose();
    const fade = phase === 'exiting' || reducedMotion.matches ? 0 : FADE_S;
    if (phase === 'off') uiBegin();
    phase = 'entering';
    html.classList.add('scene-on');
    pose = from;
    anim = {
      from,
      to: userPose ?? overviewPose(),
      t0: deps.clock() + fade,
      dur: reducedMotion.matches ? 0 : ENTER_S,
      done: () => {
        phase = 'on';
        showChrome(true);
      },
    };
    deps.wake();
  }

  function exit() {
    wanted = false;
    deps.onActiveChange(false);
    if (phase === 'off' || phase === 'exiting') return;
    if (phase === 'on') userPose = copyPose(pose);
    endDrag();
    showChrome(false);
    phase = 'exiting';
    anim = { from: copyPose(pose), to: cameraPose(), t0: deps.clock(), dur: reducedMotion.matches ? 0 : EXIT_S, done: finishExit };
    deps.wake();
  }

  /** Back at the camera: the flat page returns underneath, the scene canvas and the 2D goo cross-fade. */
  function finishExit() {
    phase = 'off';
    html.classList.remove('scene-full', 'scene-on');
    uiEnd();
    deps.resync();
  }

  function forceOff() {
    if (phase === 'off') return;
    anim = null;
    endDrag();
    showChrome(false);
    finishExit();
    wanted = false;
    deps.onActiveChange(false);
  }

  function showChrome(on: boolean) {
    hint.hidden = !on;
    if (on) openPanel();
    else closePanel();
  }

  // ---- per frame ----
  function sizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = Math.min(dpr, Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h)));
    const cw = Math.max(1, Math.round(w * k));
    const ch = Math.max(1, Math.round(h * k));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
  }

  function frame(now: number) {
    if (phase === 'off' || !view || !goo) return;
    const layout = deps.layout();
    if (!layout) return;
    let finished: (() => void) | undefined;
    if (anim && now >= anim.t0) {
      const k = anim.dur > 0 ? clamp((now - anim.t0) / anim.dur, 0, 1) : 1;
      pose = lerpPose(anim.from, anim.to, easeInOut(k));
      if (phase === 'entering') html.classList.add('scene-full');
      if (k >= 1) {
        finished = anim.done;
        anim = null;
      }
    }
    sizeCanvas();
    const cam = orbitBasis(pose);
    if (view.render(buildFrame(cam, layout))) {
      if (capturing) {
        captured ??= document.createElement('canvas');
        captured.width = canvas.width;
        captured.height = canvas.height;
        captured.getContext('2d')?.drawImage(canvas, 0, 0);
      }
      placeDom(cam, layout);
    }
    finished?.();
  }

  function lightInput(l: SceneLight, target: Vec3, theme: 'light' | 'dark') {
    const [hx, hy] = physicalHalfSize(l);
    const rad = l.radiance[theme];
    const alpha = Math.max(l.radius * sizeFactor(l), 1e-3);
    return {
      pos: vec(lightPosition(l, target)),
      kind: l.kind === 'sun' ? 0 : 1,
      dir: vec(normalize(l.dir)),
      radius: hx,
      axisT: vec(normalize(l.t)),
      halfT: hx,
      axisB: vec(normalize(l.b)),
      halfB: hy,
      radiance: vec(rad),
      corner: l.round * l.refDistance,
      // The sun delivers E at normal incidence, so its disc shows E / (π α²).
      glow: vec(l.kind === 'sun' ? scale(rad, 1 / (Math.PI * alpha * alpha)) : rad),
      pad0: 0,
    };
  }

  function buildFrame(cam: CameraBasis, layout: Layout): SceneViewFrame {
    const theme = deps.theme();
    const look = looks[theme];
    const w = layout.viewportW;
    const h = layout.viewportH;
    const target = rigTarget(layout);
    const res = goo?.sceneResources();
    const lights = scene.lights.slice(0, MAX_LIGHTS).map((l) => lightInput(l, target, theme));
    while (lights.length < MAX_LIGHTS) lights.push({ ...lightInput(scene.lights[0], target, theme), radiance: d.vec3f(), glow: d.vec3f(), radius: 0 });
    const bd = BACKDROP[theme];
    const probes = scene.probes;
    const overlay = overlayAmount();
    const page = PAGE_BACKGROUND[theme];
    const mix3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * overlay, a[1] + (b[1] - a[1]) * overlay, a[2] + (b[2] - a[2]) * overlay];
    const sceneParams: SceneParamsInput = {
      eye: vec(cam.eye),
      tanY: cam.tanY,
      rightV: vec(cam.right),
      tanX: (cam.tanY * w) / h,
      upV: vec(cam.up),
      near: 1,
      fwd: vec(cam.fwd),
      dpr: canvas.width / w,
      resolution: d.vec2f(canvas.width, canvas.height),
      viewportCss: d.vec2f(w, h),
      gooMin: d.vec2f(layout.canvasX - w / 2, layout.canvasY - h / 2),
      gooSize: d.vec2f(layout.width, layout.height),
      planeZ: -scene.page.depth,
      planeScale: planeScale(scene),
      pageLit: scene.page.lit,
      gooTop: params.shape.plateau * 2.4 + 12,
      // Beside the viewport, on the reference plane: outside the camera's frustum, so normal mode never sees them.
      probeA: probes ? d.vec4f(w / 2 + 150, -78, 56, 56) : d.vec4f(),
      probeB: probes ? d.vec4f(w / 2 + 150, 78, 56, 56) : d.vec4f(),
      voidTop: vec(mix3(page, bd.top)),
      gridAlpha: bd.grid * overlay,
      voidBottom: vec(mix3(page, bd.bottom)),
      uiAlpha: uiMode === 'html' && uiReady ? 1 : 0,
      irradianceRef: irradianceRef[theme],
      lightCount: lights.length,
      overlay,
      pad1: 0,
      uiRect: d.vec4f(...uiRect),
      lights,
    };
    // The flat shader's per-frame values, with the scene's lights; the gap is traced for real, not folded in.
    const glass = { ...(res?.glass ?? ({} as SceneViewFrame['glass'])), ...glassLights(scene, theme), ...glassDepthTerms3d(scene, look) };
    return { scene: sceneParams, glass, ...gizmos(layout, target, theme) };
  }

  /** 0 when looking straight through the scene camera, 1 once the view has tilted away (see SceneParams.overlay). */
  const overlayAmount = () => smooth(0.5, 12, pose.polar);

  // ---- gizmos ----
  const depthHandle = (): Vec3 => [0, (window.innerHeight / 2) * planeScale(scene), -scene.page.depth];

  function lightTint(l: SceneLight, theme: 'light' | 'dark', alpha: number): RGBA {
    const r = l.radiance[theme];
    const m = maxc(r) || 1;
    return [toSrgb(0.35 + (0.65 * r[0]) / m), toSrgb(0.35 + (0.65 * r[1]) / m), toSrgb(0.35 + (0.65 * r[2]) / m), alpha];
  }

  function gizmos(layout: Layout, target: Vec3, theme: 'light' | 'dark') {
    const segments: SegmentInput[] = [];
    const dots: DotInput[] = [];
    const line = (a: Vec3, b: Vec3, color: RGBA, width = 1.5, dash = 0) =>
      segments.push({ a: vec(a), width, b: vec(b), dash, color: d.vec4f(...color) });
    const loop = (pts: Vec3[], color: RGBA, width = 1.5, dash = 0) =>
      pts.forEach((p, i) => line(p, pts[(i + 1) % pts.length], color, width, dash));
    const disc = (p: Vec3, radius: number, color: RGBA, ring = 0) =>
      dots.push({ center: vec(p), radius, color: d.vec4f(...color), ring, pad0: 0, pad1: 0, pad2: 0 });
    const rect = (hx: number, hy: number, z: number): Vec3[] => [
      [-hx, -hy, z],
      [hx, -hy, z],
      [hx, hy, z],
      [-hx, hy, z],
    ];

    const w = layout.viewportW;
    const h = layout.viewportH;
    const D = scene.camera.distance;
    const g = scene.page.depth;
    const s = planeScale(scene);
    const eye = cameraEye(scene);

    // The camera's frustum: eye → the viewport rectangle on the reference plane → on to the page plane's depth.
    const ref = rect(w / 2, h / 2, 0);
    const k = (D + g) / D;
    const far = rect((w / 2) * k, (h / 2) * k, -g);
    for (let i = 0; i < 4; i++) {
      line(eye, ref[i], COLORS.cameraSoft, 1.25);
      if (g > 0) line(ref[i], far[i], COLORS.cameraSoft, 1, 18);
    }
    loop(ref, COLORS.camera, 2.5);
    if (g > 0 && !scene.page.fill) loop(far, COLORS.cameraSoft, 1, 18);
    // A small camera body with an "up" tick (screen up is −y).
    const bodyZ = D - 90;
    const kb = 90 / D;
    const body = rect((w / 2) * kb, (h / 2) * kb, bodyZ);
    body.forEach((p) => line(eye, p, COLORS.camera, 1.75));
    loop(body, COLORS.camera, 1.75);
    const upY = (-h / 2) * kb;
    line([-(w / 2) * kb * 0.35, upY, bodyZ], [0, upY - 22, bodyZ], COLORS.camera, 1.75);
    line([0, upY - 22, bodyZ], [(w / 2) * kb * 0.35, upY, bodyZ], COLORS.camera, 1.75);

    // The page plane and its depth handle.
    loop(rect((w / 2) * s, (h / 2) * s, -g), COLORS.page, 1.75);
    const hd = depthHandle();
    const hot = hover?.kind === 'depth' || drag?.kind === 'depth';
    if (g > 0) line(hd, [0, h / 2, 0], COLORS.pageSoft, 1, 10);
    disc(hd, hot ? 8 : 6.5, COLORS.page, hot ? 0 : 2.5);

    // The rig target (the goo center).
    const tc = 14;
    line(add(target, [-tc, 0, 0]), add(target, [tc, 0, 0]), COLORS.target, 1.25);
    line(add(target, [0, -tc, 0]), add(target, [0, tc, 0]), COLORS.target, 1.25);
    line(target, add(target, [0, 0, tc * 2]), COLORS.target, 1.25);

    // Lights: aim line, outline, handle.
    scene.lights.forEach((l, i) => {
      const p = lightPosition(l, target);
      const sel = i === selected;
      const hov = (hover?.kind === 'light' && hover.index === i) || (drag?.kind === 'light' && drag.index === i);
      const col = lightTint(l, theme, sel ? 1 : 0.85);
      line(p, target, lightTint(l, theme, sel ? 0.6 : 0.3), 1, 22);
      const [hx, hy] = physicalHalfSize(l);
      if (l.kind === 'softbox') {
        const t = normalize(l.t);
        const b = normalize(l.b);
        const corner = (sx: number, sy: number) => add(p, add(scale(t, sx * hx), scale(b, sy * hy)));
        loop([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], col, sel ? 2.25 : 1.25);
      } else {
        disc(p, Math.max(9, 0), col, 1.5);
        // Rays around the sun.
        const n = normalize(l.dir);
        const ax = normalize(Math.abs(n[2]) < 0.9 ? [n[1], -n[0], 0] : [1, 0, 0]);
        const ay: Vec3 = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
        for (let r = 0; r < 8; r++) {
          const a = (r / 8) * Math.PI * 2;
          const dir = add(scale(ax, Math.cos(a)), scale(ay, Math.sin(a)));
          line(add(p, scale(dir, hx * 1.35)), add(p, scale(dir, hx * 1.9)), col, 1.5);
        }
      }
      disc(p, hov || sel ? 7 : 5.5, sel ? [1, 1, 1, 1] : col, hov || sel ? 0 : 2);
    });
    return { segments, dots };
  }

  // ---- DOM that follows the camera ----
  function placeDom(cam: CameraBasis, layout: Layout) {
    const w = layout.viewportW;
    const h = layout.viewportH;
    if (uiMode === 'css') deps.stage.style.transform = cssMatrixForPlane(cam, w, h, stageBox.x, stageBox.y);
    labelLayer.style.opacity = String(overlayAmount());
    const target = rigTarget(layout);
    const D = scene.camera.distance;
    const s = planeScale(scene);
    const items: { id: string; text: string; at: Vec3; kind?: string; selected?: boolean }[] = [
      {
        id: 'camera',
        text: `Camera · fov ${cameraFov(scene, h).toFixed(1)}° · eye ${Math.round(D)} px`,
        at: [0, 0, D + 30],
        kind: 'camera',
      },
      { id: 'viewport', text: `Viewport = reference plane · ${Math.round(w)}×${Math.round(h)} CSS px`, at: [-w / 2, -h / 2, 0], kind: 'camera' },
      {
        id: 'page',
        text: `Page plane · ${Math.round(scene.page.depth)} px back · ${scene.page.fill ? `scaled ${s.toFixed(2)}×` : 'unscaled'}`,
        at: [(w / 2) * s, (h / 2) * s, -scene.page.depth],
        kind: 'page',
      },
      ...scene.lights.map((l, i) => ({
        id: `light${i}`,
        text: l.name,
        at: add(lightPosition(l, target), [0, 0, physicalHalfSize(l)[1] + 16]),
        selected: i === selected,
      })),
    ];
    if (scene.probes) items.push({ id: 'probes', text: 'Probe balls', at: [w / 2 + 150, 0, 150] });
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.id);
      let el = labels.get(it.id);
      if (!el) {
        el = document.createElement('span');
        el.className = 'scene-label';
        if (it.kind) el.dataset.kind = it.kind;
        labelLayer.append(el);
        labels.set(it.id, el);
      }
      if (el.textContent !== it.text) el.textContent = it.text;
      el.toggleAttribute('data-selected', !!it.selected);
      const p = project(cam, w, h, it.at);
      const visible = p.z > 1 && p.x > -200 && p.x < w + 200 && p.y > -50 && p.y < h + 50;
      el.style.display = visible ? '' : 'none';
      if (visible) el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of labels) if (!seen.has(id)) el.style.display = 'none';
  }

  function uiBegin() {
    if (hic.ok && hicAllowed && root) {
      try {
        uiPlane ??= createUiPlane(root, deps.stage, {
          onTexture: (tex, rect) => {
            uiReady = !!tex;
            uiRect = rect;
            view?.setUiTexture(tex);
            deps.wake();
          },
          onError: (err) => {
            console.warn('[scene] html-in-canvas failed, using CSS 3D instead:', err);
            uiPlane?.detach();
            beginCss();
          },
        });
        uiPlane.attach();
        uiMode = 'html';
        return;
      } catch (err) {
        console.warn('[scene] html-in-canvas unavailable, using CSS 3D instead:', err);
      }
    }
    beginCss();
  }

  function beginCss() {
    uiMode = 'css';
    uiReady = false;
    deps.stage.style.transform = '';
    const r = deps.stage.getBoundingClientRect();
    stageBox = { x: r.left, y: r.top };
  }

  function uiEnd() {
    if (uiMode === 'html') uiPlane?.detach();
    deps.stage.style.transform = '';
    uiMode = 'none';
    uiReady = false;
  }

  // ---- picking ----
  function gooHit(cam: CameraBasis, x: number, y: number) {
    const layout = deps.layout();
    if (!layout) return null;
    const w = layout.viewportW;
    const h = layout.viewportH;
    const r = rayThrough(cam, w, h, x, y);
    const top = params.shape.plateau * 1.8;
    let t = r.o[2] > top ? rayZ(r.o, r.d, top) : 0;
    const tEnd = rayZ(r.o, r.d, 0);
    if (!Number.isFinite(t) || !Number.isFinite(tEnd)) return null;
    const minX = layout.canvasX - w / 2;
    const minY = layout.canvasY - h / 2;
    for (let i = 0; i < 900 && t <= tEnd + 1.5; i++, t += 1.5) {
      const p = add(r.o, scale(r.d, t));
      const gx = p[0] - minX;
      const gy = p[1] - minY;
      if (gx < 0 || gy < 0 || gx > layout.width || gy > layout.height) continue;
      const height = restHeightCpu(sceneSdf(layout.shapes, gx, gy, params.shape.blend));
      if (height > 0.5 && p[2] <= height) return { x: gx, y: gy, z: p[2] };
    }
    return null;
  }

  /** The softbox panel or sun disc under the pointer, by ray. */
  function lightUnder(cam: CameraBasis, x: number, y: number): number {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = rayThrough(cam, w, h, x, y);
    const target = rigTarget(deps.layout());
    let best = -1;
    let bestT = Infinity;
    scene.lights.forEach((l, i) => {
      const p = lightPosition(l, target);
      const [hx, hy] = physicalHalfSize(l);
      if (l.kind === 'sun') {
        const oc = sub(r.o, p);
        const b = dot(oc, r.d);
        const disc = b * b - (dot(oc, oc) - (hx * 2) ** 2);
        const t = disc > 0 ? -b - Math.sqrt(disc) : Infinity;
        if (t > 0 && t < bestT) [best, bestT] = [i, t];
      } else {
        const n = normalize(l.dir);
        const t = rayPlane(r.o, r.d, p, n);
        if (!Number.isFinite(t) || t >= bestT) return;
        const q = sub(add(r.o, scale(r.d, t)), p);
        if (Math.abs(dot(q, normalize(l.t))) <= hx && Math.abs(dot(q, normalize(l.b))) <= hy) [best, bestT] = [i, t];
      }
    });
    return best;
  }

  function pickHandle(cam: CameraBasis, x: number, y: number): Handle | null {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const target = rigTarget(deps.layout());
    let best: Handle | null = null;
    let bestD = 18;
    scene.lights.forEach((l, i) => {
      const p = project(cam, w, h, lightPosition(l, target));
      const dd = Math.hypot(p.x - x, p.y - y);
      if (p.z > 1 && dd < bestD) [best, bestD] = [{ kind: 'light', index: i }, dd];
    });
    const ph = project(cam, w, h, depthHandle());
    if (ph.z > 1 && Math.hypot(ph.x - x, ph.y - y) < bestD) best = { kind: 'depth' };
    if (best) return best;
    const under = lightUnder(cam, x, y);
    if (under >= 0) return { kind: 'light', index: under };
    return gooHit(cam, x, y) ? { kind: 'goo' } : null;
  }

  // ---- input ----
  function moveLight(l: SceneLight, p: Vec3, distanceOnly: boolean) {
    const off = sub(p, rigTarget(deps.layout()));
    if (!distanceOnly) aimLight(l, off);
    l.distance = clamp(distanceOnly ? dot(off, normalize(l.dir)) : length(off), 150, 8000);
    deps.sceneChanged();
  }

  function endDrag() {
    if (drag?.kind === 'press') deps.tracker.release(drag.id, deps.clock());
    drag = null;
    canvas.classList.remove('is-dragging');
    deps.wake();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (phase !== 'on' && phase !== 'entering') return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests, assistive tech) have nothing to capture.
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      endDrag();
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), distance0: pose.distance };
      return;
    }
    if (phase === 'on') anim = null;
    const cam = orbitBasis(pose);
    const x = e.clientX;
    const y = e.clientY;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const handle = e.button === 0 && phase === 'on' ? pickHandle(cam, x, y) : null;
    if (handle?.kind === 'light') {
      selected = handle.index;
      gui?.controllersRecursive().forEach((c) => c.updateDisplay());
      const p = lightPosition(scene.lights[selected], rigTarget(deps.layout()));
      const r = rayThrough(cam, w, h, x, y);
      const t = rayPlane(r.o, r.d, p, cam.fwd);
      drag = { kind: 'light', index: selected, planePoint: p, offset: Number.isFinite(t) ? sub(p, add(r.o, scale(r.d, t))) : [0, 0, 0] };
    } else if (handle?.kind === 'depth') {
      const a = project(cam, w, h, depthHandle());
      const b = project(cam, w, h, add(depthHandle(), [0, 0, 100]));
      const dy = a.y - b.y;
      drag = { kind: 'depth', y0: y, depth0: scene.page.depth, perPx: Math.abs(dy) > 2 ? 100 / dy : 2 };
    } else if (handle?.kind === 'goo' && !e.shiftKey) {
      const hit = gooHit(cam, x, y);
      if (hit && goo) {
        const id = deps.tracker.press('mouse', hit.x, hit.y, {
          ax: 19,
          ay: 24,
          angle: -0.19,
          depthScale: 1,
          surfaceZ: Math.max(goo.surfaceAt(hit.x, hit.y), 4),
          now: deps.clock(),
        });
        if (id >= 0) drag = { kind: 'press', id, z: hit.z };
      }
    }
    drag ??= { kind: e.button !== 0 || e.shiftKey ? 'pan' : 'orbit', x0: x, y0: y, pose0: copyPose(pose) };
    canvas.classList.add('is-dragging');
    deps.wake();
  });

  canvas.addEventListener('pointermove', (e) => {
    const x = e.clientX;
    const y = e.clientY;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      pose.distance = clamp((pinch.distance0 * pinch.dist) / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 40, 40000);
      deps.wake();
      return;
    }
    const cam = orbitBasis(pose);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!drag) {
      if (phase !== 'on') return;
      const next = pickHandle(cam, x, y);
      canvas.classList.toggle('is-handle', next?.kind === 'light' || next?.kind === 'depth');
      canvas.classList.toggle('is-goo', next?.kind === 'goo');
      if (JSON.stringify(next) !== JSON.stringify(hover)) {
        hover = next;
        deps.wake();
      }
      return;
    }
    switch (drag.kind) {
      case 'orbit':
        pose.azimuth = drag.pose0.azimuth - (x - drag.x0) * 0.3;
        pose.polar = clamp(drag.pose0.polar - (y - drag.y0) * 0.3, 0, 88);
        break;
      case 'pan': {
        const k = (2 * drag.pose0.distance * Math.tan((drag.pose0.fov / 2) * DEG)) / h;
        const c0 = orbitBasis(drag.pose0);
        pose.pivot = add(drag.pose0.pivot, add(scale(c0.right, -(x - drag.x0) * k), scale(c0.up, (y - drag.y0) * k)));
        break;
      }
      case 'light': {
        const r = rayThrough(cam, w, h, x, y);
        const t = rayPlane(r.o, r.d, drag.planePoint, cam.fwd);
        if (Number.isFinite(t)) moveLight(scene.lights[drag.index], add(add(r.o, scale(r.d, t)), drag.offset), e.altKey);
        break;
      }
      case 'depth':
        scene.page.depth = clamp(drag.depth0 + (y - drag.y0) * drag.perPx, 0, 4000);
        deps.sceneChanged();
        break;
      case 'press': {
        const layout = deps.layout();
        const r = rayThrough(cam, w, h, x, y);
        const t = rayZ(r.o, r.d, drag.z);
        if (layout && Number.isFinite(t)) {
          const p = add(r.o, scale(r.d, t));
          deps.tracker.move(drag.id, p[0] - (layout.canvasX - w / 2), p[1] - (layout.canvasY - h / 2));
        }
        break;
      }
    }
    deps.wake();
  });

  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) endDrag();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (phase !== 'on') return;
      e.preventDefault();
      anim = null;
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      pose.distance = clamp(pose.distance * Math.exp(step * 0.0015), 40, 40000);
      deps.wake();
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', () => flyTo(pose.distance > focusPose().distance * 2 ? focusPose() : overviewPose()));
  window.addEventListener('keydown', (e) => {
    if (phase !== 'on' || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    if (k === 'f') flyTo(focusPose());
    else if (k === 'o') flyTo(overviewPose());
    else if (k === 'v') flyTo(cameraPose());
  });

  // ---- panel ----
  function openPanel() {
    if (gui) return;
    const container = document.createElement('div');
    container.className = 'scene-panel';
    document.body.append(container);
    gui = new GUI({ container, title: '3D scene', width: 290 });
    gui.onChange(() => deps.sceneChanged());
    const H = () => window.innerHeight;

    const camera = {
      get fov() {
        return cameraFov(scene, H());
      },
      set fov(f: number) {
        scene.camera.distance = distanceForFov(f, H());
      },
      get eye() {
        return Math.round(scene.camera.distance);
      },
    };
    const cam = gui.addFolder('Camera');
    cam.add(camera, 'fov', 8, 100, 0.1).name('field of view (°)').listen();
    cam.add(camera, 'eye').name('eye height (px)').disable().listen();

    const page = gui.addFolder('Page plane');
    page.add(scene.page, 'depth', 0, 3000, 1).name('depth behind (px)').listen();
    page.add(scene.page, 'fill').name('scale to fill the view').listen();
    page.add(scene.page, 'lit', 0, 1, 0.01).name('lit by scene (paper)').listen();

    const L = () => scene.lights[selected];
    const light = {
      get which() {
        return selected;
      },
      set which(i: number) {
        selected = Number(i);
        deps.wake();
      },
      get fromOverhead() {
        return toSpherical(L().dir).polar;
      },
      set fromOverhead(p: number) {
        aimLight(L(), fromSpherical(p, toSpherical(L().dir).azimuth));
      },
      get azimuth() {
        return toSpherical(L().dir).azimuth;
      },
      set azimuth(a: number) {
        aimLight(L(), fromSpherical(toSpherical(L().dir).polar, a));
      },
      get distance() {
        return L().distance;
      },
      set distance(x: number) {
        L().distance = x;
      },
      get brightness() {
        const t = deps.theme();
        return maxc(L().radiance[t]) / (maxc(defaults.lights[selected].radiance[t]) || 1);
      },
      set brightness(b: number) {
        const t = deps.theme();
        const r = L().radiance[t];
        const m = maxc(r);
        const want = b * (maxc(defaults.lights[selected].radiance[t]) || 1);
        L().radiance[t] = m > 0 ? scale(r, want / m) : [want, want, want];
      },
      get color() {
        const r = L().radiance[deps.theme()];
        const m = maxc(r) || 1;
        return `#${r.map((c) => Math.round(clamp(toSrgb(c / m), 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
      },
      set color(hex: string) {
        const tint: Vec3 = [1, 3, 5].map((i) => fromSrgb(parseInt(hex.slice(i, i + 2), 16) / 255)) as Vec3;
        const tm = maxc(tint) || 1;
        for (const t of ['light', 'dark'] as const) L().radiance[t] = scale(tint, (maxc(L().radiance[t]) || 1) / tm);
      },
    };
    const lights = gui.addFolder('Lights');
    lights.add(light, 'which', Object.fromEntries(scene.lights.map((l, i) => [l.name, i]))).name('light').listen();
    lights.add(light, 'fromOverhead', 1, 85, 0.5).name('angle from overhead (°)').listen();
    lights.add(light, 'azimuth', -180, 180, 0.5).name('azimuth (°)').listen();
    lights.add(light, 'distance', 150, 6000, 1).name('distance (px)').listen();
    lights.add(light, 'brightness', 0, 4, 0.01).name('brightness (× default)').listen();
    lights.addColor(light, 'color').name('color').listen();

    const viewF = gui.addFolder('View');
    viewF.add(scene, 'probes').name('probe balls').listen();
    viewF.add({ go: () => flyTo(overviewPose()) }, 'go').name('Overview (O)');
    viewF.add({ go: () => flyTo(focusPose()) }, 'go').name('Focus the goo (F)');
    viewF.add({ go: () => flyTo(cameraPose()) }, 'go').name('Look through the camera (V)');
    viewF
      .add(
        {
          ui:
            uiMode === 'html'
              ? 'html-in-canvas: live DOM → WebGPU texture'
              : hic.ok
                ? 'CSS 3D (html-in-canvas off: ?hic=0)'
                : 'CSS 3D (no html-in-canvas here)',
        },
        'ui',
      )
      .name('page UI')
      .disable();

    gui.add({ reset }, 'reset').name('Reset the scene');
    gui.add({ back: () => exit() }, 'back').name('Back to the page (Esc)');
    if (matchMedia('(max-width: 600px)').matches) gui.close();
  }

  function closePanel() {
    gui?.destroy();
    gui = null;
    document.querySelector('.scene-panel')?.remove();
  }

  function reset() {
    const fresh = defaultScene();
    Object.assign(scene.camera, fresh.camera);
    Object.assign(scene.page, fresh.page);
    scene.lights.forEach((l, i) => Object.assign(l, fresh.lights[i]));
    scene.probes = fresh.probes;
    deps.sceneChanged();
  }

  return {
    setGpu,
    enter,
    exit,
    frame,
    /** The user wants the 3D view (it may still be flying in or out). */
    get wanted() {
      return wanted;
    },
    get phase() {
      return phase;
    },
    get busy() {
      return phase === 'entering' || phase === 'exiting' || !!anim || !!drag;
    },
    /** Dev aids. */
    dev: {
      get pose() {
        return copyPose(pose);
      },
      setPose(p: Partial<OrbitPose>) {
        pose = { ...copyPose(pose), ...p };
        anim = null;
        deps.wake();
      },
      flyTo,
      overviewPose,
      focusPose,
      cameraPose,
      select(i: number) {
        selected = i;
        deps.wake();
      },
      capture(on: boolean) {
        capturing = on;
        return captured;
      },
      get uiMode() {
        return uiMode;
      },
      htmlInCanvas: hic,
    },
  };
}

export type ConfigMode = ReturnType<typeof createConfigMode>;
