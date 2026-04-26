# Scaling the Legacy Renderer to 1M+ Hexes

The legacy per-hex-prism mesh produces the visuals we want. The only
problem is it doesn't scale: 16k hexes ≈ 19M verts and ~17s build,
1M hexes naïvely ≈ 1.15B verts and ~17min build. This doc lists
approaches that get us to 1M+ hexes **without changing the visuals**
(or with changes only at scales where the difference is invisible).

## Approach summary

Five approaches, ranked by how much they actually move us toward 1M+
hexes.

### 1. Spatial chunking + view-frustum culling

Biggest unlock. Split the planet into chunks (e.g., 20 ico-faces
× N×N sub-tiles). Only camera-facing chunks are GPU-resident; the
back half of the planet is evicted. Saves ~50–70% of GPU memory at
any given time. Build all chunks once at startup, swap in/out on
camera movement.

- **Visual preservation**: pure — what's rendered is identical; we
  just don't render what we can't see.
- **Effort**: ~300–500 lines of chunk management + streaming.
- **Memory at 1M hexes**: ~290M verts in flight (down from 1.15B).

### 2. Async / time-amortized build

Move `buildGlobeMesh` from a single 17-min wall-clock blocker to
background work spread across frames. Doesn't reduce total cost but
keeps the UI responsive. Render starts on the first chunk that's
done; the rest pop in over time.

- **Visual preservation**: pure (final state is identical).
- **Effort**: smallest — wrap the cell-iteration loop in a
  `requestIdleCallback` chain. ~50 lines.
- **Pairs naturally with (1)**.

### 3. Adaptive SUBDIVISIONS by hex size

At 1M hexes each cell is ~510 km² (vs ~32k km² at 16k hexes). The
current `SUBDIVISIONS = 3` gives 384 tris per hex top → 1.3 km² per
tri at 1M hexes — sub-pixel overkill at any reasonable camera
distance. Scaling subdivisions inversely with hex count keeps
**screen-space tri density** constant.

- 16k hexes × 384 tris = 6.1M tris (today)
- 1M hexes × 24 tris = 24M tris (with SUBDIVISIONS=1)

- **Visual preservation**: effectively pure — at game-scale zoom the
  per-hex tri count doesn't matter; the screen-space tri density is
  what drives appearance, and that stays constant. Strictly the
  per-hex mesh is coarser, but at 1M hexes a single hex covers
  fewer screen pixels than at 16k anyway.
- **Effort**: trivial — make `SUBDIVISIONS` a function of hex count.
  ~5 lines.
- **Total tri count at 1M hexes**: 24M, manageable.

### 4. GPU-side displacement (medium-effort, biggest CPU/memory win)

CPU builds flat hex top meshes only (positions on the unit sphere,
no noise/cliff displacement applied). Vertex shader runs
`computeHeightWithCliffErosion` at runtime.

- **Pros**: drops mesh build time substantially (no per-vertex
  displacement loop on CPU); memory is positions-only.
- **Cons**: re-introduces per-frame vertex shader cost (the thing
  shader-globe was supposed to do); porting
  `computeHeightWithCliffErosion` to GLSL is the same kind of port
  that bit us in the cliff-erosion-shader-design experiment.
- **Critical difference vs shader-globe**: the per-hex mesh density
  is preserved. Bumps will actually shade because face-normals can
  stay on CPU using static positions, OR be done in GLSL with the
  dense per-hex mesh giving the gradient room.
- **Visual preservation**: identical because the same height
  function runs, just on GPU.
- **Effort**: ~400 lines of GLSL port + integration.

### 5. Persistent mesh cache

Pre-build meshes once, serialize to IndexedDB or a server-side
asset, reload on next session. Trades startup latency (one-time)
for ongoing convenience. Pairs with (1) — chunks become cache
units.

- **Visual preservation**: pure.
- **Effort**: ~200 lines of serialization.

## Recommended stack to hit 1M hexes

- **(1) chunking** gets GPU memory under control
- **(3) adaptive subdivisions** keeps total tri count manageable
- **(5) caching** makes startup tractable after first run
- **(2) async build** keeps the first run from feeling broken
- **(4) GPU displacement** as a wildcard — only if (1)+(3)+(5) hit a wall

## Suggested implementation order

1. **(2) async / time-amortized build** — cheapest, immediate UX
   win, lays groundwork for chunking.
2. **(1) chunking + view-frustum culling** — the real scalability
   unlock.
3. **(3) adaptive SUBDIVISIONS** — when pushing past ~100k hexes.
4. **(5) persistent cache** — polish, after the rest is in place.
5. **(4) GPU-side displacement** — only if the rest hits a memory
   or CPU wall at 1M+ hexes.

## What we already proved doesn't work

The shader-globe rewrite (uniform smooth icosphere + texture-driven
hex lookup) was the alternative to scaling the legacy mesh. It
escapes O(hex-count) mesh size — but it can't reproduce the legacy
visuals at any reasonable mesh density:

- Uniform mesh at sub=600 (~21M verts) is comparable to legacy in
  total verts but the wrong vertex distribution: too sparse where
  cliffs need detail, too dense on flat ocean.
- Per-vertex analytic normals had dark bands at the tangent-basis
  switch.
- Per-fragment dFdx/dFdy facet normals produced low-poly flat
  shading per triangle.
- Fragment-side bump-mapping at the noise scale read as ocean
  waves, not terrain bumps.

The shader-globe branch (`terrain-colors-v2`) and its experiments
(stashed as `today's shader-globe cliff/bump experiments`) remain
preserved if any of that code becomes useful again.
