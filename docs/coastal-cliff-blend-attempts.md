# Coastal Cliff Blend — Failed Attempts

## The Problem
Inland cliffs have smooth cliff rock blending on BOTH sides (upper and lower hex).
Coastal cliffs have cliff rock that stops abruptly at the bottom — no blending on the water/beach side.

## Reference: How Inland Cliffs Work
- Upper hex: cliff erosion ramp creates steep geometry → steepness-based cliff rock
- **Lower hex: ALSO has cliff erosion ramp (cliffEdges) → steep geometry → cliff rock**
- Both hexes contribute cliff rock that meets at the shared edge → smooth transition
- Cliff rock fades via `steepBlend * proxFade` as geometry flattens away from edge

## Reference: Current Coastal Cliff State (cb5d468)
- Land hex (high): cliff erosion ramp → steep geometry → cliff rock ✓
- Water hex (below): NO cliff edges, NO cliff erosion, NO steep geometry → NO cliff rock
- Result: cliff rock stops at hex boundary, sharp line against sand

## What The User Wants
The coastal cliff bottom should blend EXACTLY like the inland cliff bottom — gradual cliff rock fade into the terrain below.

---

## Attempt 1: Widen steepness smoothstep range (shader only)
**Change:** `smoothstep(0.001, 0.08, steepness)` instead of `smoothstep(0.003, 0.06, steepness)`
**Result:** No visible change. The steepness drops too fast at the cliff base — widening the range doesn't help when steepness goes from 0.05 to 0.0 in one triangle.

## Attempt 2: Suppress beach overlay near cliff (shader only)
**Change:** `beachBlend *= (1.0 - cliffProximity)` in beach section
**Result:** Removed sand near cliff but didn't add cliff rock blend. Just showed bare terrain color. Didn't match inland look.

## Attempt 3: Cross-terrain blend (globe-mesh.ts + shader)
**Change:** Allowed water→land edges in `edgeNeighborTerrains`, suppressed beach near terrain border
**Result:** Introduced white artifacts at coast. The cross-terrain blend changes terrain COLOR but not cliff ROCK texture. Beach overlay covered it anyway. Also created rendering artifacts on other coastlines.

## Attempt 4: Water hex uses inland cliff system (globe-mesh.ts + shader)
**Change:** Added `cliffEdges + steepCliffEdges + excludedEdges` for water→high-land edges, changed shader to use steepness*proxFade for all hexes
**Result:** Changed GEOMETRY — water hex ramped up to cliff creating a rocky mound. User explicitly said DO NOT CHANGE GEOMETRY.

## Attempt 5: Proximity-only fallback on land hex (shader only)
**Change:** Added `baseFade = smoothstep(0.15, 0.6, cliffProximity) * 0.4` as floor for `cliffRockDrawn` on land hexes
**Result:** "Nothing changed." The cliff proximity on the land hex only extends 0.3*hexRadius from the cliff edge. The cliff base visible in the screenshot is BEYOND this range — it's on the WATER hex, not the land hex. Modifying the land hex shader has no effect on the water hex's appearance.

---

## Key Insight From Failures
The sharp line is at the HEX BOUNDARY between the land hex and the water hex. The cliff rock only exists on the LAND hex side. ALL shader changes to the land hex path cannot affect pixels on the WATER hex.

For the water hex to show cliff rock blending:
1. It needs `cliffProximity > 0` (requires `steepCliffEdges` in globe-mesh.ts)
2. It needs the shader cliff block to enter (requires `cliffProximity > 0.01`)
3. It needs cliff rock to actually draw (water path uses `smoothstep(0.0, 0.5, cliffProximity)`)

Currently at cb5d468, the water hex has NO `steepCliffEdges` → `cliffProximity = 0` → cliff block never entered → no cliff rock blend on water side.

## What Needs To Happen (NOT geometry changes)
The water hex needs `steepCliffEdges[i] = true` for its high-land neighbor edge — this ONLY affects the cliff proximity encoding in the B channel (color data), NOT the geometry/height. The height computation (`computeHeightWithCliffErosion`) only checks `cliffEdges`, not `steepCliffEdges`. So adding ONLY `steepCliffEdges` (without `cliffEdges`) gives the water hex cliff proximity for the shader WITHOUT changing geometry.

Then the existing water hex shader path (`cliffRockDrawn = smoothstep(0.0, 0.5, cliffProximity)`) will draw cliff rock on the water hex near the cliff edge, matching the inland blend.
