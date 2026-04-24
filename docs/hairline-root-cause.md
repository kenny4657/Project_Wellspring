# Hairline Root Cause — Geometry Gap

## Confirmed Root Cause
The hairline is a **sub-pixel geometry gap** at shared hex edges, NOT a shader issue.

Both hexes at a shared cliff edge compute vertex heights independently using `computeHeightWithCliffErosion`. The `distToSegment` call uses each hex's OWN `cell.corners` as edge endpoints. Even though the edge is geometrically shared, the corner coordinates come from different hex cell objects, producing slightly different floating-point results for `dist` → different `mu` → different height → different vertex radius → sub-pixel gap → dark clearColor bleeds through.

## Failed Shader Theories
1. **Remove proxFade from blend** — didn't fix it (hairline exists without proxFade)
2. **Angular keys for normal smoothing** — didn't fix it (not a normal issue)
3. **Remove G channel override** — didn't fix it (not a G channel issue)
4. **GPU interpolation of B channel + fract()** — wrong theory (hairline exists before any B channel changes)
5. **heightLevel branching in shader** — wrong theory (all branch-free approaches still had hairlines)
6. **Separate land/water shader blocks** — didn't fix it
7. **Steepness gate changes** — made it worse but wasn't the root cause

## Why Position Smoothing Doesn't Fix It
`smoothLandSeamPositions` averages radii at coincident vertices AFTER heights are computed. But the averaged position is between the two divergent heights, creating a new discontinuity with adjacent non-shared vertices within each hex's triangle fan.

## The Fix
Make both hexes use identical edge coordinates for shared edges by canonicalizing corner positions.
