# 3D scene and config view (prototype)

The flat page now has a scene behind it: a camera, the page as a background plane, the goo on a reference plane
in between, and a rig of lights. The page stands upright like a screen on a wall, the way we look at interfaces.
Normal mode still draws the flat page plus the goo overlay. The scene reaches it through the glass uniforms and
through gravity, which the putty feels (see [Gravity and the material](#gravity-and-the-material)). At the defaults
the resting look is exactly as before, and presses differ by a fraction of a pixel.

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

The levitating button is now prototyped: the goo has its own frame, floats at a hover distance, and a press pushes the
whole button toward the page and tilts it before it springs back. See [Levitating button](#levitating-button-prototype).

In config mode:

- drag to orbit around world up (the scene turns the way you drag, about the goo); right-drag or shift-drag to pan;
  scroll or pinch to zoom (shift+scroll is kept for scrolling the camera down a tall page, later);
- drag a light (its dot or its panel) to move it; hold Alt to change only its distance;
- drag the blue handle on the page's bottom edge to push the page back;
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
| `src/levitation.ts` | The floating button's rigid-body motion: an air-cushion spring that presses sink and tilt. |
| `src/materialPanel.ts` | The Material and Gravity folders, shared by the tuning panel and the 3D view's panel. |

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

Normal mode never creates the scene canvas or loads its code (a lazy chunk of about 72 KB; lil-gui comes in a
chunk shared with the tuning panel). The scene canvas is capped at about 3.2 MP of device pixels. On the M-series
GPU this was tested on, orbiting with the html-in-canvas UI ran at the display's 120 Hz (median 8.3 ms frames).

The 3D view is a ray tracer, not a mesh renderer. The goo is a height field, and the page, probes and emitters are
analytic. So one full-screen pass can reuse the flat shader's surface (`surfaceAt`: analytic rest profile, B-spline
simulation, fingerprint detail) and its glass terms unchanged. Only the view ray is generalized.

## Scene model and math

**Frames.** The world frame is the flat shader's screen frame: x right, y down, z toward the viewer, in CSS px. The
origin is the viewport center on the **reference plane** z = 0, which is where the goo sits. A viewport point
(px, py) is the world point (px − W/2, py − H/2, 0).

**World up is screen-up, (0, −1, 0).** The page is a wall and the scene camera is a level camera facing it. Two
things keep the page's own frame, where z is the page's axis, and don't follow world up:

- the glass and its studio: `env()`'s zenith, the sky ambient and the light rig's frame convention are page-relative,
  as a screen on a wall reflects the room in front of it;
- the goo's frame, the levitation gap (along z), `groundLight` and paper lighting.

World up drives the 3D view's orbit, the backdrop gradient (lighter above eye level), where labels go and the light
panel's angles. Gravity is a separate scene vector (see [Gravity and the material](#gravity-and-the-material)); the
view's up doesn't follow it.

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

Each channel does this with its own IOR. The landing point on the page plane maps to page px through `s`. The
button label is printed on the glass' base, so it is sampled where the ray leaves the glass, before the gap.

Normal mode folds the gap into the flat shader with the same steps for a vertical view ray: out through the base
(Snell), straight across the gap, then scaled by k because the camera sees the page foreshortened. Before the
levitating button this was a paraxial `depthLens` term. The shadow and its softening follow the levitation model
below, which treats a pushed-back page as one more source of air gap.

**Shadows on a pushed-back page.** A page point p receives the key light through the goo's base. While the goo
rests on the reference plane, that light crosses it at `p.xy + L.xy / L.z · g`, so the existing `groundLight` is
evaluated there. The levitation section generalizes this to a floating, tilted base.

**Orbit camera.** The orbit pose is (pivot, yaw ψ, pitch θ, distance, fov): a turntable around world up with a
level horizon. With level = (sin ψ, 0, cos ψ):

```text
back  = level · cos θ + up_w · sin θ = (cos θ sin ψ, −sin θ, cos θ cos ψ)
right = (cos ψ, 0, −sin ψ)            (always horizontal)
up    = (−sin ψ sin θ, −cos θ, −cos ψ sin θ)
eye   = pivot + back · distance
```

At ψ = θ = 0 with pivot 0 and distance D it is exactly the scene camera, element for element. Yaw is unbounded, so
the view can go behind the wall; pitch is clamped to ±88°. Flights blend yaw the short way round, pitch and fov
linearly and distance geometrically.

**Dragging grabs the scene**, as in most 3D tools: drag right and it turns right (the eye orbits to its left), drag
down and its top tips toward you (the eye rises), 0.3°/px. A drag turns the view about the goo (the rig target)
while the goo is in view, so the goo stays put on screen and the page and the rig turn around it. Otherwise it turns
about the view's own pivot. That matters in the overview, whose pivot is the middle of everything, about 800 px in
front of the page: turning about it, the page swung the opposite way to the drag. The pivot is carried around the
goo by the same rotation that turns the view (`orbitCenter` and the orbit drag in `configMode.ts`).

**Default poses.** **V** is the scene camera. **O**, the overview, looks from the front-right and a little above (yaw
38°, pitch 16°, fov 34°). It fits by projection: the camera, the page's corners, every light and its panel's corners
and the probes land inside the screen, clear of the panel's column on the left and the hint at the bottom. **F**
looks at the goo from the same side (yaw 45°, pitch 30°), so O and F don't swing across the page.

**From behind.** The page plane is two-sided: its back is a dark, unprinted panel. Gizmos behind it dim, emitters
behind it hide, and the page blocks picks of lights and of the goo (`behindPage`), so a press from behind can't dent
the putty through the wall. The html-in-canvas UI plane is front-only, and the CSS fallback's stage is hidden
(opacity 0, still in the accessibility tree), since CSS would draw it mirrored over the page's back.

**The live DOM in 3D (CSS fallback).** `cssMatrixForPlane()` builds a `matrix3d` (with `transform-origin: 0 0`)
whose rows are, in order:

- screen x·w;
- screen y·w;
- a pass-through z (CSS refuses non-invertible matrices);
- w = view depth.

Each comes from the same projection as the shaders, so the transformed `.stage` lands on the reference plane pixel
for pixel.

**Matching the flat page at the camera pose.** Light emitters, gizmos, labels and the studio backdrop fade in as
the view turns off the camera's axis (`overlay`, 0 → 1 between 0.5° and 12°). Lights are invisible to camera rays, as in a studio
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
- **Three softboxes** (front softbox, key strip, cool kicker): centered on `c` with frame `t`/`b`. Physical
  half-extents are `halfSize · 1100`. Radiance is per theme, and `round` and `soft` scale with distance. On a wall
  the first one hangs in front of the screen, 16° off the camera's axis, hence its name.

The panel aims a light by world-up angles: **elevation** above the goo's horizontal and **swing** from straight out
of the page (+ = right). The sun sits 33.3° up and 24.7° to the left. Moving a light re-aims it with look.ts's frame
convention: the long axis stays tangential around the page's axis, and the light stays between 1° and 85° off that
axis, in front of the page. So a corner like (80°, 80°) reads back as (79.0°, 62.9°).

**Identity check.** `__goo.scene.identity()` compares the scene-derived light uniforms with look.ts as float32: the
difference is 0 in both themes. At rest, frames with the hook on and off differ by at most 1 LSB on about 0.15% of
the values, which is less than two consecutive frames with the hook off differ (0.28%).

| Material | How it uses the lights |
|---|---|
| Liquid glass (both modes) | As distant lights seen from the goo center, through the existing uniforms. The sun drives the GGX highlight (lobe width = its angular radius), the edge-glint lobe, the horizon ring's bright azimuth, the shadow and caustic direction, and the shadow reach (scaled by the tangent of its angle off the page's axis). The softboxes are the studio's rounded-rect emitters in reflections, at direction `c`, frame `t`/`b`, angular size = physical / distance. The sky and horizon ring stay look.ts environment terms. Eye distance = camera D. |
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

## Levitating button (prototype)

The button can float in front of the page. Pressing it pushes the whole button toward the page and tilts it toward
an off-centre finger, on top of the squish and the fingerprint; let go and it springs back past its rest distance and
settles.

**Try it:**

- `?hover=40` in the URL;
- the **Levitation** folder in the tuning panel (`?tune`);
- the same folder in the 3D view's panel (press **C**).

The hover distance defaults to 0. Without an air gap nothing moves, and the look is unchanged: a frame at rest
differs from the base commit in 3 of about 10⁶ values, by 1 LSB each.

### The goo's frame

The goo has its own frame (`scene.ts: gooFrame`). Goo space, the putty's height field and the simulation all live
in it unchanged:

```text
world = origin + k · (x · X + y · Y + h · Z)      goo-space (x, y), height h above the flat base
```

- **Distance.** The base sits z in front of the reference plane, measured at the pivot. The air gap behind the
  pivot is `z + page depth`. At rest z is `scene.goo.hover`; presses bring it toward the page.
- **Tilt.** X, Y and Z are the axes of the base, tilted about the pivot. The pose stores the tilt as slopes `t`:
  the base sits `t · (p − pivot)` nearer the page at goo point p. The pivot is the centroid of the resting footprint.
- **Anchored to the screen.** `k = (D − z) / D` scales the goo about the camera eye. So the camera sees it exactly
  on its DOM box at any distance, the way the page plane's "fill" mode keeps the page filling the view.
  - The DOM button, the pointer mapping and the focus ring stay exact.
  - Only the gap behind the glass gives the distance away, plus the parallax when the view orbits.
  - The world size shrinks with distance: by 3% at 40 px.
- **The label** is printed on the glass' flat base, so it rides with the button. It used to be printed on the page;
  with no gap the two are the same place.
- **The light rig** follows the goo's rest distance, not the presses.

### Physics (`src/levitation.ts`)

The button rides an air cushion: a uniform spring bed behind a rigid plate. There are three degrees of freedom: the
distance z and the two tilt slopes. The state is CPU-side and stepped every frame before the glass uniforms are
written.

- **Push.** Each finger pushes with the share of a full press it has sunk in: `w = (depth − lift) / (surfaceZ ·
  depthFrac)`, capped at 1.5. This follows the dent's own ramp, creep and skim, so a quick tap gives a small bob, a
  held press sinks fully, and the push drops within ~10 ms of release.
- **Targets.**
  - A full press sinks the button by `travel`: `z* = hover − travel · Σw`.
  - A plate on a uniform cushion under a point load tilts with slope = force × lever / second moment of the
    footprint, scaled by the **tilt** control: `t* = travel · tilt · Σ w (p − pivot) / var`.
- **Limits.**
  - The tilt is capped at a 0.15 slope (≈ 8.5°).
  - The sink, plus the dip under the tilt, stays within 90% of the gap.
  - If an overshoot would still bring the base to within 10% of the gap from the page, it bottoms out: z is clamped
    and its downward velocity is dropped.
- **Dynamics.**
  - Each of the three DOFs is a damped spring toward its target: `q'' = ω²(q* − q) − 2ζω q'`. A uniform plate on a
    uniform cushion rocks at the same frequency as it bobs.
  - It uses semi-implicit Euler in 1/600 s substeps, which stays stable up to the 20 Hz the controls allow.
- **Hover changes** go through the same spring, so the button lifts off and lands instead of jumping.
- **Reduced motion** makes the cushion critically damped (ζ = 1).
- **Sleep.** It keeps the frame loop awake while it moves, and snaps to its rest pose when the loop sleeps.

| Control | Default | What it does |
|---|---|---|
| hover distance (px) | 0 | rest distance of the base in front of the reference plane (0–150) |
| press travel (px) | 10 | how far a full press pushes the button (never past 80% of the gap) |
| stiffness (Hz) | 4 | the cushion's natural frequency |
| damping (bouncy → still) | 0.35 | damping ratio; 0.35 overshoots about 30% on release |
| tilt toward the press | 0.3 | 0 = no tilt, 1 = a rigid plate on a uniform cushion |

Measured at hover 40 with the defaults:

- **Pressed off-centre** (at 85% of the button's width): it sinks 10.8 px and tilts 3.6° toward the finger within
  ~200 ms.
- **Released:** it overshoots 3.1 px past rest and settles in under a second.
- **Keyboard press** (the middle): it sinks without tilting.

### Shadow, parallax and refraction

**Config view (traced).** The ray tracer marches the height field in the goo's frame: the eye ray is moved into it,
and the world ray parameter carries over unchanged. So floating, sinking and tilting cost one transform per pixel.

- **Refraction.** `landing()` follows each channel's ray:
  1. Snell into the top.
  2. Straight down to the base, in the goo's frame.
  3. The label is sampled there.
  4. Snell out through the tilted base.
  5. Across the air gap to the page plane.
- **Shadow.** The key light reaching a page point is traced back to where it crossed the tilted base (`shadowQ`),
  and `groundLight` is evaluated there. That one lookup moves the shadow, contact occlusion and caustics with the
  gap and the tilt.
- **Gizmos.** The base outline, the same outline projected back onto the page and four lines between them show the
  gap. A label reports it.

**Normal mode (folded into the flat overlay).** The camera sees the glass where it always was, so everything
happens below it:

- **The normal** is tilted with the button (small angles: `n.xy += t · n.z`).
- **The gap** is per pixel: `gap(p) = gap₀ − t · (p − pivot)`.
- **Refraction across the gap.** Out through the tilted base with Snell, straight across `gap(p)`, then scaled by
  `D / (D + depth)` for a pushed-back page. Nothing changes when the gap is 0.
- **The shadow's parallax.** The light reaching page point q crossed the base at

  ```text
  caster(q) = q + (q_view − center) · parallax + L.xy / L.z · gap(q) · D / (D − z)
  parallax  = (D + depth) / (D − z) − 1
  ```

  The second term is the shift toward the key light, so the shadow lands on the far side. The first is the camera's
  parallax between the page and the goo. `groundLight(caster(q))` gives the light there, both around the goo and
  through it.
- **Softening**, shared with the 3D view (`gapSoftening`):

  | Term | With an air gap |
  |---|---|
  | `gapBlur` | `gap · (sun radius / 2 + 0.06)`: the key light's penumbra, plus the softboxes filling the shadow in |
  | shadow blur | `shadowSigma + gapBlur` |
  | edge of the clear interior's light | 1.5 px + `gapBlur` (`groundLight`'s `under` mask) |
  | shadow opacity | × e^(−gap/600) |
  | contact occlusion | × e^(−gap/6) |
  | caustics | × e^(−gap/16) |

  The shadow grows softer, larger and slightly lighter. A clear glass slab floating over paper casts a soft ring
  with a light centre: light passes through the interior, and the rim bends it away. Caustics fade because dents and
  the rim focus within a few tens of px, so across a larger gap their pattern smears out. The model evaluates them
  unblurred, so it fades them instead; left in, a dent projected a crisp, distracting ring onto the page.
- **The goo canvas grows to fit the shadow.** `--goo-bleed` extends it past the button in 16 px steps, up to
  192 px. The hover slider only re-lays out the goo (rebuilding the simulation grid at rest) when it crosses a step.
  A deep page's shadow can still leave the canvas.

### Input

- **Normal mode** keeps the DOM pointer mapping. Because the goo is anchored to the screen, it is exact at any
  distance.
- **The config view** casts the pointer's ray into the goo's current frame (`gooRay`):
  - A press marches the resting height field there (`gooHit`) and lands within ~1 px of the aimed goo point.
  - While held, the finger follows the pointer's ray at the height it pressed in, in the frame as it is now. If the
    pointer is still, the finger stays put on the putty as the button sinks under it.

### What changed for a pushed-back page

The page depth is folded in as more air gap, so the existing page-depth case changed too:

- the label is on the glass' base, not on the far page;
- normal mode refracts through the gap with Snell rather than the paraxial `depthLens` term;
- normal mode's shadow is displaced, and leaves the goo canvas for deep pages;
- both modes share the softening above, so the 3D view's shadow is a little softer and its caustics fade sooner;
- a press moves the goo whenever there is an air gap, including a pushed-back page with hover 0.

### Open questions and next steps

- **Screen-anchored or rigid?** The goo keeps its apparent size at every distance, which keeps the DOM exact but
  shrinks its world size. A UI element in true 3D might rather keep its world size and look bigger as it floats.
  Then normal mode would need ray-based input and its own magnification.
- **The shadow's look.** Is the physically motivated ring with a light centre right for UI glass, or should a
  floating control cast an art-directable, darker drop shadow? It is darker in the dark theme already.
- **Caustics across the gap** fade instead of focusing. Doing them properly needs a blurred copy of the macro height
  (a mip chain or separable blur), and the rim's focus ring near its ~40 px focal distance.
- **Pressed size and tilt silhouette.** Normal mode ignores the perspective shrink while pressed (≈ sink / D: 0.7%
  at 10 px) and the tilted silhouette's foreshortening. The 3D view shows both.
- **Lateral motion.** A drag could nudge the button sideways (friction) and let it spring back. That moves it off
  its DOM box, so normal mode would need the ray-based input too.
- **Lights.** The rig follows the hover. World-anchored lights would let the reflections shift as the button rises.
- **More floating elements.** Each would need its own frame and cushion. The flat overlay's gap uniforms are per goo
  canvas.
- **Idle motion.** A slow bob would sell the levitation, but would keep the frame loop (and the GPU) awake.

## Gravity and the material

What holds the putty on the page is adhesion, cohesion and surface tension. Gravity is a scene setting that pulls on
it, down the page by default, and the default putty holds against it.

| Force | In the putty (`params.plastic`, `src/gpu/simKernels.ts`) |
|---|---|
| Cohesion | The Bingham yield (`yieldHead`, 2.5 px): below it a face carries no flow, so the putty keeps its shape. Shape memory (`memory`, 1; it used to be called `gravity`, though it never had a direction): a restoring head toward the molded shape. And the elastic layer's spring-back. |
| Adhesion | The contact line holds `pin` (0.2 px) of head before it creeps; it used to slide freely. The bare page refuses to be wetted: outside the resting footprint the restoring head is K + `dewet` (dewet = 12), so a spill pulls back. |
| Surface tension | `−σ∇²m` in the pressure head (`surfaceTension`, 0.35 cell²), and the leveling of printed ridges. |
| Weight | `weight` (0.05): head px per px of travel per g of gravity. |

**Gravity.** `scene.gravity` is a world vector in g, `[0, 1, 0]` by default. `?gravity=` sets it (`wall`, `floor`,
`ceiling`, `off`, or `x,y,z`), and so do the Gravity folders. The putty feels it in its rest frame (its own press
tilts don't count):

- into the base, it adds `weight · g_n` to the restoring head K;
- along the base, it adds a potential drop `weight · (g · ê) · cell` across every face (`driveX`, `driveY`).

Each face flows only with what its total drop, `(P_A − P_B) + drive`, has beyond its threshold: the yield between
two putty cells, the pin on a contact-line face. Creep levels only the deviation from the settled shape (below), so a
shape the yield holds stays put. `G_PX`, 1 g ≈ 37,065 CSS px/s² at 96 px per inch, is there for rigid bodies and
particles later.

**Does it hold?** At rest every face's drop is the weight's alone, so one comparison per axis decides it exactly
(`__goo.sag()`, and the "under gravity" row in both panels). With d = weight · max(|g_x|, |g_y|) · cell, the drop
across one face along either axis:

| Regime | When | What happens |
|---|---|---|
| holds | d < 0.98 · yield and d < 0.98 · pin | nothing moves |
| weeps at its edge | d ≥ 0.98 · pin only | the contact line creeps a little |
| sags | d ≥ 0.98 · yield | the putty slumps until the yield arrests it |
| would run (held at the limit) | the excess d − yield would thin the top away | the drive is held at that limit (drips aren't built) |
| would drip | the weight pulls it off a ceiling harder than its memory holds | K is clamped at 0, and any drive along the base is held at the run-off limit (with K = 0, at the yield) |

At the defaults on a wall, d = 0.15 px: S = d / yield = 0.06 and S_edge = d / pin = 0.75, so it holds exactly. The
bulk would hold up to 16.7 g along an axis, the contact line up to 1.33 g (the readout's 2% margin flags them at
16.3 g and 1.31 g). At 45° the in-plane pull can be √2 larger before anything moves.

**The settle layer** (`src/gpu/goo.ts`). When the material can't hold, a second, finger-free copy of the plastic
state runs the same four kernels with the set material and no healing, until it stops moving. That is the settled
shape m_s, and the live putty heals toward it instead of the molded shape, so a press heals back to the sag.

- It runs in real time for 6 s, then fast-forwards its slow tail ×4, up to 120 s of its own time. With reduced
  motion it runs ×8 throughout.
- Every 30 frames (half a second at 60 Hz) a readback gives the CPU a copy (for finger contact and 3D picking) and
  the quiet test: settled after two readbacks in a row that moved less than 0.005 px/s.
- When the material holds again it re-molds: the putty heals back to the mold, while m_s stays as the drawing's
  reference and fades at exactly the putty's heal rate, so the exaggerated deviation never jumps. Re-molding ends
  when the reference is under 0.02 px everywhere. If it cuts a slump short, the CPU copy may lag, so it starts from
  a bound (2 × the plateau, which the run-off limit keeps m_s within) until a readback taken then lands.
- A grid rebuild (the canvas growing for a floating button's shadow) carries the last read-back shape over (up to
  30 frames old), resampled, and the run goes on from it at that shape's clock (a settled one in the fast tail). A
  re-molding sag isn't carried: the new grid starts molded. Sleep snaps to a settled shape.
- m_s is drawn as is; `imprintGain` exaggerates only the live deviation from it. Where a sag drains the putty,
  coverage follows the material. The settled lip past the resting outline, one cell wide and about a pixel thick,
  isn't drawn.

**Material macros** (the Material folder; 0.5 gives the base values):

| Macro (0 → 1) | Drives |
|---|---|
| adhesion (slips → sticks) | pin × 3^(2a−1), 0.067–0.6 px; dewet × 2^(1−2a), 24–6 |
| cohesion (runny → holds) | yield × 2^(2c−1) |
| surface tension (wrinkly → smooth) | tension and ridge leveling × 3^(2s−1) |
| density (light → heavy) | weight × 20^(2ρ−1), 0.0025–1 |

**Stability.** The flux guard now takes the largest restoring head: the intro's 2 · memory plus the weight pressing
into the base (a floor). That is 2 at the defaults, so the flux gain stays 3035. The old guard went unstable at a 4 g
floor with density 1.

**Measured** (dev harness, 1058×1065 viewport):

- With gravity off and the pin at 0, the new code matches the previous commit to within float rounding. After the
  intro, a centre press and an edge press, the plastic state agrees when quantized to 2⁻¹² px (0.00024 px), and its
  row sums to about 1e-7. It is not bit for bit: the changed shaders compile to slightly different rounding.
- At the defaults a resting putty stays exactly molded (m = 0 everywhere). Presses differ from gravity off by at
  most 0.13 px (centre) and 0.37 px (edge).
- Density 1 on a wall (S = 1.2): it sags to m_s −6.2 … +8.0 px and settles in about 11 s. A press heals back to
  within 0.002 px of the sag, and density 0.5 re-molds it.
- The "Slime on a wall" preset (S = 1.53): −7.1 … +7.0 px, settled in about 14.5 s.
- Density 1 at 3 g is held at the run-off limit (a drive of 3.74 px per face); its top reaches 30.2 px.
- On a floor at 1 g, K is 1.05 and the flux gain 3028; with density 1, K is 2 and the flux gain 2891. On a
  ceiling, K is 0.95.

**Cost.** While the material holds (the default): five more texel loads per cell in two kernels and a two-channel
pressure texture; no extra passes. While it settles: the four kernels again per substep (four times over in the
tail) and a 114 KB readback every 30 frames, until it settles; while it re-molds, the four kernels once per
  substep.

## Dev harness additions

```js
__goo.scene.scene.goo.hover = 40; __goo.scene.changed()   // float the button (or ?hover=40)
__goo.relayout()                  // re-measure now: a hidden tab gets no ResizeObserver callback after the canvas grows
__goo.levitation.pose             // { z, tilt, pivot }: the button's height, tilt slopes and pivot
__goo.scene.identity()            // 0 → the scene-derived light uniforms equal look.ts's (as f32)
__goo.scene.hook(false)           // detach the scene from the glass to A/B normal mode (gravity stays on: an A/B
                                  // against the old simulation needs ?gravity=off and __goo.params.plastic.pin = 0)
await __goo.scene.enter()         // fly into the 3D view; __goo.scene.exit() flies back
const shot = __goo.scene.shot(300) // run 300 ms of frames on the virtual clock; copy of the scene canvas
__goo.scene.sheet([shot], 480)    // lay scene shots out over the page ([] clears)
__goo.scene.scene.page.depth = 600; __goo.scene.changed()   // edit the scene by hand
__goo.scene.config().dev.setPose({ yaw: 60, pitch: 20 })  // also flyTo, focusPose(), overviewPose(), cameraPose()
const dev = __goo.scene.config().dev
dev.basis; dev.project([0, 0, 0]); dev.target           // the view's basis; world → viewport px; the rig target
dev.lightAngles(0); dev.aimLight(0, 45, -25)            // a light's elevation, swing and angle off the page's axis
__goo.scene.scene.gravity.splice(0, 3, 0, 0, -1); __goo.scene.changed()   // gravity into the page (?gravity=floor)
__goo.sag()                       // the last frame's check: regime, S, Sedge, K, the face drives, the settle phase
await __goo.readSim()             // per-cell copies: e, v, m, age, the settled shape ms, the rest profile
__goo.eff(); __goo.snap(); __goo.resetClock(1000)   // effective params; snap to rest; restart the virtual clock
```

`drive()` runs faster than real time, so the settle layer's readbacks lag behind it: await a few ms between chunks
(`for (...) { __goo.drive(500); await new Promise((r) => setTimeout(r, 40)); }`) to see it reach `settled`.

## Limitations

- **Distant lights only.** The glass sees every light from the goo center: no per-pixel parallax, no positional
  falloff across the goo. Lights are parented to the goo, not anchored in the world. The glass takes exactly one
  sun and three softboxes (the `GlassParams` layout).
- **Paper lighting is config-view only.** In normal mode the page stays self-lit.
- **The flat approximation clips shadows.** Normal mode grows the goo canvas to fit a floating button's shadow, but
  only up to 192 px past the button, so a deep page's displaced shadow leaves it. The config view traces it exactly.
- **The camera is locked frontal.** Only its distance (FOV) is editable. An off-axis camera would mean drawing
  normal mode through the 3D path.
- **The 3D view's up is always screen-up.** It doesn't level itself to gravity.
- **Drips aren't built.** A sag that would run is held at the run-off limit, and the settled lip past the resting
  outline isn't drawn. Splashes, drips and goo carried on the cursor are on the roadmap.
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

The longer plan (tall pages and camera scrolling, several pages, scroll-scrubbed video, depth of field, gobos,
materials on meshes, particles) is in [roadmap.md](roadmap.md).

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
6. **A levitating glass button.** Prototyped: hover distance, a pressed air cushion that sinks and tilts, and
   ray-based pressing in the config view. See [Levitating button](#levitating-button-prototype) for what is open.

Open questions:

- **Answered:** UI elements can live anywhere in 3D space.
- Should the light rig follow the goo, as now, or be world-anchored, so lights stay put when the button moves?
- Is the config view a dev and design tool only, or should users ever see it? (It is becoming a bigger part of the
  project.)
