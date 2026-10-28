// Putty simulation on a coarse grid ("EVP-lite"), in goo space (CSS px from the goo canvas' top-left). Per cell:
//   e, v  elastic deviation + velocity: a damped membrane on a spring foundation (instant rebound, wobble)
//   m     plastic displacement: volume-conserving viscoplastic flow with a yield head (imprint, raised rim)
//   age   time since a finger last pressed nearby; once it passes a short hold, m relaxes back to rest
// Surface height = rest(sdf) + m + e. Each substep runs four kernels:
//   elastic → face fluxes → outflow limiter → apply fluxes. A pack kernel then prepares a filterable texture.
// Spatial derivatives are per cell; heights are CSS px.

import { tgpu, d, std } from 'typegpu';
import { Finger, MAX_FINGERS, SimParams } from './schemas.ts';

const unfilterable = { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' } as const;

export const simShared = tgpu.bindGroupLayout({
  sim: { uniform: SimParams },
  fingers: { uniform: d.arrayOf(Finger, MAX_FINGERS) },
});

/** state (e, v, m, age) + rest → state with e, v advanced and m healed; plastic pressure head. */
export const elasticLayout = tgpu.bindGroupLayout({
  state: unfilterable,
  rest: unfilterable,
  stateOut: { storageTexture: d.textureStorage2d('rgba32float', 'write-only') },
  pressureOut: { storageTexture: d.textureStorage2d('r32float', 'write-only') },
});

/** pressure + previous inertial face flux → (qx, qy, fx, fy) for the cell's +x and +y faces. */
export const fluxLayout = tgpu.bindGroupLayout({
  pressure: unfilterable,
  rest: unfilterable,
  flux: unfilterable,
  fluxOut: { storageTexture: d.textureStorage2d('rgba32float', 'write-only') },
});

/** Outflow limiter so no cell drains below the page. */
export const limitLayout = tgpu.bindGroupLayout({
  faces: unfilterable,
  rest: unfilterable,
  state: unfilterable,
  limitOut: { storageTexture: d.textureStorage2d('r32float', 'write-only') },
});

/** Limited fluxes move plastic volume; the inertial part is stored for the next substep. */
export const applyLayout = tgpu.bindGroupLayout({
  faces: unfilterable,
  limit: unfilterable,
  state: unfilterable,
  stateOut: { storageTexture: d.textureStorage2d('rgba32float', 'write-only') },
  fluxOut: { storageTexture: d.textureStorage2d('rg32float', 'write-only') },
});

/**
 * (u, ∂u/∂x, ∂u/∂y, ∇²u) in CSS px units, for bicubic sampling while rendering; plus the total height at grid
 * resolution, which decides where there is any goo at all while the dropped blob is still spreading.
 */
export const packLayout = tgpu.bindGroupLayout({
  state: unfilterable,
  rest: unfilterable,
  packOut: { storageTexture: d.textureStorage2d('rgba16float', 'write-only') },
  coverOut: { storageTexture: d.textureStorage2d('rgba16float', 'write-only') },
});

export const clampCell = (p: d.v2i, dims: d.v2u) => {
  'use gpu';
  return std.clamp(p, d.vec2i(0), d.vec2i(dims).sub(1));
};

/** Rotates an offset into a finger's frame (inverse rotation by the finger angle). */
export const toFinger = (v: d.v2f, rot: d.v2f) => {
  'use gpu';
  return d.vec2f(v.x * rot.x + v.y * rot.y, v.y * rot.x - v.x * rot.y);
};

/** Squared distance from `x` to a fingertip ellipse swept prev → pos, in units of the ellipse (< 1 = under it). */
export const fingerDist2 = (x: d.v2f, pos: d.v2f, prev: d.v2f, axes: d.v2f, rot: d.v2f) => {
  'use gpu';
  const q = toFinger(x.sub(pos), rot).div(axes);
  const qp = toFinger(prev.sub(pos), rot).div(axes);
  const along = std.neg(qp);
  const rel = q.sub(qp);
  const t = std.saturate(std.dot(rel, along) / std.max(std.dot(along, along), 1e-6));
  const off = rel.sub(along.mul(t));
  return std.dot(off, off);
};

const loadState = (p: d.v2i, dims: d.v2u) => {
  'use gpu';
  return std.textureLoad(elasticLayout.$.state, clampCell(p, dims), 0);
};

export const elasticKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(elasticLayout.$.state);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const sp = simShared.$.sim;
  const p = d.vec2i(gid.xy);
  const c = std.textureLoad(elasticLayout.$.state, p, 0);
  const l = loadState(p.sub(d.vec2i(1, 0)), dims);
  const r = loadState(p.add(d.vec2i(1, 0)), dims);
  const t = loadState(p.sub(d.vec2i(0, 1)), dims);
  const b = loadState(p.add(d.vec2i(0, 1)), dims);
  const rest = std.textureLoad(elasticLayout.$.rest, p, 0).x;
  const lapE = l.x + r.x + t.x + b.x - 4 * c.x;
  const lapM = l.z + r.z + t.z + b.z - 4 * c.z;

  // Lowest fingertip surface over this cell, and how close the nearest finger is.
  const x = d.vec2f(gid.xy).add(0.5).mul(sp.cell);
  let zf = d.f32(1e6);
  let near = d.f32(1e6);
  for (let i = d.u32(0); i < sp.fingerCount; i++) {
    const f = simShared.$.fingers[i];
    const r2 = fingerDist2(x, f.pos, f.prev, f.axes, f.rot);
    near = std.min(near, r2);
    if (r2 < 1) {
      zf = std.min(zf, f.tipZ + f.capZ * (1 - std.sqrt(1 - r2)));
    }
  }

  const h0 = rest + c.z;
  let pen = d.f32(0);
  let push = d.f32(0);
  if (zf < 1e5) {
    // The whole surface feels the real finger; the plastic layer only sets against a shallower one.
    pen = std.max(h0 + c.x - zf, 0);
    const zPlastic = zf + (1 - sp.plasticShare) * std.max(rest - zf, 0);
    push = sp.contactP * std.max(h0 - zPlastic, 0);
  }

  let v = c.y + sp.dt * (sp.wave2 * lapE - sp.omega2 * c.x - sp.dampE * c.y - sp.contactE * pen);
  let e = c.x + sp.dt * v;
  if (e < -h0) {
    e = -h0;
    v = std.max(v, 0);
  }

  let g = sp.gravity;
  if (rest < sp.dryLevel) {
    g = g + sp.dewet;
  }
  const pressure = g * c.z - sp.tension * lapM + push;

  // Self-healing: near a pressing finger the imprint holds; elsewhere it eases back to the resting shape.
  let age = std.min(c.w + sp.dt, 100);
  if (near < sp.healZone2) {
    age = d.f32(0);
  }
  const heal = sp.healRate * std.smoothstep(sp.healHold, sp.healHold + sp.healRamp, age);
  const m = c.z * std.exp(-heal * sp.dt);

  std.textureStore(elasticLayout.$.stateOut, gid.xy, d.vec4f(e, v, m, age));
  std.textureStore(elasticLayout.$.pressureOut, gid.xy, d.vec4f(pressure, 0, 0, 0));
});

/** New inertial flux q and total flux f (q + creep) across one face. */
const faceFlux = (qPrev: number, drop: number, restA: number, restB: number) => {
  'use gpu';
  const sp = simShared.$.sim;
  let yieldHead = sp.yieldHead;
  if (std.min(restA, restB) < sp.dryLevel) {
    yieldHead = d.f32(0);
  }
  const drive = std.sign(drop) * std.max(std.abs(drop) - yieldHead, 0);
  let q = qPrev * sp.fluxDecay + sp.dt * sp.fluxGain * drive;
  let f = q + sp.creep * drop;
  // Dry page on both sides: nothing flows (keeps films from creeping across the page).
  if (std.max(restA, restB) < sp.dryLevel) {
    q = d.f32(0);
    f = d.f32(0);
  }
  return d.vec2f(q, f);
};

export const fluxKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(fluxLayout.$.pressure);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const p = d.vec2i(gid.xy);
  const p0 = std.textureLoad(fluxLayout.$.pressure, p, 0).x;
  const r0 = std.textureLoad(fluxLayout.$.rest, p, 0).x;
  const qPrev = std.textureLoad(fluxLayout.$.flux, p, 0);
  let fx = d.vec2f(0, 0);
  let fy = d.vec2f(0, 0);
  if (gid.x + 1 < dims.x) {
    const n = p.add(d.vec2i(1, 0));
    fx = faceFlux(
      qPrev.x,
      p0 - std.textureLoad(fluxLayout.$.pressure, n, 0).x,
      r0,
      std.textureLoad(fluxLayout.$.rest, n, 0).x,
    );
  }
  if (gid.y + 1 < dims.y) {
    const n = p.add(d.vec2i(0, 1));
    fy = faceFlux(
      qPrev.y,
      p0 - std.textureLoad(fluxLayout.$.pressure, n, 0).x,
      r0,
      std.textureLoad(fluxLayout.$.rest, n, 0).x,
    );
  }
  std.textureStore(fluxLayout.$.fluxOut, gid.xy, d.vec4f(fx.x, fy.x, fx.y, fy.y));
});

export const limitKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(limitLayout.$.faces);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const sp = simShared.$.sim;
  const p = d.vec2i(gid.xy);
  const own = std.textureLoad(limitLayout.$.faces, p, 0);
  let outflow = std.max(own.z, 0) + std.max(own.w, 0);
  if (gid.x > 0) {
    outflow = outflow + std.max(-std.textureLoad(limitLayout.$.faces, p.sub(d.vec2i(1, 0)), 0).z, 0);
  }
  if (gid.y > 0) {
    outflow = outflow + std.max(-std.textureLoad(limitLayout.$.faces, p.sub(d.vec2i(0, 1)), 0).w, 0);
  }
  const height = std.textureLoad(limitLayout.$.rest, p, 0).x + std.textureLoad(limitLayout.$.state, p, 0).z;
  let k = d.f32(1);
  if (outflow * sp.dt > 1e-12) {
    k = std.min(1, std.max(height, 0) / (outflow * sp.dt));
  }
  std.textureStore(limitLayout.$.limitOut, gid.xy, d.vec4f(k, 0, 0, 0));
});

export const applyKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(applyLayout.$.faces);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const sp = simShared.$.sim;
  const p = d.vec2i(gid.xy);
  const own = std.textureLoad(applyLayout.$.faces, p, 0);
  const k0 = std.textureLoad(applyLayout.$.limit, p, 0).x;

  // Own faces: scale by the limiter of whichever cell the flux leaves.
  let qx = d.f32(0);
  let fx = d.f32(0);
  if (gid.x + 1 < dims.x) {
    const kn = std.textureLoad(applyLayout.$.limit, p.add(d.vec2i(1, 0)), 0).x;
    const s = std.select(kn, k0, own.z > 0);
    qx = own.x * s;
    fx = own.z * s;
  }
  let qy = d.f32(0);
  let fy = d.f32(0);
  if (gid.y + 1 < dims.y) {
    const kn = std.textureLoad(applyLayout.$.limit, p.add(d.vec2i(0, 1)), 0).x;
    const s = std.select(kn, k0, own.w > 0);
    qy = own.y * s;
    fy = own.w * s;
  }

  // Faces owned by the left/top neighbours.
  let inflow = d.f32(0);
  if (gid.x > 0) {
    const n = p.sub(d.vec2i(1, 0));
    const f = std.textureLoad(applyLayout.$.faces, n, 0).z;
    const kn = std.textureLoad(applyLayout.$.limit, n, 0).x;
    inflow = inflow + f * std.select(k0, kn, f > 0);
  }
  if (gid.y > 0) {
    const n = p.sub(d.vec2i(0, 1));
    const f = std.textureLoad(applyLayout.$.faces, n, 0).w;
    const kn = std.textureLoad(applyLayout.$.limit, n, 0).x;
    inflow = inflow + f * std.select(k0, kn, f > 0);
  }

  const s = std.textureLoad(applyLayout.$.state, p, 0);
  const m = s.z + sp.dt * (inflow - fx - fy);
  std.textureStore(applyLayout.$.stateOut, gid.xy, d.vec4f(s.x, s.y, m, s.w));
  std.textureStore(applyLayout.$.fluxOut, gid.xy, d.vec4f(qx, qy, 0, 0));
});

const displacement = (p: d.v2i, dims: d.v2u) => {
  'use gpu';
  const s = std.textureLoad(packLayout.$.state, clampCell(p, dims), 0);
  return s.x + s.z;
};

export const packKernel = tgpu.computeFn({
  workgroupSize: [8, 8],
  in: { gid: d.builtin.globalInvocationId },
})(({ gid }) => {
  'use gpu';
  const dims = std.textureDimensions(packLayout.$.state);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  const inv = 1 / simShared.$.sim.cell;
  const p = d.vec2i(gid.xy);
  let u = displacement(p, dims);
  std.textureStore(packLayout.$.coverOut, gid.xy, d.vec4f(std.textureLoad(packLayout.$.rest, p, 0).x + u, 0, 0, 0));
  // A healed surface must be exactly pristine: sub-pixel ripples would wobble reflections ("orange peel").
  if (std.abs(u) < 0.02) {
    u = d.f32(0);
  }
  const ul = displacement(p.sub(d.vec2i(1, 0)), dims);
  const ur = displacement(p.add(d.vec2i(1, 0)), dims);
  const ut = displacement(p.sub(d.vec2i(0, 1)), dims);
  const ub = displacement(p.add(d.vec2i(0, 1)), dims);
  const gx = (ur - ul) * 0.5 * inv;
  const gy = (ub - ut) * 0.5 * inv;
  const lap = (ul + ur + ut + ub - 4 * u) * inv * inv;
  std.textureStore(packLayout.$.packOut, gid.xy, d.vec4f(u, gx, gy, lap));
});
