// Optical look of the glass for each theme: refraction, tint, studio lighting, shadow and caustics.
// Screen frame: x right, y down, z toward the viewer; azimuths are atan2(y_down, x) in degrees.

import type { Theme } from './background.ts';

export interface Softbox {
  /** Unit center direction, long axis, short axis (gnomonic frame). */
  c: [number, number, number];
  t: [number, number, number];
  b: [number, number, number];
  radiance: [number, number, number];
  halfSize: [number, number];
  round: number;
  soft: number;
}

/** A rounded-rect area light, placed by polar angle from +z and screen azimuth. */
function softbox(
  polarDeg: number,
  azDeg: number,
  halfT: number,
  halfB: number,
  round: number,
  soft: number,
  radiance: [number, number, number],
): Softbox {
  const be = (polarDeg * Math.PI) / 180;
  const az = (azDeg * Math.PI) / 180;
  return {
    c: [Math.sin(be) * Math.cos(az), Math.sin(be) * Math.sin(az), Math.cos(be)],
    t: [-Math.sin(az), Math.cos(az), 0],
    b: [Math.cos(be) * Math.cos(az), Math.cos(be) * Math.sin(az), -Math.sin(be)],
    radiance,
    halfSize: [halfT, halfB],
    round,
    soft,
  };
}

const scale3 = (k: number, c: [number, number, number]): [number, number, number] => [k * c[0], k * c[1], k * c[2]];

const shared = {
  /** Apparent-depth lens term (CSS px): a small standoff that lets the steep wall lens without folding. */
  depthLens: 4,
  iorG: 1.5,
  /** Up-left key light, ~50° elevation. */
  lightDir: [-0.35, -0.55, 0.76] as [number, number, number],
  lightColor: [3.0, 2.95, 2.85] as [number, number, number],
  sunRadius: 0.052,
  roughness: 0.18,
  hazeRoughness: 0.12,
  rimLod: 0.3,
  lodMax: 2.5,
  /** Reflections use a perspective eye this far above the viewport center, so flat glass shows a sheen. */
  eyeDist: 1400,
  glintWidth: 1.1,
  aoWidth: 1.5,
  /** Faint cool body tint per CSS px of path; thin (pressed) goo looks clearer. */
  absorb: [0.002, 0.0011, 0.0007] as [number, number, number],
  filmEps: 0.35,
  glowRadius: 28,
};

export const looks = {
  light: {
    ...shared,
    iorR: 1.468,
    iorB: 1.542,
    saturation: 1.18,
    lift: 0.03,
    hazeLod: 1.0,
    skyZenith: [0.3, 0.31, 0.34] as [number, number, number],
    skyHorizon: [0.52, 0.54, 0.58] as [number, number, number],
    horizonGain: 1.0,
    groundGain: 0.9,
    glint: 0.3,
    glintOpposite: 0.55,
    shadowReach: 7,
    shadowSigma: 9,
    shadowOpacity: 0.14,
    aoOpacity: 0.2,
    causticC: 0.16,
    causticMin: 0.72,
    causticMax: 1.32,
    causticAdd: 0,
    glowPeak: 0.08,
    softboxes: [
      softbox(16, -122, 0.3, 0.22, 0.08, 0.1, scale3(1.6, [1, 0.99, 0.97])), // overhead sheen
      softbox(52, -122, 0.42, 0.11, 0.05, 0.03, scale3(8, [1, 0.98, 0.95])), // key strip → top-left arc
      softbox(60, 58, 0.35, 0.08, 0.04, 0.04, scale3(2.4, [0.92, 0.96, 1])), // cool kicker → bottom-right arc
    ],
  },
  dark: {
    ...shared,
    iorR: 1.46,
    iorB: 1.552,
    saturation: 1.3,
    lift: 0.012,
    hazeLod: 1.2,
    skyZenith: [0.05, 0.055, 0.065] as [number, number, number],
    skyHorizon: [0.1, 0.11, 0.13] as [number, number, number],
    horizonGain: 0.8,
    groundGain: 1.0,
    glint: 0.5,
    glintOpposite: 0.6,
    shadowReach: 6,
    shadowSigma: 10,
    shadowOpacity: 0.42,
    aoOpacity: 0.45,
    causticC: 0.18,
    causticMin: 0.7,
    causticMax: 1.45,
    causticAdd: 0.04,
    glowPeak: 0.14,
    softboxes: [
      softbox(16, -122, 0.3, 0.22, 0.08, 0.1, scale3(0.3, [1, 0.99, 0.97])),
      softbox(52, -122, 0.42, 0.11, 0.05, 0.03, scale3(7, [1, 0.98, 0.95])),
      softbox(60, 58, 0.35, 0.08, 0.04, 0.04, scale3(3, [0.92, 0.96, 1])),
    ],
  },
} satisfies Record<Theme, unknown>;

export type Look = (typeof looks)['light'];
