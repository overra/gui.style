// "Feel" macros → the physical and visual knobs they drive. Each macro runs 0..1 with 0.5 = the tuned defaults in
// params.ts, so the base values stay editable on their own. Everything here is recomputed every frame.

import { params } from './params.ts';
import type { FingerTuning } from './touches.ts';

/** 0 → 1/r, 0.5 → 1, 1 → r (log-symmetric around the defaults). */
const ratio = (x: number, r: number) => r ** ((x - 0.5) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Effective {
  elastic: { omega: number; zeta: number; waveSpeed: number; contact: number };
  plastic: typeof params.plastic;
  heal: typeof params.heal;
  finger: FingerTuning;
  detail: typeof params.detail;
  /** Flux damping (1/s) while the dropped goo is still liquid. */
  introDamping: number;
  /** Shader-only exaggeration: dent depth gain, ridge gain and smudge (haze) gain. */
  visual: { imprintGain: number; ridgeGain: number; hazeGain: number };
  /** Levitation cushion: press travel (CSS px), natural frequency (rad/s), damping ratio and tilt share. */
  levitation: { travel: number; omega: number; zeta: number; tilt: number };
}

/** Gravity in a goo element's rest frame (g): along its x and y axes, and into its base (n > 0 presses it on). */
export interface GooGravity {
  x: number;
  y: number;
  n: number;
}

export const NO_GRAVITY: GooGravity = { x: 0, y: 0, n: 0 };

export function effectiveParams(gravity: GooGravity = NO_GRAVITY): Effective {
  const { feel, material, elastic, plastic, heal, finger, detail, intro, sim, levitation } = params;
  const dt = sim.substep;
  const v = ratio(feel.viscosity, 4);
  const s = ratio(feel.elasticity, 2.8);
  const e = feel.elasticity;
  const i = feel.imprint;
  const f = feel.fingerprint;

  // Material: adhesion holds the contact line and makes the page wettable (smears stay put), cohesion is the yield,
  // surface tension levels the putty and the printed ridges, density is the weight gravity pulls on.
  const pin = plastic.pin * ratio(material.adhesion, 3);
  const dewet = plastic.dewet * ratio(1 - material.adhesion, 2);
  const tension = plastic.surfaceTension * ratio(material.surfaceTension, 3);
  const weight = plastic.weight * ratio(material.density, 20);

  // Viscosity: thicker putty damps its flow harder, flows less freely, creeps, heals and wobbles slower.
  const fluxDamping = plastic.fluxDamping * v;
  const decay = Math.exp(-fluxDamping * dt);
  // Creep is an explicit diffusion too: keep dt·Mc·K well inside its own limit. K's largest restoring head is the
  // intro's 2·memory plus the weight pressing into the base (a floor page); 2 at the defaults, as before.
  const headMax = 2 * plastic.memory + weight * Math.max(gravity.n, 0);
  const stiffness = 8 * (headMax + Math.max(plastic.contact, dewet) + 8 * tension);
  const creep = Math.min(plastic.creep / v, 1.2 / (dt * stiffness));
  // Keep the explicit flux update stable whatever the sliders say (checkerboard mode, headMax, 10% margin):
  // dt²·KP·K + dt·Mc·K·(1 + d) ≤ 2(1 + d), d = e^(−GP·dt).
  let fluxGain = plastic.fluxGain * Math.min(1, 1 / v);
  fluxGain = Math.min(
    fluxGain,
    Math.max(0, (0.9 * 2 * (1 + decay) - dt * creep * stiffness * (1 + decay)) / (dt * dt * stiffness)),
  );

  // Elasticity: a stiffer spring layer rings faster and takes more of the dent back instantly.
  let omega = elastic.omega * Math.sqrt(s);
  let waveSpeed = elastic.waveSpeed * Math.sqrt(s);
  const elasticLoad = dt * dt * (omega * omega + 8 * waveSpeed * waveSpeed + elastic.contact);
  if (elasticLoad > 3.6) {
    const k = Math.sqrt(3.6 / elasticLoad);
    omega *= k;
    waveSpeed *= k;
  }
  const zeta = clamp(elastic.zeta * v ** 0.4 * (1.25 - 0.5 * e), 0.06, 1);

  return {
    elastic: { omega, zeta, waveSpeed, contact: elastic.contact },
    plastic: {
      ...plastic,
      fluxGain,
      fluxDamping,
      creep,
      pin,
      dewet,
      weight,
      surfaceTension: tension,
      // Doughy putty yields easily and keeps most of the dent; bouncy putty holds its shape and springs back.
      yieldHead: plastic.yieldHead * (0.5 + e) * ratio(material.cohesion, 2),
      plasticShare: clamp(plastic.plasticShare - (e - 0.5) * 0.9 + (i - 0.5) * 0.3, 0.08, 0.95),
    },
    heal: {
      ...heal,
      tau: heal.tau * v ** 0.5,
      hold: heal.hold * v ** 0.5 * (0.4 + 1.2 * i),
    },
    finger: { ...finger, depthFrac: clamp(finger.depthFrac * (0.55 + 0.9 * i), 0.12, 0.88) },
    detail: {
      ...detail,
      fadeTau: detail.fadeTau * v ** 0.5 * (0.6 + 0.8 * f),
      smoothing: (detail.smoothing / v ** 0.5) * ratio(material.surfaceTension, 3),
    },
    introDamping: intro.liquidDamping * v,
    visual: {
      imprintGain: i <= 0.5 ? 0.6 + 0.8 * i : 1 + (i - 0.5) * 2.4,
      ridgeGain: f <= 0.5 ? 2 * f : 1 + (f - 0.5) * 6,
      // No ridges, no smudge; exaggerated ridges stay crisp instead of frosting over.
      hazeGain: Math.min(1, 2 * f) * (f > 0.5 ? 1 - (f - 0.5) * 1.2 : 1),
    },
    // The cushion is integrated in 1/600 s substeps (levitation.ts): ω and ζ stay well inside that limit.
    levitation: {
      travel: Math.max(0, levitation.travel),
      omega: 2 * Math.PI * clamp(levitation.stiffness, 0.5, 20),
      zeta: clamp(levitation.damping, 0.02, 2),
      tilt: clamp(levitation.tilt, 0, 1),
    },
  };
}
