import { d } from 'typegpu';

export const MAX_FINGERS = 8;
export const MAX_SHAPES = 4;

// Uniform arrays need a 16-byte stride, hence the explicit padding.

/** A fingertip indenter: an ellipsoidal cap swept from `prev` to `pos` during the frame (goo-space CSS px). */
export const Finger = d.struct({
  pos: d.vec2f,
  prev: d.vec2f,
  /** Fingertip ellipse semi-axes (CSS px). */
  axes: d.vec2f,
  /** cos/sin of the finger's rotation. */
  rot: d.vec2f,
  /** Semi-axes of the part of the ellipse currently touching the goo. */
  reach: d.vec2f,
  /** Height of the fingertip's lowest point above the page, and the cap's vertical semi-axis. */
  tipZ: d.f32,
  capZ: d.f32,
  /** 0..1 while pressed (prints ridges, adds haze); 0 after release. */
  contact: d.f32,
  seed: d.f32,
  /** 1 for fingertips, 0 for pen tips (no ridges). */
  skin: d.f32,
  pad0: d.f32,
});

/** A goo element: rounded rectangle in goo-space CSS px. */
export const Shape = d.struct({
  center: d.vec2f,
  halfSize: d.vec2f,
  radius: d.f32,
  pad0: d.f32,
  pad1: d.f32,
  pad2: d.f32,
});

export const SimParams = d.struct({
  /** CSS px per cell and the physics substep. */
  cell: d.f32,
  dt: d.f32,
  fingerCount: d.u32,
  /** Cells below this rest height count as dry page. */
  dryLevel: d.f32,
  // elastic layer
  omega2: d.f32,
  wave2: d.f32,
  dampE: d.f32,
  contactE: d.f32,
  // plastic layer
  gravity: d.f32,
  tension: d.f32,
  contactP: d.f32,
  plasticShare: d.f32,
  fluxGain: d.f32,
  fluxDecay: d.f32,
  yieldHead: d.f32,
  creep: d.f32,
  dewet: d.f32,
  // self-healing
  healRate: d.f32,
  healHold: d.f32,
  healRamp: d.f32,
  healZone2: d.f32,
  pad0: d.f32,
  pad1: d.f32,
  pad2: d.f32,
});

export const DetailParams = d.struct({
  texel: d.f32,
  period: d.f32,
  depth: d.f32,
  stamp: d.f32,
  fade: d.f32,
  smoothing: d.f32,
  hazeFade: d.f32,
  fingerCount: d.u32,
  /** CSS px per rendered device pixel (ridges fade out before they would alias). */
  pxCss: d.f32,
});

export const Softbox = d.struct({
  c: d.vec3f,
  t: d.vec3f,
  b: d.vec3f,
  radiance: d.vec3f,
  halfSize: d.vec2f,
  round: d.f32,
  soft: d.f32,
});

export const GlassParams = d.struct({
  /** Viewport position (CSS px) of the goo canvas' top-left, the viewport size, and CSS px per device px. */
  canvasOrigin: d.vec2f,
  viewport: d.vec2f,
  pxCss: d.f32,
  shapeCount: d.u32,
  simCell: d.f32,
  detailTexel: d.f32,
  plateau: d.f32,
  bezel: d.f32,
  steepness: d.f32,
  blend: d.f32,
  filmEps: d.f32,
  depthLens: d.f32,
  /** The label's box (goo space) — it is printed on the page under the glass. */
  labelOrigin: d.vec2f,
  labelSize: d.vec2f,
  iorR: d.f32,
  iorG: d.f32,
  iorB: d.f32,
  saturation: d.f32,
  absorb: d.vec3f,
  lift: d.f32,
  lightDir: d.vec3f,
  rimLod: d.f32,
  lightColor: d.vec3f,
  lodMax: d.f32,
  skyZenith: d.vec3f,
  hazeLod: d.f32,
  skyHorizon: d.vec3f,
  roughness: d.f32,
  hazeRoughness: d.f32,
  sunRadius: d.f32,
  eyeDist: d.f32,
  horizonGain: d.f32,
  groundGain: d.f32,
  glint: d.f32,
  glintOpposite: d.f32,
  glintWidth: d.f32,
  shadowReach: d.f32,
  shadowSigma: d.f32,
  shadowOpacity: d.f32,
  aoOpacity: d.f32,
  aoWidth: d.f32,
  causticC: d.f32,
  causticMin: d.f32,
  causticMax: d.f32,
  causticAdd: d.f32,
  glowAmount: d.f32,
  glowCenter: d.vec2f,
  glowRadius: d.f32,
  /** 0 → 1 as the dropped goo sets into glass. */
  materialize: d.f32,
  /** Shader-only exaggeration of the dents, the fingerprint ridges and the touch smudge. */
  imprintGain: d.f32,
  ridgeGain: d.f32,
  hazeGain: d.f32,
  softboxes: d.arrayOf(Softbox, 3),
});
