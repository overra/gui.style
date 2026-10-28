# 3D scene and config view (prototype)

The flat page now has a scene behind it: a camera, the page as a background plane, the goo on a reference plane
in between, and a rig of lights. Normal mode still draws the flat page plus the goo overlay, and it looks exactly
as before. The scene reaches it only through the glass uniforms.

Config mode detaches the view from the camera. The view flies to a 3/4 orbit and shows the whole scene:

- the page plane;
- the camera's frustum and viewport rectangle;
- the goo, ray-traced as real liquid glass;
- light emitters with gizmos;
- grey and chrome probe balls.

You can orbit, move lights, push the page back and press the goo from any angle. Leaving the mode flies back
into the camera and cross-fades to the flat page.

**Try it:** `npm run dev`, then press **C**, or use the "3D scene" button at the bottom left. The button shows in
dev, or with `?scene` or `?tune`. **Esc** or **C** returns to the page.

**Direction (from the user, 2026-10-28).**

- UI elements can live anywhere in 3D space, not only on the reference plane.
- A next experiment: a liquid glass button that levitates some distance in front of the backdrop. Pressing it would
  displace the whole button in 3D, as well as squishing it.
- This 3D config interface is going to become a bigger part of the project.

The groundwork is already in place for the levitating button. The glass is ray-traced in 3D with a real air gap
under it (refraction, displaced shadow), so a button raised off the page is the "page depth" case seen from the
other side. What it still needs is a goo object with its own transform (position and depth), rather than goo fixed
to the reference plane. See next step 6.

In config mode:

- drag to orbit; right-drag or shift-drag to pan; scroll or pinch to zoom;
- drag a light (its dot or its panel) to move it; hold Alt to change only its distance;
- drag the blue handle on the page's near edge to push the page back;
- press the goo to dent it;
- **F** focuses the goo, **O** shows the overview, **V** looks through the camera;
- `?hic=0` forces the CSS 3D fallback even where html-in-canvas exists.

## What was built

| File | What it does |
|---|---|
| `src/scene/scene.ts` | The scene model: camera, page plane, light rig. Derives the glass uniforms from it, plus the page-depth terms. |
| `src/scene/math.ts` | Vectors, the orbit camera, projection, rays, and the CSS `matrix3d` that matches the WebGPU projection. |
| `src/scene/host.ts` | Always loaded and small. Installs the glass hook, toggles config mode (C key / button), adds `__goo.scene`. |
| `src/scene/configMode.ts` | Config mode (lazy chunk): flights, orbit/pan/zoom, picking and dragging, labels, the lil-gui panel. |
| `src/scene/htmlInCanvas.ts` | html-in-canvas feature detection, and the UI plane (live `.stage` DOM → WebGPU texture). |
| `src/scene/scene.css` | Config-mode styles (inert otherwise). |
| `src/gpu/sceneShaders.ts` | The ray-traced scene pass and the gizmo line and dot shaders. |
| `src/gpu/sceneView.ts` | The full-viewport renderer. It shares the goo's device, simulation textures, page and label. |

The existing files changed in small, additive ways, to keep a merge with `main` easy:

- `gpu/goo.ts`:
  - `writeGlass` builds its values object, then writes `glassHook ? glassHook(values) : values`;
  - adds `setGlassHook()`;
  - adds `sceneResources()`, plus a version counter for re-bound textures.
- `gpu/renderShader.ts`: one `export { … }` block at the end (`surfaceAt`, `env`, `groundLight`, `pageTap`, …), so
  the 3D view shades the same glass. No existing line changed.
- `main.ts`:
  - creates the host and calls `attach`/`detach` around device bring-up and loss;
  - calls `sceneHost.frame(now)` after `goo.frame`;
  - keeps the loop awake while the 3D view animates;
  - skips `relayout`/`track` while the 3D view owns the page UI;
  - exposes `__goo.scene`.
- `.claude/launch.json`: a `goo-3d` server on port 5181.

### Architecture: a second, full-viewport canvas, only in config mode

The goo canvas covers only the button plus `--goo-m`, and its size, pixel budget and goo-space coordinates are what
the simulation grid is built on. Config mode needs the whole viewport. It shows the page, the frustum, lights
outside the page and probes beside it.

A second WebGPU canvas (`.scene-canvas`) is created the first time the mode opens. It shares the goo's `GPUDevice`
and textures and renders after the goo's frame in the same rAF tick. Making the goo canvas full-viewport instead
would change normal mode (a sim domain tied to the viewport, every pixel shaded, the pixel budget broken) and buy
nothing there.

Normal mode never creates the scene canvas or loads its code (a 63 KB lazy chunk with lil-gui shared). The scene
canvas is capped at about 3.2 MP of device pixels. On the M-series GPU this was tested on, orbiting with the
html-in-canvas UI ran at the display's 120 Hz (median 8.3 ms frames).

The 3D view is a ray tracer, not a mesh renderer. The goo is a height field, and the page, probes and emitters are
analytic. So one full-screen pass can reuse the flat shader's surface (`surfaceAt`: analytic rest profile, B-spline
simulation, fingerprint detail) and its glass terms unchanged. Only the view ray is generalized.

## Scene model and math

**Frames.** The world frame is the flat shader's screen frame: x right, y down, z toward the viewer, in CSS px. The
origin is the viewport center on the **reference plane** z = 0, which is where the goo sits. A viewport point
(px, py) is the world point (px − W/2, py − H/2, 0).

**Camera.** The camera sits at (0, 0, D), looks along −z, and its screen-up is −y. D is the reference distance and
defaults to look.ts's `eyeDist` = 1400. The vertical FOV follows the viewport, so the frustum cut at distance D is
exactly the viewport:

```text
tan(fov/2) = (H/2) / D        tanX = tan(fov/2) · W/H
```

A world point p projects to view space:

```text
x_v = right·(p − eye)    y_v = up·(p − eye)    z_v = fwd·(p − eye)
```

and then to the screen:

```text
sx = W/2 + (W/2) · x_v / (z_v · tanX)
sy = H/2 − (H/2) · y_v / (z_v · tanY)
```

At z = 0 this is the identity, (x, y) ↔ (x + W/2, y + H/2). D is held when the window resizes, as `eyeDist`
always was, and the FOV follows. The panel edits the FOV through `D = (H/2) / tan(fov/2)`. Changing it does not
move anything on the reference plane, but it does change perspective: the reflection eye and the parallax of a
pushed-back page.

**The page plane** sits at z = −g. At that depth the frustum's half-extents are

```text
(D + g) · tan(fov/2) · (W/H, 1) = (W/2, H/2) · (D + g)/D
```

There are two modes:

- **Fill** (default): the plane is scaled by `s = (D + g)/D`. Its corners then lie exactly on the frustum's edges
  (the config view draws the extension lines to show it), and from the camera it looks unchanged. A page point
  (u, v) in page CSS px sits at world `((u − W/2)·s, (v − H/2)·s, −g)`.
- **Fixed size**: s = 1. The camera sees the plane shrunk by `k = D/(D + g)` about the viewport center. Only the
  config view draws it that way. Normal mode keeps the page filling the view (with the same depth terms), because
  `main` maps the glass through `#page-bg`'s own box, and scaling that box would move what it measures.

  To show it in normal mode, an overlay canvas could draw the page art scaled by k. The glass would then remap its
  screen → page lookup with `viewport' = k·V` and `canvasOrigin' = canvasOrigin − (V/2)(1 − k)`, which leaves the
  reflection eye `V/2 − canvasOrigin` unchanged.

"Viewport" here means the page canvas box (`Layout.viewportW/H`), which is the window when the page doesn't
scroll. The 3D view assumes the two coincide.

**Through the glass to a pushed-back page.** The config view traces it exactly:

1. Snell into the curved top.
2. Straight down to the flat bottom. look.ts's apparent-depth standoff is kept, and so is the softer lensing of the
   liquid intro blob.
3. Snell out into the air.
4. Across the gap g to the page.

Each channel does this with its own IOR. The landing point on the page plane maps to page px through `s`.

Normal mode can't trace the gap, so it folds it into the existing uniforms. A ray deviated in the gap moves about
`iorG` times as far as in glass (paraxial approximation), and the camera sees the page foreshortened by k, so:

- `depthLens += iorG · g · D/(D + g)`;
- shadow blur grows and its opacity fades;
- contact occlusion and caustics fade out (their model assumes the page touches the glass).

At 600 px depth the flat approximation and the ray trace look nearly the same (compare `__goo.drive` with
`__goo.scene.shot` at the camera pose).

**Shadows on a pushed-back page.** A page point p receives the key light through the reference plane at
`p.xy + L.xy / L.z · g`, so the existing `groundLight` is evaluated there.

**Orbit camera.** The orbit pose is (pivot, polar θ, azimuth φ, distance, fov). The camera basis is
`Rz(φ)·Rx(θ)` applied to the scene camera's basis (right (1,0,0), up (0,−1,0), back (0,0,1)). At θ = φ = 0 with
pivot 0 and distance D, it is exactly the scene camera. Tilting it moves the eye toward the page's bottom edge and
turns screen-up toward +z, so the page reads as a floor.

At θ = 0, azimuth is a roll. So the flight holds the azimuth until the view has tilted on the way out, and finishes
it before the view flattens on the way back. Distance blends geometrically.

**The live DOM in 3D (CSS fallback).** `cssMatrixForPlane()` builds a `matrix3d` (with `transform-origin: 0 0`)
whose rows are, in order:

- screen x·w;
- screen y·w;
- a pass-through z (CSS refuses non-invertible matrices);
- w = view depth.

Each comes from the same projection as the shaders, so the transformed `.stage` lands on the reference plane pixel
for pixel.

**Matching the flat page at the camera pose.** Light emitters, gizmos, labels and the studio backdrop fade in
with the tilt (`overlay`, 0 → 1 between 0.5° and 12° polar). Lights are invisible to camera rays, as in a studio
render; reflections still see them. Only HDR content (glass, emitters, probes) goes through the flat shader's
highlight shoulder, never the page.

Measured over the goo canvas region, the first 3D frame differs from normal mode by 0.93/255 on average. The rest
is the glass silhouette rim: perspective vs orthographic refraction and per-pixel coverage. The 0.2 s cross-fade
hides it.

## Lights and materials

The rig hangs on the goo. Each light stores the direction from the goo center toward it (look.ts's vector,
verbatim), a distance, and angular sizes that hold at a reference distance (`RIG_DISTANCE` = 1100). Lights keep
their physical size, so moving one away shrinks its reflection.

The default rig is built from look.ts at runtime, for both themes:

- **Sun (key)**: `lightDir`, `lightColor` (an irradiance at normal incidence) and `sunRadius` (angular). Its
  physical radius is `sunRadius · 1100`.
- **Three softboxes**: centered on `c` with frame `t`/`b`. Physical half-extents are `halfSize · 1100`. Radiance
  is per theme, and `round` and `soft` scale with distance.

Moving a light re-aims it with look.ts's frame convention: the long axis stays horizontal, and the light is kept
between 1° and 85° from overhead.

**Identity check.** `__goo.scene.identity()` compares the scene-derived light uniforms with look.ts as float32: the
difference is 0 in both themes. At rest, frames with the hook on and off differ by at most 1 LSB on about 0.15% of
the values, which is less than two consecutive frames with the hook off differ (0.28%).

| Material | How it uses the lights |
|---|---|
| Liquid glass (both modes) | As distant lights seen from the goo center, through the existing uniforms. The sun drives the GGX highlight (lobe width = its angular radius), the edge-glint lobe, the horizon ring's bright azimuth, the shadow and caustic direction, and the shadow reach (scaled by tan of its elevation). The softboxes are the studio's rounded-rect emitters in reflections, at direction `c`, frame `t`/`b`, angular size = physical / distance. The sky and horizon ring stay look.ts environment terms. Eye distance = camera D. |
| Page plane (both modes) | Self-lit art, as today, times `groundLight` from the key light: soft shadow, contact occlusion and caustics. In the config view it is evaluated where the key light crosses the reference plane, so a pushed-back page shows a displaced, blurred shadow. |
| Page as paper (config view, "lit by scene") | `art × mix(1, E / E_ref, lit)`. E is the irradiance from all lights: the sun as `E·cos`, each softbox as a small area light `L·A·cosθ_l·cosθ_r / r²`, plus sky ambient. E_ref is what the default rig delivers at the goo, so paper starts as bright as the screen and shows pools of light as lights move. Also applied to what the glass transmits and to the UI plane. |
| Grey probe (config view) | Lambert with the same E plus sky ambient (albedo 0.45). |
| Chrome probe (config view) | A mirror that ray-traces the emitters (softbox fronts at their radiance, the sun at `E / (π α²)`), the page plane, and the backdrop. |
| Emitters (config view) | Softbox fronts show their radiance and their backs are dark panels. The sun is a glowing sphere. All fade out toward the camera pose. |

## html-in-canvas

**Status.** These facts come from the WICG explainer, Chromium sources and chromestatus. I did not check every one
of them against the specs myself.

- It ships on by default in **Chrome 157**. The flag was `chrome://flags/#canvas-draw-element`
  (`--enable-blink-features=CanvasDrawElement`); Chrome 154–156 also needed experimental web platform features.
- There was an origin trial, "HTMLInCanvas", from M148 to M160, and an Intent to Ship was approved on 2026-09-30.
- WebKit leans toward support; Mozilla has no position yet.
- Sources: [explainer](https://github.com/WICG/html-in-canvas),
  [chromestatus](https://chromestatus.com/feature/5172548013916160),
  [Chrome's change log for the trial](https://developer.chrome.com/blog/html-in-canvas-ot-changes).

**Verified in Chrome 158 on this machine** (by probing the page; the in-app preview browser, Chromium 152, has none
of it):

- **Opt-in markup.** `<canvas content="drawable">` (reflected as `canvas.content`). Every element you draw needs a
  `drawable` attribute. Without these, the calls throw `InvalidStateError`. The old opt-in attribute,
  `layoutsubtree`, is no longer accepted.
- **Layout.** Children are laid out at the canvas's position, but the browser no longer paints them. They
  shrink-wrap rather than stretching to the canvas width.
- **2D canvas.** `ctx.drawElementImage(el, x, y)` draws the element and returns `undefined`.
  `OffscreenCanvasRenderingContext2D` has the method too.
- **WebGL.** `gl.texElementSubImage2D` exists. I didn't exercise it.
- **WebGPU.** `device.queue.drawElementImageToTexture({ source }, { texture })`. Note that the source is a
  dictionary: passing the bare element throws a `TypeError`. The source can be the element or an `ElementImage`.

  It rasterizes the element at the canvas's grid resolution onto a transparent background. Both `rgba8unorm` and
  `rgba8unorm-srgb` destinations worked.
- **Canvas methods.**
  - `requestPaint()`
  - `captureElementImage(el)` → `ElementImage` (only `close()`)
  - `getElementImageDefaultSize(el)` → `{width, height}` in canvas-grid px (CSS size × grid scale)
  - `getElementTransform(el)` → `DOMMatrix` (the transform the element was last drawn with)
  - `updateElementGeometry`, `clearElementGeometry` and an `onelementgeometryupdate` handler
- **The `paint` event** fires with `CanvasPaintEvent.changedElements`.

**Per the explainer and Chromium sources** (from the research pass, not re-checked here):

- **Hit testing.** `updateElementGeometry(el, {canvasTransform, canvasClip})` places the hit-test geometry for
  elements drawn by 3D contexts. They aren't hit-testable until it's set; the 2D path sets it automatically.
- **Workers.** `ElementImage` is transferable, and workers only ever receive `ElementImage`s.
- **WebGPU destinations** need `COPY_DST | RENDER_ATTACHMENT` usage.
- **Paint timing.** `paint` fires at most once per rendering update, after Paint, and only if something changed.
  Drawing every frame is allowed, but it reuses the latest snapshot.
- **Not painted:** cross-origin content, visited-link state, system colors, spelling markers, autofill previews and
  subpixel anti-aliasing.
- **Older names.** They changed often before shipping: `placeElement` → `drawElement` → `drawHTMLElement` →
  `drawElementImage`; `copyElementImageToTexture` → `drawElementImageToTexture`; `texElementImage2D` →
  `texElementSubImage2D`; `layoutsubtree` → `content="drawable"`. Old posts use the old names. `htmlInCanvas.ts`
  detects only the shipped shape and falls back otherwise.

**What the prototype does with it.** On entering config mode, `.stage` (the heading, the button and the status
line) moves into a full-viewport `<canvas content="drawable">`.

1. Its width is pinned: children of a drawable canvas shrink-wrap, so without this the UI reflows.
2. On every `paint` event, `drawElementImageToTexture` copies it into a mipmapped texture.
3. The scene pass draws that texture on the reference plane with correct depth, lit like paper when "lit by
   scene" is on.

Leaving the mode puts `.stage` back exactly where it was.

Where html-in-canvas is missing (the in-app browser, Safari, Firefox), or with `?hic=0`, the same live DOM is
carried by the CSS `matrix3d` above instead. It is pixel-aligned, but it draws above the WebGPU canvas without
depth sorting.

**How it would replace the 2D page art and put real UI in the scene:**

1. **Keep `.stage` permanently inside a drawable canvas,** and draw it each `paint` into the page canvas with
   `drawElementImage` over the painted art, or straight into the page texture. Then the glass refracts the real
   heading and button text, not just the art. The label mask (`paintLabel`) can come from the real button.

   This needs the goo canvas moved out of `.stage`: drawn into the page, it would refract itself. It needs the goo
   canvas positioned from layout instead. And it needs the 2D path's automatic hit-test geometry, or explicit
   `updateElementGeometry` calls.
2. **In 3D, each UI element could be its own textured quad,** at any depth, and lit by the scene. With
   `updateElementGeometry` it stays hit-testable where it is drawn. Affine placements are clearly supported.
   Whether `canvasTransform` accepts a perspective `DOMMatrix` is **unconfirmed**. Refraction can never be
   expressed as a matrix, so clicks *through* the glass need our own picking: we already map rays to goo space.
3. **Accessibility and focus stay native** because the DOM is real. The snapshot includes focus rings and carets.

## Dev harness additions

```js
__goo.scene.identity()            // 0 → the scene-derived light uniforms equal look.ts's (as f32)
__goo.scene.hook(false)           // detach the scene from the glass to A/B normal mode
await __goo.scene.enter()         // fly into the 3D view; __goo.scene.exit() flies back
const shot = __goo.scene.shot(300) // run 300 ms of frames on the virtual clock; copy of the scene canvas
__goo.scene.sheet([shot], 480)    // lay scene shots out over the page ([] clears)
__goo.scene.scene.page.depth = 600; __goo.scene.changed()   // edit the scene by hand
__goo.scene.config().dev.setPose({ polar: 60, azimuth: 30 }) // also flyTo, focusPose(), overviewPose(), cameraPose()
```

## Limitations

- **Distant lights only.** The glass sees every light from the goo center: no per-pixel parallax, no positional
  falloff across the goo. Lights are parented to the goo, not anchored in the world. The glass takes exactly one
  sun and three softboxes (the `GlassParams` layout).
- **Paper lighting is config-view only.** In normal mode the page stays self-lit.
- **The flat approximation clips shadows.** For a pushed-back page, normal mode approximates the gap paraxially,
  and the goo canvas only reaches `--goo-m` past the button, so a displaced shadow is clipped. The config view
  traces it exactly.
- **The camera is locked frontal.** Only its distance (FOV) is editable. An off-axis camera would mean drawing
  normal mode through the 3D path.
- **Fixed-size page is 3D only.** An unscaled ("fixed") page pushed back is only drawn smaller in the config view.
  Normal mode shows it filling the view.
- **The page must fit the window.** The 3D view assumes the page canvas box is the window (no scrolled page, no
  mobile toolbar offset).
- **No live layout in config mode.** Layout measurement is held while the 3D view owns the page UI. A window
  resize applies on exit.
- **CSS 3D fallback has no depth sorting.** It draws the DOM above the WebGPU canvas, so gizmos and the goo can't
  occlude it.
- **The html-in-canvas path has rough edges:**
  - the UI vanishes for a frame or two while it moves into the drawable canvas;
  - the UI isn't hit-testable in 3D (no `updateElementGeometry` yet);
  - the glass doesn't refract the UI texture.
- **3D silhouettes alias slightly.** They're per-pixel (no coverage AA) and differ by a 1-px rim from normal
  mode's analytic edge at the camera pose.
- **The scene isn't persisted.** It resets on reload.
- **Touch is partial.** Pinch zooms, but two-finger pan is missing.

## Next steps and open questions

1. **Make the scene authoritative.** Persist and export it (JSON), and let look.ts hold only the environment (sky,
   horizon, ground). The rig would then be the single source of lighting.
2. **Positional lighting in the glass.** Per-pixel light directions, point and spot lights, and any number of
   lights through a storage buffer. Shadows from more than the key light.
3. **html-in-canvas for real (Chrome 157+).** Permanent drawable `.stage`, the glass refracting live UI, the label
   from the real button, hit testing via `updateElementGeometry`. Per the user, UI elements are free to sit
   anywhere in 3D: each drawable element becomes its own textured quad with a transform.
4. **One renderer for both modes?** Render normal mode through the 3D path when the scene departs from the flat
   defaults: lit paper, an off-axis camera, a deep page. That would trade the small goo canvas for a full-viewport
   pass.
5. **Gizmo UX.** Axis constraints, snapping, numeric overlays, undo, and a two-finger pan.
6. **A levitating glass button.** Give the goo object a transform: a height above the page and, later, any pose.
   - **Render.** The 3D view needs only an offset for the height-field box plus the air gap below it. Refraction
     and shadow already trace a gap. Normal mode can fold the hover height into the same depth terms as a
     pushed-back page.
   - **Press.** A press would drive the button's rigid-body motion too: a damped spring on its height (and maybe
     tilt) that a finger pushes toward the page. The squish (the existing height field) would ride on top.
   - **Input.** The press point must be found by ray, as config mode already does, because the button's screen
     position no longer matches its DOM box.

Open questions:

- **Answered:** UI elements can live anywhere in 3D space.
- Should the light rig follow the goo, as now, or be world-anchored, so lights stay put when the button moves?
- Is the config view a dev and design tool only, or should users ever see it? (It is becoming a bigger part of the
  project.)
