# Chunking + View-Frustum Culling — Implementation Plan

Implements approach **(1) Spatial chunking + view-frustum culling**
from [scaling-to-1m-hexes-legacy.md](scaling-to-1m-hexes-legacy.md),
designed so approach **(3) LOD subdivisions** can be added on top
later without re-architecting.

## Chunking scheme

- Group hexes into chunks at world-build time. Each chunk is a set
  of cell IDs.
- Group by **proximity on the sphere** — bucket cells by their
  nearest face among the 20 icosahedron faces, then subdivide each
  face into N×N sub-tiles (N=2 or 4) for finer culling granularity.
- Chunks are roughly equal-area patches; a chunk's normal direction
  is well-defined, which makes hemisphere culling cheap
  (`dot(chunkNormal, cameraDir) > threshold`).
- 16k hexes / 20 faces × 4 sub-tiles = 80 chunks, ~200 hexes each.
  At 1M / 320 chunks ≈ ~3k hexes each. Tunable.

## Per-chunk mesh, not one mega-mesh

- Today `globeMesh` is a single Babylon mesh with all hex tops +
  walls. Becomes one `Mesh` per chunk, parented to a `TransformNode`
  for grouping.
- Each chunk owns its own vertex/index buffers and its own
  `setVerticesData('hexDebugColor', ...)` etc.
- Material shared across chunks (one shader today, so just shared).
- Picking still works — Babylon picks against any `isPickable` mesh
  in the scene.

## Visibility loop

- `scene.onBeforeRenderObservable`: for each chunk, compute
  `dot(chunkCenterDir, cameraDir)`. If `< -0.1` (back of planet,
  with margin), `chunk.mesh.setEnabled(false)`. Otherwise enabled.
- Optional second pass: frustum test against chunk AABB for tighter
  culling. Defer to phase 2 — hemisphere alone gets us most of the
  win.

## LOD-readiness without implementing LOD yet

The whole point of "with #3 in mind." Concretely:

- Each chunk stores not just its cell IDs but also a
  `currentLOD: number` field (initially fixed, e.g.
  `SUBDIVISIONS = 3`). The mesh-build path takes
  `(cellIds, lodTier)` and produces a mesh.
- A `rebuildChunkAtLOD(chunkId, newLOD)` function exists from day
  one but isn't called by anything — wired up later when (3) is
  implemented.
- Cell-to-chunk map is bidirectional (chunk owns cells, each cell
  knows its chunk) so `setHexTerrain` can dirty just the affected
  chunk.

## Async build (#2 lite)

Worth doing minimally so initial build doesn't freeze the page
worse than today. Rough version: build chunks one per
`requestAnimationFrame`, render the ones already done. ~30 lines
on top of chunking. Without it, this commit makes the freeze
worse, not better, on big maps.

## Files touched

- [src/lib/engine/globe-mesh.ts](../src/lib/engine/globe-mesh.ts) —
  biggest change. Refactor `buildGlobeMesh` so the cell-iteration
  loop becomes `buildChunkMesh(cellIds, lodTier)`.
- [src/lib/engine/globe.ts](../src/lib/engine/globe.ts) — owns the
  chunk array, visibility loop, and chunk-aware `setHexTerrain` /
  debug-color path.
- New file:
  [src/lib/engine/globe-chunks.ts](../src/lib/engine/globe-chunks.ts)
  — chunk assignment (cell → chunk), chunk metadata.

## What stays the same

- All visuals. Same mesh formula, same shaders, same noise/cliff/
  border code.
- Picking, debug coloring, paint flow.
- Smoothing pass: needs care — `smoothLandSeamPositions` runs across
  cell boundaries today, which spans chunks. Run it **before**
  chunking and bake the smoothed positions into per-chunk meshes.

## Open questions for confirmation

1. **Async build (#2 lite) folded in or separate?** Recommend
   folding in — without it, this commit makes the freeze worse, not
   better, on big maps.
2. **Chunk granularity**: start with 20 faces × 4 sub-tiles = 80
   chunks at any hex count. OK?
3. **First-cut culling**: hemisphere only (cheap dot product), no
   AABB frustum test. OK?
4. **Hot reload of `setHexTerrain`**: rebuild only the affected
   chunk, not the whole world. Meaningful win for paint
   responsiveness — but adds complexity. Include in this pass?
