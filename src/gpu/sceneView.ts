// The config-mode renderer: a full-viewport WebGPU canvas showing the ray-traced scene and its gizmos. It shares
// the goo's device, simulation textures, page and label (Goo.sceneResources) and runs after the goo's own frame,
// so it always shows the current putty. Normal mode never creates it.

import { common, d, type TgpuRoot } from 'typegpu';
import type { GlassInput, Goo } from './goo.ts';
import { renderLayout } from './renderShader.ts';
import { GlassParams } from './schemas.ts';
import {
  Dot,
  dotFragment,
  dotVertex,
  gizmoLayout,
  lineFragment,
  lineVertex,
  MAX_DOTS,
  MAX_SEGMENTS,
  sceneFragment,
  sceneLayout,
  SceneParams,
  Segment,
} from './sceneShaders.ts';

export type SceneParamsInput = d.InferInput<typeof SceneParams>;
export type SegmentInput = d.InferInput<typeof Segment>;
export type DotInput = d.InferInput<typeof Dot>;

export interface SceneViewFrame {
  scene: SceneParamsInput;
  glass: GlassInput;
  segments: SegmentInput[];
  dots: DotInput[];
}

/** A mipmapped texture for the live DOM UI (html-in-canvas draws into it). */
export const createUiTexture = (root: TgpuRoot, w: number, h: number) =>
  root
    .createTexture({ size: [w, h], format: 'rgba8unorm-srgb', mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1 })
    .$usage('sampled', 'render');
export type UiTexture = ReturnType<typeof createUiTexture>;

const blank = <T>(n: number, make: () => T) => Array.from({ length: n }, make);
const emptySegment = (): SegmentInput => ({ a: d.vec3f(), width: 0, b: d.vec3f(), dash: 0, color: d.vec4f() });
const emptyDot = (): DotInput => ({ center: d.vec3f(), radius: 0, color: d.vec4f(), ring: 0, pad0: 0, pad1: 0, pad2: 0 });

export function createSceneView(root: TgpuRoot, canvas: HTMLCanvasElement, goo: Goo) {
  const context = root.configureContext({ canvas, alphaMode: 'opaque' });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const sceneUniform = root.createUniform(SceneParams);
  const glassUniform = root.createUniform(GlassParams);
  const segmentBuffer = root.createReadonly(d.arrayOf(Segment, MAX_SEGMENTS));
  const dotBuffer = root.createReadonly(d.arrayOf(Dot, MAX_DOTS));
  const uiBlank = createUiTexture(root, 1, 1);

  const scenePipe = root.createRenderPipeline({
    vertex: common.fullScreenTriangle,
    fragment: sceneFragment,
    targets: { color: { format }, depth: { format: 'r32float' } },
  });
  // Gizmo colors are premultiplied by the fragment shaders.
  const blend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const linePipe = root.createRenderPipeline({ vertex: lineVertex, fragment: lineFragment, targets: { format, blend } });
  const dotPipe = root.createRenderPipeline({ vertex: dotVertex, fragment: dotFragment, targets: { format, blend } });

  const makeDepth = (w: number, h: number) =>
    root.createTexture({ size: [w, h], format: 'r32float' }).$usage('sampled', 'render');
  let depth: ReturnType<typeof makeDepth> | null = null;
  let ui: UiTexture | null = null;
  let resourceVersion = -1;
  let renderGroup: ReturnType<typeof bindRender> | null = null;
  let sceneGroup = root.createBindGroup(sceneLayout, { scene: sceneUniform, ui: uiBlank });
  let gizmoGroup: ReturnType<typeof bindGizmo> | null = null;

  const segments = blank(MAX_SEGMENTS, emptySegment);
  const dots = blank(MAX_DOTS, emptyDot);

  function bindRender(res: NonNullable<ReturnType<Goo['sceneResources']>>) {
    return root.createBindGroup(renderLayout, {
      params: glassUniform,
      shapes: res.shapes,
      label: res.labelParams,
      page: res.page,
      labelMask: res.label,
      sim: res.simPack,
      cover: res.cover,
      detail: res.detailPack,
      smp: res.sampler,
    });
  }

  function bindGizmo(depthTex: NonNullable<typeof depth>) {
    return root.createBindGroup(gizmoLayout, {
      scene: sceneUniform,
      depth: depthTex,
      segments: segmentBuffer,
      dots: dotBuffer,
    });
  }

  /** The live DOM UI texture (html-in-canvas), or null for none. */
  function setUiTexture(tex: UiTexture | null) {
    ui = tex;
    sceneGroup = root.createBindGroup(sceneLayout, { scene: sceneUniform, ui: ui ?? uiBlank });
  }

  /** Renders one frame; false when the goo isn't ready yet. */
  function render(frame: SceneViewFrame): boolean {
    const res = goo.sceneResources();
    if (!res) return false;
    if (!renderGroup || res.version !== resourceVersion) {
      renderGroup = bindRender(res);
      resourceVersion = res.version;
    }
    const w = canvas.width;
    const h = canvas.height;
    if (!depth || depth.props.size[0] !== w || depth.props.size[1] !== h) {
      depth?.destroy();
      depth = makeDepth(w, h);
      gizmoGroup = bindGizmo(depth);
    }
    if (!gizmoGroup) return false;

    const segCount = Math.min(frame.segments.length, MAX_SEGMENTS);
    const dotCount = Math.min(frame.dots.length, MAX_DOTS);
    for (let i = 0; i < MAX_SEGMENTS; i++) segments[i] = i < segCount ? frame.segments[i] : emptySegment();
    for (let i = 0; i < MAX_DOTS; i++) dots[i] = i < dotCount ? frame.dots[i] : emptyDot();
    sceneUniform.write(frame.scene);
    glassUniform.write(frame.glass);
    segmentBuffer.write(segments);
    dotBuffer.write(dots);

    const encoder = root['~unstable'].createCommandEncoder();
    scenePipe
      .with(encoder)
      .with(renderGroup)
      .with(sceneGroup)
      .withColorAttachment({
        color: { view: context, clearValue: [0, 0, 0, 1] },
        depth: { view: depth, clearValue: [1e9, 0, 0, 0] },
      })
      .draw(3);
    if (segCount > 0) {
      linePipe
        .with(encoder)
        .with(gizmoGroup)
        .withColorAttachment({ view: context, loadOp: 'load' })
        .draw(6, segCount);
    }
    if (dotCount > 0) {
      dotPipe
        .with(encoder)
        .with(gizmoGroup)
        .withColorAttachment({ view: context, loadOp: 'load' })
        .draw(6, dotCount);
    }
    encoder.submit();
    return true;
  }

  function destroy() {
    depth?.destroy();
    depth = null;
    uiBlank.destroy();
    context.unconfigure();
  }

  return { render, setUiTexture, destroy, format };
}

export type SceneView = ReturnType<typeof createSceneView>;
