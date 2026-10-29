// GPU timing for the ?perf overlay (src/perf.ts): timestamp writes around one frame's passes. Without ?perf no timer
// is set, and every pass is recorded exactly as it would be without this module.

export interface PassTimestamps {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex?: number;
  endOfPassWriteIndex?: number;
}

/** One frame of one renderer's GPU work, timed from the start of its first pass to the end of its last. */
export interface FrameSpan {
  /** The timestamp writes for the frame's first pass, its last, or both; passes in between take none. */
  writes(first: boolean, last: boolean): PassTimestamps;
  /** Records the query resolve: after the last pass, before submitting. */
  resolve(encoder: GPUCommandEncoder): void;
  /** Reads the timestamps back once the GPU is done: after submitting. */
  collect(): void;
}

export interface PassTimer {
  /** A span for `name`'s frame, or null while its last reading is still on its way back. */
  span(name: string): FrameSpan | null;
}

let timer: PassTimer | null = null;

export function setPassTimer(next: PassTimer | null) {
  timer = next;
}

/** A span to time this frame's passes with, or null: record them untimed. */
export const frameSpan = (name: string): FrameSpan | null => timer?.span(name) ?? null;
