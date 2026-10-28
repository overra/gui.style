// html-in-canvas (WICG proposal; on by default from Chrome 157). Children of <canvas content="drawable"> are laid
// out and stay real DOM (focus, accessibility, find-in-page), but the browser no longer paints them. A page draws
// a `drawable` descendant itself: into a 2D canvas with drawElementImage(), into WebGL with texElementSubImage2D(),
// or into a WebGPU texture with GPUQueue.drawElementImageToTexture(). The `paint` event fires after any rendering
// update that changed a drawable element.
//
// Config mode uses it to carry the live page UI (.stage) into the 3D scene as a texture on the reference plane.
// The names changed several times before shipping (layoutsubtree → content="drawable", copyElementImageToTexture →
// drawElementImageToTexture, ...); only the current shape is detected, and anything else falls back to CSS 3D.

import type { TgpuRoot } from 'typegpu';
import { createUiTexture, type UiTexture } from '../gpu/sceneView.ts';

interface DrawableCanvas extends HTMLCanvasElement {
  content: string;
  onpaint: ((e: Event) => void) | null;
  requestPaint(): void;
  getElementImageDefaultSize(el: Element): { width: number; height: number };
}

interface ElementImageQueue extends GPUQueue {
  drawElementImageToTexture(source: { source: Element }, destination: { texture: GPUTexture }): void;
}

export interface HtmlInCanvasSupport {
  /** `<canvas content="drawable">` (reflected as canvas.content). */
  drawable: boolean;
  paintEvent: boolean;
  webgpu: boolean;
  ok: boolean;
}

export function htmlInCanvasSupport(): HtmlInCanvasSupport {
  const canvas = HTMLCanvasElement.prototype as Partial<DrawableCanvas>;
  const queue = typeof GPUQueue === 'undefined' ? null : (GPUQueue.prototype as Partial<ElementImageQueue>);
  const drawable = 'content' in canvas && typeof canvas.getElementImageDefaultSize === 'function';
  const paintEvent = 'onpaint' in canvas && typeof canvas.requestPaint === 'function';
  const webgpu = !!queue && typeof queue.drawElementImageToTexture === 'function';
  return { drawable, paintEvent, webgpu, ok: drawable && paintEvent && webgpu };
}

/**
 * Moves `element` into a full-viewport drawable canvas and keeps a WebGPU texture of it up to date. The element
 * keeps its layout (the canvas covers the viewport, like the page it came from), so its texture maps 1:1 onto the
 * reference plane. `detach()` puts it back exactly where it was.
 */
export function createUiPlane(
  root: TgpuRoot,
  element: HTMLElement,
  hooks: { onTexture: (tex: UiTexture | null, rect: [number, number, number, number]) => void; onError: (err: unknown) => void },
) {
  const canvas = document.createElement('canvas') as DrawableCanvas;
  canvas.setAttribute('content', 'drawable');
  canvas.className = 'scene-ui-canvas';
  // A drawable's canvas needs a rendering context before its elements can be drawn anywhere.
  canvas.getContext('2d');
  const placeholder = document.createComment('stage (drawn in the 3D scene)');
  let tex: UiTexture | null = null;
  let attached = false;
  let savedWidth = '';

  /** Canvas grid = snapshot resolution: device px, capped near 4 MP (the texture also carries mips). */
  function size() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const k = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4e6 / Math.max(1, vw * vh)));
    const w = Math.max(1, Math.round(vw * k));
    const h = Math.max(1, Math.round(vh * k));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function upload() {
    if (!attached) return;
    try {
      // Canvas-grid px; throws until the browser has taken the element's first snapshot.
      const s = canvas.getElementImageDefaultSize(element);
      const w = Math.max(1, Math.ceil(s.width));
      const h = Math.max(1, Math.ceil(s.height));
      if (!tex || tex.props.size[0] !== w || tex.props.size[1] !== h) {
        tex?.destroy();
        tex = createUiTexture(root, w, h);
      }
      // Clear first: the snapshot only covers what the element paints.
      tex.clear();
      (root.device.queue as ElementImageQueue).drawElementImageToTexture({ source: element }, { texture: root.unwrap(tex) });
      tex.generateMipmaps();
      const r = element.getBoundingClientRect();
      hooks.onTexture(tex, [r.left, r.top, (w * window.innerWidth) / canvas.width, (h * window.innerHeight) / canvas.height]);
    } catch (err) {
      hooks.onError(err);
    }
  }

  function attach() {
    if (attached) return;
    attached = true;
    size();
    // Children of a drawable canvas shrink-wrap; keep the page's own width so the UI doesn't reflow.
    savedWidth = element.style.width;
    element.style.width = `${element.getBoundingClientRect().width}px`;
    element.before(placeholder);
    element.setAttribute('drawable', '');
    placeholder.before(canvas);
    canvas.append(element);
    canvas.onpaint = upload;
    window.addEventListener('resize', size);
    canvas.requestPaint();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    canvas.onpaint = null;
    window.removeEventListener('resize', size);
    placeholder.replaceWith(element);
    element.removeAttribute('drawable');
    element.style.width = savedWidth;
    canvas.remove();
    hooks.onTexture(null, [0, 0, 1, 1]);
    tex?.destroy();
    tex = null;
  }

  return { attach, detach };
}
