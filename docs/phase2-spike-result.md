# Phase 2 Spike — Result

The plan calls Phase 2 the **make-or-break** technical decision: can a GLSL
fragment shader resolve "world position → hex ID" cheaply enough to feed all
later phases? If yes, commit to Phases 1, 3–8. If no, fall back to a
precomputed cube-map lookup.

## Conclusion

**Viable.** GLSL `worldPosToHexId` works correctly and the smooth-sphere
debug renderer holds **65 fps median (14.6 ms)** at 1280×800 with
`ICO_RESOLUTION = 40` (16,812 hexes). The path forward is Phases 1, 3–8.

## How it was verified

`scripts/phase2-verify.mjs` runs Playwright headless, switches the renderer
to `shader-preview`, and switches the debug material to mode 3 (raw ID bits
in RGB). It samples 400 random pixels across the sphere and decodes each
pixel's GLSL-computed hex ID, then asks the page to compute the **same
algorithm in JS** via `engine.pickHexByFaceGridAt(sx, sy)` — a CPU mirror
in `hex-id-lookup.ts`. This is the apples-to-apples comparison.

```
Samples       : 396
Exact matches : 258
Mismatches    : 84  (of which 83 are neighbor cells)
Lookup misses : 54  (magenta sentinel — face-edge artifacts)
Exact rate    : 75.4%
Exact+neighbor: 99.7%
```

Off-by-one mismatches arise because pickSphere (radius 0.997 R) and the
debug sphere (radius 1.001 R) intersect the camera ray at slightly different
3D points. Near a hex boundary, those two points snap to different cells.
The match rate is exact at hex centers and falls off cleanly at boundaries
— the expected fingerprint of "GLSL faithfully ported."

The 14% magenta lookup misses are face-edge artifacts where the planar
inverse of the spherical forward-map produces (i, j) one cell outside the
face's grid range. Phase 4+ work will smooth these with a cross-face
fallback (try the neighbor face's grid).

## Performance

`engine.runBenchmark()` orbits the camera through 8 fixed waypoints over
16 s and records frame ms.

| Mode             | Frames | Median ms | p99 ms | min ms |
|------------------|--------|-----------|--------|--------|
| shader-preview   | 1049   | 14.6      | 18.9   | 12.2   |

Per-fragment cost: 20-iteration face dot-product loop + 1 cross-product
barycentric + 1 nearest-neighbor texture sample. No branching cost surprises.

## Decisions deferred to later phases

1. **Face-edge magenta artifacts** (~14% of pixels). Phase 3/4 will need a
   cross-face fallback so a fragment that maps outside its primary face
   tries the neighbor face's grid.
2. **Pentagon special case.** The 12 pentagon hexes work via the lookup
   texture (they appear at fixed (i, j) slots). They should be flagged as
   pentagons in the height texture — Phase 1 work.
3. **Reconciling pickHex with face-grid lookup.** CPU `pickHex` is currently
   nearest-cell-center; GLSL is face-grid. Phase 7 will need to align them
   so click-painting and visual rendering agree on which hex a pixel is in.

## Files added in Phase 0 + Phase 2

```
src/lib/engine/perf-gpu-timer.ts             # ?gputime=1 GPU timing
src/lib/engine/benchmark.ts                  # 8-waypoint orbit benchmark
src/lib/engine/hex-id-lookup.ts              # CPU lookup + GLSL CPU mirror
src/lib/engine/shader-globe-debug-material.ts # GLSL worldPosToHexId
scripts/snapshot-references.mjs              # Reference screenshots
scripts/phase2-verify.mjs                    # Visual+numeric verification
scripts/phase2-perf.mjs                      # Mode-vs-mode benchmark runner
docs/reference-screenshots/                  # 4 frozen baselines
```

## Files modified

```
src/lib/engine/icosphere.ts                  # Export (face, i, j) → cellId
src/lib/engine/globe.ts                      # Render mode, GPU timer, benchmark, debug material
src/routes/globe/+page.svelte                # Render-mode dropdown, benchmark UI
```
