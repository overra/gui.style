// Fingertip indenters. Each contact sinks into the goo while held and lifts away after release; the GPU turns
// that into dents (simulation) and printed ridges (detail layer). Positions are goo-space CSS px.

export const MAX_FINGERS = 8;

export type ContactKind = 'mouse' | 'touch' | 'pen' | 'virtual';

export interface Finger {
  /** Unique per press (pointer ids are reused, e.g. the mouse is always 1). */
  id: number;
  kind: ContactKind;
  /** Current and previous-frame centers (the indenter sweeps between them each frame). */
  x: number;
  y: number;
  px: number;
  py: number;
  /** Contact ellipse semi-axes (CSS px) and orientation (radians). */
  ax: number;
  ay: number;
  angle: number;
  /** Press depth multiplier (pen pressure). */
  depthScale: number;
  downAt: number;
  /** When the finger starts lifting; Infinity while held. Quick taps are held for a minimum time. */
  liftAt: number;
  /** Rest-surface height (CSS px) where the finger first touched. */
  surfaceZ: number;
  /** Current indentation depth and post-release lift (CSS px). */
  depth: number;
  lift: number;
  /** Smoothed sliding speed (CSS px / s). */
  speed: number;
  /** Picks this finger's ridge pattern. */
  seed: number;
}

export interface FingerTuning {
  depthFrac: number;
  minFilm: number;
  pressTau: number;
  minPress: number;
  creepFrac: number;
  creepTau: number;
  liftSpeed: number;
  capZ: number;
}

export class FingerTracker {
  readonly fingers = new Map<number, Finger>();
  private nextId = 1;
  private seedCounter = Math.random() * 1000;
  /** Most recent press time (for the touch glow and assistive-tech click detection). */
  lastPressAt = -1e9;

  constructor(private tuning: FingerTuning) {}

  setTuning(tuning: FingerTuning): void {
    this.tuning = tuning;
  }

  get busy(): boolean {
    return this.fingers.size > 0;
  }

  /** Starts a press; returns its id (or -1 when all slots are busy). */
  press(
    kind: ContactKind,
    x: number,
    y: number,
    opts: { ax: number; ay: number; angle: number; depthScale: number; surfaceZ: number; now: number },
  ): number {
    if (this.fingers.size >= MAX_FINGERS) {
      // Recycle the contact that has been lifting the longest.
      let oldest: Finger | null = null;
      for (const f of this.fingers.values()) if (f.liftAt < (oldest?.liftAt ?? Infinity)) oldest = f;
      if (!oldest || oldest.liftAt === Infinity) return -1;
      this.fingers.delete(oldest.id);
    }
    // Golden-ratio steps keep consecutive prints visibly different.
    this.seedCounter = (this.seedCounter + 61.803) % 1000;
    const id = this.nextId++;
    this.fingers.set(id, {
      id,
      kind,
      x,
      y,
      px: x,
      py: y,
      ax: opts.ax,
      ay: opts.ay,
      angle: opts.angle,
      depthScale: opts.depthScale,
      downAt: opts.now,
      liftAt: Infinity,
      surfaceZ: opts.surfaceZ,
      depth: 0,
      lift: 0,
      speed: 0,
      seed: this.seedCounter,
    });
    this.lastPressAt = opts.now;
    return id;
  }

  move(id: number, x: number, y: number, depthScale?: number): void {
    const f = this.fingers.get(id);
    if (!f || f.liftAt !== Infinity) return;
    f.x = x;
    f.y = y;
    if (depthScale !== undefined) f.depthScale = depthScale;
  }

  release(id: number, now: number): void {
    const f = this.fingers.get(id);
    if (!f || f.liftAt !== Infinity) return;
    f.liftAt = Math.max(now, f.downAt + this.tuning.minPress);
  }

  releaseAll(now: number): void {
    for (const id of this.fingers.keys()) this.release(id, now);
  }

  /** True while the contact is pressing (including the minimum-press tail of a quick tap). */
  pressing(f: Finger, now: number): boolean {
    return now < f.liftAt;
  }

  /**
   * Advances finger depth / lift. Call once per frame before uploading. Depth is measured from the resting
   * surface under the finger *now*, so dragging from the thin rim onto the plateau doesn't dig to the page.
   */
  update(now: number, dt: number, surfaceAt: (x: number, y: number) => number): void {
    const t = this.tuning;
    for (const f of this.fingers.values()) {
      if (this.pressing(f, now)) {
        f.surfaceZ = Math.max(surfaceAt(f.x, f.y), 4);
        // Frame and event clocks can disagree by a few ms; never let a press start in the future.
        const hold = Math.max(0, now - f.downAt);
        const maxDepth = Math.max(0, f.surfaceZ - t.minFilm);
        const creep = 1 + t.creepFrac * (1 - Math.exp(-hold / t.creepTau));
        // Critically damped sink-in: starts gently, so the contact edge never outruns the goo's waves.
        const s = hold / t.pressTau;
        const ramp = 1 - (1 + s) * Math.exp(-s);
        // A fast-moving finger skims instead of digging in.
        const speed = Math.hypot(f.x - f.px, f.y - f.py) / Math.max(dt, 1e-3);
        f.speed += (speed - f.speed) * 0.35;
        const skim = 1 / Math.sqrt(1 + (f.speed / 400) ** 2);
        f.depth = Math.min(maxDepth, f.surfaceZ * t.depthFrac * f.depthScale * creep * ramp * skim);
      } else {
        f.lift += t.liftSpeed * dt;
      }
    }
    for (const [id, f] of this.fingers) {
      if (!this.pressing(f, now) && f.lift > f.depth + t.capZ) this.fingers.delete(id);
    }
  }

  /** Call after uploading so the next frame sweeps from here. */
  endFrame(): void {
    for (const f of this.fingers.values()) {
      f.px = f.x;
      f.py = f.y;
    }
  }

  /** Bottom of the fingertip above the page (CSS px). */
  tipZ(f: Finger): number {
    return f.surfaceZ - f.depth + f.lift;
  }
}
