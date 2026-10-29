# Roadmap

gui.style puts interface elements into a 3D scene as physical objects. Today that is one goo button on one flat page,
plus a 3D view of the scene behind it. This roadmap covers what the user asked for on 2026-10-28, listed in the first
table: what has landed, and a plan for the rest. Each workstream's heading names its milestone and what that needs
first. Code is cited by file and function, since line numbers move.

- **Landed**: in the code now. [`docs/3d-config-view.md`](3d-config-view.md) has the detail.
- **Decided**: the user's call, not built yet.
- **Proposal**: the recommended design. It needs a yes before it is built.
- **Open**: a decision still to make, numbered Q1 to Q26 at the end.
- **est.**: computed by a throwaway script (camera, lens, gobo, unit arithmetic, or a CPU putty port), not measured.

## What was asked

| Request | Where |
|---|---|
| Lay the 3D view out vertically, "more aligned with how we view the interfaces" | Landed |
| Instead of gravity, a material "capable of handling adhesion, cohesion, and surface tension" | Landed |
| "a global gravity setting that objects and materials can follow" | Landed for materials; objects in M11, M12 and [Gravity for objects](#gravity-for-objects) |
| "multiple pages in a scene", with "navigation transitions between the scenes" | M7 |
| Pages and their assets "organized into files and lazy loaded and all the optimizations" | M8 |
| Content "below the bottom of the camera's viewport", and "something like shift+scroll to scroll the camera up and down the page" | M2; Shift+wheel is reserved in the 3D view (Landed) |
| "full page video animations" stepped through by scrolling "with the camera locked at that vertical position", the frames "a transparent stack behind the frontmost and current visible frame" | M9 |
| The goo as a material effect applied to "base mesh shapes" | M10, M13 |
| "particle effects that can use the materials", and a goo variant that splashes when touched, or "sticks to the cursor and could fall off the cursor" | M11, M12 |
| "camera settings like dof", and "beyond straight-on depth effects", a camera that "can tilt or something" so that while scrolling, items "toward the top of the view" go through "the dof focus range" | M3, M6 |
| "gobos" | M4, M6 |
| "host on cloudflare workers eventually and probably have useblume.dev docs" | M8, D |

## Landed

The upright 3D view, the material model and global gravity landed together. The upright view changes nothing in
normal mode. With the default material under the default gravity, a resting putty stays exactly molded, and presses
differ from gravity off by at most 0.37 px (measured).

### Upright page in the 3D view

- World coordinates are unchanged: x right, y down, z toward the viewer, in CSS px, with the page plane at
  z = −depth. World up is screen-up, (0, −1, 0), so the page stands like a screen on a wall.
- The orbit is a yaw/pitch turntable around world up with a level horizon; yaw 0, pitch 0 is the scene camera. A
  drag grabs the scene and turns it about the goo while the goo is in view. Yaw is unbounded: from behind, the page
  shows a dark back, the CSS 3D fallback hides the stage, and the page blocks picks.
- The panel aims lights by elevation and swing, and the overview frames everything by projection, clear of the
  panel. Shift+wheel is reserved for scrolling the scene camera down a tall page; it does nothing yet.
- `cameraOrigin(scene)` in scene.ts is the one place a camera scroll offset will be read. The camera eye, the scene
  camera's pose, the frustum and camera gizmos, the camera and viewport labels, and the remembered orbit pose all go
  through it.

Later work can rely on two frames kept apart. The page frame (z is the page normal) holds the glass and its studio,
the softbox frames, the goo frame and `groundLight`, since a screen on a wall reflects the room in front of it (Q1).
World up holds the orbit, the backdrop, labels and light angles, and later a camera pitch or focal-plane tilt, always
about a horizontal axis. Gravity is a separate world vector, and the view's up doesn't follow it. At yaw 0, pitch 0
the 3D path matches normal mode (0.93/255 mean over the goo canvas, measured before the levitation merge), so a
transition can cross-fade into it and out.

### Material: adhesion, cohesion and surface tension

| Role | In the putty | Default |
|---|---|---|
| Adhesion | A contact-line pin, `plastic.pin`: the yield head of a face with one dry cell (it was 0). The dewetting contrast of the bare page: an extra restoring head `dewet`·m on dry cells, and no flow between two dry cells. | pin 0.2 px, dewet 12 |
| Cohesion | The Bingham yield, `plastic.yieldHead` × (0.5 + elasticity), tested per face (Q4), and shape memory, `plastic.memory`: the head that levels dents back out, formerly misnamed `plastic.gravity`. The elastic layer springs back. | 2.5 px; 1 |
| Surface tension | `plastic.surfaceTension`, the −T∇²m part of the pressure head | 0.35 cell² |

The Material folder's macros are adhesion, cohesion, surface tension and density, 0.5 being the base values, and
presets can set them ("Slime on a wall" sags). When a material can't hold, a finger-free settle layer finds its
arrested (Bingham) shape. Healing returns to that shape and the loop sleeps in it; once the material holds again, the
putty re-molds (Q2), the settled shape fading as the putty heals so the drawing never jumps. Settling costs 4 extra
dispatches per substep for its first 6 s and 16 after that, when it fast-forwards the slow tail (Q3), plus a 114 KB
readback every 30 frames. A run-off limit holds every sag before its top thins away, including one pulled off the page
(Q15); drips are not built.

### Global gravity

- `scene.gravity` is a world vector in g, default [0, 1, 0], down the page. The Gravity folder (in both panels) and
  `?gravity=wall|floor|ceiling|off|x,y,z` set it.
- Materials feel it through a per-material weight ŵ (`plastic.weight`, head px per px of travel per g: 0.05, scaled
  by density). Into the base it adds to the restoring head, K = max(memory + ŵ·g_n, 0); along the base it adds a
  potential drop of ŵ·(g·ê)·ℓ across each face, ℓ being one 3 px cell.
- At the defaults the putty holds exactly: the bulk and contact-line sag numbers are 0.06 and 0.75, and every face
  stays static. At density 1, a wall at 1 g sags it −6 to +8 px, settling in about 11 s.
- `G_PX = 9.80665 m/s² × 96/0.0254 px/m`, about 37,065 CSS px/s² per g, is defined for future rigid bodies and
  particles; the putty's weight does not use it. The 3D view's up stays screen-up when gravity changes.

Later work can rely on one gravity vector, read in each element's rest frame, so another element or a turned page
reads its own axes; on an O(1) sag check that names the regime (holds, weeps at its edge, sags, would run, would
drip); and on a legacy setting, `?gravity=off` with `plastic.pin = 0`, that matches the old simulation to within
float rounding.

## Target architecture (proposal)

The site holds scenes and routes, a scene holds pages, and a page holds layers and elements. Materials and media are
shared resources named by id, and lights are nodes with a parent (Q9). Each scene has one camera and its own gravity.

- **Page space** is one page's CSS px: x right and y down from its top-left corner, z out of the page. The UI layer
  (the real DOM) sits on the reference plane, z = 0, and art and video layers sit behind it. Re-centred on the
  camera's window, page space is today's world frame, so the glass and its studio, the softbox frames, the goo frames
  and every equation in `docs/3d-config-view.md` hold on every page.
- **World space** is the scene's frame, today's world frame with up (0, −1, 0), where gravity, the 3D view and
  transitions live. A page's placement (its top-left corner in the world, plus a yaw about up) maps its space into
  the world; today's page sits at (−W/2, −H/2, 0).
- **The camera** keeps its distance D and gains a height y on the active page: its eye is at page (W/2, y + H/2, D),
  straight on, so the flat path stays exact. `cameraOrigin(scene)` turns y into the world point on its axis.

**Renderers.** The DOM is the source of truth for content, focus, accessibility and layout. Islands are per-element
WebGPU canvases (the element plus a margin) that sleep when idle. The scene layer is the full-viewport ray tracer:
the 3D view now, and normal mode when an effect needs pixels outside the islands (M5). Compute runs simulations,
particles and media uploads. Everything interactive or readable stays real DOM; WebGPU only draws it.

```ts
interface SceneDoc {                   // the scene document, sketched; site.json lists scenes, routes and materials
  id: string;
  gravity: Vec3;                       // in g, world frame; default (0, 1, 0), as scene.gravity
  pages: { id: string; file: string; position: Vec3; yaw: number }[];   // top-left corner; turn about up
  lights: LightNode[];                 // parent: 'world', a page id or an element id (Q9)
  camera: { distance: number; lens?: { aperture: number; focus: number; tilt: number; focusLine: number; ramp: 'band' | 'receding' } };
  transitions?: { from: string; to: string; path: 'truck' | 'overview' | 'dissolve'; duration: number }[];
}
interface PageDoc {
  id: string; title: string; html: string; module?: string; height: number | 'content'; lights?: LightNode[];
  layers: { id: string; kind: 'ui' | 'art' | 'video'; depth: number; src?: string }[];
  media?: { layer: string; frames: string; count: number; pxPerFrame: number; pinAt: number }[];   // page px
}
```

## Workstreams

### Scene document and materials as data (M1, after M0)

The scene becomes the versioned document above, with ids, export, import and persistence; today `defaultScene()`
rebuilds it from look.ts on every load. `params`, `looks` and `effectiveParams()` hold one global material, which
becomes a record that the putty and its particles share, and look.ts keeps only the environment (the 3D view docs'
next step 1). Every later milestone adds fields, so versioning now saves migrating singletons one at a time.

- **Approach.** `effectiveParams` takes a material as well as the gravity. `page.depth` and `page.fill` become an
  art layer's depth and scale mode, `goo.hover` an element property, and lights get ids and a parent (Q9). Panels
  edit the document in place, as the Gravity folder edits `scene.gravity`; documents migrate on load.
- **Hard parts.** Moving every default without changing a pixel: `__goo.scene.identity()` stays 0 and seeded frames
  stay identical. Optics differ per theme.

### Camera, tall pages and Shift+scroll (M2, after M1)

Page content extends "below the bottom of the camera's viewport". Proposal: in normal mode native scrolling moves the
camera, camera.y = y(s) (the scroll offset minus any pinned video, M9), so keyboard scrolling, focus, find-in-page,
anchors, momentum and screen readers keep working. In the 3D view, where page scrolling is off, Shift+wheel, PageUp,
PageDown, Home and End move the scene camera, and the orbit pivot follows (a toggle).

- **Glass.** `pageOnly` maps through `#page-bg`'s box, which survives scrolling, but five terms put the eye over the
  page canvas's centre, not the window's: the reflection eye, `casterAt`'s and `shadowReach`'s `fromCenter`,
  `gooFrame` and `rigTarget`. They move to a new `viewCenter`, the window's centre in page px, and
  `GlassParams.viewport` becomes `pageSize`. Scrolling then changes the reflection, so `track()` runs on scroll and
  redraws the island.
- **3D view.** `buildFrame` takes the frustum's aspect and extent from the page box but its FOV from the window; the
  frustum moves to the window and the page plane to `pageSize`. Leaving restores scrolling, scrolls to the camera's
  offset and re-measures. Shift+wheel reads the dominant axis, as a shifted mouse wheel sends deltaX.
- **Tiles.** Page art in 1024² device-px tiles, painted on demand (a `paintRect` form of `paintPage`), shown as DOM
  canvases that scroll natively and uploaded to a `texture_2d_array` with a page table. 16-texel gutters keep the
  mips exact (`env()` reads mip 4), and one grain seed per page keeps it continuous. Only tiles under islands need
  GPU copies; a 2880×1800 window plus a row each way is about 107 MiB with mips (est.), its DOM canvases as much
  again.
- **Hard parts.** Textures over 8192 px fail validation, as `requestDevice` asks for no limits: at DPR 2 that is a
  4096 CSS px page, and the goo falls back to the static button. html-in-canvas snapshots an element's whole box at
  the canvas grid's scale, which keeps the grid near 4 MP (1.76 for a 1440×900 window), so a 1440×6000 page comes out
  2530×10,540 px. The plan is a window-sized, clipped wrapper that scrolls with the camera, plus build-time snapshots
  (M8); whether such a scroller scrolls natively, and how far its snapshots lag, is unverified (check in Chrome 158
  first). DOM tiles at fractional DPR can show seams. A layer anchored g px behind the content scrolls at D/(D + g) of
  its speed (Q5), which normal mode shows only through a CSS perspective scroller: `window.scrollY` then stays 0, and
  mobile toolbars may not collapse.

### Depth of field and tilt-shift (M3, after M1; normal mode in M6)

"camera settings like dof", and a tilt so that while scrolling, items "toward the top of the view" go through "the
dof focus range". Proposal: tilt the focal plane, as a tilt-shift lens does, and keep the camera square, so the DOM
and input stay exact (Q6). The 3D view's scene pass already writes view depth to an r32float target, so only the
scrolling demo waits for M2. Exposure, vignette, lens shift and motion blur in transitions are further candidates.

```text
CoC_px   = A · D · |1/z_f − 1/z|             thin lens, aperture A: focused at D, the far background blurs A px
1/z_f(y) = (1 − tan θ · (y − y₀)/D) / s      the focal plane tilted by θ through a focus line at screen height y₀
CoC(y)   = A · tan θ · |y − y₀| / D          for the page at s = D: a linear ramp, with no keystone
```

- **Ramps.** The focus line is fixed in the view, so scrolled content passes through it: a band is sharp at the line
  and soft on both sides, a receding ramp sharp at and below it and softer toward the top. At 1440×900, A = 24 and
  θ = 45° (est.), a band 30% down blurs the top edge 4.6 px and the bottom 10.8 px around a 117 px sharp strip; a
  receding ramp 60% down blurs the top edge 9.3 px. Interactive and focused elements stay sharp (CoC 0 in their
  boxes); otherwise the band would blur a button at the centre of the view 3.1 px.
- **Passes.** The scene pass writes linear colour to an rgba16float target instead of the canvas. A DOF pass computes
  CoC from depth, gathers at half resolution (a 48-tap golden-angle disc, with scatter-as-gather weights so sharp
  foregrounds don't bleed), composites and dithers; gizmos draw after it. The blur belongs to the scene camera: it is
  weighted by 1 − overlay, so it fades in as an orbit view returns to the camera. Glass lookups of the page, and its
  shadow's backdrop, take `lod = max(lodLens, log2(max(CoC · texelsPerCss, 1)))`, so the page seen through the goo
  blurs like the page beside it. Alt+click sets the focus.
- **Normal mode (M6).** Straight-on DOF of a pushed-back page works in islands in every browser, as
  `#page-bg { filter: blur(CoC/4 px) }` (a disc of diameter c has σ ≈ c/4) plus the same LOD bias in the glass.
  Tilt-shift across the view needs the scene layer (M5). Blurring live text row by row needs html-in-canvas;
  elsewhere it takes six masked `backdrop-filter` bands, or only the art and the glass blur (Q7).
- **Hard parts.** One depth per pixel is wrong on translucent layers such as the video stack; the focus line holds
  only at the focus distance, so a pushed-back page or a floating button blurs differently; a mip-LOD blur is
  box-like. Pitching the camera gives less blur for more distortion (est.: at 30°, 4.5 px at the edges and the top of
  the view 31% narrower) and takes normal mode off the flat path: CSS 3D keeps the DOM hit-testable, but perspective
  `canvasTransform`s under html-in-canvas are unconfirmed.

### Spot lights and gobos (M4, after M1; normal mode in M6)

"gobos": a patterned mask in front of a light. Proposal: a spot light that projects a pattern texture, in the 3D view
first; the upright wall is the natural target, such as blind stripes across the page. The 3D view's lights already
have a `kind` field, and paper lighting (`irradiance`, `paperLight`) exists there; the glass sees one sun and three
softboxes as distant lights, with the shadow and caustics following the sun only.

- **Lights as nodes.** A storage buffer of up to 16 lights replaces the four-light uniform array (`MAX_LIGHTS`). Kind
  2 is a spot, each light hangs on the world, a page or an element (Q9), and `__goo.scene.addLight()` adds one that
  the shader, the panel and `reset()` all see.
- **The spot** has a position L, an aim a, a cone half-angle α (20°), an edge softness and a falloff. Its gobo is a
  layer of a 512² `texture_2d_array` (blinds, window panes, leaves, dots, water caustics) with a scale, a rotation ρ,
  a softness and an optional drift. With the spot's basis (r, u, a), u from world up:

  ```text
  v = p − L    z = v·a    (s, t) = (v·r, v·u) / (z tan α)    uv = 0.5 + R(ρ)·(s, t) · 0.5 / scale
  E   = radiance · gobo(uv, lod) · cone(s, t) · cos θ_r · (d_ref / |v|)² · T(p)
  lod = log2(max(w · N / (2 d_r tan α), 1))      penumbra w = 2 R_s (d_r − d_c) / d_c, gobo N texels wide
  ```

  T(p) is the goo's shadow from the spot's own direction: split `groundLight` into `groundLightFor(q, dir, reach)`,
  keeping `groundLight(q)` as the sun's wrapper so normal mode is unchanged. With z instead of |v| in the falloff, a
  20° cone's edge would come out 13% too bright (1/cos² 20°).
- **The sun** can take an orthographic gobo once it has a real frame: its default `t` and `b` are placeholders, not
  perpendicular to its `dir`. Every light needs a roll about its aim, since the softbox convention turns a pattern as
  its light swings. Animated gobos run only while visible, never under reduced motion.
- **Hard parts.** In normal mode the page is self-lit and WebGPU covers only the goo canvas, so a pattern on the page
  would stop at the canvas edge: gobos across a page need paper lighting through the scene layer (M5, M6), and until
  then only the glass's own highlights can show them (Q8). A tilted spot stretches its pattern (est.: 40° off the
  normal at 1100 px, stripes 67 px apart at the centre run 51–96 px apart edge to edge), so checks measure at the
  centre. Later the glass takes light directions per element, then per pixel for spots.

### The scene layer in normal mode (M5, after M2)

Proposal: normal mode, which today never draws a full-viewport canvas, draws through the full-viewport path from the
camera pose whenever an effect needs pixels outside the islands: DOF or tilt-shift across the view, gobos on a lit
page, particles that leave an element, page transitions, lit paper. Otherwise it keeps the islands. This is the 3D
view docs' next step 4 and the plan's main architectural fork, so it waits until the camera model has settled.

- **The page UI.** With html-in-canvas the page stays inside a drawable canvas that takes pointer input, and
  `updateElementGeometry` with the identity keeps the DOM hit-testable where it is drawn (per the explainer; not yet
  exercised here). Without it the DOM stays on top, and effects reach only the art and the glass.
- **Split** the renderer and its camera animation from the 3D view's chrome (gizmos, labels, panel). It holds the
  overlay at 0 itself: the overlay follows `offAxis`, the view's angle off −z (today's scene camera axis), and a page
  turned about world up has its camera at a yaw.
- **Scroll sync.** Compositor scrolling runs a frame or more ahead of the main thread, so a fixed canvas redrawn from
  the scroll offset trails the DOM that takes the clicks. Put the canvas in the document instead, the window plus a
  quarter window above and below, at the offset it was drawn for; if viewport-pinned effects such as a tilt-shift
  band visibly trail by a frame, draw them in a fixed overlay.
- **Cost.** A WebGPU canvas keeps showing its last frame, so the layer costs nothing idle, but each drawn frame
  starts from a fresh texture: redraw whole frames or blit a persistent one. Resolution runs from 0.6 to 1.0 of the
  3.2 MP cap, steered by frame time.

### Several pages and navigation transitions (M7, after M2 and M5)

"multiple pages in a scene", with "navigation transitions between the scenes". Proposal: a scene is one world of
upright pages, and a transition is a camera flight; what a scene is and how its pages are laid out is Q10. A page has
a placement, the viewport's width, a height set by its content, layers, the lights it carries and a route; the
default layout (proposal) is a strip along +x, 160 px apart. It builds on `flyTo`, `lerpPose` (now a plain blend, yaw
the short way round), the 0.2 s cross-fade from the flat page to the scene canvas, and reduced motion's zero
durations.

- **A to B.** Prefetch B's module and art when a link to it is hovered or focused, and mount B inert. Switch to the
  scene layer with the 0.2 s fade and fly: within a strip, pull back to 1.6 D at the midpoint, truck across and push
  in, over about 0.9 s; between scenes, dissolve through an overview. On arrival A turns inert or unmounts, focus
  moves to B's heading (tabindex −1), `document.title` updates, `history.replaceState` stores A's scroll offset in
  A's entry before `history.pushState` adds B's (`history.scrollRestoration = 'manual'`), a polite announcement
  plays, and the view cross-fades back to the islands. Back and forward replay the reverse flight on `popstate` and
  restore the offset.
- **The DOM in flight.** With html-in-canvas every page stays a drawable child of one canvas, since moving UI into a
  drawable canvas blanks it for a frame or two. Without it, each page's live DOM gets its own `matrix3d`, drawn above
  the scene canvas without depth sorting. Reduced motion gets a 200 ms cross-fade without camera motion; without
  WebGPU, or under forced colours, `document.startViewTransition` where it exists, else a plain swap.
- **Changes first.** A page array in a storage buffer replaces the single page plane (`Scene.page`, `planeZ`,
  `planeScale`, one `uiRect`). Turned pages need a general ray–plane test in the shader, whose `rayToZ` (like the
  CPU's `behindPage`) handles planes z = z0 only, and a `cssMatrixForPlane` that takes a page frame. Page textures
  join an array or the tile pool.

### Pages and assets as files, lazy loading and optimizations (M8, after M7)

Pages and their assets "organized into files and lazy loaded and all the optimizations". Proposal: the layout below.
Authoring is Q11.

```text
site/site.json                 routes, scenes, materials (ids → files)
site/materials/<id>.json       optics, macros, behaviors
site/scenes/<id>/scene.json    page placements, gravity, lights, camera, transitions
site/pages/<id>/               page.html (the real DOM, with data-goo bindings), page.ts (optional, lazy),
                               page.json (height, layers, media, lights), assets/ (art, image sequences, video)
site/gobos/<id>.png|ktx2
```

- **Code and HTML.** `import.meta.glob('/site/pages/*/page.ts')` makes each page a lazy chunk, and tsconfig's
  `include` gains `site`. A build step prerenders each route to `dist/<route>/index.html` with its page's DOM inline,
  so content works without JavaScript and can be indexed; the scene runtime enhances it.
- **Loading.** Prefetch on link hover or focus, for pages within one page-width of the 3D view's frustum, and through
  `<link rel="modulepreload">` for the next page. Images decode off the main thread (`createImageBitmap` in a
  worker), upload when idle and get mipmaps. KTX2 (BC on desktop, ASTC or ETC2 on phones) only where the adapter has
  the feature, which `requestDevice` must ask for; its WebAssembly transcoder loads only for pages with KTX2 assets.
- **Snapshots.** The build renders each page small in a headless browser, a new build dependency. Snapshots stand in
  where html-in-canvas is missing, serve far views of tall pages, and hold the place until the art is resident.
- **The fallback** stops loading GPU code. Today the static button still loads 463 KB of JavaScript (128 KB gzip, in
  the latest `dist/` build: the main chunk and the shared TypeGPU chunk it imports). main.ts imports `tgpu` and
  `createGoo` statically, and the always-loaded scene host imports scene.ts, which builds uniforms with TypeGPU's `d`.
  Check for WebGPU first, then `import()` the GPU code; scene.ts returns plain tuples and goo.ts converts them. This
  part can land at any time.

### Scroll-scrubbed video and the frame stack (M9, after M2)

For "full page video animations", scrolling steps through the frames "with the camera locked at that vertical
position", and the frames look like "a transparent stack behind the frontmost and current visible frame". Proposal: a
media layer has a rect, a depth, F frames, a scroll length per frame p (12 px) and a pin position P; pinned segment j
starts at offset s_j and lasts L_j. It needs only M2's scroll mapping; production media hosting (R2) follows M8.

```text
y(s)       = s − Σ_j clamp(s − s_j, 0, L_j)                 camera height on the page (page px)
frame_j(s) = clamp(floor((s − s_j) / p_j), 0, F_j − 1)
s_j = P_j + Σ_{i<j} L_i      L_j = F_j · p_j      total scroll = (page height − window height) + Σ_j L_j
```

- **Normal mode.** The pin is `position: sticky; top: 0` on a window-tall section inside a container L_j taller: the
  DOM holds still while the scroll advances, which is exactly camera.y holding. The spacer shifts everything below it
  (DOM y = page y + Σ L_j of the pins above), so one table converts between the two for layout and the camera. At
  12 px a frame, 240 frames hold the camera for 2880 px, 3.2 windows of 900 px.
- **Frames.** A decoded 1080p RGBA8 frame is 7.9 MiB, and 240 would take 1.85 GiB, so at most 4 full-resolution
  frames stay resident. Start with an image sequence, AVIF or WebP (Q12): each frame decodes on its own, caches at
  the edge and loads progressively, every 8th frame first; 240 frames at 1080p come to about 14–28 MB, against about
  8 MB for WebCodecs with a short GOP at 8 Mb/s. The current frame draws into a 2D canvas in the sticky section; with
  WebGPU the same bitmap goes into a media texture that `pageOnly` samples, so the goo refracts the video.
- **The stack**, in the 3D view first. Frame n sits at the layer's depth and frames n + k (k = 1…K) 8k px behind it,
  so scrolling pulls the stack toward the viewer a frame at a time (Q13). Frame k has opacity 0.25·e^(−(k−1)/10);
  with K = 32, 6.6% of the light gets through. The camera sees only the front frame, and an orbit view fans the stack
  out. Draw instanced quads after the ray-traced pass, back to front, discarding fragments behind the
  scene's depth (the gizmos only dim them); 32 layers of 480×270 take 15.8 MiB. A stack that recedes into the wall
  needs the page art transparent over the video's rect; otherwise it stands in front of the page (Q14).
- **Accessibility.** A decorative video is `aria-hidden`; an informative one needs captions or a transcript. Keyboard
  scrolling scrubs too, nothing plays by itself, and reduced motion gets a still and no pin.

### The goo as a material on base shapes (M10, after M1; research in M13)

The goo as a material effect applied to "base mesh shapes". Proposal: any number of elements, each with its own
material. Today there is one of everything: one `.goo` wrapper, up to 4 smooth-unioned shapes (`MAX_SHAPES`), one
`createGoo` that builds its own pipelines, a label for `buttons[0]` only, one tracker and one levitation. The base
shape is a DOM box with its border radius, as a rounded-box SDF, and the rest profile H0(1 − (1 − t)³)^(1/B) works
for any SDF.

- **Binding.** `data-goo="<material id>"`, the attribute that already marks the button; empty means the default
  material. Overrides through CSS custom properties, such as `--goo-viscosity`, are Q22.
- **Tier 1, flat bases (first).** Ellipse, capsule, polygon and path SDFs; any element's silhouette, by jump flooding
  its mask from an html-in-canvas snapshot or a 2D canvas; text through MSDF. The simulation is unchanged: a grid in
  the footprint's plane, with gravity read in the element's rest frame. Which shapes come first is Q21.
- **Tiers 2 and 3 (research).** Curved primitives (sphere, capsule, rounded box): a shell on one grid per face of a
  cube-sphere, displaced along the base's normal, marched as SDF(base) − shell, and drawn through the scene layer in
  normal mode; the gravity uniforms (`driveX`, `driveY`, the weight in the restoring head) become a per-texel frame
  texture. glTF meshes: front and back depth for the thickness, the simulation on a UV atlas with stitched seams.
- **Many elements.** Pipelines are shared, built outside `createGoo`; textures and uniforms are per instance. Each
  WebGPU canvas holds its own swap-chain textures, so nearby elements share an island and many active ones move to
  the scene layer. An element costs 32 dispatches per frame at 60 Hz (8 substeps × 4) plus pack and detail, more
  while it settles; later one simulation atlas (1-cell gutters, an instance map) keeps the count at 4 per substep.

### Particles that use the materials (M11, after M5 and M10)

"particle effects that can use the materials". Proposal: droplets, splashes and carried blobs, shaded as the same
glass.

- **Storage and motion.** A storage buffer of particles, 48 bytes each (position, volume, velocity, age, material,
  state, owner): 4096 on desktop and 1024 on phones, emitted through an atomic counter by simulation events (M12) or
  the CPU. They integrate world gravity × G_PX (whose scale is Q16) × a gravity scale with linear drag, and collide
  with page planes and with each element's height field in its own frame.
- **Where they go (proposal; Q19).** Gravity runs along an upright page, so a particle in front of it never lands. A
  particle within a contact distance of a page sticks, losing its normal velocity, and slides down with friction from
  its material's adhesion, like a drip on a window. It merges into any goo it reaches and leaves past the page's
  bottom edge as lost volume. Only a throw toward the viewer, or floor gravity, gives a free flight.
- **Merging.** A particle that lands on goo returns its volume to that element's plastic layer. WebGPU has no texture
  atomics, so deposits go through fixed-point integer atomics that a small kernel folds into m; on bare page they go
  into a coarse film per page, in 6 px cells.
- **Rendering**, in both modes: splat spheres into thickness and depth at half resolution, smooth with a two-pass
  bilateral filter, take normals from depth, and shade with the glass terms renderShader.ts exports (`env`,
  `fresnelSchlick`, `ggxSpecular`, `pageOnly`, `highlightShoulder`), on the scene layer or inside an island.
- **Hard parts.** Away from fingers, healing pulls m back toward its target, so deposits fade and splashes refill:
  volume checks run with healing off, and lost volume needs a rule (Q20). The settle layer ignores particles.

### Splashing, sticky and dripping goo (M12, after M11)

A goo variant "where touching it splashes it or sticks to the cursor and could fall off the cursor". Drips, where a
sag runs off, belong here too. If drips should come next (Q15), M11's core can be built for the existing element
first.

- **Splash.** At a rim crest of radius R_c, the Weber number We = ŵ·u²·R_c/(G_PX·T), from the stored inertial flux,
  passes about 5–12; T is the surface tension in px² (0.35 cell² is 3.15 px²). The default putty never splashes
  (est. We ≈ 0.4 for a 300 px/s slap on a 10 px crest); a splashing variant is heavier, with less surface tension. A
  splash kernel after the apply kernel appends up to 32 droplets from the leading rim, at 0.6–1× the finger's
  velocity plus an outward part, and takes their volume out of m.
- **Sticks to the cursor.** A per-material tack. A finger lifting just above the surface pulls up a tent: a tensile
  penalty in the elastic layer and suction in the plastic layer. The strand is a chain of 8 particles with springs
  and surface-tension necking. It breaks past 90 px or once its neck r = √(V/(πL)) is under 1.5 px; a disc sink takes
  its volume V out of m, and the cursor carries a blob of V. The tracker keeps the finger alive until then.
- **Falls off.** The blob rides a spring-damper to the pointer (5 Hz, ζ 0.4), hanging below the hotspot by g/ω², and
  lets go when the spring's pull (ω²·stretch plus damping) exceeds stickiness × g; raw pointer acceleration is too
  noisy to test against. Est., at 1 px = 1 mm (9,807 px/s² per g): the blob hangs about 10 px below, a 300 px flick
  in 120 ms pulls 8.7–12 g, and stickiness 5 sheds the blob only on 300 px moves shorter than about 230 ms. Counted
  in g, these pulls are 3.8 times smaller at the physical scale (37,065/9,807), so the default stickiness waits on
  Q16. A blob that lets go is a particle: it lands on the page and slides down, or merges into goo below.
- **Drip.** The run-off limit becomes detachment: lip volume above it turns into drip particles. Runs over bare page
  also need a dry test on the current height, a lower dewet and a goo canvas that grows downward; the 3D view's march
  slab (`gooTop`) already rises with the settled top. A cursor blob with low stickiness drips after a 3 s hold.
- **Accessibility.** This is play: nothing requires these gestures. Under reduced motion there are no splashes, and
  the blob doesn't follow the cursor; the dent stays. The system cursor stays visible, and the blob hangs below and
  to the right of the hotspot, never over focused text.

### Gravity for objects

The objects half of "a global gravity setting that objects and materials can follow". Particles and free blobs follow
it fully (M11, M12). Floating elements don't yet: the air cushion acts along the page normal, so gravity down an
upright page puts no load on it, and the in-plane part has no degree of freedom to act on. Under floor gravity the
hover height stays the loaded equilibrium (the "carried" convention); an opt-in `levitation.weighted` would sag the
button by weighted·g_n·G_PX/ω², 58.7 px per g at 4 Hz (Q17). A sideways spring, or an adhesive bond past which a
whole element slides as a rigid body, would take the element off its DOM box, so normal mode would need ray-based
input (Q18 asks whether floating elements are screen-anchored or rigid). Later options: a ground plane in the 3D view
as a collider for falling goo (none now, because it would cut through the cool kicker's panel and through tall
pages), device-tilt gravity on phones (Q23), and re-leveling the 3D view to gravity.

### Hosting and docs (M8 and D)

Decided: Cloudflare Workers, eventually, for gui.style (repo `overra/gui.style`); the docs probably go on
useblume.dev (Q25). Proposal: Static Assets first, with no Worker script. `wrangler.jsonc` names the worker
`gui-style` and sets `"assets": { "directory": "./dist", "not_found_handling": "404-page" }`, with
`"single-page-application"` until the routes are prerendered.

- `npm run deploy` runs `npm run build && wrangler deploy`; the build already type-checks. `wrangler versions upload`
  gives preview URLs, which are also how to test on phones: WebGPU needs a secure context, and a LAN `http://` dev
  URL has no `navigator.gpu`. Until a Cloudflare project exists, which takes a `wrangler login` by the account's
  owner, a quick tunnel to the dev server gives an https URL (Q26).
- A `_headers` file sets `Cache-Control: public, max-age=31536000, immutable` on the hashed `/assets/*` and
  revalidation on HTML; check the current Workers support, and test it under `wrangler dev`, since `vite preview`
  ignores it. Static Assets cap each file's size (25 MiB when last checked), so big videos and image sequences go in
  R2, behind a small Worker that answers Range requests.
- The dev harness is dev-only, so production builds get a `?perf` overlay for phones: frame time, GPU time where
  timestamp queries exist, and resident MB. The 3D view's button shows only in dev or with `?scene` or `?tune`, but
  the C key opens the view for anyone, production included (Q24).
- Docs: `docs/*.md` stay the source, tables come from the material schema, and live demos embed gui.style routes.

## Milestones

| ID | Milestone | Size | Needs | Normal mode | Done when |
|---|---|---|---|---|---|
| M0 | Safety net: seeded randomness and event times, `__goo.diff`, `__goo.sim.stats`, `__goo.glass`, test arts, `?tall`, `?perf`; fresh size, parity and budget baselines; phone testing over https | S | – | unchanged | Two seeded runs give identical frames; the baselines are recorded |
| M1 | Scene document v1; materials as data | M | M0 | identical | `export()` and `load()` round-trip; `identity()` is 0; seeded frames are unchanged |
| M2 | Camera height, tall pages, Shift+scroll, `viewCenter`, the 3D view's window/page split, device limits, tiles | L | M1 | scrolling made correct | `?tall=6000` runs at DPR 2; scrolled 1200 px on `?tall=3000&at=1200&art=flat`, the goo matches scroll 0 within 1 LSB; a 300 px Shift+wheel moves the frustum 300 px, and exit lands at `scrollY` 300 |
| M3 | DOF and tilt-shift in the 3D view | M | M1 | unchanged | On `?art=bars` the 10–90% edge width follows 0.69·CoC, about 7.4 px at the bottom edge with the band preset |
| M4 | Spot lights and gobos in the 3D view | M | M1 | unchanged | The stripe period at the spot's centre matches the projection; with no spot, `identity()` is 0 |
| M5 | Scene layer in normal mode | L | M2 | opt-in | `mode('full')` matches the islands within a mean of 1/255 over the goo box; real flings keep the art registered with the DOM; no frames after 10 s idle |
| M6 | Optics and gobos in normal mode: page blur and glass LOD in islands, tilt-shift on the scene layer, spots in the glass | M | M3, M4, M5 | opt-in | The page seen through the goo blurs like the page beside it; with the lens off, frames are unchanged |
| M7 | Several pages per scene, transitions | L | M2, M5 | yes | After `nav.go('/b')` focus is on B's heading, A is `inert` and `history.state.page` is 'b'; `history.back()` restores A and its scroll; reduced motion shows no camera motion |
| M8 | Pages as files, lazy loading, prerendered routes, production hosting | M | M7 | yes | B's chunk loads only after a link to it is hovered; no GPU chunk loads without WebGPU; hashed assets come back `immutable` under `wrangler dev` |
| M9 | Scroll-scrubbed video and the frame stack, from local image sequences; R2 media with M8 | M–L | M2 | yes | `media.state()` reports frame 100 at s_j + 100·p; `camera.y` holds at P during the pin; an orbit shot shows the stack |
| M10 | Materials on flat base shapes, many elements | L | M1 | yes | Two elements with different materials press independently; the default material's seeded frames are unchanged |
| M11 | Particles | L | M5, M10 | opt-in | With healing off, putty, particle and lost volume sum to a constant within 0.5% |
| M12 | Splash, sticky cursor, drip | M | M11 | opt-in | A slow 300 px move keeps the cursor blob and a 120 ms one sheds it; a released blob lands and merges, conserving volume |
| M13 | Research: curved primitives and meshes | XL | M10 | – | – |
| D | Docs site | S | M8 | – | – |

## Build order

1. **Re-found:** M0, then M1. Normal mode stays bit-identical, checked with `identity()` and seeded pixel diffs.
2. **Look development in the 3D view:** M3 and M4, alongside M2; neither touches normal mode.
3. **The camera:** M2, then M9 and M3's scrolling demo. M2 is the keystone: the camera's height, tall pages and the
   scroll mapping underlie the focus band, video pinning and the frames of several pages.
4. **Normal mode:** M5, then M6. Do the fork once, after the camera has settled and before the features that need it.
5. **The site:** M7, then M8 and the docs site.

The materials track (M10, M11, M12, then the M13 research) runs alongside steps 2 to 5 from M1 on, because it touches
only the simulation and glass instancing. Particles wait for M5.

## Risks

| Risk | Mitigation |
|---|---|
| Default WebGPU limits (8192 px textures, 256 array layers, 16 sampled and 4 storage textures per stage, 64 KiB uniform bindings), which `requestDevice` doesn't raise; optional features (`float32-filterable`, `timestamp-query`, `texture-compression-bc`/`-astc`/`-etc2`, `shader-f16`, `subgroups`) vary by device | Request the adapter's limits and features; tile pools, texture arrays, storage buffers; rgba16float packing for filtered reads; CPU frame timing and uncompressed fallbacks |
| The adapter is requested as `'low-power'`, which hurts full-viewport effects on dual-GPU laptops | Keep it for islands. A device can't share textures with another, so choose at bring-up from what the scene needs |
| No texture or float atomics; external video textures expire at the end of each task | Fixed-point integer atomics for deposits; copy video frames into a ring texture |
| Each WebGPU canvas holds its own swap-chain textures, and gets a fresh texture for every frame it draws | Share islands between nearby elements; redraw the scene layer whole, or blit; islands stay the idle path |
| Shader compile time on phones: one large `sceneFragment`, and the 3D view compiles on first use | Split passes; compile ahead with `initAsync`, as `goo.ready()` does; warm pipelines when idle |
| TypeGPU 0.12 is pre-1.0 (`root['~unstable'].createCommandEncoder()`) behind caret ranges, and TGSL has rules: `d.f32` for integer literals, `std.select` for vector ternaries, 16-byte uniform array strides, derivatives only in uniform control flow | Pin exact versions and upgrade behind `identity()` and seeded pixel checks; follow `sceneFragment` (derivative terms first, explicit LOD inside branches) |
| Device loss; WebGPU reach, last checked in late 2025: Chrome and Edge on desktop, Chrome on Android 12+ with some GPUs, Safari 26, Firefox on Windows | Every resource rebuilds from CPU sources (`start()` retries after the first two losses in a minute and gives up at the third); recheck reach; keep the static fallback |
| html-in-canvas is Chrome and Edge 157+ only; WebKit leans toward support, Mozilla has no position | Every feature keeps a path without it: CSS 3D (no depth sorting, no shader effects on the DOM) or build-time snapshots |
| 3D hit testing under html-in-canvas needs `updateElementGeometry`; perspective `canvasTransform`s are unconfirmed; UI blanks for a frame or two moving into a drawable canvas, snapshots lag paint, and cross-origin content and system colours aren't painted | Picking by rays, as `gooHit` does, with a page interactive only while it faces the camera; pages drawable permanently; the previous texture held until the first paint |
| Full-viewport tracing on phones (about 1.3 MP at DPR 2, 96 march steps plus the glass) is unlikely to hold 60 Hz on mid-range GPUs (not measured); thermal throttling, tab kills and iOS canvas-area limits | Islands by default; dynamic resolution; half-resolution effects; the march is already culled to the element's box; resident budgets with an LRU; at most 4 decoded video frames; budget tests on real phones from M0 |
| Drawn UI loses semantics, focus, find-in-page, translation, zoom, forced colours and user styles; the 3D view is mostly canvas | The DOM is the truth and WebGPU only draws it; the lil-gui panel, the shortcuts (C, Esc, F, O, V) and keyboard camera moves cover the 3D view |
| DOF, gobos over text and translucent stacks hurt legibility | Interactive and focused elements stay sharp; `prefers-contrast: more` turns DOF and gobos over text off; a user toggle |

## Budgets (proposal; measure in M0)

| | Desktop | Phone (mid-range, 60 Hz) |
|---|---|---|
| Idle | 0: the loop sleeps, as now | 0 |
| Pressing one element (islands) | ≤ 2 ms GPU | ≤ 4 ms GPU |
| Scene layer in normal mode | ≤ 6 ms at ≤ 3.2 MP | ≤ 8 ms at ≤ 1.3 MP, with dynamic resolution |
| 3D view | Holds the display's 120 Hz while orbiting now (an 8.3 ms frame interval on an M-series GPU; GPU time not measured) | ≤ 12 ms at ≤ 1 MP |
| GPU memory | ≤ 512 MB | ≤ 256 MB |
| First-load JavaScript, home route | 128 KB gzip (463 KB) in the latest `dist/` build; M0 records the baseline | The same; the static fallback loads no GPU code |
| Particles | 4096 | 1024 |

## Dev harness additions

Pitfalls that still apply: a hidden pane gets no rAF, `ResizeObserver` or scroll callbacks, so call
`__goo.relayout()` after changing layout or scrolling. After `enter()` or `exit()`, run `shot(1500)` or
`drive(1000)`, because the wheel and the shortcuts work only once the 3D view's phase is 'on'. Until `__goo.seed`
exists, compare pixels within one page load, or replace `Math.random` with a seeded generator and repaint first (a
`resize` event). Across builds, also wait 20 s after load: the intro's set factor reaches exactly 1 only after about
9.6 s in f32 and 19.5 s in f64. Test html-in-canvas in Chrome 157 or later (Chrome 158, through Claude in Chrome) and
the fallbacks in the in-app browser (Chromium 152). Dispatched events skip hit testing, so check real pointer paths
with `document.elementFromPoint` or real drags.

| New | Milestone | What it does |
|---|---|---|
| `__goo.seed(n)` | M0 | Seeds `Math.random` (the page grain, the finger angle, tap jitter), resets the tracker's print seeds and repaints the page; on the virtual clock, input takes its event times from that clock |
| `__goo.diff(a, b, rect?)` | M0 | `{ mean, max, over1 }` in 8-bit units, after resampling both canvases to CSS px over `rect` (the scene and goo canvases have different scales) |
| `__goo.sim.stats(element?)` | M0 | Volume Σ(rest + m)·cell², centroid and the range of m, built on the existing `__goo.readSim()` readback |
| `__goo.glass()` | M0 | The last glass uniforms written |
| `?art=flat`, `?art=bars`, `?tall=N&at=M`, `?perf` | M0 | A solid and a high-contrast test art; a page N px taller, with M px of the extra above `.stage`; the perf overlay |
| `__goo.scene.export()`, `load(doc)` | M1 | Round-trips the scene document |
| `__goo.scrollTo(y)`, `__goo.scene.camera.scrollTo(s)`, `.y` | M2 | Scrolls the page's scroller and re-measures; moves the scene camera; reads its height on the page |
| `config().dev.setOptics(o)`, `dev.cocAt(x, y)` | M3 | Lens settings (`debug: true` shows CoC as a heat map); the expected CoC at a point |
| `__goo.scene.addLight(l)` | M4 | Adds a light that the shader, the panel and `reset()` all see |
| `__goo.scene.mode('islands' or 'full')` | M5 | Forces a renderer, for A/B parity |
| `__goo.nav.go(route)`, `__goo.reducedMotion(on)` | M7 | Navigates; overrides the reduced-motion queries and sets a class that the CSS's reduced-motion rules also key on |
| `__goo.media.state()` | M9 | `{ frame, resident, pending }` |
| `__goo.press(fx, fy, type, element)` | M10 | Presses any element; today `__goo.press` presses `buttons[0]` |
| `__goo.particles.spawn(o)`, `.stats()`, `.volume()`, `.set(id, o)` | M11 | Particle checks and volume bookkeeping, lost volume included |

## Open questions

1. Keep the glass's studio page-relative, in front of the page (normal mode unchanged), or move it to world up?
2. When gravity returns to a value the material can hold, re-mold to the molded shape (as now) or stay sagged?
3. The settle layer fast-forwards a sag's slow tail ×4 after 6 s; without that, a honey-like slump would keep the loop
   awake for about 100 s. Keep it, or play the whole slump in real time?
4. The yield is tested per face, so the putty holds up to √2 more against a diagonal pull than a straight one. Make
   it isotropic now (this changes presses), or later?
5. Is pushed-back art anchored to the wall as the camera scrolls (parallax at D/(D + g)), or locked to the camera?
6. Tilt the focal plane (the camera stays square, so the DOM and input stay exact) or pitch the camera (the page
   recedes, with keystone)? A receding blur, sharp at and below the focus line, or a band, sharp only at it? Where
   does the line sit by default (the presets say 60% and 30% down)?
7. In normal mode, does DOF blur live DOM text (html-in-canvas in Chrome 157+, CSS bands elsewhere), or only the art
   and the glass? Do interactive elements always stay sharp?
8. Gobos in the 3D view first, with only glass highlights in normal mode? On a self-lit page, hidden or additive?
9. By default, are lights anchored in the world, carried by pages, or carried by elements?
10. Is a scene a group of pages (camera moves within, dissolves between), or is every page its own scene? Are its
    pages artboards side by side on a wall, one long page, a stack in depth, a ring, or turned about world up?
11. How are pages authored: HTML fragments plus TypeScript and JSON, or a component framework?
12. For video, image sequences first or WebCodecs from the start? And how long can a video be?
13. Is the frame stack the upcoming frames or the ones already shown, and as you scroll, does the front frame peel
    off toward you or does the whole stack slide forward?
14. Does the stack recede into the wall behind the video (the page see-through there) or stand in front of the page,
    and does it show outside the 3D view, for example as faint ghosts in normal mode?
15. Is the run-off limit the right stand-in until drips exist, or should drips come next?
16. Particles and rigid bodies at the physical scale, G_PX ≈ 37,065 px/s² per g (a 100 px fall takes 73 ms, a 4 Hz
    spring sags 58.7 px), or at a scene scale such as 1 px = 1 mm, 9,807 px/s² (143 ms, 15.5 px)? Should the putty's
    weight follow it, so a billboard-sized element sags?
17. Should a levitating button carry weight (sagging along its cushion under floor gravity, or sideways under gravity
    down the page, off its DOM box), or keep the "carried" convention?
18. Screen-anchored or rigid levitation? Under a scrolling camera a screen-anchored button slides across the page by
    3% of the scroll at 40 px hover; a rigid one parallaxes against it, which CSS `translateZ` in a perspective
    scroller can show with native input.
19. Do splashes and dropped blobs stick to an upright page and slide down it like drips on a window, or fly in front
    of it and fall out of view? Do they stain the page, as a film that dries or heals?
20. When drips, splashes or carried blobs take volume away, should healing regrow it, or heal toward the molded shape
    scaled by the remaining volume? Must volume be conserved at all, given that the source heals anyway?
21. Which base mesh shapes come first: flat outlines of any element, analytic solids, or imported glTF meshes?
22. Should materials accept overrides through CSS custom properties, such as `--goo-viscosity`?
23. Should phones offer device-tilt gravity, which needs a permission prompt on iOS?
24. Do visitors get the 3D view in production, and on phones? Today the C key opens it for anyone.
25. Do the docs live on useblume.dev or under gui.style, and which generator builds them?
26. Set up a Cloudflare project for preview deploys in M0 (the account's owner runs `wrangler login`), or test phones
    through a tunnel to the dev server until M8?
