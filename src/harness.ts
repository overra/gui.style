// Pure helpers for the dev harness (window.__goo in main.ts): a seeded generator, frame diffs and simulation
// statistics. Only the dev build uses them.

import type { Goo } from './gpu/goo.ts';

/** mulberry32: a small, fast seeded generator for Math.random, so runs repeat exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A box in viewport CSS px: x, y, width, height. */
export type Box = [number, number, number, number];
type BoxLike = Box | { x: number; y: number; width: number; height: number };

const toBox = (r: BoxLike): Box => (Array.isArray(r) ? r : [r.x, r.y, r.width, r.height]);

/**
 * Where a frame copy sat on screen (viewport CSS px): its `data-box` tag (`x,y,w,h`, set by drive() and
 * scene.shot()), else its box on the page, else its own pixels at the origin.
 */
export function boxOf(c: HTMLCanvasElement): Box {
  const tag = c.dataset.box?.split(',').map(Number);
  if (tag?.length === 4 && tag.every(Number.isFinite)) return tag as Box;
  if (c.isConnected) return toBox(c.getBoundingClientRect());
  return [0, 0, c.width, c.height];
}

export function tagBox(c: HTMLCanvasElement, r: BoxLike): HTMLCanvasElement {
  c.dataset.box = toBox(r).join(',');
  return c;
}

/**
 * How far apart two frames are over `rect` (viewport CSS px; by default wherever both are), in 8-bit units over the
 * RGB values: the mean and largest |a − b|, and the share of values more than 1 apart. Copies of the same size and
 * place compare pixel for pixel; otherwise (the goo and scene canvases have different scales) both are resampled to
 * CSS px first.
 */
export function diffFrames(a: HTMLCanvasElement, b: HTMLCanvasElement, rect?: BoxLike) {
  const ba = boxOf(a);
  const bb = boxOf(b);
  const r = rect ? toBox(rect) : ba;
  const x0 = Math.max(ba[0], bb[0], r[0]);
  const y0 = Math.max(ba[1], bb[1], r[1]);
  const x1 = Math.min(ba[0] + ba[2], bb[0] + bb[2], r[0] + r[2]);
  const y1 = Math.min(ba[1] + ba[3], bb[1] + bb[3], r[1] + r[3]);
  if (x1 <= x0 || y1 <= y0) return null;
  const native = a.width === b.width && a.height === b.height && ba.every((v, i) => v === bb[i]);
  const kx = native ? a.width / ba[2] : 1;
  const ky = native ? a.height / ba[3] : 1;
  const w = Math.max(1, Math.round((x1 - x0) * kx));
  const h = Math.max(1, Math.round((y1 - y0) * ky));
  const pixels = (c: HTMLCanvasElement, box: Box) => {
    const sx = c.width / box[2];
    const sy = c.height / box[3];
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingEnabled = !native;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, (x0 - box[0]) * sx, (y0 - box[1]) * sy, (x1 - x0) * sx, (y1 - y0) * sy, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const pa = pixels(a, ba);
  const pb = pixels(b, bb);
  let sum = 0;
  let max = 0;
  let over = 0;
  for (let i = 0; i < pa.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(pa[i + c] - pb[i + c]);
      sum += d;
      if (d > max) max = d;
      if (d > 1) over++;
    }
  }
  const n = (pa.length / 4) * 3;
  return { mean: sum / n, max, over1: over / n, n, rect: [x0, y0, x1 - x0, y1 - y0] as Box, resampled: !native };
}

type SimState = NonNullable<Awaited<ReturnType<Goo['readState']>>>;

/**
 * The putty's volume Σ(rest + m)·cell² (CSS px³) and its resting volume Σ rest·cell², the volume's centroid in page
 * CSS px (the goo canvas's corner is at `origin`), and the range of the plastic deviation m (CSS px).
 */
export function simStats(s: SimState, cell: number, origin: [number, number]) {
  let volume = 0;
  let rest = 0;
  let sx = 0;
  let sy = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < s.rows; j++) {
    for (let i = 0; i < s.cols; i++) {
      const k = j * s.cols + i;
      const h = s.rest[k] + s.m[k];
      volume += h;
      rest += s.rest[k];
      sx += h * (i + 0.5);
      sy += h * (j + 0.5);
      lo = Math.min(lo, s.m[k]);
      hi = Math.max(hi, s.m[k]);
    }
  }
  const area = cell * cell;
  return {
    volume: volume * area,
    restVolume: rest * area,
    centroid: [origin[0] + (sx / volume) * cell, origin[1] + (sy / volume) * cell] as [number, number],
    m: [lo, hi] as [number, number],
  };
}
