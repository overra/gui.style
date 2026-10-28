import type GUI from 'lil-gui';
import { tgpu } from 'typegpu';
import { paintLabel, paintPage, type Theme } from './background.ts';
import { effectiveParams } from './feel.ts';
import { createGoo, type Goo } from './gpu/goo.ts';
import { attachInput } from './input.ts';
import { measureLayout, type Layout } from './layout.ts';
import { createLevitation } from './levitation.ts';
import { looks } from './look.ts';
import { params } from './params.ts';
import { createSceneHost } from './scene/host.ts';
import { FingerTracker } from './touches.ts';

const MAX_DPR = 2;
/** How far the goo canvas may reach past the button for a floating button's shadow (CSS px). */
const MAX_BLEED = 192;
const NO_WEBGPU = 'WebGPU isn’t available here, so this is a static stand-in. Try a recent Chrome, Edge or Safari.';

const pageBg = document.getElementById('page-bg') as HTMLCanvasElement;
const gooWrap = document.querySelector('.goo') as HTMLElement;
const gooCanvas = gooWrap.querySelector('canvas') as HTMLCanvasElement;
const buttons = [...gooWrap.querySelectorAll<HTMLElement>('[data-goo]')];
const status = document.getElementById('status');
const support = document.getElementById('support');
const tweak = document.getElementById('tweak') as HTMLButtonElement | null;

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const forcedColors = matchMedia('(forced-colors: active)');
const theme = (): Theme => (darkQuery.matches ? 'dark' : 'light');
/** Seconds. The dev harness can replace real time with a virtual clock to step frames deterministically. */
let virtualNow: number | null = null;
const clock = () => virtualNow ?? performance.now() / 1000;

// ---- page background (always a plain 2D canvas, with or without WebGPU) ----
// It is painted at its own CSS box, and the glass maps into that same box, so what is refracted always lines up
// with what is around it (mobile toolbars, pinch-zoom and scrolling included).
const pageScale = () => Math.min(window.devicePixelRatio || 1, MAX_DPR);
const pageBox = () => pageBg.getBoundingClientRect();
function repaintPage() {
  const { width, height } = pageBox();
  paintPage(pageBg, { width, height, scale: pageScale(), theme: theme() });
}
repaintPage();

// ---- activation count, announced politely (debounced: key repeat can fire many clicks a second) ----
let presses = 0;
let announce = 0;
for (const b of buttons) {
  b.addEventListener('click', () => {
    presses++;
    clearTimeout(announce);
    announce = window.setTimeout(() => {
      if (status) status.textContent = presses === 1 ? 'Squished once.' : `Squished ${presses} times.`;
    }, 700);
  });
}

/** Falls back to the static CSS button; `message` (if any) tells the visitor why. */
function explain(reason: string, message: string | null = NO_WEBGPU) {
  console.info('[goo] showing the static button:', reason);
  gooWrap.classList.remove('is-live');
  if (tweak) tweak.hidden = true;
  if (support && message) {
    support.textContent = message;
    support.hidden = false;
  }
}

async function requestDevice(): Promise<GPUDevice | null> {
  if (!window.isSecureContext || !('gpu' in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' }).catch(() => null);
  // A software adapter would run the glass at single-digit frame rates.
  if (!adapter || (adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter) return null;
  return adapter.requestDevice({ label: 'goo' }).catch(() => null);
}

// ---- the live goo ----
const tracker = new FingerTracker(params.finger);
/** The whole button's rigid motion when it floats above the page (presses sink and tilt it). */
const levitation = createLevitation();
let goo: Goo | null = null;
let layout: Layout | null = null;
let gooScale = 1;
let droppedAt = -1e3;
let dropped = false;
let afterFrame: (() => void) | null = null;

const labelCanvas = document.createElement('canvas');
function repaintLabel() {
  const button = buttons[0];
  const shape = layout?.shapes[0];
  if (!goo || !button || !shape) return;
  const cs = getComputedStyle(button);
  paintLabel(labelCanvas, {
    width: shape.hx * 2,
    height: shape.hy * 2,
    scale: gooScale,
    text: (button.textContent ?? '').trim().replace(/\s+/g, ' '),
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
  });
  goo.setLabel(labelCanvas);
}

function relayout() {
  // The 3D view transforms or re-parents the page UI, so DOM boxes are not page boxes until it hands back.
  if (!goo || sceneHost.holdsLayout) return;
  const rect = gooCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const budget = matchMedia('(pointer: coarse)').matches ? params.pixelBudget.coarse : params.pixelBudget.fine;
  gooScale = Math.min(dpr, MAX_DPR, Math.sqrt(budget / Math.max(1, rect.width * rect.height)));
  const w = Math.max(1, Math.round(rect.width * gooScale));
  const h = Math.max(1, Math.round(rect.height * gooScale));
  if (gooCanvas.width !== w || gooCanvas.height !== h) {
    gooCanvas.width = w;
    gooCanvas.height = h;
  }
  layout = measureLayout(gooCanvas, buttons, params.sim.cell, pageBox());
  // Drop the goo onto the page the first time it appears (unless motion is reduced).
  const drop = !dropped && !motionQuery.matches;
  if (drop) droppedAt = clock();
  dropped = true;
  goo.setLayout(layout, gooScale, drop);
  repaintLabel();
}

function refreshPage() {
  repaintPage();
  goo?.setPage(pageBg, theme());
}

/** The goo moved relative to the page (layout shift) or the page box changed size. */
function track() {
  if (!goo || !layout || sceneHost.holdsLayout) return;
  const r = gooCanvas.getBoundingClientRect();
  const p = pageBox();
  layout = { ...layout, canvasX: r.left - p.left, canvasY: r.top - p.top, viewportW: p.width, viewportH: p.height };
  goo.setViewport(layout.canvasX, layout.canvasY, p.width, p.height);
}

// A floating button's shadow lands further out than --goo-m: the goo canvas grows to fit it (in 16 px steps, so a
// hover slider doesn't re-lay out the goo on every tick; resizing it rebuilds the simulation grid at rest).
const gooMargin = parseFloat(getComputedStyle(gooWrap).getPropertyValue('--goo-m')) || 48;
let bleed = gooMargin;
function syncBleed() {
  if (sceneHost.holdsLayout) return;
  const want = Math.min(Math.max(Math.ceil(sceneHost.shadowReach() / 16) * 16, gooMargin), MAX_BLEED);
  if (want === bleed) return;
  bleed = want;
  if (want === gooMargin) gooWrap.style.removeProperty('--goo-bleed');
  else gooWrap.style.setProperty('--goo-bleed', `${want}px`);
}

// ---- frame loop: runs while anything moves, sleeps once the goo has healed ----
let rafId = 0;
let lastFrame = 0;
let quietSince = clock();

const frame = (ms: number) => {
  rafId = 0;
  if (!goo || !layout) return;
  const now = ms / 1000;
  const dt = lastFrame ? Math.min(now - lastFrame, 1 / 20) : 1 / 60;
  lastFrame = now;

  const eff = effectiveParams();
  tracker.setTuning(eff.finger);
  tracker.update(now, dt, goo.surfaceAt);
  const { scene } = sceneHost;
  const reducedMotion = motionQuery.matches;
  levitation.step(dt, { hover: scene.goo.hover, pageDepth: scene.page.depth, layout, tracker, eff, reducedMotion });
  if (tracker.busy || sceneHost.busy || levitation.moving) quietSince = now;
  // Sleep only once every imprint, ridge and smudge has visibly healed under the current feel settings.
  const settle = Math.max(
    params.sleepAfter,
    eff.heal.hold + eff.heal.ramp + 5 * eff.heal.tau,
    5 * eff.detail.fadeTau,
    5 * eff.detail.hazeTau,
  );
  const sleeping = now - quietSince >= settle;
  // Going to sleep: snap exactly back to the pristine shape and draw it once.
  if (sleeping) {
    goo.snapToRest();
    levitation.reset();
  }
  goo.frame({ now, dt, tracker, reducedMotion, sinceIntro: now - droppedAt, eff });
  sceneHost.frame(now);
  tracker.endFrame();
  syncBleed();
  afterFrame?.();
  afterFrame = null;

  if (sleeping) lastFrame = 0;
  else if (virtualNow === null) rafId = requestAnimationFrame(frame);
};

/** Something moved the goo: simulate until it has healed again. */
const wake = () => {
  quietSince = clock();
  if (!rafId && virtualNow === null) rafId = requestAnimationFrame(frame);
};

/** Only the picture changed (resize, theme, fonts): draw once, without restarting the simulation. */
const redraw = () => {
  if (!rafId && virtualNow === null) rafId = requestAnimationFrame(frame);
};

attachInput({
  tracker,
  buttons,
  toGoo: (x, y) => {
    const r = gooCanvas.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  },
  centerOf: (button) => {
    const s = layout?.shapes.find((sh) => sh.element === button);
    return s ? { x: s.cx, y: s.cy } : null;
  },
  surfaceAt: (x, y) => goo?.surfaceAt(x, y) ?? 0,
  now: clock,
  wake,
});

// ---- the scene behind the page: lights and camera for the glass, and the 3D config view (press C) ----
const sceneHost = createSceneHost({
  pageBg,
  stage: document.querySelector('.stage') as HTMLElement,
  tracker,
  theme,
  clock,
  wake: () => wake(),
  layout: () => layout,
  pose: () => levitation.pose,
  resync: () => {
    relayout();
    track();
  },
});

// ---- bring-up, with recovery from device loss ----
let losses: number[] = [];

async function start() {
  if (forcedColors.matches) return explain('forced colors are active', null);
  const device = await requestDevice();
  if (!device) return explain('no WebGPU adapter');

  void device.lost.then((info) => {
    gooWrap.classList.remove('is-live');
    goo = null;
    sceneHost.detach();
    if (info.reason === 'destroyed') return;
    const t = clock();
    losses = losses.filter((x) => t - x < 60).concat(t);
    if (losses.length >= 3) {
      return explain('the GPU device keeps getting lost', 'The GPU stopped responding, so this is a static stand-in.');
    }
    setTimeout(() => void start(), 300 * losses.length);
  });

  // Prove the whole GPU path — pipelines, uploads and a first rendered frame — before hiding the CSS button.
  const scopes = ['validation', 'out-of-memory', 'internal'] as const;
  for (const s of scopes) device.pushErrorScope(s);
  let failure: unknown = null;
  try {
    const root = tgpu.initFromDevice({ device });
    const next = createGoo(root, gooCanvas);
    await next.ready();
    goo = next;
    sceneHost.attach(next, root);
    refreshPage();
    relayout();
    quietSince = clock();
    frame(performance.now());
  } catch (err) {
    failure = err;
  }
  const errors = await Promise.all(scopes.map(() => device.popErrorScope()));
  failure ??= errors.find(Boolean) ?? null;
  if (failure || !goo) {
    console.error(failure);
    goo = null;
    sceneHost.detach();
    device.destroy();
    return explain('the GPU pipeline failed to build', 'The GPU couldn’t build this effect, so this is a static stand-in.');
  }
  await device.queue.onSubmittedWorkDone();
  if (!goo) return;
  gooWrap.classList.add('is-live');
  if (tweak) tweak.hidden = false;
  device.addEventListener(
    'uncapturederror',
    (e) => {
      console.error((e as GPUUncapturedErrorEvent).error);
      goo = null;
      sceneHost.detach();
      explain('GPU error while rendering', 'The GPU hit an error, so this is a static stand-in.');
    },
    { once: true },
  );
}

function dropAgain() {
  droppedAt = clock();
  goo?.replayDrop();
  wake();
}

// The tuning panel loads on demand (the "Tweak the goo" button, or ?tune in the URL).
let guiPromise: Promise<GUI> | null = null;
let guiOpen = false;
async function toggleTuning(open = !guiOpen) {
  guiOpen = open;
  tweak?.setAttribute('aria-expanded', String(open));
  guiPromise ??= import('./tuning.ts').then(({ openTuning }) =>
    openTuning({ theme, wake, replayDrop: dropAgain, tap: () => buttons[0]?.click(), goo: sceneHost.scene.goo }),
  );
  try {
    (await guiPromise).show(guiOpen);
  } catch (err) {
    guiPromise = null; // let a later click retry the chunk load
    console.error(err);
  }
}
tweak?.addEventListener('click', () => void toggleTuning());
if (new URLSearchParams(location.search).has('tune')) void toggleTuning(true);

// Resizing a canvas clears it, so every size change redraws.
const onViewport = () => {
  refreshPage();
  relayout();
  track();
  redraw();
};
window.addEventListener('resize', onViewport);
// Zoom or a move to another display changes the device-pixel ratio without resizing anything in CSS px.
const watchDpr = () =>
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      watchDpr();
      onViewport();
    },
    { once: true },
  );
watchDpr();
new ResizeObserver(() => {
  relayout();
  redraw();
}).observe(gooCanvas);
new ResizeObserver(() => {
  refreshPage();
  track();
  redraw();
}).observe(pageBg);
darkQuery.addEventListener('change', () => {
  refreshPage();
  redraw();
});
motionQuery.addEventListener('change', redraw);
forcedColors.addEventListener('change', () => location.reload());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && redraw());
void document.fonts.ready.then(() => {
  relayout();
  track();
  redraw();
});

if (import.meta.env.DEV) {
  // Dev aids for inspecting the goo up close (they work even when the tab is in the background):
  //   __goo.drive(ms)          → step frames on a virtual clock (60 fps) and return a copy of the last one,
  //                              taken while the WebGPU drawing buffer is still readable
  //   __goo.show(frames, zoom) → lays copies out as a magnified contact sheet
  //   __goo.press(fx, fy) / move / release → synthetic touches at a fraction of the button's box
  //   __goo.realtime()         → back to requestAnimationFrame
  //   __goo.params / __goo.looks → live tunables
  const copyFrame = () => {
    const out = document.createElement('canvas');
    out.width = gooCanvas.width;
    out.height = gooCanvas.height;
    const ctx = out.getContext('2d');
    ctx?.drawImage(pageBg, ...captureSource(), 0, 0, out.width, out.height);
    ctx?.drawImage(gooCanvas, 0, 0);
    return out;
  };
  let synthetic = 900;
  Object.assign(window, {
    __goo: {
      params,
      looks,
      tracker,
      /** The floating button's rigid motion: .pose (height, tilt, pivot), .moving. Hover: __goo.scene.scene.goo. */
      levitation,
      wake,
      /** The 3D scene: __goo.scene.enter() / exit(), .scene (the model), .identity(), .shot(ms) (see scene/host.ts). */
      scene: sceneHost.dev,
      drive(ms: number) {
        if (virtualNow === null) {
          cancelAnimationFrame(rafId);
          rafId = 0;
          virtualNow = performance.now() / 1000;
        }
        let copy: HTMLCanvasElement | null = null;
        const frames = Math.max(1, Math.round((ms / 1000) * 60));
        for (let i = 0; i < frames; i++) {
          virtualNow += 1 / 60;
          quietSince = virtualNow;
          afterFrame = i === frames - 1 ? () => (copy = copyFrame()) : null;
          frame(virtualNow * 1000);
        }
        return copy;
      },
      realtime() {
        virtualNow = null;
        lastFrame = 0;
        wake();
      },
      /** Re-measure now (a hidden tab delivers no ResizeObserver callbacks, e.g. after the canvas grew for a shadow). */
      relayout() {
        syncBleed();
        relayout();
        track();
      },
      drop: dropAgain,
      /** `crop` is [x, y, w, h] in goo-space CSS px (the canvas extends --goo-m past the button). */
      show(frames: HTMLCanvasElement[], zoom = 2, cols = 2, crop?: [number, number, number, number]) {
        document.getElementById('goo-sheet')?.remove();
        const sheet = document.createElement('div');
        sheet.id = 'goo-sheet';
        sheet.style.cssText = `position:fixed;left:0;top:0;z-index:9;display:grid;grid-template-columns:repeat(${cols},auto);gap:4px;background:#888;pointer-events:none`;
        for (const f of frames) {
          const [cx, cy, cw, ch] = crop ?? [0, 0, f.width / gooScale, f.height / gooScale];
          const out = document.createElement('canvas');
          out.width = Math.round(cw * gooScale);
          out.height = Math.round(ch * gooScale);
          out.getContext('2d')?.drawImage(f, cx * gooScale, cy * gooScale, out.width, out.height, 0, 0, out.width, out.height);
          out.style.cssText = `width:${cw * zoom}px;height:${ch * zoom}px;image-rendering:pixelated`;
          sheet.append(out);
        }
        document.body.append(sheet);
      },
      clear() {
        document.getElementById('goo-sheet')?.remove();
      },
      press(fx = 0.5, fy = 0.5, pointerType = 'touch') {
        const b = buttons[0].getBoundingClientRect();
        const init = { bubbles: true, pointerId: ++synthetic, pointerType, clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, buttons: 1, isPrimary: true };
        buttons[0].dispatchEvent(new PointerEvent('pointerdown', init));
        return synthetic;
      },
      move(id: number, fx: number, fy: number) {
        const b = buttons[0].getBoundingClientRect();
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, buttons: 1 }));
      },
      release(id = synthetic) {
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id }));
      },
    },
  });
}

/** The page-background region under the goo canvas, in page-canvas pixels. */
function captureSource(): [number, number, number, number] {
  const r = gooCanvas.getBoundingClientRect();
  const p = pageBox();
  const k = pageBg.width / p.width;
  return [(r.left - p.left) * k, (r.top - p.top) * k, r.width * k, r.height * k];
}

void start();
