// CPU-side geometry in goo space (CSS px from the goo canvas' top-left): where the goo elements sit, the
// simulation grid, and the same shape math the shaders use (for hit testing and where a finger meets the surface).

export interface GooShape {
  /** Center and half extents in goo-space CSS px. */
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  radius: number;
  element: HTMLElement;
}

export interface Layout {
  viewportW: number;
  viewportH: number;
  /** The goo canvas in viewport CSS px. */
  canvasX: number;
  canvasY: number;
  width: number;
  height: number;
  shapes: GooShape[];
  cols: number;
  rows: number;
  /** Simulation cell size in CSS px. */
  cell: number;
}

/** Matches `sdRoundedBox2d` from @typegpu/sdf (half-size includes the corner radius). */
export function sdRoundedBox(px: number, py: number, hx: number, hy: number, r: number): number {
  const dx = Math.abs(px) - hx + r;
  const dy = Math.abs(py) - hy + r;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/** Matches the shader's polynomial smooth union. */
export function smoothUnion(d1: number, d2: number, k: number): number {
  const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
  return Math.min(d1, d2) - h * h * k * 0.25;
}

export function sceneSdf(shapes: GooShape[], x: number, y: number, blend: number, shrink = 1): number {
  let d = 1e9;
  for (const s of shapes) {
    const sd = shrink * sdRoundedBox((x - s.cx) / shrink, (y - s.cy) / shrink, s.hx, s.hy, s.radius);
    d = d > 1e8 ? sd : smoothUnion(d, sd, blend);
  }
  return d;
}

export function measureLayout(canvas: HTMLCanvasElement, elements: HTMLElement[], cell: number): Layout {
  const c = canvas.getBoundingClientRect();
  const shapes: GooShape[] = elements.map((element) => {
    const r = element.getBoundingClientRect();
    const hx = r.width / 2;
    const hy = r.height / 2;
    const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, hx, hy);
    return { cx: r.left - c.left + hx, cy: r.top - c.top + hy, hx, hy, radius, element };
  });
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    canvasX: c.left,
    canvasY: c.top,
    width: c.width,
    height: c.height,
    shapes,
    cols: Math.max(4, Math.ceil(c.width / cell)),
    rows: Math.max(4, Math.ceil(c.height / cell)),
    cell,
  };
}

/** Same grid and shapes (the simulation state can be kept). */
export function sameGrid(a: Layout | null, b: Layout): boolean {
  return (
    !!a &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.shapes.length === b.shapes.length &&
    a.shapes.every((s, i) => {
      const o = b.shapes[i];
      return (
        Math.abs(s.cx - o.cx) < 0.5 &&
        Math.abs(s.cy - o.cy) < 0.5 &&
        Math.abs(s.hx - o.hx) < 0.5 &&
        Math.abs(s.hy - o.hy) < 0.5
      );
    })
  );
}
