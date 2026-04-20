# Globe Mesh Transition Constraints

Every rule below must hold simultaneously. Fixing one gap must not break another.

## Core Invariant

**At any shared edge or corner between two adjacent hexes, both hexes MUST compute the exact same vertex height.** This is the root cause of every gap.

## Hard Constraints (NEVER violate)

### 1. Land hexes MUST ramp at water borders
Land hexes ramp down to sea level at coastline edges. This was explicitly requested and creates the smooth coastline transition. **NEVER revert to flat land + wall at coastline.**

### 2. Land-land transitions use walls, NOT ramps
Land hex ramps ONLY apply at water-adjacent edges. Land-land height transitions MUST use walls from the higher hex. A land ramp that affects vertices at land-land corners creates 100+ km height mismatches (proven by gap detection).

### 3. Water hexes ramp — never use walls
Water→land: ramp to sea level. Water→water different depth: shallower ramps to deeper. Same-depth water: excluded (continuous flat). No walls ever on water hexes.

### 4. No deep ocean flat fast path
Flat fan geometry (6 tris) creates topology mismatches with adjacent subdivided hexes (384 tris). All hexes must use full subdivision for consistent edge vertices.

## The Land Ramp Problem (UNSOLVED)

A land hex bordering BOTH water AND higher land has conflicting needs:
- It must ramp at its water edges (constraint #1)
- It must stay at full tier height at its land-land wall edges (constraint #2)

The current `distToBorder` approach applies the ramp globally based on distance to the nearest non-excluded edge. If water is the nearest non-excluded edge, ALL vertices get pulled toward sea level — including corners shared with higher land hexes. This creates huge gaps (127+ km) at those corners.

**The fix must**: ramp land vertices near water edges WITHOUT affecting vertices near land-land edges. This requires either:
- A per-vertex blend that considers distance to BOTH water edges and land-land edges
- Or separate distance fields for coastline vs interior

## Noise Rules

- At water-water borders: both sides must use `NOISE_AMP` (full)
- At water-land borders: both sides must use matching noise coefficient
- Water hexes without borders use `h = tierH + noise * NOISE_AMP`
- The noise coefficient interpolation (0.3× interior vs 1.0× border for water) creates mismatches when a water hex has borders to both land and other water

## Shader Boundary

- `seaLevel = -0.002 * R`
- Vertices with `h < -0.002` render as water
- Vertices with `h >= -0.002` render as land/shore
- Shore transition zone blends sand→grass near h=0
