// Authored material data. The scene refers to materials by id; renderers derive their uniforms from these values.
// Environment and light-rig defaults stay in look.ts. No GPU resources or simulated state belong in this record.

import type { Theme } from './background.ts';
import { params, type Params } from './params.ts';

const shared = {
  /** Apparent-depth lens term (CSS px): a small standoff that lets the steep wall lens without folding. */
  depthLens: 4,
  iorG: 1.5,
  roughness: 0.18,
  hazeRoughness: 0.12,
  rimLod: 0.3,
  lodMax: 2.5,
  glintWidth: 1.1,
  aoWidth: 1.5,
  /** Faint cool body tint per CSS px of path; thin (pressed) goo looks clearer. */
  absorb: [0.002, 0.0011, 0.0007] as [number, number, number],
  filmEps: 0.35,
  glowRadius: 28,
};

const defaultOptics = {
  light: {
    ...shared,
    iorR: 1.468,
    iorB: 1.542,
    saturation: 1.18,
    lift: 0.03,
    hazeLod: 1.0,
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
  },
  dark: {
    ...shared,
    iorR: 1.46,
    iorB: 1.552,
    saturation: 1.3,
    lift: 0.012,
    hazeLod: 1.2,
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
  },
};

export type MaterialOptics = typeof defaultOptics.light;

export interface Material {
  id: string;
  name: string;
  params: Params;
  optics: Record<Theme, MaterialOptics>;
}

/** The live default material shares the legacy params object, so existing controls edit the authored record. */
export const defaultMaterial: Material = {
  id: 'glass-putty',
  name: 'Glass putty',
  params,
  optics: structuredClone(defaultOptics),
};

// Keep pristine defaults apart from the live material: reset and a new document should never inherit an edit.
const initialMaterial = structuredClone(defaultMaterial);

/** Independent material data with the tuned defaults; ids are supplied by the document. */
export function createDefaultMaterial(id = 'glass-putty'): Material {
  const material = structuredClone(initialMaterial);
  material.id = id;
  return material;
}

/** Copy authored values while preserving objects already held by GUI controls and the renderer. */
export function applyMaterial(target: Material, source: Material): void {
  const copy = (into: object, from: object) => {
    for (const key of Object.keys(from)) {
      const value = Reflect.get(from, key);
      const current = Reflect.get(into, key);
      if (value !== null && typeof value === 'object' && current !== null && typeof current === 'object') {
        copy(current, value);
        if (Array.isArray(current) && Array.isArray(value)) current.length = value.length;
      } else {
        Reflect.set(into, key, value);
      }
    }
  };
  copy(target, source);
}

/** Adopt a selected material without replacing references already used by the single-element runtime. */
export function bindMaterial(source: Material): Material {
  applyMaterial(defaultMaterial, source);
  return defaultMaterial;
}
