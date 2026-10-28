// Scene host, always loaded and small. It owns the scene model and feeds it to the goo's glass uniforms in
// normal mode (the default scene reproduces look.ts exactly). It also loads config mode, the 3D view, on demand:
// press C, or use the "3D scene" button. The button shows in dev, or with ?scene or ?tune in the URL.

import type { TgpuRoot } from 'typegpu';
import type { Theme } from '../background.ts';
import type { GlassInput, Goo } from '../gpu/goo.ts';
import type { Layout } from '../layout.ts';
import { looks } from '../look.ts';
import type { FingerTracker } from '../touches.ts';
import type { ConfigMode } from './configMode.ts';
import { defaultScene, glassDepthTerms, glassLights, pageForeshortening, type Scene } from './scene.ts';
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
  /** Re-measure the page layout (after the 3D view hands the page UI back). */
  resync: () => void;
}

export function createSceneHost(deps: SceneHostDeps) {
  const scene: Scene = defaultScene();
  let goo: Goo | null = null;
  let root: TgpuRoot | null = null;
  let config: ConfigMode | null = null;
  let loading: Promise<ConfigMode | null> | null = null;

  /** Normal mode: the scene's lights, eye distance and page depth, as glass uniforms. */
  const glassHook = (values: GlassInput, theme: Theme): GlassInput => ({
    ...values,
    ...glassLights(scene, theme),
    ...glassDepthTerms(scene, looks[theme], values),
  });

  /** A page that keeps its size while pushed back is seen smaller: scale the page canvas to match. */
  function applyPageTransform() {
    const k = scene.page.fill || scene.page.depth <= 0 ? 1 : pageForeshortening(scene);
    deps.pageBg.style.transform = k === 1 ? '' : `scale(${k})`;
  }

  function sceneChanged() {
    applyPageTransform();
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
      config = createConfigMode({ ...deps, scene, sceneChanged, onActiveChange: syncToggle });
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
  const query = new URLSearchParams(location.search);
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
    attach,
    detach,
    sceneChanged,
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
      scene,
      /** Call after editing `scene` by hand (re-applies the page transform, wakes the loop). */
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
