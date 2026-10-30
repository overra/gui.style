// Environment and initial light rig for each theme. Material optics live in materials.ts; composeLook joins
// the two through live properties, so the renderer and legacy glass controls see the same authored values.
// Screen frame: x right, y down, z toward the viewer; azimuths are atan2(y_down, x) in degrees.

import type { Theme } from './background.ts';
import { defaultMaterial, type Material, type MaterialOptics } from './materials.ts';

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

/** A rounded-rect area light, placed by polar angle from +z (out of the page) and screen azimuth. */
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
  /** Key light 33° above the goo and 25° to its left: 41° off the screen's axis, toward the top-left. */
  lightDir: [-0.35, -0.55, 0.76] as [number, number, number],
  lightColor: [3.0, 2.95, 2.85] as [number, number, number],
  sunRadius: 0.052,
  /** Reflections use a perspective eye this far in front of the viewport center, so flat glass shows a sheen. */
  eyeDist: 1400,
};

export const environments = {
  light: {
    ...shared,
    skyZenith: [0.3, 0.31, 0.34] as [number, number, number],
    skyHorizon: [0.52, 0.54, 0.58] as [number, number, number],
    horizonGain: 1.0,
    groundGain: 0.9,
    softboxes: [
      softbox(16, -122, 0.3, 0.22, 0.08, 0.1, scale3(1.6, [1, 0.99, 0.97])), // front sheen
      softbox(52, -122, 0.42, 0.11, 0.05, 0.03, scale3(8, [1, 0.98, 0.95])), // key strip → top-left arc
      softbox(60, 58, 0.35, 0.08, 0.04, 0.04, scale3(2.4, [0.92, 0.96, 1])), // cool kicker → bottom-right arc
    ],
  },
  dark: {
    ...shared,
    skyZenith: [0.05, 0.055, 0.065] as [number, number, number],
    skyHorizon: [0.1, 0.11, 0.13] as [number, number, number],
    horizonGain: 0.8,
    groundGain: 1.0,
    softboxes: [
      softbox(16, -122, 0.3, 0.22, 0.08, 0.1, scale3(0.3, [1, 0.99, 0.97])),
      softbox(52, -122, 0.42, 0.11, 0.05, 0.03, scale3(7, [1, 0.98, 0.95])),
      softbox(60, 58, 0.35, 0.08, 0.04, 0.04, scale3(3, [0.92, 0.96, 1])),
    ],
  },
} satisfies Record<Theme, unknown>;

export type EnvironmentLook = (typeof environments)['light'];
export type Look = MaterialOptics & EnvironmentLook;

const views = new WeakMap<Material, Partial<Record<Theme, Look>>>();

/** A live view: material sliders write optics, while lighting and the studio retain their own defaults. */
export function composeLook(material: Material, theme: Theme): Look {
  let themes = views.get(material);
  if (!themes) views.set(material, (themes = {}));
  let view = themes[theme];
  if (view) return view;
  view = {} as Look;
  for (const key of Object.keys(material.optics[theme])) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => Reflect.get(material.optics[theme], key),
      set: (value) => { Reflect.set(material.optics[theme], key, value); },
    });
  }
  for (const key of Object.keys(environments[theme])) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => Reflect.get(environments[theme], key),
      set: (value) => { Reflect.set(environments[theme], key, value); },
    });
  }
  themes[theme] = view;
  return view;
}

/** Compatibility views used by existing controls; their optics are the active material's authored data. */
export const looks: Record<Theme, Look> = {
  light: composeLook(defaultMaterial, 'light'),
  dark: composeLook(defaultMaterial, 'dark'),
};
