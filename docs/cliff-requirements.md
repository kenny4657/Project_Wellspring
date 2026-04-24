# Cliff System Requirements & Failed Attempts

## The Problem

When a hex has cliff edges (2+ level height difference) on SOME sides and gentle slopes (0-1 level difference) on OTHER sides, the cliff texture bleeds across the entire hex. A hex that is a "pass" or "pathway" between two cliff zones gets fully covered in cliff rock texture, blocking what should be a gentle slope.

Each type of edge intersection needs DISTINCT handling — not the same cliff logic applied everywhere.

## Edge Intersection Types

| Type | Height Diff | Ramp Shape | Cliff Texture? |
|------|-------------|------------|----------------|
| Same level | 0 | None (flat) | No |
| Gentle slope | 1 level | Wide cosine (0.7 hexR) | No |
| Steep cliff | 2+ levels | Narrow parabolic (0.2 hexR) | Yes |

## Failed Attempts

### Attempt 1: Remove neighbor propagation only
Removed neighbor cliff edge checking from `distToSteepCliff`. Both sides of a cliff already have `steepCliffEdges` marked symmetrically, so this alone doesn't fix within-hex bleeding. The cliff proximity from the hex's OWN edges still bleeds toward gentle-slope edges.

### Attempt 2: Suppress cliffProximity (B channel) near gentle edges
Added `gentleLandEdges` tracking and `distToGentleLandEdge()`. Multiplied B channel cliff proximity by smoothstep fade near gentle edges. **Failed because cliff texture is driven by geometric steepness in the shader (`steepness > 0.003`), NOT the proximity value.** Reducing proximity does nothing when the mesh faces are physically steep.

### Attempt 3: Suppress cliff RAMP (geometry) near gentle edges  
Modified `computeHeightWithCliffErosion` to push `bestMu → 1.0` near gentle edges, suppressing the steep geometry. **Created blue holes** — suppressing the ramp near gentle edges means the cliff midpoint height isn't reached, leaving gaps between the two sides of the cliff where the water sphere shows through. Also created other visual artifacts.

### Root cause of all failures
All three attempts tried to SUPPRESS or FADE the existing single cliff system. The system treats ALL `cliffEdges` (any height diff) with the SAME narrow parabolic ramp. The fix must give each edge type its OWN distinct ramp from the start.

## Current Approach (Attempt 4)

Two changes:
1. **Per-edge ramp type in `computeHeightWithCliffErosion`**: Steep edges (2+ level) get narrow parabolic ramp → steep geometry → cliff texture. Gentle edges (1-level) get wide cosine ramp → smooth geometry → no cliff texture. Min-mu logic handles corners where different edge types meet.
2. **No neighbor propagation in `distToSteepCliff`**: Each hex only checks its own steep edges for cliff proximity. A "pass" hex with only 1-level diffs gets zero proximity → no cliff texture.

Key: both sides of a shared edge compute the SAME midpoint height, so the mesh stays watertight regardless of ramp shape.
