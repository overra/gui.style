// Levitation: the button can float above the page on an air cushion, a damped spring under its whole base. A
// press pushes the whole button toward the page and tilts it toward an off-centre finger, on top of the squish;
// let go and it springs back past its rest height and settles. A new hover height is reached the same way, so the
// button lifts off and lands instead of jumping.
//
// This is rigid-body state only (CPU): the base's height at the pivot and its tilt. The renderers carry the
// putty's own frame with it (scene/scene.ts: gooFrame for the 3D view, glassDepthTerms for the flat overlay).

import type { Effective } from './feel.ts';
import { sceneSdf, type Layout } from './layout.ts';
import { params, restHeightCpu } from './params.ts';
import type { FingerTracker } from './touches.ts';

export interface LevitationPose {
  /** Height of the base at the pivot above the reference plane (CSS px). The air gap is this plus the page depth. */
  z: number;
  /** Slopes of the base: it sits tilt·(p − pivot) lower at goo-space point p (it dips toward an off-centre press). */
  tilt: [number, number];
  /** Goo-space pivot: the centroid of the resting footprint. */
  pivot: [number, number];
}

export interface LevitationInput {
  /** Rest height of the base above the reference plane (scene.goo.hover), and the page's depth behind it. */
  hover: number;
  pageDepth: number;
  layout: Layout;
  tracker: FingerTracker;
  eff: Effective;
  reducedMotion: boolean;
}

/** The cushion under the resting footprint: centroid, second moments about it, and reach (goo-space CSS px). */
interface Cushion {
  shapes: Layout['shapes'];
  pivot: [number, number];
  varX: number;
  varY: number;
  reachX: number;
  reachY: number;
}

/** Integration substep (s); the stiffest cushion feel.ts allows stays far inside its stability limit. */
const SUBSTEP = 1 / 600;
/** Steepest tilt the cushion allows (a slope, about 8.5°). */
const MAX_TILT = 0.15;
/** Even bottomed out, the base keeps this share of the rest gap between itself and the page. */
const MIN_GAP = 0.1;
/** Putty under a finger (CSS px of rest height) for it to push with full weight: touches.ts' thinnest surface. */
const FULL_CONTACT = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function measure(layout: Layout): Cushion {
  const { cols, rows, cell, shapes } = layout;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell;
      const y = (j + 0.5) * cell;
      if (restHeightCpu(sceneSdf(shapes, x, y, params.shape.blend)) <= 0) continue;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (!n) return { shapes, pivot: [layout.width / 2, layout.height / 2], varX: 1, varY: 1, reachX: 0, reachY: 0 };
  const cx = sx / n;
  const cy = sy / n;
  return {
    shapes,
    pivot: [cx, cy],
    varX: Math.max(sxx / n - cx * cx, 1),
    varY: Math.max(syy / n - cy * cy, 1),
    reachX: Math.max(cx - x0, x1 - cx) + cell / 2,
    reachY: Math.max(cy - y0, y1 - cy) + cell / 2,
  };
}

export function createLevitation() {
  let cushion: Cushion | null = null;
  let started = false;
  /** Rest height last seen, and the targets of the last step. */
  let rest = 0;
  let target = { z: 0, tx: 0, ty: 0 };
  // Base height at the pivot and the two tilt slopes, with their rates.
  let z = 0;
  let vz = 0;
  let ax = 0;
  let vax = 0;
  let ay = 0;
  let vay = 0;
  const pose: LevitationPose = { z: 0, tilt: [0, 0], pivot: [0, 0] };

  function publish() {
    pose.z = z;
    pose.tilt[0] = ax;
    pose.tilt[1] = ay;
    if (cushion) {
      pose.pivot[0] = cushion.pivot[0];
      pose.pivot[1] = cushion.pivot[1];
    }
  }

  function step(dt: number, input: LevitationInput) {
    const { hover, pageDepth, layout, tracker, eff } = input;
    if (cushion?.shapes !== layout.shapes) cushion = measure(layout);
    const c = cushion;
    if (!started) {
      z = hover;
      started = true;
    }
    rest = hover;
    const gap = Math.max(hover + pageDepth, 0);
    const lev = eff.levitation;

    // Each finger pushes with the share of a full press it has sunk in: its dent's own ramp, creep and skim. Only
    // putty under the finger pushes: one slid off the button (and still held) leans on nothing.
    let push = 0;
    let mx = 0;
    let my = 0;
    for (const f of tracker.fingers.values()) {
      const pen = Math.max(0, f.depth - f.lift);
      const under = restHeightCpu(sceneSdf(c.shapes, f.x, f.y, params.shape.blend));
      const contact = clamp(under / FULL_CONTACT, 0, 1);
      const w = contact * Math.min(pen / Math.max(f.surfaceZ * eff.finger.depthFrac, 1), 1.5);
      push += w;
      mx += w * clamp(f.x - c.pivot[0], -c.reachX, c.reachX);
      my += w * clamp(f.y - c.pivot[1], -c.reachY, c.reachY);
    }

    // Targets: a full press sinks the button by `travel`. An off-centre press also tilts it like a rigid plate on
    // a uniform cushion (slope = force × lever / second moment), scaled by `tilt`. Never further than the gap.
    const room = (1 - MIN_GAP) * gap;
    const travel = Math.min(lev.travel, 0.8 * gap);
    let tx = clamp((travel * lev.tilt * mx) / c.varX, -MAX_TILT, MAX_TILT);
    let ty = clamp((travel * lev.tilt * my) / c.varY, -MAX_TILT, MAX_TILT);
    const sink = Math.min(travel * push, room);
    const dip = Math.abs(tx) * c.reachX + Math.abs(ty) * c.reachY;
    if (sink + dip > room && dip > 0) {
      const k = Math.max(room - sink, 0) / dip;
      tx *= k;
      ty *= k;
    }
    target = { z: hover - sink, tx, ty };

    // Damped springs. A uniform plate on a uniform cushion rocks at the same frequency as it bobs.
    const w2 = lev.omega * lev.omega;
    const damp = 2 * (input.reducedMotion ? 1 : lev.zeta) * lev.omega;
    const n = Math.min(64, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      vz += (w2 * (target.z - z) - damp * vz) * h;
      z += vz * h;
      vax += (w2 * (tx - ax) - damp * vax) * h;
      ax += vax * h;
      vay += (w2 * (ty - ay) - damp * vay) * h;
      ay += vay * h;
    }
    // The base never reaches the page: it bottoms out on the cushion instead.
    const floor = MIN_GAP * gap - pageDepth + Math.abs(ax) * c.reachX + Math.abs(ay) * c.reachY;
    if (z < floor) {
      z = floor;
      vz = Math.max(vz, 0);
    }
    publish();
  }

  /** Straight back to the rest pose (when the frame loop goes to sleep). */
  function reset() {
    z = rest;
    vz = vax = vay = ax = ay = 0;
    target = { z: rest, tx: 0, ty: 0 };
    publish();
  }

  return {
    pose,
    step,
    reset,
    /** Still bobbing or rocking, or not yet at its target (keeps the frame loop awake). */
    get moving() {
      const off = Math.abs(z - target.z) + 100 * (Math.abs(ax - target.tx) + Math.abs(ay - target.ty));
      const speed = Math.abs(vz) + 100 * (Math.abs(vax) + Math.abs(vay));
      return off > 0.01 || speed > 0.05;
    },
  };
}

export type Levitation = ReturnType<typeof createLevitation>;
