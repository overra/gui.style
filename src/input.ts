// Pointer, keyboard and assistive-tech input → fingertip contacts. The native <button> keeps its own click
// semantics (no pointer capture, so releasing outside still cancels); this layer only adds the physical press.

import type { ContactKind, FingerTracker } from './touches.ts';

export interface InputHooks {
  tracker: FingerTracker;
  buttons: HTMLElement[];
  /** Viewport CSS px → goo space. */
  toGoo: (clientX: number, clientY: number) => { x: number; y: number };
  /** Goo-space center of a button's shape. */
  centerOf: (button: HTMLElement) => { x: number; y: number } | null;
  /** Rest-surface height (CSS px) at a goo-space point. */
  surfaceAt: (x: number, y: number) => number;
  now: () => number;
  /** Called whenever input should wake the render loop. */
  wake: () => void;
}

/** Default fingertip semi-axes (CSS px) by contact kind; a pen tip is small and leaves no ridges. */
const AXES: Record<ContactKind, [number, number]> = {
  mouse: [19, 24],
  virtual: [19, 24],
  touch: [22, 28],
  pen: [5, 5],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fingertips land rotated ~-11°, varied so repeated prints don't look stamped. */
const fingerAngle = () => -0.19 + (Math.random() - 0.5) * 0.35;

/** Event timestamps share performance.now()'s clock in modern browsers; fall back to `now` if they don't. */
const eventTime = (e: Event, now: number) => {
  const t = e.timeStamp / 1000;
  return Math.abs(t - now) < 0.1 ? Math.min(t, now) : now;
};

export function attachInput(hooks: InputHooks): () => void {
  const { tracker } = hooks;
  const held = new Map<number, { id: number; kind: ContactKind; x0: number; y0: number; dragged: boolean }>();
  const keyHeld = new Map<HTMLElement, number>();
  let lastReleaseAt = -1e9;
  let lastMouseDragAt = -1e9;
  const ac = new AbortController();
  const on = { signal: ac.signal };
  const passive = { signal: ac.signal, passive: true };

  const press = (kind: ContactKind, x: number, y: number, size: [number, number], depthScale: number, t: number) => {
    const id = tracker.press(kind, x, y, {
      ax: size[0],
      ay: size[1],
      angle: fingerAngle(),
      depthScale,
      surfaceZ: Math.max(hooks.surfaceAt(x, y), 4),
      now: t,
    });
    hooks.wake();
    return id;
  };

  const virtualTap = (button: HTMLElement, t: number) => {
    const c = hooks.centerOf(button);
    if (!c) return;
    const id = press('virtual', c.x + (Math.random() - 0.5) * 6, c.y + (Math.random() - 0.5) * 6, AXES.virtual, 1, t);
    tracker.release(id, t);
    lastReleaseAt = t;
  };

  for (const button of hooks.buttons) {
    button.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const kind = (e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse') as ContactKind;
        // A new press on the button starts a new gesture: an earlier drag must not swallow its click.
        if (kind === 'mouse') lastMouseDragAt = -1e9;
        let size = AXES[kind];
        if (kind === 'touch' && e.width > 2 && e.height > 2) {
          const a = clamp(0.62 * e.width, 16, 34);
          let b = clamp(0.62 * e.height, 20, 40);
          if (b < 1.15 * a) b = Math.min(40, 1.25 * a);
          size = [a, b];
        }
        // Only pens report real pressure; mice report 0.5 by spec and many touchscreens report noise.
        const depthScale = kind === 'pen' && e.pressure > 0 ? 0.55 + 0.9 * e.pressure : 1;
        const p = hooks.toGoo(e.clientX, e.clientY);
        const t = eventTime(e, hooks.now());
        const prev = held.get(e.pointerId);
        if (prev) tracker.release(prev.id, t);
        held.set(e.pointerId, { id: press(kind, p.x, p.y, size, depthScale, t), kind, x0: e.clientX, y0: e.clientY, dragged: false });
      },
      passive,
    );

    // Keyboard: the visual follows the key being held. Clicks are left entirely to the browser.
    button.addEventListener(
      'keydown',
      (e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
        const c = hooks.centerOf(button);
        if (!c || keyHeld.has(button)) return;
        const t = eventTime(e, hooks.now());
        keyHeld.set(button, press('virtual', c.x + (Math.random() - 0.5) * 6, c.y + (Math.random() - 0.5) * 6, AXES.virtual, 1, t));
      },
      on,
    );
    const keyUp = (t: number) => {
      const id = keyHeld.get(button);
      if (id === undefined) return;
      keyHeld.delete(button);
      tracker.release(id, t);
      lastReleaseAt = t;
      hooks.wake();
    };
    button.addEventListener('keyup', (e) => (e.key === 'Enter' || e.key === ' ') && keyUp(eventTime(e, hooks.now())), on);
    button.addEventListener('blur', () => keyUp(hooks.now()), on);

    // Screen readers, Voice Control and el.click() activate without any press: give them a dent too.
    button.addEventListener(
      'click',
      () => {
        // A held Enter key already presses the goo (and auto-repeat fires a click per repeat).
        if (keyHeld.has(button)) return;
        const t = hooks.now();
        if (t - Math.max(tracker.lastPressAt, lastReleaseAt) > 0.35) virtualTap(button, t);
      },
      on,
    );

    // Keep native right-click for the mouse, but stop long-press callouts from cancelling a touch hold.
    button.addEventListener(
      'contextmenu',
      (e) => {
        const kind = (e as PointerEvent).pointerType;
        if (kind === 'touch' || kind === 'pen' || [...held.values()].some((h) => h.kind !== 'mouse')) e.preventDefault();
      },
      on,
    );
  }

  window.addEventListener(
    'pointermove',
    (e) => {
      const h = held.get(e.pointerId);
      if (!h) return;
      // The freshest coalesced sample; the indenter sweeps from last frame's position to it.
      const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const last = samples.length ? samples[samples.length - 1] : e;
      const p = hooks.toGoo(last.clientX, last.clientY);
      const depthScale = h.kind === 'pen' && last.pressure > 0 ? 0.55 + 0.9 * last.pressure : undefined;
      tracker.move(h.id, p.x, p.y, depthScale);
      if (!h.dragged && Math.hypot(e.clientX - h.x0, e.clientY - h.y0) > 10) h.dragged = true;
      hooks.wake();
    },
    passive,
  );

  const up = (e: PointerEvent) => {
    const h = held.get(e.pointerId);
    if (!h) return;
    held.delete(e.pointerId);
    const t = eventTime(e, hooks.now());
    tracker.release(h.id, t);
    lastReleaseAt = t;
    if (h.kind === 'mouse' && h.dragged) lastMouseDragAt = t;
    hooks.wake();
  };
  window.addEventListener('pointerup', up, passive);
  window.addEventListener('pointercancel', up, passive);

  // Dragging the mouse through the goo is play, not a press: don't let it activate the button.
  window.addEventListener(
    'click',
    (e) => {
      if (e.detail === 0) return; // keyboard / assistive tech
      if (!hooks.buttons.some((b) => b.contains(e.target as Node))) return;
      if (hooks.now() - lastMouseDragAt < 0.5) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { signal: ac.signal, capture: true },
  );

  const releaseAll = () => {
    const t = hooks.now();
    tracker.releaseAll(t);
    held.clear();
    keyHeld.clear();
    lastReleaseAt = t;
    hooks.wake();
  };
  window.addEventListener('blur', releaseAll, on);
  document.addEventListener('visibilitychange', () => document.hidden && releaseAll(), on);

  return () => ac.abort();
}
