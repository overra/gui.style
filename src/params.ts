// Tunables. Lengths are CSS px, times are seconds. Simulation constants marked "cell" use grid units
// (one cell = `sim.cell` CSS px) because the stencils are written per cell.

export const params = {
  shape: {
    /** Plateau thickness of the resting putty and the width of its rounded wall. */
    plateau: 18,
    bezel: 22,
    /** Wall steepness: 1 = sloped puddle edge (~68° contact), 2 = vertical, non-wetting putty wall. */
    steepness: 2,
    /** Smooth-union radius when several goo elements sit close together. */
    blend: 16,
  },

  sim: {
    /** CSS px per simulation cell. */
    cell: 3,
    /** Canvas / domain margin around the goo (bulges, fingers hanging off the edge, shadow). */
    margin: 48,
    /** Fixed physics substep; each frame runs as many as fit (capped, extra time is dropped). */
    substep: 1 / 480,
    maxSubsteps: 16,
  },

  /** Elastic layer: damped membrane on a spring foundation (fast rebound + wobble). */
  elastic: {
    omega: 2 * Math.PI * 7,
    zeta: 0.3,
    /** Membrane wave speed (cells/s). */
    waveSpeed: 80,
    /** Finger penalty stiffness. */
    contact: 20000,
  },

  /** Plastic layer: volume-conserving viscoplastic flow (imprint, raised rim). */
  plastic: {
    gravity: 1,
    /** Capillary smoothing (cell²). */
    surfaceTension: 0.35,
    /** Penalty stiffness of the shallower "plastic" finger, and the share of the dent that sets plastically. */
    contact: 20,
    plasticShare: 0.6,
    /** Inertial flux gain (cell²/s²) and its damping (1/s). */
    fluxGain: 3600,
    fluxDamping: 120,
    /** Bingham yield head (px): below it the putty holds its shape. */
    yieldHead: 2.5,
    /** Creep conductance (cell²/s): slow leveling flow. */
    creep: 0.8,
    /** Extra restoring head outside the resting footprint (dewetting). */
    dewet: 12,
  },

  /** Self-healing: the putty remembers its resting shape and returns to it once left alone. */
  heal: {
    /** Time constant of the return to rest. */
    tau: 0.85,
    /** A pressed region holds its imprint this long before it starts healing, then eases in over `ramp`. */
    hold: 0.35,
    ramp: 0.65,
    /** Fingertip ellipse scale that counts as "being pressed" (covers the dent and its rim). */
    zone: 1.7,
  },

  /** Fingerprint detail layer (0.5 CSS px per texel). */
  detail: {
    texel: 0.5,
    /** Ridge period (CSS px, ~2.5× real scale) and peak-to-peak groove depth (px). */
    period: 3.4,
    depth: 0.24,
    /** Time constant for ridges to print while pressed. */
    stampTau: 0.07,
    /** Global fade, and biharmonic smoothing per second (it flattens sharp crests and fine ridges first). */
    fadeTau: 1.0,
    smoothing: 1.2,
    /** Touch haze (skin residue: frost + roughness) fade. */
    hazeTau: 1.1,
  },

  finger: {
    /** Max press depth as a fraction of the local surface height. */
    depthFrac: 0.48,
    /** Thinnest film the finger can squeeze the goo to (CSS px). */
    minFilm: 1.5,
    /** Time constant for the finger sinking in (s), and the shortest a press lasts (quick taps still print). */
    pressTau: 0.045,
    minPress: 0.11,
    /** Extra sinking while held, as a fraction of depth, and its time constant (s). */
    creepFrac: 0.15,
    creepTau: 0.9,
    /** Lift speed after release (CSS px / s). */
    liftSpeed: 900,
    /** Vertical semi-axis of the fingertip ellipsoid (CSS px); ~1.4× the contact semi-axis. */
    capZ: 26,
  },

  intro: {
    /** Footprint shrink of the dropped blob, how long it stays liquid, and how fast it sets into putty. */
    shrink: 0.82,
    liquidFor: 0.9,
    setTau: 0.5,
    /** Flux damping (1/s) while liquid: low enough to slosh once, high enough not to ripple at grid scale. */
    liquidDamping: 30,
  },

  /** Rendering budget: device pixels for the goo canvas, by pointer type. */
  pixelBudget: { coarse: 1.0e6, fine: 2.5e6 },

  /** Stop the loop this long after the last interaction (everything has healed by then). */
  sleepAfter: 5,
};

export type Params = typeof params;

/** Rest height (CSS px) of the putty at a signed distance `sd` (negative inside): H0 (1 - (1 - t)³)^(1/B). */
export function restHeightCpu(sd: number): number {
  const u = -sd;
  if (u <= 0) return 0;
  const { plateau, bezel, steepness } = params.shape;
  const t = Math.min(u / bezel, 1);
  const g = 1 - (1 - t) ** 3;
  return plateau * g ** (1 / steepness);
}
