# Coastal Cliff Blend — Failed Attempts

## The Problem
Inland cliffs have smooth cliff rock blending on BOTH sides (upper and lower hex).
Coastal cliffs have cliff rock that stops abruptly at the bottom — no blending on the water/beach side.

## Reference: How Inland Cliffs Work
- Upper hex: cliff erosion ramp creates steep geometry → steepness-based cliff rock
- **Lower hex: ALSO has cliff erosion ramp (cliffEdges) → steep geometry → cliff rock**
- Both hexes contribute cliff rock that meets at the shared edge → smooth transition
- Cliff rock fades via `steepBlend * proxFade` as geometry flattens away from edge
- **Key: the lower hex's cliff rock works because the cliff erosion ramp creates STEEP FACES on the lower hex. The steepness is what the shader uses to draw cliff rock.**

## Reference: Current State (2287df0)
- Land hex (high): cliff erosion ramp → steep geometry → cliff rock ✓
- Water hex: HAS steepCliffEdges + coast ramp to midTierH → BUT the coast ramp is a gentle cosine over hexRadius, NOT the narrow parabolic cliff erosion ramp
- The water hex's coast ramp creates GENTLE slopes, not steep ones → steepness stays low → no cliff rock from steepness path
- Water hex shader uses proximity-only path: `smoothstep(0.0, 0.5, cliffProximity)` → draws cliff rock based on distance, NOT steepness
- This proximity-only blend creates hex-shaped contours and sharp edges at hex boundaries

---

## Attempt 1: Widen steepness smoothstep range (shader only)
**Result:** No visible change. Steepness drops too fast at cliff base.

## Attempt 2: Suppress beach overlay near cliff (shader only)  
**Result:** Removed sand but didn't add cliff rock. Wrong approach.

## Attempt 3: Cross-terrain blend (globe-mesh + shader)
**Result:** Artifacts at coast. Beach overlay covers the blend anyway.

## Attempt 4: Full inland cliff system on water hex (cliffEdges + excludedEdges)
**Result:** Changed geometry drastically — created rocky mound. User rejected.

## Attempt 5: Proximity-only fallback on LAND hex
**Result:** No change — the sharp line is on the WATER hex, not land hex.

## Attempt 6: steepCliffEdges only (no cliffEdges) — proximity for shader only
**Result:** Cliff rock appeared on water hex but with sharp hex-shaped edges. Not blended with neighbors.

## Attempt 7: Propagate cliff proximity to neighbor water hexes
**Result:** Still hex-shaped. Sharp boundaries between hexes.

## Attempt 8: Noise perturbation + harmonize cliff proximity at water vertices
**Result:** Still failed. Hex-shaped blend persists.

---

## Root Cause Analysis

The inland cliff blend works because of TWO things working together:
1. **Cliff erosion geometry** creates steep faces on the lower hex
2. **Steepness-based shader** draws cliff rock on those steep faces

The steep faces are what make the blend look ORGANIC — cliff rock follows the geometry contour, not hex distance.

ALL my attempts on the water hex used PROXIMITY-BASED cliff rock (distance from cliff edge). This always looks hex-shaped because distance-to-edge follows hex geometry. No amount of noise perturbation or harmonization fixes this fundamental problem — the blend follows hex edges instead of terrain geometry.

## What Actually Needs To Happen

The water hex needs the cliff erosion ramp from `computeHeightWithCliffErosion` — but ONLY the narrow parabolic ramp (0.2*hexR), not the full coast ramp. This creates steep faces near the cliff that the steepness-based shader draws cliff rock on.

The previous attempt (Attempt 4) failed because it also added `excludedEdges` which removed the coast ramp entirely, AND the parabolic ramp pulled the water hex up to midTierH creating a visible mound.

Better approach: keep the coast ramp as-is, but ALSO apply cliff erosion on top. The cliff erosion ramp should be small enough (0.2*hexR) that it only affects the area right next to the cliff edge, creating steep faces there while the rest of the water hex stays on its normal coast ramp.
