# Water Implementation — Failed Attempts Log

## Core Problem
Water hex terrain geometry sits BELOW sea level (bowls/cavities at -0.020R to -0.008R). Need a visible flat surface AT sea level for ocean, while land occludes it.

---

## Approach 1: Terrain Shader — Height Threshold (`heightAboveR < seaLevel`)
**Commits:** fca7383, fab9de7, f1a9b18
**What:** Paint water pixels blue in terrain shader based on fragment height.
**Result:** FAILED — Spikes/jagged boundaries. Noise-displaced water geometry straddles the seaLevel threshold. Some fragments pass the check, others don't, creating spiky color boundaries. Works in "dry" mode only because both sides of the boundary are sandy (invisible).
**Root cause:** Height threshold can't cleanly separate water from land when noise displacement makes geometry straddle the boundary.

## Approach 2: Terrain Shader — Sphere Normal Override
**What:** Same as above but override N with normalize(vWorldPos) for water pixels.
**Result:** FAILED — "Less pronounced but still spikes." Lighting was smoother but the height threshold boundary was still jagged. Also tried early return with self-contained lighting.
**Root cause:** Same as #1 — the threshold itself is the problem, not the normals.

## Approach 3: Flatten Water Geometry (remove noise from computeSurfaceHeight)
**What:** Return flat tierH for water hexes, skip noise displacement.
**Result:** FAILED — Broke coastline ramps and slopes. Water hexes with borders need noise to match land hexes at shared edges. Only flattening `allSameHeight` interior hexes created visible gaps between flat and ramped water hexes.
**Root cause:** Noise coefficients must match on both sides of shared hex edges for watertight coastlines.

## Approach 4: Separate Water Sphere — Basic
**Commits:** 4f039cc, d00aa4b, aa87a42
**What:** Icosphere at sea level with water shader material.
**Result:** FAILED — Z-fighting everywhere. Water and terrain at same depth flicker.

## Approach 5: Water Sphere — Lowered to R*0.997
**Commits:** 3ce4976, f76fdfb, d7e1f6d
**What:** Water sphere slightly below terrain surface.
**Result:** FAILED — Still z-fighting at coastlines. Eventually abandoned for terrain shader approach (fab9de7).

## Approach 6: Water Sphere — Rendering Groups (water after terrain)
**What:** Terrain group 0, water group 1. Depth buffer preserved so terrain occludes water.
**Result:** FAILED — Rendering group 1 cleared depth buffer by default. Fixed with setRenderingAutoClearDepthStencil(1, false), but still had artifacts/flickering.

## Approach 7: Water Sphere — Rendering Groups (water BEFORE terrain)
**What:** Water group 0 (opaque), terrain group 1 on top. Depth cleared between groups so terrain always renders.
**Result:** FAILED — Water sphere color bleeds through sub-pixel gaps in terrain mesh. Blue spots visible on land, especially at hex boundaries and coastal areas.

## Approach 8: Don't Negate Normals for Water Hexes
**What:** Keep original normal direction for water, negate only for land.
**Result:** FAILED — "Looks awful." Inconsistent lighting between water and land.

## Approach 9: Terrain Shader — Vertex Color Detection
**What:** Detect water via `vColor.b > vColor.r + 0.15` instead of height threshold.
**Result:** FAILED — No spikes (vertex color is per-vertex, no threshold straddling), BUT still no actual surface at sea level. Geometry is still in bowls below sea level — "caved in."

---

# Coastline Color Transition — Failed Attempts Log

## Problem
The coastline shows a harsh, hex-shaped sandy strip where land meets water. The user wants smooth, organic color transitions from land terrain → sandy beach → water.

## Root Cause (confirmed by runtime diagnostics at commit 468f762)
Two sources of sandy pixels:

### Source A: Water hex vertices above water sphere
- Shallow_ocean (id=1) hex vertices poke above the water sphere (at `R * 0.9995`) near land borders
- Their palette is ALL sandy tan at every height band — shore, grass, hill are all tan
- No height manipulation can change the color — the palette itself is all-sandy
- Count: 68 vertices (in diagnostic sample), heights -0.0005 to +0.0004 (fraction of R)

### Source B: Land hex vertices in shore band
- The cosine height ramp drops land vertices near coast to low heights (0.05–20.84 km)
- `computeTerrainColor`'s shore-grass blend zone spans -22.94 to 53.52 km (76km wide)
- ALL 1152 land coastal vertices (in diagnostic sample) fall within this band
- They get sandy colors from `palShore ↔ palGrass` blend
- This 76km band is INTENTIONAL for interior terrain (creates two-tone color variation)
- Blend neighbors point to OTHER LAND terrains (hills=9, desert=6), NOT water

### Shore band math
- `amplitude = abs(topOffset) + abs(bottomOffset) = 637.1 km`
- `sw = terrainBlend[id] * amplitude = 0.06 * 637.1 = 38.23 km`
- `tierBase = tierH + noiseBias = 3.82 + 15.29 = 19.11 km` (grassland example)
- Shore band: `boundary1 - sw` to `boundary1 + sw` = -19.12 to 57.34 km
- Cosine ramp brings coastal vertices down to ~0 km → blend factor t ≈ 0.25 → 75% shore

## Baseline
Commit `4aaf0db` — land-land terrain blending works correctly. Coastline is the only remaining issue.

---

## Attempt C1: Noise-perturb coast distance field (CPU)
**Commit**: `965c6ef`
**What**: Added FBM noise to `dist` in `computeSurfaceHeight` before cosine ramp. COAST_NOISE_STRENGTH=0.35, COAST_NOISE_SCALE=12.0, COAST_NOISE_SAFE_ZONE=0.08. edgeSafety smoothstep keeps perturbation zero at shared edge.
**File**: `globe-mesh.ts` only
**Result**: FAILED — Zero visible effect
**Root cause**: Sandy color comes from the PALETTE (shallow_ocean palette is all-sandy), not from mesh height. Changing the height field doesn't change palette colors for water terrain IDs. And for land terrain IDs, the shore band is 76km wide — height perturbation can't push vertices out of it.

---

## Attempt C2: Enable water↔land blend encoding + shader blend (92% max)
**Commit**: `2becacb`
**What**: Removed `!nbIsWaterTerrain && !cellIsWaterTerrain` exclusion from `getHexBorderInfo`. Shader uses 92% max blend for water↔land transitions vs 45% for land↔land.
**Files**: `globe-mesh.ts`, `terrain-material.ts`
**Result**: FAILED — White gaps at hex corners, bright green ring artifacts
**Root cause**: Corner gap patches (`buildCornerGapPatchMesh`) used hardcoded `getTopFaceColor(cell.terrain, tierH, -1, 0)` with no blend data → showed as white. Shader noise modulation on coastal blend produced vivid green rings because the noise threshold created sharp contours.

---

## Attempt C3: Noise-perturb coast distance field (retry, CPU only)
**Commit**: `cdc6e49`
**What**: Same as C1 but inlined constants. Only changed `globe-mesh.ts`, no shader changes.
**Result**: FAILED — Zero visible effect (confirmed same root cause as C1)
**Root cause**: Identical to C1. Sandy strip is water hex palette + land hex palShore band. Height perturbation doesn't change palette colors.

---

## Attempt C4: Fix water blend + corner patches + shader water-to-land
**Commit**: `1d09cd7`
**What**: Three-part fix: (1) water↔land edges in blend encoding, (2) corner patches compute per-vertex blend data, (3) shader: water vertices use 100% land neighbor color (no noise), land vertices near water use smooth blend.
**Files**: `globe-mesh.ts`, `terrain-material.ts`
**Result**: FAILED — White gaps remained at some corners, green coloring in wrong areas, wrong blend direction, hard lines between terrain types at coast
**Root cause**: Green artifacts from shader using `palGrass(neighborId)` which is vivid flat green that doesn't match the actual terrain color. Hard lines between terrain types because each hex only encodes ONE neighbor — where two different land terrains meet at coast, there's no cross-blend.

---

## Attempt C5: Submerge coastal vertices below water sphere
**Commit**: `77610bf`
**What**: Changed coastal edge target from `0` to `-0.0008` so coastal vertices sit below the water sphere (`R * 0.9995`). Updated `borderTarget === 0` checks to match new value. Updated `smoothDistanceToTargetEdges` call.
**File**: `globe-mesh.ts` only
**Result**: PARTIAL FAIL — Water hex sandy strip hidden under water (good), but land-side sandy strip completely unchanged
**Root cause**: Land hex vertices still drop via cosine ramp into the palShore height range of `computeTerrainColor`. The shore band is 76km wide — hiding a few km at the bottom doesn't help when all vertices are deep inside the band.

---

## Attempt C6: Bypass shore palette, use palGrass directly
**Commit**: `1b6c1d2`
**What**: Shader detects water↔land blend (`isCoastalBlend`). Water hex vertices get `palGrass(neighborId)`. Land hex vertices near water blend `ownColor → palGrass(terrainId)` via coastFade.
**Files**: `globe-mesh.ts` (blend encoding for water→land), `terrain-material.ts`
**Result**: FAILED — Color too vivid green, doesn't match surrounding terrain at all
**Root cause**: `palGrass` is a flat bright green. Interior terrain shows a blended shore-grass color from `computeTerrainColor`. The flat vivid green looked completely wrong next to the natural terrain.

---

## Attempt C7: Use inland fake height for color lookup
**Commit**: `94a9a1a`
**What**: Shader computes `computeTerrainColor(id, inlandHeight)` where `inlandHeight = tierH + noiseBias` for coastal vertices. This gives the same color as deep interior terrain.
**File**: `terrain-material.ts` only
**Result**: FAILED — No beach at all, hard line between terrain types at coast
**Root cause**: Extended terrain color all the way to water edge with zero shore/sand transition. User wants a sandy beach — this removed it entirely. Also, two different land terrains at the coast showed a hard cut line with no cross-blending between them.

---

## Attempt C8: Noise-modulated shore band via distance-to-coast
**Commit**: `41940c8`
**What**: Shader uses `distToBorder + noise` to control shore↔grass boundary. `shoreWidth = 0.30 + coastNoise`. Both water and land vertices use `landId` for `palShore → inlandColor` blend via `smoothstep(0, shoreWidth, distToBorder)`.
**File**: `terrain-material.ts` only
**Result**: FAILED — Water vertices far from edge got green (wrong direction), hard lines between different land terrains
**Root cause**: `distToBorder` for water hex vertices increases toward hex CENTER (away from land), so `t=smoothstep(0, shoreWidth, distToBorder)` goes toward inlandColor in the wrong direction — center of water hex got green. Each hex encodes only one neighbor terrain, so two different land terrains at coast have hard boundary.

---

## Attempt C9: Water=always shore, land=noise gradient
**Commit**: `b1b8982`
**What**: Fixed C8's direction issue: water hex vertices always show `palShore(landNeighborId)`. Land hex vertices: noise-modulated `palShore → inlandColor` via `smoothstep(0, shoreWidth, distToBorder)`.
**File**: `terrain-material.ts` only
**Result**: FAILED — Black/dark lines appeared at hex edges, hard cut between different terrain types
**Root cause**: Black lines from edge cases in blend encoding where `distToBorder ≈ 0` produced artifacts. Two different land terrains at coast each show their own shore color independently with no cross-terrain blend — visible hard boundary.

---

## Attempt C10: Perturb color lookup height ±20km (shader only)
**Commit**: `dfd1e8b`
**What**: Shader adds world-space noise to `heightAboveR` before passing to `computeTerrainColor`. `seaProximity = 1.0 - smoothstep(seaLevel, seaLevel + 30.0, heightAboveR)` fades effect near sea level. Two noise octaves, ±20km amplitude. Reverted globe-mesh.ts to baseline.
**File**: `terrain-material.ts` only
**Result**: FAILED — Zero visible effect
**Root cause**: Shore-grass blend zone is 76km wide. ±20km noise only shifts blend factor t by ~0.26 within the zone. Both ends of the shifted range produce very similar sandy-tan mixes — palShore and palGrass colors for most terrains are too close in color to see a difference.

---

## Attempt C11: Amplify height noise to ±60km
**Commit**: `af60983`
**What**: Increased noise amplitude from ±20km to ±60km. Wider `seaProximity` fade (60km instead of 30km). Three noise octaves instead of two.
**File**: `terrain-material.ts` only
**Result**: FAILED — Still no visible effect
**Root cause**: Even with ±60km, `seaProximity` at typical coastal heights (15km) reduces effective amplitude to ±35km. The vertices are deep in a 76km blend zone where shore and grass palette colors are nearly identical (both are sandy-tan tones). The noise DOES shift the blend factor but the resulting color change is invisible.

---

## Attempt C12: Water blend encoding + isWaterToLand shader path
**Commit**: `468f762`
**What**: (1) `getHexBorderInfo`: water→land edges added to `edgeNeighborTerrains` (water hexes only). (2) Corner patches: per-vertex blend data. (3) Shader: new `isWaterToLand` branch — water vertices with land neighbor use land terrain's palette with noise-modulated shore↔grass transition.
**Files**: `globe-mesh.ts`, `terrain-material.ts`
**Result**: FAILED — Water hex sandy strip partially fixed (now shows land colors, but with green tint and wrong blend direction). Land-side sandy strip completely unchanged. Hard lines between terrain types at coast.
**Root cause**: Diagnostics confirmed all 68 water vertices got blend data (hasBlendData: 0→68). BUT the 1152 LAND coastal vertices have blend neighbors pointing to other LAND terrains (hills=9, desert=6), not water. Shader's `isWaterToLand` (terrainId ≤ 3) never fires for land vertices. They still go through `computeTerrainColor` → sandy. The land-side strip was never addressed.

---

## Approaches NOT yet tried
1. **Steeper cosine ramp** — Make the cosine ramp drop faster at coast so land vertices stay above the shore band until right at the water edge
2. **Separate coast-proximity vertex attribute** — Encode distance-to-nearest-water in vertex data so shader can suppress/narrow shore band near coast
3. **Reduce shore band width (sw) globally** — Make sw near-zero. Removes two-tone from ALL terrain (would need alternative for interior variation)
4. **Modify computeTerrainColor to accept coast-proximity** — Pass a parameter that shrinks sw near the coast, preserving it inland
5. **Replace cosine ramp with cliff-drop at coast** — Instead of smooth cosine interpolation, use a sharp step so land stays at full height until the shared edge, then drops vertically (wall handles visual)
