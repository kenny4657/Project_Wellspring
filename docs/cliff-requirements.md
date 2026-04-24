# Cliff System Requirements & Failed Attempts

## The Problem

When a hex has cliff edges (2+ level height difference) on SOME sides and gentle slopes (0-1 level difference) on OTHER sides, the cliff texture bleeds across the entire hex. A hex that is a "pass" or "pathway" between two cliff zones gets fully covered in cliff rock texture, blocking what should be a gentle slope.

The cliff texture needs to be **shaped per-edge** — it must curve to follow only the actual cliff edges and taper off toward edges that are gentle slopes. The system must handle each type of edge intersection distinctly.

## Visual Requirements

1. **Cliff edges (2+ level diff)**: Full cliff rock texture with slab map pattern
2. **Gentle slope edges (0-1 level diff)**: Normal terrain color, NO cliff rock texture
3. **Mixed hex (some cliff edges + some gentle edges)**: Cliff texture curves around cliff edges, fading before reaching gentle-slope edges. The cliff should visually "bend" to follow the cliff contour.
4. **Bridge/pass hex (cliffs on opposite sides, slopes between)**: Cliff curves around each cliff edge independently; the gentle-slope path between them stays clear of cliff texture
5. **Upper/lower cliff halves**: Must blend at the midpoint without a visible seam. Current midRock blend (vec3 0.32, 0.26, 0.19) at smoothstep(0.5, 1.0, proximity) partially works.

## Current Architecture

### Mesh side (globe-mesh.ts)
- **B channel encoding**: `B = heightLevel * 0.1 + cliffProximity * 0.09`
  - `heightLevel`: 0-4 discrete levels
  - `cliffProximity`: 0-1 continuous value, distance-based falloff from steep cliff edges
- **`distToSteepCliff()`**: Computes distance to nearest 2+ level cliff edge. Currently checks BOTH own edges AND neighbor cells' edges (propagation).
- **`computeHeightWithCliffErosion()`**: Parabolic ramp `t*(2-t)` near cliff edges, 20% hexRadius width. Uses min-mu across ALL cliff edges to fill corner holes. Only uses own edges (no neighbor propagation).
- **Cliff proximity radius**: `hexRadius * 0.45` falloff

### Shader side (terrain-material.ts)
- Decodes B channel: `heightLevel = floor(B*10)`, `cliffProximity = fract(B*10)/0.9`
- Cliff texture gate: `cliffProximity > 0.01 && steepness > 0.003`
- `steepness = 1.0 - dot(N, normalize(vWorldPos))` — geometric steepness of the face
- `erosionBlend = smoothstep(0.003 + erosionNoise, 0.06, steepness)` — only steepness, no proximity in blend
- Slab map pattern with per-terrain cliff palette (light/dark/pale rock colors)
- midRock blend at high proximity for upper/lower seam

## Failed Attempts

### Attempt 1: Remove neighbor propagation from distToSteepCliff
**What**: Removed lines 582-597 that check neighbor cells' cliff edges. Each hex only uses own steep cliff edges.
**Result**: FAILED — Did not address the core issue. Both sides of a cliff already have steepCliffEdges marked symmetrically, so removing neighbor propagation doesn't change which hexes get cliff proximity on their own edges. The problem is about WITHIN a hex — cliff bleeds from cliff-edges toward gentle-slope-edges of the SAME hex.
**Why it failed**: The cliff proximity is a simple radial falloff from the nearest cliff edge. It doesn't know about the OTHER edges of the hex. A vertex in the middle of a hex near a cliff edge gets high proximity regardless of what the opposite edge is.

### Attempt 2: Add gentleLandEdges + suppress cliff near gentle edges
**What**: Added `gentleLandEdges` boolean array to HexBorderInfo. Computed `distToGentleLandEdge()`. Multiplied cliffProximity by a smoothstep fade based on distance to nearest gentle edge.
**Result**: FAILED — "Does nothing of what you described." The cliff texture is driven by the SHADER's steepness check (`steepness > 0.003`), not just the cliffProximity value. Even if cliffProximity is reduced, the steep faces near cliff edges still have high steepness, so the shader still renders cliff texture there. The proximity suppression has no visible effect because steepness dominates.
**Why it failed**: The cliff texture rendering has TWO inputs: proximity AND steepness. Reducing proximity alone doesn't help because steep cliff faces inherently have high steepness values. The geometry itself is steep near cliffs — you can't change that by adjusting a color channel value.

### Attempt 3 (prior session): proxCover — proximity-based coverage independent of steepness
**What**: Added proximity as a direct blend factor in the shader, bypassing the steepness check.
**Result**: FAILED — Creates a visible hairline artifact at the cliff boundary. Every attempt to use proxCover produces this hairline. Binary search confirmed: commit 34b3ec3 (no proxCover) = no hairline, commit eab13b4 (with proxCover) = hairline.
**Why it failed**: GPU interpolation of the proximity value across triangle edges creates sub-pixel discontinuities at the 0/non-0 boundary.

### Attempt 4 (prior session): Various shader-only approaches
**What**: Tried overriding shore color, special-casing water neighbors, height threshold approaches.
**Result**: All FAILED — The underlying HEIGHT FIELD follows hex geometry. Any color logic on top still reveals the hex shape.

## Key Constraints

1. **NO proxCover**: Using cliffProximity directly in the shader blend (bypassing steepness) causes hairline artifacts. The shader MUST gate cliff texture on geometric steepness.
2. **Steepness is geometric**: `steepness = 1.0 - dot(N, normalize(pos))` comes from the actual mesh geometry. You cannot fake it — steep faces ARE steep.
3. **The cliff texture follows the geometry**: Since the shader gates on steepness, and steep faces exist wherever there's a height transition in the mesh, the only way to control WHERE cliff texture appears is to control WHERE steep geometry exists.
4. **Both sides of a cliff share the edge**: The cliff edge is shared geometry. Both hexes see the same steepness on their side.

## The Real Insight

**The cliff texture follows the GEOMETRY, not the color channel.** Since the shader uses geometric steepness to decide where to draw cliff rock, the ONLY way to make cliff texture curve away from gentle-slope edges is to make the GEOMETRY itself curve. The height ramp near cliff edges must be shaped so that:

- Near a cliff edge: steep geometry exists (cliff texture appears)
- Near a gentle-slope edge of the same hex: geometry transitions smoothly without steep faces (no cliff texture)
- In between: the steep zone curves/tapers

This means `computeHeightWithCliffErosion()` must be aware of gentle-slope edges and shape the cliff ramp to avoid creating steep faces near those edges. The cliff erosion ramp should "bend" in the mesh geometry itself.

## What Must Change

The solution must modify `computeHeightWithCliffErosion()` (or a similar geometry-level function) to:

1. Know which edges are cliff edges AND which edges are gentle-slope edges
2. Near gentle-slope edges, suppress or reduce the cliff ramp so the geometry stays smooth
3. The cliff ramp should curve — steep near cliff edges, smooth near gentle edges
4. This is a GEOMETRY change, not a color/shader change

The cliff proximity in the B channel can remain as-is (it's informational for the shader's midRock blend). But the actual cliff visibility is controlled by whether the mesh has steep faces, which is controlled by the height computation.
