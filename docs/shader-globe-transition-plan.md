# Shader-Globe Transition Plan

Migrating from per-hex prism geometry to a smooth sphere with shader-based hex
rendering, so we can scale from ~16k hexes to 1M+ without melting the GPU or
the mesh-build wall time.

---

## TL;DR

- **Current architecture:** every hex is a real hexagonal prism with ~1170
  verts. At 16k hexes that's ~20M verts, ~17s mesh build, GPU is fine but no
  headroom for a more complex world.
- **Target architecture:** the planet is a smooth, subdivided sphere mesh.
  Per-hex data (terrain, height, owner) lives in textures. The fragment
  shader draws hex outlines and biome colors by sampling those textures.
  Cliffs come from vertex displacement plus noise.
- **Why:** decouples hex *count* from vertex *count*, lifting the cap from
  ~250k hexes to 1M+ trivially. Painting becomes a single texel write.
  Mesh build goes from 17s to <1s.
- **Effort:** 5–7 weeks full-time, 3–5 months at part-time pace.

---

## Decisions up front (with rationale)

### 1. Target stack: WebGL2 + Babylon.js (not WebGPU)

Babylon's WebGL2 path is mature and the current code already lives there.
WebGPU would unlock compute shaders for terrain generation, but the browser
support gaps and Babylon WebGPU edge-case bugs don't justify stacking that
risk on top of the architecture rewrite. If we hit a wall later, WebGPU
porting is incremental.

### 2. Tessellation-shader-driven sphere, NOT a uniformly dense one

A uniformly dense sphere with enough verts for sharp cliffs (1–2M) wastes
most of its geometry on the back side of the planet and on smooth ocean.
Tessellation shaders let the GPU subdivide adaptively where the camera
actually is.

If tessellation turns out to be unreliable in WebGL2 (it's an extension,
not core in WebGL2 base), fall back to multi-LOD meshes (3–4 levels swapped
by camera distance). Decide at end of Phase 3 based on testing.

### 3. Hex data lives in textures, indexed by hex ID

A single RGBA8 1024×1024 texture stores one byte per channel per hex
(terrain ID, height level, owner, flags). 1024² = ~1M hexes per texture,
exactly the scale we want. Packing decisions in Phase 1.

### 4. Hex lookup in the shader uses icosphere index, NOT a screen-space lookup

Given a world position, walk the icosahedron faces to find which one
contains the point, then walk that face's local hex grid. This is the
existing CPU `pickHex` algorithm but in GLSL. Same math the CPU side
already uses.

### 5. Keep old and new renderers behind a feature flag throughout

A boolean `USE_SHADER_GLOBE` in `globe.ts`, set via a query param or env
variable. Both code paths coexist until the new one is verified at parity.
Reduces "everything broken at once" risk.

### 6. Cliffs use vertex displacement + noise, NOT separate cliff geometry

Strategy 3 + 4 (flat hex top + steep noisy transition) from the cliff
explanation. We give up overhangs in exchange for unlimited hex count and
natural cliff appearance. Stratification noise added in Phase 6.

### 7. Existing terrain shader logic is PORTED, not rewritten

Most of the GLSL math in `terrain-material.ts` survives — what changes is
*where the inputs come from* (texture sample vs. vertex attribute). Keep
the existing palettes, blend curves, beach overlay logic intact. Reduces
risk of art regression.

### 8. Painting becomes a single texel write

`setHexTerrain` writes one byte to the data texture using
`engine.updateRawTexture` or `texture.update`. Goes from "rebuild this
cell's verts and re-upload range" to "write 1 byte." Worth it on its own.

---

## Phase 0 — De-risk & instrument (1–2 days)

**Goal:** know what we're optimizing and have a way to compare old vs. new
objectively.

**Tasks:**

- Add a hidden GPU-time measurement that doesn't break rendering. Use
  `EXT_disjoint_timer_query_webgl2` ourselves with safer wrapping than
  `EngineInstrumentation`. Keep behind a query-param flag; off by default.
- Add a "Render mode" dropdown in the View panel: **Legacy / Shader (preview)**.
  For now, only Legacy works.
- Add a benchmark mode: orbit the camera through 8 fixed waypoints over 16s,
  log min / median / 99th percentile frame ms.
- Snapshot current visual output at 4 standard camera positions (top-down,
  near-horizon, equator, polar). Save as PNG references for visual regression
  checks later.

**Deliverable:** can run a benchmark and get reproducible numbers; have visual
references locked in.

---

## Phase 1 — Hex data textures (2–3 days)

**Goal:** stop carrying per-hex data in vertex attributes. Move it into
textures. Don't change rendering yet — keep rendering from the old mesh,
but read its inputs from textures so we know the texture layout works.

**New file:** `src/lib/engine/hex-data-textures.ts`

```typescript
export interface HexDataTextures {
  terrain: RawTexture;     // R = terrain id, GBA reserved
  height: RawTexture;      // R = height level (0..4), G = cliff style, BA reserved
  owner: RawTexture;       // R = owner id (for future gameplay)
  size: number;            // texture side length (1024 for ≤1M hexes)
  capacity: number;        // size * size
}

export function createHexDataTextures(cells: HexCell[], scene: Scene): HexDataTextures
export function updateHex(tex: HexDataTextures, hexId: number, terrain: number, height: number): void
```

**Layout decision:** `pixelIndex = hexId`, with `x = hexId % size`,
`y = floor(hexId / size)`. Linear, simplest possible. Hex IDs are stable
(already assigned in `icosphere.ts`).

**Format decision:** `Engine.TEXTUREFORMAT_RGBA` +
`Engine.TEXTURETYPE_UNSIGNED_BYTE`. 4 bytes per hex per texture, 4 channels
free for future expansion. Three textures = 12 bytes per hex total. At 1M
hexes that's 12 MB GPU mem — trivial.

**Why three textures, not one packed texture:**
Different update frequencies. Terrain gets painted one hex at a time; owner
gets bulk-rewritten when borders shift; height is mostly static. Separate
textures = cheap partial updates. Packing can come later if VRAM matters;
it won't.

**Validate:** write a debug mode that reads texture data on the GPU side and
renders it as a flat color overlay on the legacy mesh. Confirm hex N's color
matches `cells[N].terrain` for all hexes.

**Deliverable:** texture system working end-to-end, alongside legacy renderer.

---

## Phase 2 — Hex ID lookup in GLSL (3–5 days, highest technical risk)

**Goal:** given a 3D world position on the sphere, return the hex ID it falls
in. Computed entirely on the GPU.

**This is the load-bearing piece.** If it's too expensive in the shader, the
whole approach is in trouble. Spike it first, alone, before committing to the
rest.

**Tasks:**

- Read `icosphere.ts` carefully. Document the algorithm: how do you go from a
  world point to a hex? It's almost certainly two steps:
  1. Find which of the 20 icosahedron faces the point lies in (ray-triangle
     test or precomputed face-plane comparisons).
  2. Within that face, find which hex/pent the point belongs to via the
     face's local 2D hex grid.
- Port both steps into a GLSL function:
  `int worldPosToHexId(vec3 normalizedSpherePos)`.
- Stand up a debug visualization: render the legacy sphere mesh with a
  fragment shader that calls `worldPosToHexId` and outputs
  `vec3(float(hexId % 256) / 255, ...)` — a "hex ID color heat map."
  Visually verify it matches `pickHex`.

**Performance budget:** the lookup runs once per fragment. At 1080p that's
~2M calls/frame. Shader can comfortably do ~10ns per call before this
dominates frame time. Keep iteration counts bounded; precompute face data
into a uniform buffer.

**Decisions to make during this phase:**

- *Face lookup method.* Trivially: dot product against 20 face normals, pick
  the largest. ~20 ops, branchless, fast. Don't bother with anything more
  clever first.
- *In-face hex lookup.* Hardest part. Each icosphere face has `res²` hexes
  arranged in a triangular grid. Convert the 3D point to face-local 2D
  coordinates (project onto face plane), then index a 2D triangular hex grid.
  This is `mod`/`floor` arithmetic — finite cost, no loops.
- *Pentagon handling.* The 12 pentagons are special cases (one per vertex of
  the icosahedron). Detect at start by checking if the point is within
  angular threshold of an icosahedron vertex; if so, return the pentagon's
  hex ID directly. Handle before face lookup.

**Visual regression test:** the heat-map shader on the legacy mesh should
produce output identical to a CPU-rendered "color by hexId" sanity check.

**Deliverable:** `worldPosToHexId(p)` works correctly and runs at full FPS
on the legacy mesh. If perf is bad here, **stop and rethink** (consider a
precomputed cube-map "hexId texture" as a fallback — slower to update, but
simpler).

---

## Phase 3 — Smooth sphere base mesh (2–3 days)

**Goal:** stand up the new mesh with NO terrain shading yet. Just confirm we
can render a smooth subdivided sphere alongside the legacy mesh.

**Tasks:**

- Build a uniform icosphere with ~200k–500k verts. Babylon has
  `MeshBuilder.CreateIcoSphere` — use it. No per-hex prism logic.
- New file: `src/lib/engine/shader-globe-mesh.ts` — builds and owns this mesh.
- Wire the `Render mode` dropdown so "Shader (preview)" hides the legacy
  mesh and shows the new one.
- New material: `src/lib/engine/shader-globe-material.ts`. Initial fragment
  shader = single flat color. Initial vertex shader = no displacement.
- Verify: switching to Shader mode shows a uniform-colored sphere at correct
  position and size.

**Decision: tessellation now or later?**

*Later.* Get a static dense mesh working first. Only escalate to tessellation
if Phase 8 perf testing demands it.

**Deliverable:** a flat-colored sphere shows up under the new render mode.
Legacy mode unchanged.

---

## Phase 4 — Port terrain shading to texture-driven (5–8 days, biggest piece)

**Goal:** the new sphere looks identical to the legacy globe at 60 fps with
no elevation yet (everything at sea level).

This is where the existing `terrain-material.ts` GLSL gets ported. Keep
palette logic, blend curves, beach overlay math, lighting — change only the
data sources.

### Mapping from old vertex inputs to new texture lookups

| Old vertex attribute | New shader operation |
|---|---|
| `vColor.r` (terrain ID) | `texelFetch(terrainTex, hexCoord(hexId)).r * 255` |
| `vColor.g` (neighbor ID + blend) | look up nearest 3 hex IDs (current + 2 nearest neighbors), compute blend from `distanceToHexEdge` |
| `vColor.b` (heightLevel × 0.1 + cliffProx × 0.09) | `texelFetch(heightTex, ...).r` for level; cliff proximity computed from `distanceToHexEdge` against neighbors with different height |
| `vColor.a` (coast proximity) | computed from `distanceToHexEdge` against water/land neighbors |

### The blending decision

The current vertex-based blend interpolates between hex colors using the GPU's
per-fragment interpolation of vertex attributes. The new version explicitly
samples 2–3 nearby hex IDs and blends in the fragment shader. Slightly more
work per fragment but full control over blend shape.

### `distanceToHexEdge` is the key new helper

A function in the shader that, given a world position and the hex ID it falls
in, returns:

- distance to the nearest hex edge
- which neighbor hex is across that edge
- (optionally) distance to the nearest hex corner

Implement as: take the in-face 2D coordinates from Phase 2, compute distance
to each of the 6 (or 5) edges of the cell using line equations of the hex's
edges. Math is bounded and cheap.

### Sub-phases inside Phase 4

1. **Solid-color hexes from terrain texture.** No blending, no overlays. Just
   "what color is this hex." Verify visually against legacy.
2. **Cross-hex blending.** Sample neighbor hex, blend within last 15% of
   distance to edge. Verify smooth transitions match old look.
3. **Beach overlay.** Port `GLSL_BEACH_OVERLAY` logic — same math, but coast
   proximity is now from `distanceToHexEdge` rather than `vColor.a`.
4. **Cliff color (no geometry yet).** Port `GLSL_CLIFF_RENDERING` section.
   Cliff proximity computed similarly.
5. **Lighting.** `GLSL_LIGHTING` should port as-is — it operates on world-space
   normal and view direction, which haven't changed.

**Visual regression at every sub-phase:** screenshot at the 4 reference camera
positions, diff against Phase 0 references. Threshold for "good": <2% pixel
difference in the central globe area, ignoring AA at the silhouette.

**Deliverable:** legacy and shader modes look indistinguishable when both
render the same world data. Performance: shader mode should ALREADY be
substantially faster than legacy at this stage because the mesh is much
smaller, even without elevation.

---

## Phase 5 — Vertex displacement for elevation (3–4 days)

**Goal:** bring back the height tiers. Hex tops at correct elevation, with
sharp transitions between hexes.

### Vertex shader gets

```glsl
vec3 normalizedPos = normalize(position);
int hexId = worldPosToHexId(normalizedPos);
float ownHeight = sampleHeight(hexId);

// Strategy 3: flat hex top + sharp transition near edge
EdgeInfo e = distanceToHexEdge(normalizedPos, hexId);
float neighborHeight = sampleHeight(e.neighborHexId);
float t = smoothstep(0.0, 0.15, e.distance);
float h = mix(neighborHeight, ownHeight, t);

vec3 displacedPos = normalizedPos * (EARTH_RADIUS + h * HEIGHT_SCALE);
gl_Position = projection * view * vec4(displacedPos, 1);
```

### Decisions in this phase

- *Where does cliff proximity for the FRAGMENT shader come from?* The same
  `EdgeInfo.distance` computed in vertex shader, plus delta in heights between
  own and neighbor. Pass via varying or recompute per-fragment (recomputing is
  ~free, avoids varying interpolation artifacts at hex corners — recommended).
- *Mesh density required.* Strategy 3's transition is 15% of a hex. With
  ~1024² hexes (~6M km² each, edge ~200 m at planet scale — do the math
  against `EARTH_RADIUS_KM`). For a sharp visual cliff, mesh quads need to be
  smaller than `0.15 × hexEdgeLength`. At 200k verts on the sphere, average
  vert spacing is ~1.4 km — too coarse for hex edges shorter than ~10 km.
  Likely we need **at least 1M base verts**, OR tessellation. Decide based on
  actual rendering of Phase 5 sub-phase 1.
- *Height scale.* Same constants as today (`LEVEL_HEIGHTS` from
  `hex-borders.ts`). Reuse directly so heights match.
- *Camera collision / frustum.* `camera.maxZ` and `camera.minZ` may need
  tweaks — the planet is now visually identical but the bounding sphere
  computed by Babylon will be slightly different.

**Visual regression check:** profile views from the side should show
terraced heights matching the current cliff system (modulo natural-vs-boxy
edges).

**Deliverable:** shader globe shows terrain elevation; cliffs visible as
steep transitions; FPS still good.

---

## Phase 6 — Natural cliff detail via noise (3–4 days)

**Goal:** make the cliff faces look like rock instead of a smooth ramp. This
is "art-tunable" work, not technical risk.

**Tasks:**

- Add 3D noise function to vertex shader (Perlin or simplex; existing GLSL
  libraries are tiny). Keep it as a separate file
  `src/lib/engine/shaders/noise.glsl` and `#include` it.
- Compute `cliffness = 1 - smoothstep(0, 0.15, distanceToHexEdge)` (1 near
  edge, 0 in center).
- Compute `heightDelta = abs(ownHeight - neighborHeight)`.
- `displacement += cliffness * smoothstep(0, 1, heightDelta) * noise3D(pos * NOISE_FREQ) * NOISE_AMP`.
- Add a `cliffStyle` byte in the height texture to vary noise per terrain
  type (rock cliffs have high-freq jagged noise; sand cliffs have low-freq
  smooth noise; ice cliffs have stratification noise).
- Expose `NOISE_FREQ` and `NOISE_AMP` as material settings, tunable via the
  existing Cliffs tab in the UI.

### Decisions

- *Noise type.* 3-octave simplex noise. Cheap, well-known, results look
  organic. Don't reach for fancier first.
- *Stratification.* Add a second noise term `noise(altitude * STRATA_FREQ)`
  projected onto the cliff face direction — gives visible rock layers.
  Optional polish.
- *Where to evaluate noise.* Vertex shader, not fragment. Fragment-shader
  noise displacement (parallax mapping) is an additional possible polish
  step but breaks the pixel-perfect picking story. Keep noise on vertices.

**Deliverable:** cliffs that look hand-painted rather than CAD-extruded. The
Cliffs tab can drive the look without code changes.

---

## Phase 7 — Painting and click handling (1–2 days)

**Goal:** the editor side of the app works against the new renderer.

**Tasks:**

- `setHexTerrain(cellIndex, terrain)`: write 1 texel to `terrainTexture`.
  Use `RawTexture.update()` with the modified subarray. Single-texel
  updates cost almost nothing — well under 1 ms even with the GPU upload
  pipeline.
- `pickHex(sx, sy)`: unchanged. Already picks against `pickSphere`, gets a
  world point, then runs `pickHex` math on the CPU. Same result.
- Hex grid wireframe overlay: today this is a separate `LinesMesh`. With the
  new approach, draw hex outlines in the fragment shader (line at
  `distanceToHexEdge < 0.005`, painted on top of terrain). Toggleable.
  Removes another mesh from the scene.

**Visual regression:** paint a hex, confirm it changes color exactly as
before; toggle grid, confirm outlines match old.

**Deliverable:** all editor functions work in shader mode. No regression.

---

## Phase 8 — Optimize for scale (4–7 days, final stretch)

**Goal:** confirm we can hit 1M hexes at 60 fps with headroom.

**Tasks in priority order:**

1. **Bump `ICO_RESOLUTION` to 100, then 200, then higher.** With shader mode,
   mesh build no longer scales with hex count — only the data texture size
   and `worldPosToHexId` parameters change. Find the actual perf cliff.
2. **Frustum cull the back hemisphere.** Replace the single sphere mesh with
   N submeshes (one per icosahedron face = 20 submeshes), enable/disable each
   per frame based on dot product with camera-to-origin. Frees ~50% of vertex
   throughput. (Babylon `SubMesh` or just multiple meshes with `setEnabled`.)
3. **Tessellation shader (only if needed).** If fixed-density base sphere
   isn't sharp enough at high zoom, switch the base mesh to a low-poly
   icosphere and add a tessellation control + evaluation shader that
   subdivides triangles within camera radius. This is non-trivial — budget
   separately and only if step 1 isn't enough.
4. **Texture mips for the data textures.** Mip levels 1–4 of `terrainTexture`
   give "average terrain over 4-hex regions." Lets the fragment shader sample
   a coarser mip when far from camera, reducing per-fragment work. Be
   careful: nearest-neighbor filtering only — bilinear filtering on hex-ID
   textures would corrupt IDs.
5. **WebGPU port (only if WebGL2 isn't enough).** Reserve as a last resort.

### Acceptance criteria

- 1M hexes (`ICO_RESOLUTION ≈ 316`)
- 60 fps locked on dev hardware at all 4 reference camera positions, including
  high tilt
- ≤ 8 ms GPU frame time on RTX 2060 (tested on actual hardware)
- ≤ 5 s mesh build wall time (mostly the smooth sphere mesh; the data
  textures generate in <100 ms)
- Visual regression < 2% pixel difference from current (modulo natural cliffs)

---

## What stays untouched

- `src/lib/world/terrain-types.ts` — palettes, blend params, tier definitions
- `src/lib/engine/icosphere.ts` — the hex grid generator. Still needed for
  `cells[]` data and as the reference algorithm for the GLSL port.
- `src/lib/engine/terrain-gen.ts` — runs once at startup to fill the data
  textures. Logic unchanged.
- `src/lib/engine/water-material.ts` — water sphere is already a smooth
  sphere; only minor tweaks for new depth texture binding.
- Camera, lighting, FXAA — untouched.
- Click → hex → setHexTerrain UI flow — untouched.

## What gets retired (eventually)

- `src/lib/engine/globe-mesh.ts` — the per-hex prism builder. Keep around
  behind the feature flag through Phase 7, delete after Phase 8 acceptance.
- `src/lib/engine/vertex-encoding.ts` — RGBA packing for vertex attributes.
  Logic moves into texture writes; the file itself becomes the texture-write
  helpers.
- `src/lib/engine/mesh-smoothing.ts` — irrelevant once geometry is a smooth
  sphere.
- `src/lib/engine/hex-distance-fields.ts` — distances baked at build time.
  Replaced by `distanceToHexEdge` shader function. Logic largely portable.

`src/lib/engine/hex-borders.ts` survives in modified form — neighbor
classification still useful but consumed differently.

---

## Risk register

| Risk | Probability | Mitigation |
|---|---|---|
| `worldPosToHexId` too expensive in fragment shader | medium | Phase 2 spike before committing. Fallback: precomputed cube-map ID texture (slower to update, simpler shader). |
| Cliff sharpness limited by mesh density | high | Tessellation in Phase 8. Have a working multi-LOD fallback ready. |
| Visual regression in biome blends | medium | Reference screenshots at every sub-phase, automated diff. |
| WebGL2 vertex shader can't sample textures on some drivers | low | Standard since WebGL2; if hit, fall back to passing height per-vertex via a precomputed buffer (defeats the rebuild story but works). |
| Tessellation shader unreliable in WebGL2 | medium | Multi-LOD mesh fallback decided at Phase 3 end. |
| Pentagon edge cases break hex math | medium | Dedicated unit tests for the 12 pentagons in CPU `pickHex` first; mirror in GLSL. |
| Mesh build never gets faster because we forget to remove old code | low | Feature-flag enforced throughout. Final cleanup in Phase 8 acceptance. |

---

## Estimated effort

- Solo dev, full-time: **5–7 weeks** to acceptance criteria.
- Side-project pace (10 h/week): **3–5 months.**

Phase 4 (terrain shading port) and Phase 8 (scale optimization) are the
longest poles. Phases 0–3 are mostly tractable; Phase 2 has the highest
single-task risk.

If a hard 1M-hex deadline isn't on a 2-month horizon, do this on a branch and
merge in Phase 7 (when feature parity is reached) rather than Phase 8 (when
it's optimized). That way you can ship the rewrite at parity and tune scale
incrementally afterward.

---

## What to do first

1. Phase 0 instrumentation + reference screenshots. Half a day.
2. **Phase 2 spike on a throwaway branch.** Just `worldPosToHexId` working
   in a debug shader on the legacy mesh. If this isn't fast enough, the
   entire plan needs reconsidering. ~3 days. Don't write any of the rest
   until this works.
3. Then commit to Phases 1–8 in order, one PR per phase, with the feature
   flag preserving the legacy path the whole way.

**Phase 2 is the make-or-break technical decision. Do it before everything
else.**
