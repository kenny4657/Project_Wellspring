# Phase 2 Spike — Result (revised after audit)

The plan calls Phase 2 the **make-or-break** technical decision: can a GLSL
fragment shader resolve "world position → hex ID" cheaply enough to feed all
later phases? If yes, commit to Phases 1, 3–8.

## Conclusion

**Viable, with one structural caveat.** GLSL `worldPosToHexId` runs at
**65 fps median (14.6 ms)** at 1280×800 and 16,812 hexes. The shader
faithfully implements the face-grid algorithm the plan asked for
(self-consistency 77% exact, 100% exact-or-neighbor, 0% far). However the
face-grid algorithm itself disagrees with the canonical CPU `pickHex`
(nearest-center Voronoi) at ~18% of pixels by 2+ cells — this is structural
to the algorithm choice, not a shader bug. Phase 7 will need to either
align CPU `pickHex` to face-grid (so click-paint and rendering agree) or
add a nearest-center refinement step in GLSL.

## How it was verified

`scripts/phase2-verify.mjs` runs three independent comparisons over 800
random screen pixels:

```
A) GLSL          vs CPU pickHexAt        : exact=21.9%  neighbor=60.0%  far=18.1%
B) GLSL          vs CPU pickHexByFaceGrid: exact=76.9%  neighbor=23.1%  far= 0.0%
C) CPU face-grid vs CPU nearest-center   : exact=23.1%  neighbor=60.1%  far=16.8%
```

* **(A)** GLSL vs canonical click-pick. The "true" regression test.
* **(B)** GLSL vs CPU mirror of the same algorithm. The "shader-correctness"
  test. **0% far** confirms the shader implements the spec.
* **(C)** CPU vs CPU. Isolates the algorithm choice from the shader. Almost
  identical to (A), proving the disagreement in (A) comes from "face-grid ≠
  Voronoi", not from any GLSL bug.

The 800 samples include 0 magenta lookup-misses (down from 14% in the
original spike — the **gnomonic projection** fix below eliminated face-edge
artifacts entirely).

## Issues fixed since the original spike

### 1. Gnomonic-projection inverse map

The original GLSL did perpendicular projection of the sphere point onto
each face's triangle plane, then planar barycentric. This is wrong off-axis:
icosahedral hex centers are placed via slerp, not flat triangulation.
Gnomonic projection (ray from origin → triangle plane intersection) is the
standard inverse for icosahedral discrete grids; great circles map to
straight lines, so the slerp forward-map's interior points project linearly
under gnomonic.

`shader-globe-debug-material.ts:107` and `hex-id-lookup.ts:109-114` now
compute `Q = P * dot(n, v0) / dot(n, P)` before the cross-product
barycentric. Result: magenta lookup-miss rate dropped from 14% → 0%; "far"
mismatches dropped from 35% → 18% (the residual ~18% is the structural
face-grid vs Voronoi gap).

### 2. Pentagon early-exit

The plan explicitly requires:
> Detect at start by checking if the point is within angular threshold of
> an icosahedron vertex; if so, return the pentagon's hex ID directly.
> Handle before face lookup.

Implemented in `shader-globe-debug-material.ts:94-104` (and the CPU mirror
in `hex-id-lookup.ts:64-74`). Mechanism:

* `createHexIdLookup` builds a 12-entry table mapping each icosahedron
  vertex to its pentagon hex ID (matched by nearest cell-center).
* Threshold = `cos((icosahedron-edge-angle / (resolution + 1)) × 0.55)`.
  The 0.55 factor stays well inside the pentagon's Voronoi region so the
  early-exit never misclassifies a pentagon-neighbor hex.
* GLSL loops 12 vertex dots before the face dot loop; first hit wins.

Verifier output:
```
Pentagon cells in grid: 12  ids=[0,41,902,903,1764,2625,4306,4347,5208,5209,6070,6931]
```

The verifier's pentagon-only sample bucket frequently shows 0 hits because
the camera in `?ref=1` mode points at the equator and the pentagons sit
near the poles. To exercise the early-exit, switch the heat-map output to
mode 1 (face index) and visually confirm the 12 vertices show as
single-color disks — they do.

### 3. Verifier honesty

The original verifier compared GLSL output to `pickHexByFaceGrid` (the
*same algorithm* implemented in JS), then headlined "99.7% exact-or-
neighbor." That measurement was real but mislabeled: it says "the shader
faithfully implements the algorithm," not "the algorithm is correct." The
revised verifier reports three comparisons separately so reviewers can tell
algorithm error from shader-implementation error.

The previous "exact-or-neighbor" framing also obscured how much the
neighbor bucket was inflated by hex grids' inherent 6-way adjacency. The
new report breaks `exact / neighbor / far` out so neighbor inflation is
visible.

## Performance

`engine.runBenchmark()` orbits the camera through 8 fixed waypoints over
16 s and records frame ms.

| Mode             | Frames | Median ms | p99 ms | min ms |
|------------------|--------|-----------|--------|--------|
| shader-preview   | 1049   | 14.6      | 18.9   | 12.2   |

Per-fragment cost: 12 pentagon dot products + 20 face dot products + 1
cross-product gnomonic barycentric + 1 nearest-neighbor texture sample.
Adding pentagon and gnomonic did not measurably move the benchmark.

## What's still deferred

1. **Face-grid → nearest-center alignment.** ~18% of pixels disagree with
   `pickHexAt` by 2+ cells (most boundary cases). Two ways to close it:
   * Phase 7: change CPU `pickHex` to use face-grid lookup. Cheap, but
     changes click-paint behavior at boundaries.
   * Add a 6-neighbor refinement step in GLSL (and CPU mirror): after the
     initial face-grid hit, check that cell + its 6 neighbors and pick the
     one whose center is closest to P. ~6 extra texture fetches per
     fragment; needs a per-cell-center texture (RGBA32F, ~256KB at 16k
     hexes).
2. **Pentagon test coverage.** The verifier currently can't drive the
   camera to look at a pole, so the pentagon-region statistic is empty in
   automated runs. Manual visual confirmation works (mode 1 face-index view
   shows clean pentagon disks at the 12 vertices). A future verifier run
   should call `engine.flyTo(90, 0, ...)` to sample the polar pentagon.

## Files affected by the audit fix

```
src/lib/engine/icosphere.ts                  # icoVerts now in IcoGridWithFaces
src/lib/engine/hex-id-lookup.ts              # Pentagon table, gnomonic CPU mirror
src/lib/engine/shader-globe-debug-material.ts # Pentagon GLSL, gnomonic projection
scripts/phase2-verify.mjs                    # Three-way comparison report
```
