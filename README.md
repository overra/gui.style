# gui.style

Experiments in interface elements as physical objects: real materials, lit by the scene they live in, placed in 3D
space.

The direction is "Blender meets Figma": a browser-based 3D workspace for designing websites, with TypeGPU and
related tools powering the rendering and simulation. Pages, interface elements, materials, world lights and the
website's camera are parts of the scene you design. The 3D view is the beginning of that workspace.

The first one is **Liquid Glass Goo**, a WebGPU button made of glassy putty, built with [TypeGPU](https://typegpu.com)
and `@typegpu/sdf`.

The putty clings to the page. Adhesion holds its edge, cohesion (a yield stress and a memory of its molded shape)
holds its form, and surface tension rounds and smooths it. Gravity is a scene setting, down the page by default, and
the default putty holds against it. Press it and a fingertip dent sinks in, pushing material into a raised rim and
printing your fingerprint into the surface. Let go and it springs back with a little wobble, keeps the imprint for a
moment, then heals back into smooth, glossy glass. Drag through it and you plough a trough full of smeared ridges.

```bash
npm install
npm run dev
```

Open the printed URL in a browser with WebGPU (recent Chrome, Edge or Safari). Without WebGPU, or under forced
colors, you get a plain CSS glass button with the same semantics.

## Tweaking the goo

The **Tweak the goo** button (bottom right, or `?tune` in the URL) opens a live panel. Its four feel sliders run from
0 to 1, and 0.5 is the default tuning:

| Slider | 0 → 1 | What it drives |
|---|---|---|
| viscosity | thin and sloshy → thick and slow | flow damping and mobility, creep, how fast imprints heal, wobble damping, ridge leveling |
| elasticity | doughy → bouncy | spring stiffness and wobble speed, how much of a dent springs back instantly versus sets, yield |
| imprint | subtle → exaggerated | press depth, how long the imprint lingers, and a visual depth boost for the dent |
| fingerprint | none → exaggerated | ridge prominence (shading gain), how long the print lasts, smudge haze |

Presets (glass putty, jelly, honey, modeling clay, crime scene, slime on a wall) set them all at once. The collapsed
folders below them expose the base physics, fingerprint and glass values the sliders scale. Stability guards keep the
explicit solver within its limits at any setting.

The **Material** folder sets what holds the putty and what gravity pulls on, again 0 to 1 with 0.5 as the default:

| Slider | 0 → 1 | What it drives |
|---|---|---|
| adhesion | slips → sticks | how hard the contact line holds, and how strongly the bare page refuses to be wetted |
| cohesion | runny → holds | the yield stress |
| surface tension | wrinkly → smooth | capillary smoothing of the putty and of the printed ridges |
| density | light → heavy | the putty's weight per g of gravity |

Below it, "under gravity" says what the putty does: it holds, weeps at its edge, or sags until its yield holds it.

The **Gravity** folder sets the scene's gravity: a direction (down the page, into it like a floor, out of it like a
ceiling, or weightless), a strength in g, and its angles along and into the page. `?gravity=floor` (or `wall`,
`ceiling`, `off`, or `x,y,z` in g) sets it from the URL.

The **Levitation** folder lifts the button off the page: a hover distance (0 by default, or `?hover=40` in the URL),
plus the press travel, stiffness, damping and tilt of the air cushion it floats on. A press then pushes the whole
button toward the page and tilts it toward the finger, and it springs back. See `docs/3d-config-view.md`.

## Interaction

- **Press / hold**: the finger sinks in over ~50 ms; holding longer sinks a little deeper and sets a deeper imprint.
- **Drag**: the fingertip ploughs a trough; fast swipes skim instead of digging.
- **Multi-touch**: up to 8 contacts.
- **Keyboard**: Enter or Space presses the middle of the button while held. Screen-reader and voice-control
  activations get a press too.
- It is a real `<button>`: clicks, focus, keyboard and accessible name are native. Dragging the mouse through the
  goo counts as play, not a click.

## The 3D view

Press **C** (or the **3D scene** button, shown in dev and with `?scene` or `?tune`) to step out of the page. The view
flies to a 3/4 view of the scene: the camera and its frustum, the page as a plane behind the screen, the light rig,
two probe balls, the goo and an arrow for gravity. The page stands upright like a screen on a wall, and the view
orbits around world up with a level horizon. From behind, the page shows its dark back.

- Drag to orbit: the scene turns the way you drag, about the goo. Right- or shift-drag to pan, scroll or pinch to
  zoom (shift+scroll is kept for scrolling down a tall page later).
- Drag a light or the page's blue depth handle, or press the goo from any angle.
- F, O and V fly to the goo, an overview and the camera. Esc or C goes back.

With html-in-canvas (Chrome 157 and later) the page UI is drawn into the scene as a texture; elsewhere a CSS 3D
transform carries the live DOM along. Design notes are in `docs/3d-config-view.md`; what comes next is in
`docs/roadmap.md`.

## The shared scene document

The editor and agents edit the same versioned scene document. It owns the camera, gravity, page art, goo element,
world lights and named materials. Version 1 supports the current single page, art layer and goo element, one sun
and up to three softboxes. The DOM still owns the page's content and semantics.

Lights have stable ids and world positions. A new default rig is placed once, after the first layout, around the
unlifted button; moving the page, changing the camera or hovering the button then leaves the lights in place.
Imported documents keep their saved world positions. The glass still samples each light from the goo center;
per-pixel positional lighting remains later work.

The 3D panel's **Scene document** folder exports and imports JSON and offers undo and redo. The same API is
available in every build as `window.guiStyle.scene`, and in development as `__goo.scene`:

```js
const scene = window.guiStyle.scene;
await scene.ready;                         // initial layout and default light placement
const before = scene.export();             // independent object; JSON.stringify it to save a file
scene.edit({ id: 'goo', changes: { hover: 40 } }, { expectedRevision: scene.revision });
scene.edit([
  { id: 'sun', changes: { position: [-300, -500, 900] } },
  { id: 'glass-putty', changes: { params: { feel: { viscosity: 0.7 } } } },
]);                                        // one validated edit and undo step
scene.undo();
scene.redo();
scene.load(before);                         // also accepts a JSON string
scene.validate(before);                     // [] when valid; otherwise path/message issues
```

Accepted edits save automatically in this browser under `gui.style.scene.v1` and restore on reload. `save()`
retries saving; `saved` and `storageError` report the result. `clearSaved()` removes the saved copy while keeping
the live scene; `reset()` restores the current layout's default scene. Unknown fields, unsupported versions and
invalid references are rejected before the live scene changes. There is no older shipped format to migrate.

Materials carry their own physics parameters and light/dark optics. Elements reference them by id, and both
panels edit the active material. Changes to its shape or simulation grid rebuild the affected resources and
reset transient simulation state; dents, fingerprints and GPU buffers are not part of the document.

## How it works

The page background is a 2D canvas. The goo is drawn by a separate, transparent WebGPU canvas that overlays the
button plus a margin. The same page pixels are uploaded as a texture so the glass refracts exactly what is behind it.
The button label is a separate mask printed on the page, so it is only ever seen through the glass.

**Resting shape.** Each goo element is a rounded box from `sdRoundedBox2d`. Its signed distance drives a height
profile `H0 (1 − (1 − t)³)^(1/2)`: a steep, non-wetting putty wall that joins a flat top. This is its molded
shape, the one it remembers.

**Putty physics** (`src/gpu/simKernels.ts`, 3 CSS px cells, 480 Hz fixed substeps). There are two layers:

- **Elastic layer.** A damped membrane on a spring foundation. It gives the instant spring-back and the ~7 Hz wobble.
- **Plastic layer.** A volume-conserving viscoplastic flow with a yield stress (cohesion), using signed face fluxes,
  inertia and an outflow limiter. Shape memory and surface tension act as a pressure head; the bare page around the
  putty refuses to be wetted, and the contact line holds a small head before it creeps (adhesion). Gravity adds its
  weight into the base and a drop along it. Material pushed out from under the finger piles into a rim. Below the
  yield head the putty holds its shape, so the imprint lingers.
- **Settling.** When the material can't hold its molded shape under gravity (heavy enough, or weak enough), a second,
  finger-free copy of the plastic layer finds the shape the yield arrests it in: a sag. The live putty heals back to
  that shape. A sag that would thin its top away is held there, since drips don't exist yet.
- **Self-healing.** Cells near a pressing finger keep their imprint. Everywhere else the plastic layer eases back to
  its resting shape (molded, or sagged) after a short hold.
- **Intro.** On load the goo lands on the page as a taller, narrower blob of equal volume, slumps as a liquid, and
  then sets into putty.

**Fingerprints** (`src/gpu/detailKernels.ts`, 0.5 CSS px texels).

- While a finger presses, a procedural fingerprint is stamped into a detail layer, along with its exact gradient. The
  pattern is a loop or whorl with noise wobble and minutiae.
- Every frame the layer fades and is smoothed with a biharmonic stencil. That flattens the sharp crests and fine
  ridges first, like capillary leveling, so the print softens before it disappears.

**Glass** (`src/gpu/renderShader.ts`). The surface is the analytic rest profile, plus the simulated displacement
(bicubic B-spline sampled), plus the fingerprint detail. It is shaded in linear light with:

- refraction of the page with per-channel IOR (dispersion), plus a small apparent-depth lens term;
- Schlick Fresnel reflection of a procedural studio: sky, a horizon ring and three softboxes, seen from a perspective
  eye so flat glass shows a sheen;
- a GGX sun glint with specular anti-aliasing;
- Beer–Lambert body tint and vibrancy;
- light on the page below: soft shadow, contact occlusion and caustics, evaluated where the refracted ray lands.

The output is premultiplied, so outside the goo only the shadow is drawn.

Everything is recorded into one command encoder per frame (plus a small readback every 30 frames while a sag
settles). The loop sleeps once the goo has healed and snaps back to the exact resting state, so an idle page costs
nothing.

## Files

| File | What it does |
|---|---|
| `src/main.ts` | Bootstrap, device bring-up and loss recovery, frame loop and sleep, dev harness |
| `src/harness.ts` | The dev harness's seeded generator, frame diffs and simulation statistics |
| `src/perf.ts`, `src/gpu/timing.ts` | The `?perf` overlay (loaded on demand); GPU timestamps around each renderer's passes |
| `src/input.ts`, `src/touches.ts` | Pointer, keyboard and assistive-tech input; fingertip contacts |
| `src/layout.ts` | Goo-space geometry; CPU copy of the SDF |
| `src/background.ts` | Page art and the label mask |
| `src/params.ts`, `src/materials.ts`, `src/look.ts` | Physics defaults; named material data and light/dark optics; environment and light defaults |
| `src/gpu/goo.ts` | Textures, bind groups, uniforms, per-frame encoding |
| `src/gpu/simKernels.ts` | Putty simulation |
| `src/gpu/detailKernels.ts` | Fingerprint layer |
| `src/gpu/renderShader.ts` | Liquid-glass shading |
| `src/levitation.ts` | The floating button's rigid-body motion (air-cushion spring) |
| `src/scene/scene.ts`, `src/scene/math.ts` | Scene model (camera, page plane, lights, the goo's frame); vector helpers |
| `src/scene/document.ts` | Versioned document, validation, edits by id, history and browser persistence |
| `src/scene/host.ts` | Feeds the scene to the glass in normal mode; loads the 3D view on demand |
| `src/scene/configMode.ts`, `src/scene/htmlInCanvas.ts` | The 3D view: orbit camera, gizmos, panel, picking; page UI via html-in-canvas |
| `src/gpu/sceneView.ts`, `src/gpu/sceneShaders.ts` | Ray-traces the 3D view |
| `src/tuning.ts`, `src/materialPanel.ts` | `?tune` panel (lil-gui, loaded on demand); the Material and Gravity folders both panels share |
| `src/feel.ts` | The feel and material macros, and the solver's stability guards |

## Dev harness

In `npm run dev`, `window.__goo` steps the simulation on a virtual clock. That keeps it deterministic, and it works
even in a background tab:

```js
const id = __goo.press(0.4, 0.5);   // synthetic touch at a fraction of the button box
const held = __goo.drive(450);      // run 450 ms of frames; returns a copy of the last one
__goo.release(id);
const after = __goo.drive(300);
__goo.show([held, after], 3);       // magnified contact sheet
__goo.realtime();                   // back to requestAnimationFrame

__goo.sag();                        // what the material does under gravity: regime, sag numbers, settle phase
await __goo.readSim();              // per-cell copies of the simulation state (e, v, m, age, settled shape ms)

__goo.seed(1); __goo.resetClock(); __goo.snap();   // runs that repeat: the same inputs then give the same frames
__goo.diff(held, after);            // { mean, max, over1 } in 8-bit units between two frame copies
await __goo.sim.stats();            // the putty's volume, its centroid and the range of m
__goo.glass();                      // the glass uniforms the last frame wrote
```

Test pages, in any build: `?art=flat` or `?art=bars` swaps the page art for a solid colour or black and white
bars, and `?tall=N&at=M` makes the page N px taller than the window, with M px of that above the content. `?perf`
shows an overlay with the frame interval, JavaScript and GPU times (where the GPU has timestamp queries) and
resident memory.

Vector math in shader code uses `.add()` / `.mul()` / `std.*` rather than operators, because operator overloading
needs the `tsover` TypeScript fork.
