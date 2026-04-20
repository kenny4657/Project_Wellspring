# Globe Mesh Transition Constraints

Every rule below must hold simultaneously. Fixing one gap must not break another.

## Core Invariant

**At any shared edge or corner between two adjacent hexes, both hexes MUST compute the exact same vertex height.** This is the root cause of every gap — if two hexes disagree on a shared vertex position, there's a hole.

## Height Formula

```
h = tierH * mu + borderTarget * (1 - mu) + noise * noiseCoeff
```

Where:
- `tierH` = this hex's LEVEL_HEIGHTS value
- `borderTarget` = ramp target at the nearest non-excluded edge
- `mu` = cosine interpolation of normalized distance to border (0 at edge, 1 at center)
- `noise` = fbmNoise at the unit-sphere position (deterministic per position)
- `noiseCoeff` = must match between adjacent hexes at their shared border

## Transition Types

### 1. Water↔Water Same Depth
- **Edge excluded** — both sides stay flat at their tier height
- Both use: `h = tierH + noise * NOISE_AMP`
- Result: continuous ocean surface, no ramp, no wall

### 2. Water↔Water Different Depth
- **Only the shallower hex ramps** down to the deeper hex's tierH
- Deeper hex excludes this edge (stays flat)
- Shallower at border: `h = deepTierH + noise * NOISE_AMP`
- Deeper at border: `h = deepTierH + noise * NOISE_AMP`
- **Noise coefficient MUST be identical** (both use full NOISE_AMP)

### 3. Water↔Land (Coastline)
- **Both sides ramp** toward sea level (target = 0)
- Water ramps up from depth, land ramps down from elevation
- Both at border: `h = 0 + noise * noiseCoeff` (same coeff for both)
- **No wall** at this edge — smooth slope replaces it
- Shore zone in shader (sand blend) handles the h≈0 visual

### 4. Land↔Land Same Height
- **Edge excluded** — no ramp, no wall
- Both use: `h = tierH + noise * NOISE_AMP`
- Result: continuous land surface

### 5. Land↔Land Different Height
- **No ramp** — wall from the higher hex covers the height step
- Both stay flat: `h = tierH + noise * NOISE_AMP`
- Higher hex emits wall quad down to BASE_HEIGHT

## Corner Constraint (Triple Junctions)

When 3+ hexes of different types/heights meet at a single corner vertex:
- ALL hexes must compute the same `h` at that corner
- At a corner, `dist = 0` for multiple non-excluded edges simultaneously
- The ramp target must be chosen CONSISTENTLY across all hexes
- Rule: **use the highest (closest to zero) target** among all nearby non-excluded edges
- This ensures all hexes converge to the same value at the corner

Example — deep(0) + shallow(1) + land(2) corner:
- Deep: target = 0 (from land edge)
- Shallow: targets = {-0.020 (deep edge), 0 (land edge)} → max = 0
- Land: target = 0 (from water edges)
- All three: h = 0 + noise * noiseCoeff → match

## Noise Coefficient Rules

To guarantee matching heights at borders, the noise coefficient must be the same on both sides:
- **Simplest rule: use NOISE_AMP everywhere** (no 0.3× reduction)
- This eliminates an entire class of mismatch bugs
- Water surface is slightly bumpier but shader handles visual smoothing

## Deep Ocean Fast Path

- Only applies when ALL neighbors are same-height water (`allSameHeight`)
- Uses simple fan geometry (6 tris vs 384)
- Corner vertices MUST include noise displacement to match adjacent subdivided hexes
- Between corners, the straight fan edge vs subdivided edge creates sub-pixel gaps (acceptable)

## Walls

- Only emitted by land hexes at land→land height transitions
- Never at coastline edges (land→water or water→land)
- Never by water hexes
- Emitted only from the HIGHER hex (faces outward/downward)
- Wall top = `tierH + noise * NOISE_AMP` at corner positions
- Wall bottom = `BASE_HEIGHT` (below all surfaces)

## Shader Boundary

- `seaLevel = -0.002 * R` in the shader
- Vertices with `h < -0.002` render as water
- Vertices with `h >= -0.002` render as land/shore
- Shore transition zone blends sand→grass for `h` near 0
- All water interior vertices must have `h < -0.002`
- Coastline border vertices at `h ≈ 0` are in the shore zone (intentional)
