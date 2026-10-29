// The ?perf overlay, in every build (phones included): the frame interval, the frame loop's CPU time, GPU time per
// renderer from timestamp queries (where the adapter has them) and resident memory. It loads on demand and redraws
// twice a second from a timer, never from a frame of its own, so an idle page stays idle.

import { setPassTimer, type PassTimer, type PassTimestamps } from './gpu/timing.ts';

/** Seconds of samples behind each figure. */
const WINDOW_S = 2;
/** A gap longer than this between frames is the loop sleeping, not a slow frame (ms). */
const GAP_MS = 250;
/** Swap-chain textures counted per WebGPU canvas (an estimate: the browser doesn't say). */
const SWAP_TEXTURES = 2;

const BYTES_PER_TEXEL: Record<string, number> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  r16float: 2,
  rg16float: 4,
  rgba16float: 8,
  r32float: 4,
  rg32float: 8,
  rgba32float: 16,
  r32uint: 4,
  rg32uint: 8,
  rgba32uint: 16,
  depth16unorm: 2,
  depth24plus: 4,
  depth32float: 4,
  'depth24plus-stencil8': 4,
};

function textureBytes(desc: GPUTextureDescriptor): number {
  const s = desc.size;
  const [w, h = 1, d = 1] = Symbol.iterator in s ? [...(s as Iterable<number>)] : [s.width, s.height, s.depthOrArrayLayers];
  const texel = (BYTES_PER_TEXEL[desc.format] ?? 4) * (desc.sampleCount ?? 1);
  let bytes = 0;
  for (let l = 0; l < (desc.mipLevelCount ?? 1); l++) {
    bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * (desc.dimension === '3d' ? Math.max(1, d >> l) : d) * texel;
  }
  return bytes;
}

/** Counts the bytes of every texture and buffer the device creates, until they are destroyed or collected. */
function trackMemory(device: GPUDevice) {
  const live = { textures: 0, buffers: 0 };
  type Kind = keyof typeof live;
  const collected = new FinalizationRegistry<{ kind: Kind; bytes: number }>(({ kind, bytes }) => (live[kind] -= bytes));
  const track = <T extends GPUTexture | GPUBuffer>(resource: T, kind: Kind, bytes: number): T => {
    live[kind] += bytes;
    const token = {};
    collected.register(resource, { kind, bytes }, token);
    const destroy = resource.destroy.bind(resource);
    let alive = true;
    resource.destroy = (() => {
      if (alive) {
        alive = false;
        live[kind] -= bytes;
        collected.unregister(token);
      }
      destroy();
    }) as T['destroy'];
    return resource;
  };
  const createTexture = device.createTexture.bind(device);
  const createBuffer = device.createBuffer.bind(device);
  device.createTexture = (desc) => track(createTexture(desc), 'textures', textureBytes(desc));
  device.createBuffer = (desc) => track(createBuffer(desc), 'buffers', desc.size);
  return live;
}

/** Two timestamps per renderer, resolved and read back each frame unless the last reading is still pending. */
function createPassTimer(device: GPUDevice, record: (name: string, ms: number) => void): PassTimer {
  const slots = new Map<string, { querySet: GPUQuerySet; resolved: GPUBuffer; readback: GPUBuffer; busy: boolean }>();
  return {
    span(name) {
      let slot = slots.get(name);
      if (!slot) {
        slot = {
          querySet: device.createQuerySet({ type: 'timestamp', count: 2 }),
          resolved: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          readback: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          busy: false,
        };
        slots.set(name, slot);
      }
      if (slot.busy) return null;
      const s = slot;
      s.busy = true;
      return {
        writes(first, last) {
          const w: PassTimestamps = { querySet: s.querySet };
          if (first) w.beginningOfPassWriteIndex = 0;
          if (last) w.endOfPassWriteIndex = 1;
          return w;
        },
        resolve(encoder) {
          encoder.resolveQuerySet(s.querySet, 0, 2, s.resolved, 0);
          encoder.copyBufferToBuffer(s.resolved, 0, s.readback, 0, 16);
        },
        collect() {
          s.readback
            .mapAsync(GPUMapMode.READ)
            .then(() => {
              const [t0, t1] = new BigUint64Array(s.readback.getMappedRange());
              s.readback.unmap();
              // A counter that reset or wrapped mid-frame gives nonsense: keep only plausible spans.
              if (t1 >= t0 && t1 - t0 < 1_000_000_000n) record(name, Number(t1 - t0) / 1e6);
            })
            .catch(() => {})
            .finally(() => (s.busy = false));
        },
      };
    },
  };
}

interface Sample {
  at: number;
  v: number;
}

/** Median and 95th percentile of the samples in the window (ms), or null without any. */
function summary(samples: Sample[]) {
  if (!samples.length) return null;
  const v = samples.map((s) => s.v).sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { median: at(0.5), p95: at(0.95), n: v.length };
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => bytes / MIB;
const fixed = (v: number | undefined, digits = 2) => (v === undefined ? '–' : v.toFixed(digits));

export function createPerf() {
  const intervals: Sample[] = [];
  const cpu: Sample[] = [];
  const gpu = new Map<string, Sample[]>();
  let timed = false;
  let memory: { textures: number; buffers: number } | null = null;
  let frames = 0;
  let lastMs: number | null = null;
  let lastFrameAt = -Infinity;
  let virtualClock = false;

  const prune = (samples: Sample[], now: number) => {
    while (samples.length && now - samples[0].at > WINDOW_S * 1000) samples.shift();
  };

  const canvasBytes = () => {
    let bytes = 0;
    for (const c of document.querySelectorAll<HTMLCanvasElement>('.goo-canvas, .scene-canvas')) bytes += c.width * c.height * 4 * SWAP_TEXTURES;
    const page = document.getElementById('page-bg') as HTMLCanvasElement | null;
    if (page) bytes += page.width * page.height * 4;
    return bytes;
  };
  const megapixels = (selector: string) => {
    const c = document.querySelector<HTMLCanvasElement>(selector);
    return c ? (c.width * c.height) / 1e6 : null;
  };

  function stats() {
    const now = performance.now();
    prune(intervals, now);
    prune(cpu, now);
    for (const s of gpu.values()) prune(s, now);
    const frame = summary(intervals);
    const canvases = canvasBytes();
    const js = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return {
      frames,
      idle: now - lastFrameAt > 500,
      /** Interval between drawn frames (rAF time, ms); none on the harness's virtual clock. */
      frame: frame && { ...frame, hz: 1000 / frame.median },
      /** The frame loop's JavaScript (ms). */
      cpu: summary(cpu),
      /** GPU time per renderer (ms), or null without the timestamp-query feature. */
      gpu: timed ? Object.fromEntries([...gpu].map(([name, s]) => [name, summary(s)])) : null,
      /** MiB: textures and buffers by size (tracked from the start), canvases estimated; JS heap where Chrome tells. */
      memory: memory && {
        gpu: mib(memory.textures + memory.buffers + canvases),
        textures: mib(memory.textures),
        buffers: mib(memory.buffers),
        canvases: mib(canvases),
        js: js === undefined ? null : mib(js),
      },
      megapixels: { goo: megapixels('.goo-canvas'), scene: megapixels('.scene-canvas'), dpr: window.devicePixelRatio },
    };
  }

  const overlay = document.createElement('pre');
  overlay.className = 'perf';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    'position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:1000;' +
    'margin:0;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,0.66);color:#fff;pointer-events:none;' +
    'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre';
  document.body.append(overlay);

  function draw() {
    const s = stats();
    const gpuLine = s.gpu
      ? Object.entries(s.gpu)
          .map(([name, g]) => `${name} ${fixed(g?.median)}`)
          .join(' · ') || 'waiting'
      : 'no timestamp queries';
    const m = s.memory;
    const px = s.megapixels;
    overlay.textContent = [
      `frame  ${s.idle ? 'idle' : virtualClock ? 'virtual clock' : s.frame ? `${fixed(s.frame.median)} ms  p95 ${fixed(s.frame.p95)}  ${fixed(s.frame.hz, 0)} Hz` : '–'}`,
      `cpu    ${s.cpu ? `${fixed(s.cpu.median)} ms  p95 ${fixed(s.cpu.p95)}` : '–'}`,
      `gpu    ${gpuLine}${s.gpu ? ' ms' : ''}`,
      `mem    ${m ? `GPU ${fixed(m.gpu, 1)} MiB (tex ${fixed(m.textures, 1)} · buf ${fixed(m.buffers, 1)} · canvas ${fixed(m.canvases, 1)})` : '–'}${m?.js != null ? `  JS ${fixed(m.js, 1)} MiB` : ''}`,
      `px     goo ${fixed(px.goo ?? undefined)} MP${px.scene != null ? ` · scene ${fixed(px.scene)} MP` : ''} · dpr ${fixed(px.dpr)}`,
      `frames ${s.frames}`,
    ].join('\n');
  }
  draw();
  setInterval(draw, 500);

  return {
    /** Optional device features this overlay uses, when the adapter has them. */
    features: ['timestamp-query'] as GPUFeatureName[],
    /** A new device: track its memory from the start, and time its passes if it can. */
    attach(device: GPUDevice) {
      memory = trackMemory(device);
      timed = device.features.has('timestamp-query');
      gpu.clear();
      setPassTimer(
        timed
          ? createPassTimer(device, (name, ms) => {
              const s = gpu.get(name) ?? [];
              s.push({ at: performance.now(), v: ms });
              gpu.set(name, s);
            })
          : null,
      );
    },
    /** Called at the end of every frame: its rAF time (ms), the CPU time it took, and how the loop runs. */
    frame(ms: number, cpuMs: number, virtual: boolean, sleeping: boolean) {
      const now = performance.now();
      frames++;
      lastFrameAt = now;
      virtualClock = virtual;
      cpu.push({ at: now, v: cpuMs });
      if (!virtual && lastMs !== null && ms - lastMs < GAP_MS) intervals.push({ at: now, v: ms - lastMs });
      lastMs = virtual || sleeping ? null : ms;
    },
    stats,
  };
}

export type Perf = ReturnType<typeof createPerf>;
