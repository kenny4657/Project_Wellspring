# Phase 4 — Result

The plan called Phase 4 "the biggest piece" (5–8 days): port `terrain-material.ts`'s
GLSL onto texture-driven inputs so the new sphere matches the legacy globe at
60 fps with no elevation yet.

## Conclusion

**Done with two known deviations**, both architectural:

1. **Water rendering is inline, not via the legacy water-sphere.** The legacy
   stack composites a separate animated water-sphere on top of the land mesh,
   using depth-buffer occlusion to discard water fragments where land is
   nearer. With no displacement (Phase 4's deliberate constraint), the
   shader-globe sits at exactly `planetRadius` — the water-sphere at
   `0.9995 * planetRadius` is fully occluded and never renders. So Phase 4
   colors water-tier hexes (heightLevel ≤ 1) with a static blue from the
   terrain profile's `color` field plus a small noise variation. **Phase 5
   or 6 should bring the animated water shader back** once vertex
   displacement makes the water-sphere positionable again.

2. **Pentagon hexes skip the 6-neighbor scan.** Pentagons sit at icosahedron
   vertices where face-grid `(i, j)` is undefined; the cross-hex blend,
   beach, and cliff overlays don't apply to them. Visually you get 12
   slightly-flat-looking pole hexes; everything else renders normally.
   Acceptable for Phase 4; Phase 7 click-handling work can revisit if it
   becomes meaningful.

## Sub-phase deliverables

The plan listed five sub-phases. All ported, in one commit (the plan
allowed but did not require sub-phase-by-sub-phase commits).

| Sub-phase | Status | Notes |
|---|---|---|
| 1. Solid color from terrain texture | ✅ | `computeTerrainColor` reused verbatim from `terrain-material.ts`; data source swapped to `terrainTex` lookup. |
| 2. Cross-hex blending | ✅ | `distanceToHexEdge` walks 6 neighbors, picks closest edge, blends within last ~35% of edge distance. Same noise-modulated threshold as legacy. |
| 3. Beach overlay | ✅ | `GLSL_BEACH_OVERLAY` imported verbatim. `coastProximity` re-derived from edge distance against any neighbor with different water/land status (water = `heightLevel ≤ 1`). |
| 4. Cliff color | ✅ | `GLSL_CLIFF_RENDERING` imported verbatim. `cliffProximity` triggered only on the legacy steep-cliff criteria (`abs(heightGap) ≥ 2`, or water↔land where the land tier > 2). On the smooth sphere `steepness ≈ 0`, so the cliff TEXTURE branch self-gates off and only the color-side cliff effects run. |
| 5. Lighting | ✅ | `GLSL_LIGHTING` imported verbatim. Operates on world-space normal and view direction — no changes needed. |

## How it was verified

`scripts/phase4-verify.mjs` switches between legacy and shader-preview at
the four reference camera positions (top-down, near-horizon, equator,
polar) and saves side-by-side composite PNGs to
`docs/phase4-screenshots/`.

Eyeball comparison of the four `*-compare.png` files:
- Continents render with matching biome colors (greens, browns, tundra).
- Beach band at coastlines.
- Cliff outlines only at significant tier transitions (no per-hex border
  noise after the steep-cliff fix).
- Hex grid pattern visible — same hex resolution as legacy.
- Water color approximate but consistent across views.

Real-browser FPS:
| Mode           | FPS |
|----------------|-----|
| legacy         | 60.0 (vsync) |
| shader-preview | 60.0 (vsync) |

Both vsync-locked in this measurement, but shader-preview's underlying mesh is 384k verts vs legacy's 19.68M, so the actual headroom is large. Phase 8 perf work will measure this properly via the benchmark harness once tessellation/displacement land.

## Bug fixes that came up during the port

1. **`colorH = max(heightAboveR, inlandH)` clamped water hexes to grass colors.**
   With no displacement in Phase 4, `heightAboveR` is always ~0, so the legacy `max` formula clamps water-tier `inlandH < 0` up to 0 — which sits in the grass band of `computeTerrainColor`. Fix: use `colorH = inlandH` directly. The `max` formula reduces to `inlandH` on the legacy mesh anyway (where `heightAboveR ≈ tierH < inlandH`), so this is consistent.

2. **Cliff overlay triggered at every hex border with a different `heightLevel`.**
   First port used "any different heightLevel" as the cliff trigger. Legacy `hex-borders.ts` actually uses `gap ≥ 2` (or water↔cliff with land tier > 2). After fixing, the dark per-hex outlines disappeared and cliff color shows only at real cliff transitions.

3. **GLSL string with backticks broke esbuild.** Comments inside a TypeScript template literal containing backtick characters confuse esbuild's parser ("expected ;"). Stripped backticks from GLSL comments.

## Files

```
src/lib/engine/shader-globe-material.ts   # Phase 4 port (full rewrite from Phase 3 stub)
src/lib/engine/terrain-material.ts        # GLSL chunks now `export`ed for reuse
src/lib/engine/globe.ts                   # per-frame uniform pushes; settings pipe
scripts/phase4-verify.mjs                 # 4-camera side-by-side capture
docs/phase4-screenshots/                  # legacy/shader-preview/compare PNGs
docs/phase4-result.md                     # this file
```
