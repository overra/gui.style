// Scene host, always loaded and small. It owns the scene model and feeds it to the goo's glass uniforms in
// normal mode (the default scene reproduces look.ts exactly). It also loads config mode, the 3D view, on demand:
// press C, or use the "3D scene" button. The button shows in dev, or with ?scene or ?tune in the URL.

import type { TgpuRoot } from 'typegpu';
import type { Theme } from '../background.ts';
import type { GlassInput, Goo } from '../gpu/goo.ts';
import type { Layout } from '../layout.ts';
import type { LevitationPose } from '../levitation.ts';
import { looks } from '../look.ts';
import { params } from '../params.ts';
import type { FingerTracker } from '../touches.ts';
import type { ConfigMode } from './configMode.ts';
import { createSceneDocument, createSceneStore, readSceneDocument, SceneDocumentError, type SceneEdit } from './document.ts';
import { normalize } from './math.ts';
import { defaultScene, gapSoftening, glassDepthTerms, glassLights, gooGravity, initializeWorldLights, lightDirection, MAX_HOVER, rigTarget } from './scene.ts';
import './scene.css';

export interface SceneHostDeps {
  pageBg: HTMLCanvasElement;
  stage: HTMLElement;
  tracker: FingerTracker;
  theme: () => Theme;
  /** Seconds (the dev harness may run a virtual clock). */
  clock: () => number;
  wake: () => void;
  layout: () => Layout | null;
  /** Where the levitating goo is this frame (levitation.ts). */
  pose: () => LevitationPose;
  /** Re-measure the page layout (after the 3D view hands the page UI back). */
  resync: () => void;
  /** A loaded material may need a new simulation grid; scalar and optics edits only redraw. */
  materialChanged: (structural: boolean) => void;
}

export function createSceneHost(deps: SceneHostDeps) {
  let config: ConfigMode | null = null;
  const store = createSceneStore(createSceneDocument(), (change) => {
    deps.materialChanged(change.structural);
    config?.refresh(change.source !== 'editor');
    deps.wake();
  });
  const scene = store.scene;
  let placed = store.restore();
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  function initialize() {
    const layout = deps.layout();
    if (!placed && layout) {
      initializeWorldLights(scene, layout);
      placed = true;
      store.initialize();
    }
    if (placed) resolveReady();
  }
  function requireReady() {
    initialize();
    if (!placed) throw new SceneDocumentError([{ path: 'scene', message: 'layout is not ready; await guiStyle.scene.ready' }]);
  }
  function reset() {
    const fresh = createSceneDocument();
    const runtime = { ...defaultScene(), lights: fresh.lights };
    const layout = deps.layout();
    if (layout) initializeWorldLights(runtime, layout);
    placed = !!layout;
    store.api.load(fresh);
    initialize();
  }
  const query = new URLSearchParams(location.search);
  // ?hover=40 starts with the button floating 40 px in front of the page.
  const hover = Number(query.get('hover'));
  if (query.has('hover') && Number.isFinite(hover)) scene.goo.hover = Math.min(Math.max(hover, 0), MAX_HOVER);
  // ?gravity=wall (the default) | floor | ceiling | off | x,y,z (g, world frame).
  const GRAVITY: Record<string, [number, number, number]> = { wall: [0, 1, 0], floor: [0, 0, -1], ceiling: [0, 0, 1], off: [0, 0, 0] };
  const gq = query.get('gravity');
  if (gq) {
    const v = GRAVITY[gq] ?? gq.split(',').map(Number);
    if (v.length === 3 && v.every(Number.isFinite)) scene.gravity.splice(0, 3, ...v.map((c) => Math.min(Math.max(c, -10), 10)));
  }
  store.initialize();
  const documentApi = {
    ...store.api,
    ready,
    export() { requireReady(); return store.api.export(); },
    save() { requireReady(); return store.api.save(); },
    load(input: unknown) {
      const next = readSceneDocument(input);
      placed = true;
      const revision = store.api.load(next);
      resolveReady();
      return revision;
    },
    edit(edits: SceneEdit | SceneEdit[], options?: { expectedRevision?: number }) {
      requireReady();
      return store.api.edit(edits, options);
    },
    reset,
    get revision() { return store.api.revision; },
    get saved() { return store.api.saved; },
    get storageError() { return store.api.storageError; },
    get canUndo() { return store.api.canUndo; },
    get canRedo() { return store.api.canRedo; },
  };
  let goo: Goo | null = null;
  let root: TgpuRoot | null = null;
  let loading: Promise<ConfigMode | null> | null = null;

  /** Normal mode: the scene's lights, eye distance, page depth and the floating goo, as glass uniforms. */
  const glassHook = (values: GlassInput, theme: Theme): GlassInput => {
    initialize();
    const target = rigTarget(deps.layout(), scene, deps.pose());
    return { ...values, ...glassLights(scene, theme, target), ...glassDepthTerms(scene, looks[theme], deps.pose(), target) };
  };

  /**
   * How far past the button a floating goo's shadow reaches in normal mode (CSS px): displaced toward the far side
   * of the key light by the gap (plus a spring overshoot), spread by the softened blur, and shifted by the camera's
   * parallax between page and goo. The goo canvas grows to fit it (main.ts).
   */
  function shadowReach(): number {
    const layout = deps.layout();
    const s0 = layout?.shapes[0];
    const rest = scene.goo.hover + scene.page.depth;
    if (!layout || !s0 || rest <= 0) return 0;
    const look = looks[deps.theme()];
    const gap = rest + 0.3 * params.levitation.travel;
    const sun = scene.lights.find((l) => l.kind === 'sun');
    initialize();
    const target = rigTarget(layout, scene, deps.pose());
    const L = normalize(sun ? lightDirection(sun, target) : [look.lightDir[0], look.lightDir[1], look.lightDir[2]]);
    const shift = (gap * Math.max(Math.abs(L[0]), Math.abs(L[1]))) / Math.max(L[2], 0.05);
    const D = scene.camera.distance;
    const fromCenter =
      Math.hypot(layout.canvasX + s0.cx - layout.viewportW / 2, layout.canvasY + s0.cy - layout.viewportH / 2) + Math.max(s0.hx, s0.hy);
    const parallax = ((D + scene.page.depth) / Math.max(D - scene.goo.hover, 0.2 * D) - 1) * fromCenter;
    const sigma = gapSoftening(scene, look, gap, target).shadowSigma ?? look.shadowSigma;
    return shift + parallax + look.shadowReach + 2.5 * sigma;
  }

  function sceneChanged() {
    initialize();
    store.changed();
    deps.wake();
  }

  function attach(nextGoo: Goo, nextRoot: TgpuRoot) {
    goo = nextGoo;
    root = nextRoot;
    goo.setGlassHook(glassHook);
    config?.setGpu(root, goo);
    toggle?.removeAttribute('hidden');
  }

  function detach() {
    goo = null;
    root = null;
    config?.setGpu(null, null);
    toggle?.setAttribute('hidden', '');
  }

  async function loadConfig(): Promise<ConfigMode | null> {
    if (config) return config;
    loading ??= import('./configMode.ts').then(({ createConfigMode }) => {
      initialize();
      config = createConfigMode({ ...deps, scene, sceneChanged, document: documentApi, resetScene: reset, beginEdit: store.begin, endEdit: store.end, onActiveChange: syncToggle });
      if (root && goo) config.setGpu(root, goo);
      return config;
    });
    return loading;
  }

  async function setActive(on: boolean) {
    if (!goo || !root) return;
    if (!on && !config) return;
    const c = await loadConfig();
    if (!c) return;
    if (on) c.enter();
    else c.exit();
    deps.wake();
  }

  const isActive = () => !!config && config.wanted;

  // ---- the toggle: a key everywhere, a button where it is useful ----
  const showButton = import.meta.env.DEV || query.has('scene') || query.has('tune');
  let toggle: HTMLButtonElement | null = null;
  if (showButton) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'scene-toggle';
    toggle.textContent = '3D scene';
    toggle.title = 'Show the scene in 3D (C)';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.hidden = true;
    toggle.addEventListener('click', () => void setActive(!isActive()));
    document.body.append(toggle);
  }
  function syncToggle(active: boolean) {
    toggle?.setAttribute('aria-pressed', String(active));
    if (toggle) toggle.textContent = active ? 'Back to the page' : '3D scene';
  }

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'c' || e.key === 'C') void setActive(!isActive());
    else if (e.key === 'Escape' && isActive()) void setActive(false);
  });
  if (query.has('scene')) void loadConfig();

  return {
    scene,
    document: documentApi,
    material: () => store.material,
    initialize,
    beginEdit: store.begin,
    endEdit: store.end,
    attach,
    detach,
    sceneChanged,
    shadowReach,
    /** Gravity in the goo's rest frame (g), for the putty and the stability guard. */
    gravity: () => gooGravity(scene),
    /** True while the 3D view owns the page UI (its DOM boxes are transformed or re-parented). */
    get holdsLayout() {
      return !!config && config.phase !== 'off';
    },
    /** True while config mode animates or is being handled (keeps the frame loop awake). */
    get busy() {
      return config?.busy ?? false;
    },
    /** Called after the goo's frame, with the same clock. */
    frame(now: number) {
      config?.frame(now);
    },
    /** Dev aids: __goo.scene.* */
    dev: {
      ...documentApi,
      get revision() { return store.api.revision; },
      get saved() { return store.api.saved; },
      get storageError() { return store.api.storageError; },
      get canUndo() { return store.api.canUndo; },
      get canRedo() { return store.api.canRedo; },
      reset,
      scene,
      /** Call after editing `scene` by hand (wakes the loop). */
      changed: sceneChanged,
      enter: () => setActive(true),
      exit: () => setActive(false),
      config: () => config,
      /** Runs `ms` of frames on the harness's virtual clock (__goo.drive) and returns a copy of the scene canvas. */
      shot(ms = 50) {
        const c = config;
        const harness = (window as unknown as { __goo?: { drive(ms: number): unknown } }).__goo;
        if (!c || !harness) return null;
        c.dev.capture(true);
        harness.drive(ms);
        const copy = c.dev.capture(false);
        if (!copy) return null;
        const out = document.createElement('canvas');
        out.width = copy.width;
        out.height = copy.height;
        out.getContext('2d')?.drawImage(copy, 0, 0);
        // Where it sat on screen (viewport CSS px), so __goo.diff can line it up with a goo frame at another scale.
        const r = document.querySelector('.scene-canvas')?.getBoundingClientRect();
        out.dataset.box = (r ? [r.left, r.top, r.width, r.height] : [0, 0, window.innerWidth, window.innerHeight]).join(',');
        return out;
      },
      /** Lays scene shots out side by side, `width` CSS px each, over the page (call again with [] to clear). */
      sheet(frames: HTMLCanvasElement[], width = 480, cols = 2) {
        document.getElementById('scene-sheet')?.remove();
        if (!frames.length) return;
        const sheet = document.createElement('div');
        sheet.id = 'scene-sheet';
        sheet.style.cssText = `position:fixed;left:0;top:0;z-index:99;display:grid;grid-template-columns:repeat(${cols},auto);gap:4px;background:#888;pointer-events:none`;
        for (const f of frames) {
          f.style.cssText = `width:${width}px;height:${(width * f.height) / f.width}px`;
          sheet.append(f);
        }
        document.body.append(sheet);
      },
      /** Detach (false) or reattach the scene from the glass uniforms, to compare frames against plain look.ts. */
      hook(on: boolean) {
        goo?.setGlassHook(on ? glassHook : null);
        deps.wake();
      },
      /** Max |scene-derived − look.ts| over the glass light uniforms, both as f32 (0 = bit-identical uniforms). */
      identity(theme: Theme = deps.theme()) {
        const fresh = defaultScene();
        const derived = glassLights(fresh, theme);
        const look = looks[theme];
        const flat = (v: unknown): number[] =>
          typeof v === 'number' ? [v] : Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [];
        const pairs: [unknown, unknown][] = [
          [derived.lightDir, look.lightDir],
          [derived.lightColor, look.lightColor],
          [derived.sunRadius, look.sunRadius],
          [derived.eyeDist, look.eyeDist],
          [derived.softboxes, look.softboxes.map((b) => [b.c, b.t, b.b, b.radiance, b.halfSize, b.round, b.soft])],
        ];
        let max = 0;
        for (const [a, b] of pairs) {
          const fa = flat(a);
          const fb = flat(b);
          if (fa.length !== fb.length) return Infinity;
          fa.forEach((x, i) => (max = Math.max(max, Math.abs(Math.fround(x) - Math.fround(fb[i])))));
        }
        return max;
      },
    },
  };
}

export type SceneHost = ReturnType<typeof createSceneHost>;
