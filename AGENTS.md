# Working on gui.style

gui.style is a set of experiments in interface elements as physical objects: real materials, lit by the scene they
live in, placed in 3D space. The first is **Liquid Glass Goo**, a WebGPU button made of glassy putty (TypeGPU), with a
ray-traced 3D view of the scene behind the page (press C). The repo is public: github.com/overra/gui.style.

The direction is "Blender meets Figma": a browser-based 3D workspace for designing websites, with TypeGPU and
related tools powering rendering and simulation. The 3D view is the beginning of that authoring workspace.

Read these first:

- `README.md`: what it does, the putty physics, the glass, and a table of every source file.
- `docs/3d-config-view.md`: the scene model and its math, the 3D view, levitation, gravity and the material, the dev
  harness, limitations.
- `docs/roadmap.md`: what comes next, as milestones M0–M13, and the open questions (Q1–Q26) that are the user's to
  answer.

## Where things stand (2026-10-29)

- **Landed on `main`:**
  - the upright 3D view: world up is screen-up, and a drag grabs the scene and turns it about the goo;
  - the material model: adhesion, cohesion and surface tension hold the putty, `scene.gravity` (in g, down the page
    by default) pulls on it, and a settle layer finds a sag;
  - the roadmap;
  - M0, the harness safety net.
- **Landed on `main`:** M1's shared versioned scene document, edits by id, undo/redo, JSON
  import/export, browser persistence, named material records and world-space lights. See `docs/roadmap.md` for
  verification results. The compact text grammar and page-authoring choice (Q11) remain open.
- **Decided and implemented (2026-10-29):** lights live in the world (Q9). A new default rig is placed once after
  the first layout; imported positions are preserved. Moving pages, elements or the camera leaves lights in place.
- **Next after M1 is M2**, camera height and tall pages (see `docs/roadmap.md`). Don't settle remaining open
  questions silently: ask the user, or build the roadmap's proposal and say so.
- **Research for M1:** Brilliant's Blueprint suggests a shared design model edited visually and through text by
  agents. See the roadmap's research proposal; the text grammar and page-authoring choice (Q11) remain open.

## Commands

```bash
npm install
npm run dev          # Vite dev server; for a second server, `npx vite --port 5185 --strictPort`
npm run typecheck    # tsc --noEmit
npm test             # native Node document/material tests
npm run build        # typecheck + production build; must pass before a commit
```

Pure document and material behavior has a native Node test suite. GPU behavior is verified in the browser with
the dev harness (below).

## Code conventions

- **Match the surrounding code.** Its comments are plain sentences that say what and why, at about the same density;
  wrap comments at about 118 columns (code lines may run longer).
- **TGSL** (the `'use gpu'` functions that TypeGPU compiles to WGSL):
  - vector math through `.add()`, `.sub()`, `.mul()`, `.div()` and `std.*`;
  - `d.f32(…)` where a literal's type matters, and `std.select` for vector ternaries;
  - uniform structs keep 16-byte alignment, with explicit pad fields;
  - derivatives (`fwidth`, `dpdx`) only in uniform control flow: compute derivative terms for every pixel first,
    then sample with explicit LOD inside branches (see `sceneFragment` in `src/gpu/sceneShaders.ts`).
- **Frames.**
  - The world is the screen frame: x right, y down, z toward the viewer, in CSS px. The reference plane z = 0 is
    the screen, and the page plane sits at z = −depth.
  - World up is (0, −1, 0). The glass, its studio, the goo's frame and the levitation gap stay page-relative,
    with z as the page's axis.
  - Lights store world positions and emitter axes. Derive their appearance from the observation point; page,
    camera and goo transforms never reparent or reinitialize them.
  - Say "in front of the page", not "above it".
- **Normal mode** (the flat page plus the goo overlay) must not change unless that is the point. Check that
  `__goo.scene.identity()` is 0, and diff seeded frames before and after.

## Verifying in the browser

`window.__goo` exists in dev builds:

- **Stepping.** `drive(ms)` steps frames on a virtual clock and returns a canvas copy of the last one. `press(fx, fy)`
  returns an id for `move` and `release`; `show(frames, zoom)` lays frames out as a contact sheet; `realtime()` goes
  back to rAF; `relayout()` re-measures.
- **3D view.** `scene.enter()`, `scene.exit()`, `scene.config().dev` (poses, `setPose`, `project`, light angles),
  `scene.shot(ms)` and `scene.sheet(shots)`.
- **Putty.** `sag()` says what the material does under gravity, and `await readSim()` returns per-cell state
  (e, v, m, age, the settled shape `ms`). Also `eff()`, `snap()` and `resetClock(t)`.
- **M0.** `seed(n)`, then `resetClock()` and `snap()` or `drop()`, makes runs repeat exactly. `diff(a, b, rect)`
  compares two frames, `sim.stats()` reports volume and centroid, `glass()` returns the last glass uniforms, and
  `perf()` returns the `?perf` overlay's numbers.
- **M1.** `window.guiStyle.scene` in every build, or `__goo.scene` in dev: await `ready`, then `export()`,
  `load(docOrJson)`, `edit({ id, changes }, { expectedRevision })` (or a batch), `validate()`, `undo()` and `redo()`.
  The `revision`, `saved`, `storageError`, `canUndo` and `canRedo` properties report state. `reset()` restores the
  live defaults; `clearSaved()` removes browser persistence without changing the live scene. Accepted edits save
  under `gui.style.scene.v1`. Reset the scene before default parity checks so a saved edit cannot affect them.
- **URL parameters.**
  - test pages: `?art=flat|bars`, `?tall=N&at=M`;
  - overlays and panels: `?perf`, `?tune`, `?scene` (shows the 3D button);
  - scene setup: `?hover=40`, `?gravity=wall|floor|ceiling|off|x,y,z`;
  - `?hic=0` forces the CSS 3D fallback.

Pitfalls that have cost time:

- **Hidden or background tabs** run no rAF and get no ResizeObserver callbacks. Call `__goo.relayout()`, and use
  `scene.shot(ms)` to advance 3D flights. html-in-canvas (Chrome 157+) uploads the page UI only while the tab is
  visible.
- **Events dispatched on an element skip hit testing.** Check `document.elementFromPoint`, or use real input.
- **`drive()` runs far ahead of the GPU,** so async readbacks (the settle layer's) lag. Await about 40 ms between
  `drive(500)` chunks.
- **Comparing against an older commit:** check it out in its own `git worktree`, serve it on another port, and
  compare `readSim()` state quantized to 2⁻¹² px. Changed shaders round slightly differently, so bit-exact won't hold.
- **The pre-material putty** comes back with `?gravity=off` plus `__goo.params.plastic.pin = 0`, to within float
  rounding.

## Process

- Commit and push only when the user asks. Work on `main` unless told otherwise, and don't push other branches.
- Keep `README.md` and `docs/3d-config-view.md` in step with behaviour changes. Record what was measured, and mark
  estimates as such.
- Hosting will be Cloudflare Workers (not set up yet), with docs probably on useblume.dev.
