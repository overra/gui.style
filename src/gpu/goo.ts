// Owns the GPU side: textures sized to the goo's layout, the putty simulation, the fingerprint layer and the
// glass render, all recorded into one command encoder per frame.

import { common, d, type TgpuRoot } from 'typegpu';
import type { Theme } from '../background.ts';
import type { Effective } from '../feel.ts';
import { sceneSdf, sameGrid, type GooShape, type Layout } from '../layout.ts';
import { looks } from '../look.ts';
import { params, restHeightCpu } from '../params.ts';
import type { FingerTracker } from '../touches.ts';
import { detailKernel, detailLayout, detailPackKernel, detailPackLayout } from './detailKernels.ts';
import { gooFragment, LabelParams, renderLayout } from './renderShader.ts';
import { DetailParams, Finger, GlassParams, MAX_FINGERS, MAX_SHAPES, Shape, SimParams } from './schemas.ts';
import {
  applyKernel,
  applyLayout,
  elasticKernel,
  elasticLayout,
  fluxKernel,
  fluxLayout,
  limitKernel,
  limitLayout,
  packKernel,
  packLayout,
  simShared,
} from './simKernels.ts';

export interface FrameInput {
  now: number;
  dt: number;
  tracker: FingerTracker;
  reducedMotion: boolean;
  /** Seconds since the goo was dropped onto the page (large when there's no intro). */
  sinceIntro: number;
  /** Physical and visual knobs after the feel macros (feel.ts). */
  eff: Effective;
}

type FingerData = d.InferInput<typeof Finger>;
export type GlassInput = d.InferInput<typeof GlassParams>;

const WG = 8;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLinear = (hex: string) =>
  d.vec3f(
    srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255),
    srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255),
    srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255),
  );

const LABEL_LOOK = {
  light: { plateColor: d.vec3f(1, 1, 1), plateAlpha: 0.22, inkColor: hexLinear('#1a1a1a'), inkAlpha: 0.92 },
  dark: { plateColor: d.vec3f(0, 0, 0), plateAlpha: 0.3, inkColor: hexLinear('#f2f3f7'), inkAlpha: 0.92 },
} satisfies Record<Theme, d.InferInput<typeof LabelParams>>;

export function createGoo(root: TgpuRoot, canvas: HTMLCanvasElement) {
  const context = root.configureContext({ canvas, alphaMode: 'premultiplied' });

  const simUniform = root.createUniform(SimParams);
  const fingerUniform = root.createUniform(d.arrayOf(Finger, MAX_FINGERS));
  const detailUniform = root.createUniform(DetailParams);
  const glassUniform = root.createUniform(GlassParams);
  const shapeUniform = root.createUniform(d.arrayOf(Shape, MAX_SHAPES));
  const labelUniform = root.createUniform(LabelParams);
  const sharedGroup = root.createBindGroup(simShared, { sim: simUniform, fingers: fingerUniform });

  const pipes = {
    elastic: root.createComputePipeline({ compute: elasticKernel }),
    flux: root.createComputePipeline({ compute: fluxKernel }),
    limit: root.createComputePipeline({ compute: limitKernel }),
    apply: root.createComputePipeline({ compute: applyKernel }),
    pack: root.createComputePipeline({ compute: packKernel }),
    detail: root.createComputePipeline({ compute: detailKernel }),
    detailPack: root.createComputePipeline({ compute: detailPackKernel }),
  };
  const renderPipe = root.createRenderPipeline({ vertex: common.fullScreenTriangle, fragment: gooFragment });
  const smp = root.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // One factory per format keeps each texture's literal format type (bind groups check it).
  const tex = {
    rgba32: (w: number, h: number) =>
      root.createTexture({ size: [w, h], format: 'rgba32float' }).$usage('storage', 'sampled'),
    rg32: (w: number, h: number) => root.createTexture({ size: [w, h], format: 'rg32float' }).$usage('storage', 'sampled'),
    r32: (w: number, h: number) => root.createTexture({ size: [w, h], format: 'r32float' }).$usage('storage', 'sampled'),
    rgba16: (w: number, h: number) =>
      root.createTexture({ size: [w, h], format: 'rgba16float' }).$usage('storage', 'sampled'),
    page: (w: number, h: number) =>
      root
        .createTexture({ size: [w, h], format: 'rgba8unorm-srgb', mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1 })
        .$usage('sampled', 'render'),
    mask: (w: number, h: number) =>
      root
        .createTexture({ size: [w, h], format: 'rgba8unorm', mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1 })
        .$usage('sampled', 'render'),
  };

  const makeSimTextures = (layout: Layout) => {
    const { cols, rows } = layout;
    const dw = Math.ceil(layout.width / params.detail.texel);
    const dh = Math.ceil(layout.height / params.detail.texel);
    return {
      cols,
      rows,
      dw,
      dh,
      rest: root.createTexture({ size: [cols, rows], format: 'r32float' }).$usage('sampled'),
      stateA: tex.rgba32(cols, rows),
      stateB: tex.rgba32(cols, rows),
      pressure: tex.r32(cols, rows),
      flux: tex.rg32(cols, rows),
      faces: tex.rgba32(cols, rows),
      limit: tex.r32(cols, rows),
      simPack: tex.rgba16(cols, rows),
      cover: tex.rgba16(cols, rows),
      detail: [tex.rgba32(dw, dh), tex.rgba32(dw, dh)] as const,
      detailPack: tex.rgba16(dw, dh),
    };
  };
  type SimTextures = ReturnType<typeof makeSimTextures>;

  let sim: SimTextures | null = null;
  let page: ReturnType<typeof tex.page> | null = null;
  let label: ReturnType<typeof tex.mask> | null = null;
  let layout: Layout | null = null;
  let theme: Theme = 'light';
  let scale = 1;
  let accumulator = 0;
  let detailFlip = 0;
  let restField = new Float32Array(0);
  // Scene hooks (src/scene): the scene's lights and camera rewrite the glass uniforms; the 3D view shares textures.
  let glassHook: ((values: GlassInput, theme: Theme) => GlassInput) | null = null;
  let lastGlass: GlassInput | null = null;
  let resourceVersion = 0;
  const glow = { x: 0, y: 0, amount: 0, radius: 20 };

  const bindSim = (t: SimTextures) => {
    const groups = {
      elastic: root.createBindGroup(elasticLayout, {
        state: t.stateA,
        rest: t.rest,
        stateOut: t.stateB,
        pressureOut: t.pressure,
      }),
      flux: root.createBindGroup(fluxLayout, { pressure: t.pressure, rest: t.rest, flux: t.flux, fluxOut: t.faces }),
      limit: root.createBindGroup(limitLayout, { faces: t.faces, rest: t.rest, state: t.stateB, limitOut: t.limit }),
      apply: root.createBindGroup(applyLayout, {
        faces: t.faces,
        limit: t.limit,
        state: t.stateB,
        stateOut: t.stateA,
        fluxOut: t.flux,
      }),
      pack: root.createBindGroup(packLayout, { state: t.stateA, rest: t.rest, packOut: t.simPack, coverOut: t.cover }),
    };
    return {
      elastic: pipes.elastic.with(sharedGroup).with(groups.elastic),
      flux: pipes.flux.with(sharedGroup).with(groups.flux),
      limit: pipes.limit.with(sharedGroup).with(groups.limit),
      apply: pipes.apply.with(sharedGroup).with(groups.apply),
      pack: pipes.pack.with(sharedGroup).with(groups.pack),
      detail: [0, 1].map((k) =>
        pipes.detail.with(
          root.createBindGroup(detailLayout, {
            params: detailUniform,
            fingers: fingerUniform,
            src: t.detail[k],
            dst: t.detail[1 - k],
          }),
        ),
      ),
      detailPack: [0, 1].map((k) =>
        pipes.detailPack.with(
          root.createBindGroup(detailPackLayout, { src: t.detail[1 - k], packOut: t.detailPack }),
        ),
      ),
    };
  };
  let bound: ReturnType<typeof bindSim> | null = null;

  const bindRender = () =>
    sim && page && label
      ? root.createBindGroup(renderLayout, {
          params: glassUniform,
          shapes: shapeUniform,
          label: labelUniform,
          page,
          labelMask: label,
          sim: sim.simPack,
          cover: sim.cover,
          detail: sim.detailPack,
          smp,
        })
      : null;
  let renderGroup: ReturnType<typeof bindRender> = null;

  /** Rest heights per cell, and a state that is either at rest or a taller, narrower blob of equal volume. */
  const initialState = (l: Layout, drop: boolean) => {
    const { cols, rows, cell, shapes } = l;
    const rest = new Float32Array(cols * rows);
    const blob = new Float32Array(cols * rows);
    let volRest = 0;
    let volBlob = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cell;
        const y = (j + 0.5) * cell;
        const k = j * cols + i;
        rest[k] = restHeightCpu(sceneSdf(shapes, x, y, params.shape.blend));
        volRest += rest[k];
        if (drop) {
          blob[k] = restHeightCpu(sceneSdf(shapes, x, y, params.shape.blend, params.intro.shrink));
          volBlob += blob[k];
        }
      }
    }
    const gain = drop && volBlob > 0 ? volRest / volBlob : 0;
    const state = new Float32Array(cols * rows * 4);
    for (let k = 0; k < cols * rows; k++) {
      state[k * 4 + 2] = drop ? gain * blob[k] - rest[k] : 0;
      state[k * 4 + 3] = 100; // long since touched: heals freely
    }
    return { rest, state };
  };

  const shapeData = (shapes: GooShape[]) =>
    Array.from({ length: MAX_SHAPES }, (_, i) => {
      const s = shapes[i];
      return {
        center: s ? d.vec2f(s.cx, s.cy) : d.vec2f(),
        halfSize: s ? d.vec2f(s.hx, s.hy) : d.vec2f(1, 1),
        radius: s?.radius ?? 0,
        pad0: 0,
        pad1: 0,
        pad2: 0,
      };
    });

  function setLayout(next: Layout, nextScale: number, drop: boolean) {
    scale = nextScale;
    // The canvas can grow or shrink around the button (a floating button's shadow): the touch glow stays on it.
    const a = layout?.shapes[0];
    const b = next.shapes[0];
    if (a && b) {
      glow.x += b.cx - a.cx;
      glow.y += b.cy - a.cy;
    }
    if (!sameGrid(layout, next) || !sim) {
      if (sim) {
        for (const t of [sim.rest, sim.stateA, sim.stateB, sim.pressure, sim.flux, sim.faces, sim.limit, sim.simPack, sim.cover]) {
          t.destroy();
        }
        for (const t of [...sim.detail, sim.detailPack]) t.destroy();
      }
      sim = makeSimTextures(next);
      resourceVersion++;
      const init = initialState(next, drop);
      restField = init.rest;
      sim.rest.write(init.rest);
      sim.stateA.write(init.state);
      sim.flux.clear();
      sim.detail[0].clear();
      sim.detail[1].clear();
      bound = bindSim(sim);
      accumulator = 0;
      shapeUniform.write(shapeData(next.shapes));
    }
    layout = next;
    renderGroup = bindRender();
  }

  /** Upload the page canvas (shown behind us) so the glass can refract the same pixels. */
  function setPage(pageCanvas: HTMLCanvasElement, nextTheme: Theme) {
    theme = nextTheme;
    if (!page || page.props.size[0] !== pageCanvas.width || page.props.size[1] !== pageCanvas.height) {
      page?.destroy();
      page = tex.page(pageCanvas.width, pageCanvas.height);
      resourceVersion++;
    }
    page.write(pageCanvas);
    page.generateMipmaps();
    labelUniform.write(LABEL_LOOK[theme]);
    renderGroup = bindRender();
  }

  function setLabel(labelCanvas: HTMLCanvasElement) {
    if (!label || label.props.size[0] !== labelCanvas.width || label.props.size[1] !== labelCanvas.height) {
      label?.destroy();
      label = tex.mask(labelCanvas.width, labelCanvas.height);
      resourceVersion++;
    }
    label.write(labelCanvas);
    label.generateMipmaps();
    renderGroup = bindRender();
  }

  /** The canvas moved (scroll) or the viewport resized: keeps page lookups aligned. */
  function setViewport(canvasX: number, canvasY: number, viewportW: number, viewportH: number) {
    if (!layout) return;
    layout = { ...layout, canvasX, canvasY, viewportW, viewportH };
  }

  /** Drop the goo onto the page again: a taller, narrower blob that slumps into shape. */
  function replayDrop() {
    if (!sim || !layout) return;
    sim.stateA.write(initialState(layout, true).state);
    sim.flux.clear();
    sim.detail[0].clear();
    sim.detail[1].clear();
  }

  /** Back to the pristine resting shape (used when the loop goes to sleep, and to recover from blow-ups). */
  function snapToRest() {
    if (!sim || !layout) return;
    const state = new Float32Array(sim.cols * sim.rows * 4);
    for (let k = 0; k < sim.cols * sim.rows; k++) state[k * 4 + 3] = 100;
    sim.stateA.write(state);
    sim.flux.clear();
    sim.detail[0].clear();
    sim.detail[1].clear();
    glow.amount = 0;
  }

  /** Rest height at a goo-space point (where a finger first meets the surface). */
  function surfaceAt(x: number, y: number) {
    if (!layout) return 0;
    const i = Math.min(layout.cols - 1, Math.max(0, Math.floor(x / layout.cell)));
    const j = Math.min(layout.rows - 1, Math.max(0, Math.floor(y / layout.cell)));
    return Math.max(restField[j * layout.cols + i] ?? 0, restHeightCpu(sceneSdf(layout.shapes, x, y, params.shape.blend)));
  }

  const fingerScratch: FingerData[] = Array.from({ length: MAX_FINGERS }, () => ({
    pos: d.vec2f(),
    prev: d.vec2f(),
    axes: d.vec2f(1, 1),
    rot: d.vec2f(1, 0),
    reach: d.vec2f(),
    tipZ: 1e6,
    capZ: 1,
    contact: 0,
    seed: 0,
    skin: 1,
    pad0: 0,
  }));

  function writeFingers(tracker: FingerTracker, now: number, dt: number): number {
    const capZ = params.finger.capZ;
    let count = 0;
    let newest = -Infinity;
    let glowTarget = 0;
    for (const f of tracker.fingers.values()) {
      if (count >= MAX_FINGERS) break;
      const tipZ = tracker.tipZ(f);
      // The part of the ellipsoidal cap below the resting surface is what touches the goo.
      const sink = Math.min(Math.max(f.surfaceZ - tipZ, 0), capZ);
      const reach = Math.sqrt(1 - (1 - sink / capZ) ** 2);
      const pressing = tracker.pressing(f, now);
      fingerScratch[count] = {
        pos: d.vec2f(f.x, f.y),
        prev: d.vec2f(f.px, f.py),
        axes: d.vec2f(f.ax, f.ay),
        rot: d.vec2f(Math.cos(f.angle), Math.sin(f.angle)),
        reach: d.vec2f(f.ax * reach, f.ay * reach),
        tipZ,
        capZ,
        contact: pressing ? Math.min(1, sink / 1.5) : 0,
        seed: f.seed,
        skin: f.kind === 'pen' ? 0 : 1,
        pad0: 0,
      };
      count++;
      if (pressing && f.downAt > newest) {
        newest = f.downAt;
        const hold = Math.max(0, now - f.downAt);
        glow.x = f.x;
        glow.y = f.y;
        glow.radius = f.ay * (0.6 + 1.0 * (1 - Math.exp(-hold / 0.25)));
        glowTarget = looks[theme].glowPeak;
      }
    }
    // The glow rises quickly under a finger and fades slowly after release.
    const tau = glowTarget > glow.amount ? 0.05 : 0.45;
    glow.amount += (glowTarget - glow.amount) * (1 - Math.exp(-dt / tau));
    fingerUniform.write(fingerScratch);
    return count;
  }

  function writeGlass(setF: number, visual: Effective['visual']) {
    if (!layout) return;
    const look = looks[theme];
    const s0 = layout.shapes[0];
    const values: GlassInput = {
      canvasOrigin: d.vec2f(layout.canvasX, layout.canvasY),
      viewport: d.vec2f(layout.viewportW, layout.viewportH),
      pxCss: 1 / scale,
      shapeCount: Math.min(layout.shapes.length, MAX_SHAPES),
      simCell: layout.cell,
      detailTexel: params.detail.texel,
      plateau: params.shape.plateau,
      bezel: params.shape.bezel,
      steepness: params.shape.steepness,
      blend: params.shape.blend,
      filmEps: look.filmEps,
      depthLens: look.depthLens,
      labelOrigin: s0 ? d.vec2f(s0.cx - s0.hx, s0.cy - s0.hy) : d.vec2f(),
      labelSize: s0 ? d.vec2f(s0.hx * 2, s0.hy * 2) : d.vec2f(1, 1),
      iorR: look.iorR,
      iorG: look.iorG,
      iorB: look.iorB,
      saturation: look.saturation,
      absorb: d.vec3f(...look.absorb),
      lift: look.lift,
      lightDir: d.vec3f(...look.lightDir),
      rimLod: look.rimLod,
      lightColor: d.vec3f(...look.lightColor),
      lodMax: look.lodMax,
      skyZenith: d.vec3f(...look.skyZenith),
      hazeLod: look.hazeLod,
      skyHorizon: d.vec3f(...look.skyHorizon),
      roughness: look.roughness,
      hazeRoughness: look.hazeRoughness,
      sunRadius: look.sunRadius,
      eyeDist: look.eyeDist,
      horizonGain: look.horizonGain,
      groundGain: look.groundGain,
      glint: look.glint,
      glintOpposite: look.glintOpposite,
      glintWidth: look.glintWidth,
      shadowReach: look.shadowReach,
      shadowSigma: look.shadowSigma,
      shadowOpacity: look.shadowOpacity,
      aoOpacity: look.aoOpacity,
      aoWidth: look.aoWidth,
      causticC: look.causticC,
      causticMin: look.causticMin,
      causticMax: look.causticMax,
      causticAdd: look.causticAdd,
      glowAmount: glow.amount,
      glowCenter: d.vec2f(glow.x, glow.y),
      glowRadius: glow.radius,
      materialize: setF,
      imprintGain: visual.imprintGain,
      ridgeGain: visual.ridgeGain,
      hazeGain: visual.hazeGain,
      // Resting on the page; the scene hook fills these in while the button floats.
      gap: 0,
      gapScale: 1,
      tilt: d.vec2f(),
      pivot: s0 ? d.vec2f(s0.cx, s0.cy) : d.vec2f(),
      parallax: 0,
      gapBlur: 0,
      softboxes: look.softboxes.map((b) => ({
        c: d.vec3f(...b.c),
        t: d.vec3f(...b.t),
        b: d.vec3f(...b.b),
        radiance: d.vec3f(...b.radiance),
        halfSize: d.vec2f(...b.halfSize),
        round: b.round,
        soft: b.soft,
      })),
    };
    lastGlass = values;
    glassUniform.write(glassHook ? glassHook(values, theme) : values);
  }

  function frame({ dt, tracker, reducedMotion, sinceIntro, now, eff }: FrameInput) {
    if (!sim || !bound || !renderGroup || !layout) return;
    const { substep, maxSubsteps } = params.sim;

    // Intro: the dropped blob slumps as a liquid, then sets into putty (thixotropic build-up).
    const intro = params.intro;
    const setF = sinceIntro < intro.liquidFor ? 0 : 1 - Math.exp(-(sinceIntro - intro.liquidFor) / intro.setTau);
    const pl = eff.plastic;
    const el = eff.elastic;
    const fluxDamping = eff.introDamping + (pl.fluxDamping - eff.introDamping) * setF;
    // Reduced motion: critically damped elastic layer (no wobble) and quicker healing.
    const zeta = reducedMotion ? 1 : el.zeta;
    const heal = eff.heal;

    accumulator += dt;
    const steps = Math.min(maxSubsteps, Math.floor(accumulator / substep));
    accumulator = Math.min(accumulator - steps * substep, substep);

    const fingerCount = writeFingers(tracker, now, dt);
    simUniform.write({
      cell: layout.cell,
      dt: substep,
      fingerCount,
      dryLevel: 0.05 * params.shape.plateau,
      omega2: el.omega * el.omega,
      wave2: el.waveSpeed * el.waveSpeed,
      dampE: 2 * zeta * el.omega,
      contactE: el.contact,
      gravity: 2 + (pl.gravity - 2) * setF,
      tension: pl.surfaceTension,
      contactP: pl.contact,
      plasticShare: pl.plasticShare,
      fluxGain: pl.fluxGain,
      fluxDecay: Math.exp(-fluxDamping * substep),
      yieldHead: pl.yieldHead * setF,
      creep: pl.creep,
      dewet: pl.dewet,
      healRate: (reducedMotion ? 2 : 1) / heal.tau,
      healHold: heal.hold,
      healRamp: heal.ramp,
      healZone2: heal.zone * heal.zone,
      pad0: 0,
      pad1: 0,
      pad2: 0,
    });

    const det = eff.detail;
    const fade = Math.exp(-dt / (reducedMotion ? det.fadeTau * 0.6 : det.fadeTau));
    detailUniform.write({
      texel: det.texel,
      period: det.period,
      depth: det.depth,
      stamp: 1 - Math.exp(-dt / det.stampTau),
      fade,
      // Biharmonic leveling: |fade − 64·c| < 1 keeps even the finest (checkerboard) mode decaying, never flipping.
      smoothing: Math.min(det.smoothing * dt, (0.95 * (1 + fade)) / 64),
      hazeFade: Math.exp(-dt / det.hazeTau),
      fingerCount,
      pxCss: 1 / scale,
    });
    writeGlass(setF, eff.visual);

    const encoder = root['~unstable'].createCommandEncoder();
    const pass = encoder.beginComputePass();
    const wx = Math.ceil(sim.cols / WG);
    const wy = Math.ceil(sim.rows / WG);
    for (let s = 0; s < steps; s++) {
      bound.elastic.with(pass).dispatchWorkgroups(wx, wy);
      bound.flux.with(pass).dispatchWorkgroups(wx, wy);
      bound.limit.with(pass).dispatchWorkgroups(wx, wy);
      bound.apply.with(pass).dispatchWorkgroups(wx, wy);
    }
    bound.pack.with(pass).dispatchWorkgroups(wx, wy);
    const dwx = Math.ceil(sim.dw / WG);
    const dwy = Math.ceil(sim.dh / WG);
    bound.detail[detailFlip].with(pass).dispatchWorkgroups(dwx, dwy);
    bound.detailPack[detailFlip].with(pass).dispatchWorkgroups(dwx, dwy);
    pass.end();
    detailFlip ^= 1;

    renderPipe
      .with(encoder)
      .with(renderGroup)
      .withColorAttachment({ view: context, clearValue: [0, 0, 0, 0] })
      .draw(3);
    encoder.submit();
  }

  /** Compiles every pipeline up front (rejects if the device refuses one), instead of on the first frame. */
  async function ready() {
    await Promise.all([...Object.values(pipes), renderPipe].map((p) => p.initAsync()));
  }


  /** Lets the scene rewrite the glass uniforms (null restores look.ts as is). */
  function setGlassHook(hook: typeof glassHook) {
    glassHook = hook;
  }

  /** What the 3D scene view shares with us: the same textures and per-frame glass values (before the hook). */
  function sceneResources() {
    if (!sim || !page || !label || !layout || !lastGlass) return null;
    return {
      version: resourceVersion,
      page,
      label,
      simPack: sim.simPack,
      cover: sim.cover,
      detailPack: sim.detailPack,
      shapes: shapeUniform,
      labelParams: labelUniform,
      sampler: smp,
      glass: lastGlass,
      layout,
      theme,
    };
  }

  return {
    ready,
    setLayout,
    setPage,
    setLabel,
    setViewport,
    replayDrop,
    snapToRest,
    surfaceAt,
    frame,
    setGlassHook,
    sceneResources,
  };
}

export type Goo = ReturnType<typeof createGoo>;
