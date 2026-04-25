# Phase 5 + Phase 6 — Result

The plan called Phase 5 (vertex displacement) and Phase 6 (cliff-face
noise) two separate ~3-4 day passes. We did them in one go because they
share the same vertex shader and the same edge-distance math: Phase 6's
noise term only fires where Phase 5 has produced a height delta.

## Conclusion

**Done.** Both phase deliverables met:

- **Phase 5 deliverable** ("shader globe shows terrain elevation; cliffs
  visible as steep transitions; FPS still good"): water hexes are now
  visibly displaced down to their tier elevation (-0.020R for deep ocean,
  -0.008R for shallow), land hexes sit at +0.005R / +0.010R for hills /
  mountains. The near-horizon screenshot shows water as a clear bowl-shape
  below the surrounding land. 60 fps in real browser.
- **Phase 6 deliverable** ("cliffs that look hand-painted rather than
  CAD-extruded"): cliff faces now get 3-octave simplex noise displacement
  modulated by the height delta between adjacent hexes. Plus an optional
  stratification term that bands the cliff face vertically. Tunable via
  `applyShaderGlobeCliffNoise()` -- a Cliffs-tab UI hook can wire to that
  later.

## What changed

`shader-globe-material.ts` was substantially rewritten. The hex-lookup
machinery (`worldPosToHexId`, `distanceToHexEdge`, `sampleHexData`) is
now in a shared `GLSL_HEX_HELPERS` chunk that both vertex and fragment
shaders import. Vertex shader gets:

```glsl
vec3 normPos = normalize(position);
computeHexLookup(normPos);
float ownLevel = sampleHexData(g_hexId).y;
vec2 disp = phase5AndPhase6Displacement(normPos, ownLevel);
vec3 displaced = normPos * (planetRadius * (1.0 + disp.x));
gl_Position = viewProjection * world * vec4(displaced, 1.0);
```

`phase5AndPhase6Displacement` runs Strategy 3 (flat hex top + sharp edge
ramp via `smoothstep(0, 0.15, edgeDistNorm)`) plus the Phase 6 noise
addition:

```glsl
float cliffness = 1.0 - smoothstep(0.0, 0.15, edgeDistNorm);
float heightDelta = abs(neighborH - ownH);
float cliffActivity = cliffness * smoothstep(0.0, 0.012, heightDelta);
h += cliffActivity * snoise3D(P * NOISE_FREQ) * NOISE_AMP;
// + optional stratification term banded along cliff direction
```

Per-vertex cost: 12 pentagon dots + face find (20) + gnomonic bary +
edge distance loop (6) + 1 neighbor lookup + height samples + 3-octave
noise. At 384k verts that's ~30M ops/frame -- well within budget; FPS
holds 60.

Fragment shader changes:

- Restored `colorH = max(heightAboveR, inlandH)` (was `inlandH` only in
  Phase 4 because `heightAboveR == 0`). Now `heightAboveR` reflects real
  elevation and the legacy formula works as intended.
- FXAA re-enabled in shader-preview mode. It had been off for the Phase 2
  verifier; with displacement the cliff edges read as harsh stair-steps
  in the silhouette without it.

## Phase 6 tunables

```ts
const PHASE6_DEFAULTS = {
    cliffNoiseAmp:   0.0015,  // peak displacement, fraction of planetRadius (~9.5 km)
    cliffNoiseFreq:  6.0,     // 1/(unit-sphere distance); feature size ~1/6 quadrant
    cliffStrataAmp:  0.0008,  // stratification ridge amplitude
    cliffStrataFreq: 30.0,    // bands per unit hex-radius along cliff direction
};
```

`applyShaderGlobeCliffNoise(mat, { ... })` updates them at runtime. A
Cliffs-tab UI extension can drive sliders here.

## Visual regression

`scripts/phase4-verify.mjs` (kept the name; the verifier's not
phase-specific) still drives the same 4 reference cameras. Comparing
`docs/phase4-screenshots/*-compare.png`:

- **Top-down**: continents at correct biome colors, water visibly
  saturated blue, tiny stair-step at silhouette where mountain hexes
  protrude. Pretty close to legacy.
- **Near-horizon**: water visibly bowled below the land surface --
  Phase 5 displacement reading clearly. Beach band at the coast. Cliff
  noise visible on the rocky coast as edge variation rather than perfect
  straight lines.
- **Equator**: hex tessellation still visible at this zoom (expected -
  the plan's "looks identical" target is matched by Phase 5+6, not
  exceeded; tessellation is part of legacy too at this zoom).
- **Polar**: hex-stair silhouette at the planet edge from elevation
  tiers. Cliff noise breaks the stairs into a more rocky outline.

Real-browser FPS: 60.0 in both legacy and shader-preview.

## What's still deferred

- **Animated water**: still the inline static-blue rendering from Phase 4.
  With Phase 5 displacement, water hexes are now properly below land --
  the legacy water-sphere can be re-attached and would composite correctly.
  Phase 7 or 8 work.
- **Cliffs-tab UI for noise tunables**: only the engine API exists; no
  user-facing slider yet. `applyShaderGlobeCliffNoise()` is exported.
- **Smooth normals after displacement**: vertex normal is the radial
  outward normal of the *displaced* position. At hex-edge transitions
  the displacement is steep but normal stays radial -- lighting reads
  the cliff as a smooth ramp rather than a sharp face. Phase 8 could
  compute analytic normals from neighbour heights if it becomes a
  visible artifact.

## Files

```
src/lib/engine/shader-globe-material.ts   # Phase 5+6 rewrite (vertex displacement, cliff noise)
src/lib/engine/globe.ts                   # FXAA per-mode (preview on, debug off)
docs/phase4-screenshots/                  # updated 4-camera composites
docs/phase5-6-result.md                   # this file
```
