# Globe Mesh Transition Constraints

Every rule below must hold simultaneously. Fixing one gap must not break another.

## Core Invariant

**At any shared edge or corner between two adjacent hexes, both hexes MUST compute the exact same vertex height.** This is the root cause of every gap.

## Hard Constraints (NEVER violate)

### 1. Land hexes MUST ramp at water borders
Land hexes ramp down to sea level at coastline edges. This creates the smooth coastline transition. **NEVER revert to flat land + wall at coastline.**

### 2. Land-land transitions use walls, NOT ramps
Land hex ramps ONLY apply at water-adjacent edges. Land-land height transitions MUST use walls from the higher hex. A land ramp that affects vertices at land-land corners creates 100+ km height mismatches (proven by gap detection).

### 3. Water hexes ramp — never use walls
Water→land: ramp to sea level. Water→water different depth: shallower ramps to deeper. Same-depth water: excluded (continuous flat). No walls ever on water hexes.

### 4. Deep ocean flat fast path is OK
Only when `allSameHeight` (ALL neighbors exact same height). These hexes are surrounded by identical-height water so no edge mismatches.

## Solved: The Triple Junction Gap

### Problem
At corners where land + shallow water + deep water meet, the shallow hex's `distToBorderWithTarget` could arbitrarily pick the deep-water edge (target=-0.020) instead of the land edge (target=0). Land and deep both computed target=0, shallow computed target=-0.020 → 127km gap.

### Solution (Codex)
**`buildCornerTargetMap`**: Pre-computes the correct ramp target at every hex corner by taking the MAX target across all non-excluded edges touching that corner, across ALL hexes sharing that corner. This is stored in a global `Map<string, number>`.

**`distToBorderWithTarget` corner fast-path**: When a vertex is at a hex corner (within `CORNER_EPS2`), it looks up the pre-computed target instead of iterating edges. All hexes sharing that corner get the same target → same height → no gap.

## Solved: Wall Gaps at Ramp Corners

### Problem
Wall tops used flat `tierH + noise` but the top face used the ramp formula. At corners where a wall edge meets a coastline ramp, wall top ≠ surface → gap.

### Solution (Codex)
1. **`computeSurfaceHeight` helper**: Extracted the height formula (ramp + noise) into a shared function used by BOTH the top face subdivision AND the wall generation. Walls and surface always agree.
2. **`subdivideEdge`**: Walls are subdivided along the edge to match the top face's subdivision points, so intermediate wall segments follow the noise displacement exactly.

## Solved: Coastline Smoothing

### Smooth distance blending
`smoothDistanceToTargetEdges` uses `smoothMin` (smooth minimum) to blend distance fields from multiple coastline edges. This rounds coastline corners instead of creating sharp hex-shaped cuts.

### Coast rounding
`COAST_ROUNDING` applies a subtle height depression at the midpoint of each coastal edge (`coastMid * coastBlend`), making shoreline contours read rounder.

## Architecture Summary

```
getHexBorderInfo(cell)     → per-edge: excluded?, target, for each hex
buildCornerTargetMap(cells) → per-corner: max target across all hexes (global)
distToBorderWithTarget(v)   → corner lookup OR nearest edge with max-target tiebreak
computeSurfaceHeight(v)     → ramp + noise, used by both top face and walls
subdivideEdge(c0,c1,level)  → edge points matching top face subdivision
```

## Noise Rules

- At water-water borders: both sides must use `NOISE_AMP` (full)
- At water-land borders (coastline): both sides use `NOISE_AMP * 0.3`
- Water interior: `NOISE_AMP * 0.3` (calm water)
- Land interior: `NOISE_AMP` (full terrain noise)
- Flat hexes (no border): `tierH + noise * NOISE_AMP`

## Shader Boundary

- `seaLevel = -0.002 * R`
- Vertices with `h < -0.002` render as water
- Vertices with `h >= -0.002` render as land/shore
- Shore transition zone blends sand→grass near h=0
