// Owns the GPU side: textures sized to the goo's layout, the putty simulation, the fingerprint layer and the
// glass render, all recorded into one command encoder per frame.

import { common, d, type TgpuRoot } from 'typegpu';
import type { Theme } from '../background.ts';
import type { Effective, GooGravity } from '../feel.ts';
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
  /** Gravity in the goo's rest frame (g): along goo x and y, and into the base (scene.ts: gooGravity). */
  gravity: GooGravity;
}

/** Whether the material holds its molded shape under the current gravity (exact for the face rules at rest). */
export interface SagCheck {
  regime: 'holds' | 'weeps at its edge' | 'sags' | 'would run (held at the limit)' | 'would drip';
  /** Bulk and contact-line sag numbers (the weight's face drop over the yield and over the pin), restoring head. */
  S: number;
  Sedge: number;
  K: number;
  /** The weight's potential drop per +x / +y face (head px), after the run-off limit. */
  driveX: number;
  driveY: number;
}

/**
 * The settle layer: idle while the molded shape holds; otherwise it finds the shape the material can hold. When the
 * material holds again it re-molds: the settled shape stays as the drawing's reference and fades exactly as the
 * putty heals back, so the exaggerated deviation (imprintGain) never jumps.
 */
type SettlePhase = 'molded' | 'settling' | 'settled' | 'remolding';
/** Ghost seconds of real-time slump before the settle layer fast-forwards its slow tail, and its time cap. */
const SETTLE_REALTIME = 6;
const SETTLE_CAP = 120;
/** Quiet: the settled shape moves less than this (px per ghost second) on two readbacks in a row. */
const SETTLE_QUIET = 0.005;
/** Re-molding is over once the fading reference is under this everywhere (CSS px; the pack kernel's pristine snap). */
const REMOLD_DONE = 0.02;

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
  // The settle layer runs the same kernels on its own state, finger-free and without healing.
  const ghostUniform = root.createUniform(SimParams);
  const fingerUniform = root.createUniform(d.arrayOf(Finger, MAX_FINGERS));
  const detailUniform = root.createUniform(DetailParams);
  const glassUniform = root.createUniform(GlassParams);
  const shapeUniform = root.createUniform(d.arrayOf(Shape, MAX_SHAPES));
  const labelUniform = root.createUniform(LabelParams);
  const sharedGroup = root.createBindGroup(simShared, { sim: simUniform, fingers: fingerUniform });
  const ghostGroup = root.createBindGroup(simShared, { sim: ghostUniform, fingers: fingerUniform });

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
      // The settle layer's state (e = v = 0, m_s, age) and inertial flux.
      settleA: tex.rgba32(cols, rows),
      settleB: tex.rgba32(cols, rows),
      settleFlux: tex.rg32(cols, rows),
      // All zeros: the heal target and creep reference while the molded shape holds or the putty re-molds.
      molded: tex.rgba32(cols, rows),
      // (P, P_dev), shared scratch: the two layers' dispatches run in order.
      pressure: tex.rg32(cols, rows),
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
  // CPU copy of the settled shape m_s (finger contact and 3D picking), refreshed from readbacks while settling.
  let settledField = new Float32Array(0);
  let settledTop = 0;
  let settlePhase: SettlePhase = 'molded';
  let settleKey = '';
  let settleClock = 0;
  let settleReadAt = 0;
  let settleQuiet = 0;
  let settleFrames = 0;
  /** Bumped whenever a settling run starts or ends, so a late readback from an older run is ignored. */
  let settleRun = 0;
  /** A grid rebuild carried a settling run over: its key, so the next check resumes it instead of restarting it. */
  let resumeKey = '';
  /** While re-molding: a bound on the largest |m_s| left in the fading reference (CSS px), the fade so far, and
   *  whether the CPU copy matches the GPU's (a re-mold that cuts a slump short waits for a readback). */
  let remoldLeft = 0;
  let remoldFade = 1;
  let remoldFresh = false;
  let reading = false;
  let extentKey = '';
  let extent = 1;
  let sag: SagCheck = { regime: 'holds', S: 0, Sedge: 0, K: 1, driveX: 0, driveY: 0 };
  // Scene hooks (src/scene): the scene's lights and camera rewrite the glass uniforms; the 3D view shares textures.
  let glassHook: ((values: GlassInput, theme: Theme) => GlassInput) | null = null;
  let lastGlass: GlassInput | null = null;
  let resourceVersion = 0;
  const glow = { x: 0, y: 0, amount: 0, radius: 20 };

  const bindSim = (t: SimTextures) => {
    const groups = {
      // Heals toward the settled shape while there is one (settling, settled) and toward the mold otherwise.
      elastic: root.createBindGroup(elasticLayout, {
        state: t.stateA,
        rest: t.rest,
        settle: t.settleA,
        stateOut: t.stateB,
        pressureOut: t.pressure,
      }),
      elasticMolded: root.createBindGroup(elasticLayout, {
        state: t.stateA,
        rest: t.rest,
        settle: t.molded,
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
      pack: root.createBindGroup(packLayout, {
        state: t.stateA,
        rest: t.rest,
        settle: t.settleA,
        packOut: t.simPack,
        coverOut: t.cover,
      }),
    };
    // Its own settled shape is its heal target and creep reference, so it never heals and never creeps. Re-molding,
    // it heals toward the mold instead, as the putty does, and nothing flows.
    const ghost = {
      elastic: root.createBindGroup(elasticLayout, {
        state: t.settleA,
        rest: t.rest,
        settle: t.settleA,
        stateOut: t.settleB,
        pressureOut: t.pressure,
      }),
      elasticRemold: root.createBindGroup(elasticLayout, {
        state: t.settleA,
        rest: t.rest,
        settle: t.molded,
        stateOut: t.settleB,
        pressureOut: t.pressure,
      }),
      flux: root.createBindGroup(fluxLayout, { pressure: t.pressure, rest: t.rest, flux: t.settleFlux, fluxOut: t.faces }),
      limit: root.createBindGroup(limitLayout, { faces: t.faces, rest: t.rest, state: t.settleB, limitOut: t.limit }),
      apply: root.createBindGroup(applyLayout, {
        faces: t.faces,
        limit: t.limit,
        state: t.settleB,
        stateOut: t.settleA,
        fluxOut: t.settleFlux,
      }),
    };
    return {
      elastic: pipes.elastic.with(sharedGroup).with(groups.elastic),
      elasticMolded: pipes.elastic.with(sharedGroup).with(groups.elasticMolded),
      flux: pipes.flux.with(sharedGroup).with(groups.flux),
      limit: pipes.limit.with(sharedGroup).with(groups.limit),
      apply: pipes.apply.with(sharedGroup).with(groups.apply),
      pack: pipes.pack.with(sharedGroup).with(groups.pack),
      ghost: {
        elastic: pipes.elastic.with(ghostGroup).with(ghost.elastic),
        elasticRemold: pipes.elastic.with(ghostGroup).with(ghost.elasticRemold),
        flux: pipes.flux.with(ghostGroup).with(ghost.flux),
        limit: pipes.limit.with(ghostGroup).with(ghost.limit),
        apply: pipes.apply.with(ghostGroup).with(ghost.apply),
      },
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
    // The canvas can move on the page (it grows around a floating button's shadow): the touch glow keeps its spot.
    if (layout) {
      glow.x += layout.canvasX - next.canvasX;
      glow.y += layout.canvasY - next.canvasY;
    }
    if (!sameGrid(layout, next) || !sim) {
      // A rebuilt grid starts at rest; a settled sag comes along (resampled), so the putty doesn't re-slump.
      // (A re-molding sag isn't carried: the new grid starts molded.)
      // The run goes on from its last read-back shape, at that shape's own clock.
      const carried =
        layout && sim && (settlePhase === 'settling' || settlePhase === 'settled')
          ? { from: layout, field: settledField, key: settleKey, clock: settleReadAt, settled: settlePhase === 'settled' }
          : null;
      if (sim) {
        for (const t of [sim.rest, sim.stateA, sim.stateB, sim.settleA, sim.settleB, sim.settleFlux, sim.molded, sim.pressure, sim.flux, sim.faces, sim.limit, sim.simPack, sim.cover]) {
          t.destroy();
        }
        for (const t of [...sim.detail, sim.detailPack]) t.destroy();
      }
      sim = makeSimTextures(next);
      resourceVersion++;
      const init = initialState(next, drop);
      restField = init.rest;
      settledField = new Float32Array(restField.length);
      sim.rest.write(init.rest);
      sim.stateA.write(init.state);
      sim.flux.clear();
      remold();
      extentKey = '';
      if (carried) {
        carrySettled(carried.from, carried.field, next, carried.clock, carried.settled);
        resumeKey = carried.key;
      }
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

  /** A state at rest: zero deviation, long since touched. */
  const restState = (cells: number) => {
    const state = new Float32Array(cells * 4);
    for (let k = 0; k < cells; k++) state[k * 4 + 3] = 100;
    return state;
  };

  /** The settle layer straight back to the molded shape (zeros). */
  function remold() {
    if (!sim) return;
    sim.settleA.write(restState(sim.cols * sim.rows));
    sim.settleFlux.clear();
    settledField.fill(0);
    settledTop = 0;
    settlePhase = 'molded';
    settleKey = '';
    resumeKey = '';
    remoldLeft = 0;
    settleRun++;
  }

  /**
   * The material holds again: the putty heals back to the mold, and the settled shape, kept as the drawing's
   * reference, fades at the same rate (frame), so what imprintGain exaggerates stays the live deviation.
   */
  function beginRemold() {
    if (!sim) return;
    // Settled, the CPU copy is the GPU's shape. Mid-slump it lags by up to a readback (or is still all zeros), so
    // start from a bound the run-off limit guarantees, until a readback taken now lands (frame, readSettled).
    const fresh = settlePhase === 'settled';
    sim.settleFlux.clear();
    settlePhase = 'remolding';
    const copyMax = settledField.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    remoldLeft = fresh ? copyMax : Math.max(copyMax, 2 * params.shape.plateau);
    remoldFresh = fresh;
    remoldFade = 1;
    settleRun++;
  }

  /**
   * Resamples the last read-back settled shape onto a new grid (same page position), uploads it and lets the run go
   * on from there: at that shape's clock, or in the fast-forwarded tail if it had settled (updateSettle resumes the
   * run instead of restarting it: resumeKey).
   */
  function carrySettled(from: Layout, field: Float32Array, to: Layout, clock: number, settled: boolean) {
    if (!sim) return;
    const state = restState(to.cols * to.rows);
    const at = (i: number, j: number) => field[Math.min(Math.max(j, 0), from.rows - 1) * from.cols + Math.min(Math.max(i, 0), from.cols - 1)];
    for (let j = 0; j < to.rows; j++) {
      for (let i = 0; i < to.cols; i++) {
        // Same page point: goo space shifts by the canvas offset.
        const x = ((i + 0.5) * to.cell + to.canvasX - from.canvasX) / from.cell - 0.5;
        const y = ((j + 0.5) * to.cell + to.canvasY - from.canvasY) / from.cell - 0.5;
        const i0 = Math.floor(x);
        const j0 = Math.floor(y);
        const fx = x - i0;
        const fy = y - j0;
        const v = (at(i0, j0) * (1 - fx) + at(i0 + 1, j0) * fx) * (1 - fy) + (at(i0, j0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1) * fx) * fy;
        const k = j * to.cols + i;
        state[k * 4 + 2] = v;
        settledField[k] = v;
      }
    }
    sim.settleA.write(state);
    sim.stateA.write(state);
    settlePhase = 'settling';
    settleClock = settleReadAt = settled ? Math.max(clock, SETTLE_REALTIME) : clock;
    settleQuiet = 0;
  }

  /** Copies of the main state (e, v, m, age) and the settled shape m_s, for the dev harness. */
  async function readState() {
    if (!sim) return null;
    const t = sim;
    const bytesPerRow = Math.ceil((t.cols * 16) / 256) * 256;
    const read = async (texture: typeof t.stateA) => {
      const buffer = root.device.createBuffer({ size: bytesPerRow * t.rows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = root.device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: root.unwrap(texture) }, { buffer, bytesPerRow }, [t.cols, t.rows]);
      root.device.queue.submit([enc.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Float32Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      const out = [0, 1, 2, 3].map(() => new Float32Array(t.cols * t.rows));
      for (let j = 0; j < t.rows; j++) {
        for (let i = 0; i < t.cols; i++) {
          for (let c = 0; c < 4; c++) out[c][j * t.cols + i] = raw[(j * bytesPerRow) / 4 + i * 4 + c];
        }
      }
      return out;
    };
    const [e, v, m, age] = await read(t.stateA);
    const [, , ms] = await read(t.settleA);
    return { cols: t.cols, rows: t.rows, e, v, m, age, ms, rest: restField.slice() };
  }

  /** Drop the goo onto the page again: a taller, narrower blob that slumps into shape. */
  function replayDrop() {
    if (!sim || !layout) return;
    sim.stateA.write(initialState(layout, true).state);
    sim.flux.clear();
    sim.detail[0].clear();
    sim.detail[1].clear();
    // The drop starts from the mold; a deterministic substep phase keeps harness runs comparable.
    remold();
    accumulator = 0;
  }

  /** Back to the pristine resting shape: the molded one, or the settled sag (when the loop goes to sleep). */
  function snapToRest() {
    if (!sim || !layout) return;
    if (settlePhase === 'remolding') remold();
    if (settlePhase === 'molded') {
      sim.stateA.write(restState(sim.cols * sim.rows));
    } else {
      const enc = root.device.createCommandEncoder();
      enc.copyTextureToTexture({ texture: root.unwrap(sim.settleA) }, { texture: root.unwrap(sim.stateA) }, [sim.cols, sim.rows]);
      root.device.queue.submit([enc.finish()]);
    }
    sim.flux.clear();
    sim.detail[0].clear();
    sim.detail[1].clear();
    glow.amount = 0;
  }

  /** The footprint's extent along the weight's in-plane direction (CSS px), for the run-off limit. */
  function footprintExtent(gx: number, gy: number): number {
    if (!layout) return 1;
    const len = Math.hypot(gx, gy);
    const key = `${layout.cols}x${layout.rows}:${(gx / len).toFixed(3)},${(gy / len).toFixed(3)}`;
    if (key === extentKey) return extent;
    const dry = 0.05 * params.shape.plateau;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < layout.rows; j++) {
      for (let i = 0; i < layout.cols; i++) {
        if (restField[j * layout.cols + i] < dry) continue;
        const t = ((i + 0.5) * gx + (j + 0.5) * gy) * (layout.cell / len);
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    extentKey = key;
    extent = hi > lo ? hi - lo + layout.cell : layout.cell;
    return extent;
  }

  /**
   * Can the material hold its molded shape under this gravity? At rest every face drop is the weight's alone, so
   * the face rules decide it exactly: the yield on putty faces, the pin on contact-line faces. A sag the memory
   * can't hold before the top thins away would run off the page; until drips exist, the weight is held there.
   */
  function sagCheck(pl: Effective['plastic'], g: GooGravity, cell: number): SagCheck {
    const K = Math.max(pl.memory + pl.weight * g.n, 0);
    let driveX = pl.weight * g.x * cell;
    let driveY = pl.weight * g.y * cell;
    const drive = Math.max(Math.abs(driveX), Math.abs(driveY));
    const S = drive / Math.max(pl.yieldHead, 1e-6);
    const Sedge = drive > 0 ? drive / Math.max(pl.pin, 1e-6) : 0;
    // The run-off limit holds the drive whatever the label says (pulled off the page, K is 0: at the yield).
    const excessMax = drive > 0 ? (2 * params.shape.plateau * K * cell) / footprintExtent(g.x, g.y) : 0;
    const runs = drive - pl.yieldHead > excessMax;
    if (runs) {
      const k = (pl.yieldHead + excessMax) / drive;
      driveX *= k;
      driveY *= k;
    }
    let regime: SagCheck['regime'] = 'holds';
    if (pl.memory + pl.weight * g.n < 0) regime = 'would drip';
    else if (runs) regime = 'would run (held at the limit)';
    else if (S >= 0.98) regime = 'sags';
    else if (Sedge >= 0.98) regime = 'weeps at its edge';
    return { regime, S, Sedge, K, driveX, driveY };
  }

  /** Re-checks the material when gravity or the material changed; starts, continues or ends settling. */
  function updateSettle(pl: Effective['plastic'], g: GooGravity) {
    if (!layout) return;
    const key = [g.x, g.y, g.n, pl.weight, pl.yieldHead, pl.pin, pl.memory, pl.surfaceTension, pl.dewet].join();
    if (key === settleKey) return;
    sag = sagCheck(pl, g, layout.cell);
    if (key === resumeKey && sag.regime !== 'holds') {
      // The same material and gravity across a grid rebuild: carrySettled set the run's phase and clock.
      settleKey = key;
      resumeKey = '';
      return;
    }
    resumeKey = '';
    if (sag.regime === 'holds') {
      if (settlePhase === 'settling' || settlePhase === 'settled') beginRemold();
    } else {
      // Path-dependent, like real putty: a new sag continues from the shape it has.
      settlePhase = 'settling';
      settleClock = 0;
      settleReadAt = 0;
      settleQuiet = 0;
      settleRun++;
    }
    settleKey = key;
  }

  /** Reads the settled shape back (async): the CPU copy for fingers and picking, and the quiet test. */
  function readSettled() {
    if (!sim || reading) return;
    const t = sim;
    const version = resourceVersion;
    const bytesPerRow = Math.ceil((t.cols * 16) / 256) * 256;
    const buffer = root.device.createBuffer({ size: bytesPerRow * t.rows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = root.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: root.unwrap(t.settleA) }, { buffer, bytesPerRow }, [t.cols, t.rows]);
    root.device.queue.submit([enc.finish()]);
    const clockAt = settleClock;
    const run = settleRun;
    const fadeAt = remoldFade;
    reading = true;
    void buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (version !== resourceVersion || run !== settleRun) return;
        const data = new Float32Array(buffer.getMappedRange());
        if (settlePhase === 'remolding') {
          // Taken while re-molding: brought up to date with the fade since, it bounds what's left exactly.
          const since = remoldFade / fadeAt;
          let left = 0;
          for (let j = 0; j < t.rows; j++) {
            for (let i = 0; i < t.cols; i++) {
              const ms = data[(j * bytesPerRow) / 4 + i * 4 + 2] * since;
              settledField[j * t.cols + i] = ms;
              left = Math.max(left, Math.abs(ms));
            }
          }
          remoldLeft = left;
          remoldFresh = true;
          return;
        }
        if (settlePhase !== 'settling') return;
        let moved = 0;
        let top = 0;
        for (let j = 0; j < t.rows; j++) {
          for (let i = 0; i < t.cols; i++) {
            const k = j * t.cols + i;
            const ms = data[(j * bytesPerRow) / 4 + i * 4 + 2];
            moved = Math.max(moved, Math.abs(ms - settledField[k]));
            settledField[k] = ms;
            top = Math.max(top, restField[k] + ms);
          }
        }
        settledTop = top;
        const rate = moved / Math.max(clockAt - settleReadAt, 1e-3);
        settleReadAt = clockAt;
        settleQuiet = rate < SETTLE_QUIET ? settleQuiet + 1 : 0;
        if (settleQuiet >= 2 || clockAt >= SETTLE_CAP) settlePhase = 'settled';
      })
      .catch(() => {})
      .finally(() => {
        reading = false;
        buffer.destroy();
      });
  }

  /** Settled-shape offset m_s at a goo-space point (0 while the material holds its molded shape). */
  function settledAt(x: number, y: number) {
    if (!layout) return 0;
    const i = Math.min(layout.cols - 1, Math.max(0, Math.floor(x / layout.cell)));
    const j = Math.min(layout.rows - 1, Math.max(0, Math.floor(y / layout.cell)));
    return settledField[j * layout.cols + i] ?? 0;
  }

  /** Resting height at a goo-space point (where a finger first meets the surface): molded, plus any settled sag. */
  function surfaceAt(x: number, y: number) {
    if (!layout) return 0;
    const i = Math.min(layout.cols - 1, Math.max(0, Math.floor(x / layout.cell)));
    const j = Math.min(layout.rows - 1, Math.max(0, Math.floor(y / layout.cell)));
    const molded = Math.max(restField[j * layout.cols + i] ?? 0, restHeightCpu(sceneSdf(layout.shapes, x, y, params.shape.blend)));
    return molded + (settledField[j * layout.cols + i] ?? 0);
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

  function frame({ dt, tracker, reducedMotion, sinceIntro, now, eff, gravity }: FrameInput) {
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
    const healRate = (reducedMotion ? 2 : 1) / heal.tau;

    accumulator += dt;
    const steps = Math.min(maxSubsteps, Math.floor(accumulator / substep));
    accumulator = Math.min(accumulator - steps * substep, substep);

    // Gravity: the weight presses into the base (restoring head) and pulls along it (a drop across every face).
    // While liquid the splat grips where it lands: the weight along the base and the pin build up as it sets.
    updateSettle(pl, gravity);
    const Kintro = Math.max(2 * pl.memory + pl.weight * gravity.n, 0);
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
      // = 2 + (1 − 2)·setF at the defaults, as before.
      restore: Kintro + (sag.K - Kintro) * setF,
      tension: pl.surfaceTension,
      contactP: pl.contact,
      plasticShare: pl.plasticShare,
      fluxGain: pl.fluxGain,
      fluxDecay: Math.exp(-fluxDamping * substep),
      yieldHead: pl.yieldHead * setF,
      creep: pl.creep,
      dewet: pl.dewet,
      healRate,
      healHold: heal.hold,
      healRamp: heal.ramp,
      healZone2: heal.zone * heal.zone,
      driveX: sag.driveX * setF,
      driveY: sag.driveY * setF,
      pinHead: pl.pin * setF,
    });
    // The settle layer: the set material, finger-free, never healing. Real-time while the slump shows, then it
    // fast-forwards the slow tail (and with reduced motion, all of it).
    const remolding = settlePhase === 'remolding';
    const ghostRate = remolding ? 1 : settlePhase !== 'settling' ? 0 : reducedMotion ? 8 : settleClock < SETTLE_REALTIME ? 1 : 4;
    if (remolding) {
      // The reference heals toward the mold exactly as untouched putty does (same rate, no flow), on the GPU and in
      // the CPU copy; once it's gone, re-molding is over.
      ghostUniform.write({
        cell: layout.cell,
        dt: substep,
        fingerCount: 0,
        dryLevel: 0.05 * params.shape.plateau,
        omega2: el.omega * el.omega,
        wave2: el.waveSpeed * el.waveSpeed,
        dampE: 2 * el.zeta * el.omega,
        contactE: el.contact,
        restore: sag.K,
        tension: pl.surfaceTension,
        contactP: pl.contact,
        plasticShare: pl.plasticShare,
        fluxGain: 0,
        fluxDecay: 0,
        yieldHead: pl.yieldHead,
        creep: 0,
        dewet: pl.dewet,
        healRate,
        healHold: heal.hold,
        healRamp: heal.ramp,
        healZone2: 0,
        driveX: 0,
        driveY: 0,
        pinHead: pl.pin,
      });
      const fadeBy = Math.exp(-healRate * steps * substep);
      for (let k = 0; k < settledField.length; k++) settledField[k] *= fadeBy;
      remoldLeft *= fadeBy;
      remoldFade *= fadeBy;
    } else if (ghostRate > 0) {
      ghostUniform.write({
        cell: layout.cell,
        dt: substep,
        fingerCount: 0,
        dryLevel: 0.05 * params.shape.plateau,
        omega2: el.omega * el.omega,
        wave2: el.waveSpeed * el.waveSpeed,
        dampE: 2 * el.zeta * el.omega,
        contactE: el.contact,
        restore: sag.K,
        tension: pl.surfaceTension,
        contactP: pl.contact,
        plasticShare: pl.plasticShare,
        fluxGain: pl.fluxGain,
        fluxDecay: Math.exp(-pl.fluxDamping * substep),
        yieldHead: pl.yieldHead,
        creep: pl.creep,
        dewet: pl.dewet,
        healRate: 0,
        healHold: heal.hold,
        healRamp: heal.ramp,
        healZone2: 0,
        driveX: sag.driveX,
        driveY: sag.driveY,
        pinHead: pl.pin,
      });
      settleClock += steps * ghostRate * substep;
    }

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
    const ghostElastic = remolding ? bound.ghost.elasticRemold : bound.ghost.elastic;
    const liveElastic = settlePhase === 'settling' || settlePhase === 'settled' ? bound.elastic : bound.elasticMolded;
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < ghostRate; k++) {
        ghostElastic.with(pass).dispatchWorkgroups(wx, wy);
        bound.ghost.flux.with(pass).dispatchWorkgroups(wx, wy);
        bound.ghost.limit.with(pass).dispatchWorkgroups(wx, wy);
        bound.ghost.apply.with(pass).dispatchWorkgroups(wx, wy);
      }
      liveElastic.with(pass).dispatchWorkgroups(wx, wy);
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
    // Every 30 frames (half a second at 60 Hz) while settling: read the settled shape back (CPU copy, quiet test).
    if (settlePhase === 'settling' && ++settleFrames >= 30) {
      settleFrames = 0;
      readSettled();
    }
    if (remolding && !remoldFresh) readSettled();
    if (remolding && remoldLeft < REMOLD_DONE) remold();
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
      /** Highest settled height (CSS px): the 3D march's slab must reach over it. */
      settledTop,
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
    settledAt,
    readState,
    /** The last frame's sag check under the current gravity and material (regime, S, Sedge, K, drives). */
    get sag() {
      return sag;
    },
    /** The settle layer is finding a sagged shape, or fading one out (keeps the frame loop awake). */
    get settling() {
      return settlePhase === 'settling' || settlePhase === 'remolding';
    },
    get settlePhase() {
      return settlePhase;
    },
    frame,
    setGlassHook,
    sceneResources,
  };
}

export type Goo = ReturnType<typeof createGoo>;
