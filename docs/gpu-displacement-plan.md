# GPU Displacement (Approach #4) — Implementation Plan

Implements approach **(4) GPU-side displacement** from
[scaling-to-1m-hexes-legacy.md](scaling-to-1m-hexes-legacy.md).

CPU builds flat unit-sphere hex meshes only; the vertex shader
computes the full displacement (noise + cliff erosion + coastline
rounding) every frame from a small set of textures. Eliminates
the 17-min-rebuild and 35-GB-cache problems that block 1M+ hexes.

## Why this works when the previous shader-globe attempt didn't

The earlier `terrain-colors-v2` experiments tried a uniform smooth
icosphere with per-fragment displacement. That failed because
uniform mesh density at any reasonable subdivision was the wrong
distribution — too sparse where cliffs needed detail, too dense
on flat ocean.

This plan **preserves the per-hex tessellated mesh structure on
CPU** — same subdivided hex prisms as today — and only moves the
*height function* to GPU. Mesh density per hex is unchanged; what
changes is where the height math runs.

## Architecture summary

```
   CPU build (one-time, ~50ms even at 1M hexes):
   ┌─────────────────────────────────────────────────────┐
   │ 1. generateIcoHexGrid → cells                       │
   │ 2. assignTerrain → cells.terrain, cells.heightLevel │
   │ 3. assignCellsToChunks → chunks                     │
   │ 4. For each chunk: build FLAT unit-sphere mesh       │
   │    (subdivided hex tops + walls, no displacement)   │
   │ 5. Write per-hex data into hexDataTex                │
   │ 6. Bake fbmNoise into noiseHeightmap (cubemap)       │
   └─────────────────────────────────────────────────────┘

   Per frame (GPU):
   ┌─────────────────────────────────────────────────────┐
   │ Vertex shader, for each vertex:                     │
   │   unitDir = position;       // already on sphere    │
   │   hex     = hexDataTex[hexId];                       │
   │   noise   = sample(noiseHeightmap, unitDir);         │
   │   tier    = levelHeight(hex.heightLevel);            │
   │   cliff   = cliffErosion(unitDir, hex);              │
   │   coast   = coastRounding(unitDir, hex);             │
   │   h       = tier + noise + cliff + coast;            │
   │   worldPos = unitDir * radius * (1 + h);             │
   │   gl_Position = viewProj * vec4(worldPos, 1);        │
   └─────────────────────────────────────────────────────┘
```

No CPU-side displacement. No per-frame rebuild. Editing = texture
write.

## Data structures

### CPU mesh (per chunk)

Flat hex mesh with vertices on the unit sphere — same tessellation
algorithm as today (`subdivTriangle`, `subdivideEdge`), but skip
the displacement step entirely.

Vertex attributes:
- `position: vec3` — unit direction on sphere (length 1.0)
- `hexId: float` — index into hexDataTex (one per hex, ~1M max →
  fits in float32 mantissa cleanly)
- `localUV: vec2` — barycentric within the hex (used by fragment
  shader for terrain blending; replaces today's vertex color
  encoding)
- `wallFlag: float` — 0.0 = top vertex, 1.0 = wall vertex
  (replaces today's `vColor.a < 0.05` check)

That's 28 bytes/vert vs current 28 (positions+colors). Same
budget, different content.

### Noise heightmap (one global texture)

A baked sample of `fbmNoise(unitDir)` for the whole sphere.

- Storage: **cube map**, 6 × 1024×1024, R16F format = 12 MB
  - Cubemap sampling on GPU is very fast (1 cycle)
  - 1024² per face = ~0.5° angular resolution → finer than the
    finest hex at 1M scale
- Bake: at startup, run `fbmNoise` on each cube face's pixel
  positions, project to unit sphere, store. ~1–2 s.

Three noise channels are needed today (rawNoise, cliffNoise,
midNoise). Cliff and mid noise can be derived from raw via
position offset + scale shift; bake one channel, derive the
others in-shader. Or bake all three into RGB16F = 36 MB. Not a
big deal either way.

### Per-hex data texture

One pixel per hex, indexed by `hexId`. At 1M hexes → 1024×1024
RGBA texture.

Layout (per pixel, 16 bytes):
| Component | Type   | Meaning                                   |
|-----------|--------|-------------------------------------------|
| R         | uint8  | heightLevel (0–4)                         |
| G         | uint8  | terrain (0–14)                            |
| B         | uint8  | isPentagon flag + edge count              |
| A         | uint8  | reserved                                  |
| (next 3 pixels) | -- | up to 6 neighbor heightLevels, packed     |

Reading: vertex shader does `texelFetch(hexDataTex, ivec2(hexId%w, hexId/w))`.

For neighbor data (needed for cliff erosion), use either:
- **Adjacent pixels** in the same texture (4 pixels per hex = 64 bytes)
- **Separate buffer texture** indexed by hexId for cleaner layout

Total at 1M: 64 MB. Comfortable.

### Per-hex corner positions

Cliff erosion needs `distToSegment(point, edgeA, edgeB)` for each
edge of the hex. The edge endpoints are corner positions on the
unit sphere — needed by the shader.

Options:
- **Bake all corners into a buffer texture** — 1M hexes × 6 corners
  × 12 bytes = 72 MB. Workable but bulky.
- **Pass corners as instanced vertex data** — only the relevant
  hex's corners are loaded per draw call. Doesn't match our
  draw-by-chunk pattern.
- **Compute corner positions in shader from hex center + ico
  geometry** — possible but complex; not all hexes are regular,
  pentagons exist, and corner positions came out of a slerp
  projection on CPU.

Recommended: **bake corners**. 72 MB is fine for a 1M-hex world.

### What's NOT in textures

- Smoothing positions (smoothLandSeamPositions etc.) — gone. With
  GPU displacement the height function is deterministic, so two
  vertices at the same unit direction always compute the same
  displacement. No CPU snapping needed.
- `vertexStarts`, `totalVerticesPerCell`, `chunkOfCell` — still
  needed for paint/edit operations to know which texels to update.
- `colorsBuffer`, `positionsBuffer` (per-vertex CPU mirrors) —
  gone. State lives in textures.

## Vertex shader (structure)

```glsl
#version 300 es
precision highp float;

uniform mat4 viewProj;
uniform float planetRadius;
uniform samplerCube noiseHeightmap;
uniform sampler2D hexDataTex;
uniform sampler2D hexCornersTex;
uniform float NOISE_AMP;
uniform float NOISE_SCALE;

in vec3 position;       // unit direction
in float hexId;         // packed cell index
in vec2 localUV;        // for fragment
in float wallFlag;

out vec3 vWorldPos;
out vec3 vUnitDir;
out vec2 vLocalUV;
out float vWallFlag;
out float vTierHeight;
out float vCliffMask;

void main() {
    vec3 unitDir = normalize(position);

    // 1. Sample noise
    float rawNoise = textureLod(noiseHeightmap, unitDir, 0.0).r;

    // 2. Read hex data
    HexData hex = readHex(hexDataTex, hexId);
    float tierH = levelHeight(hex.heightLevel);

    // 3. Cliff erosion: walk edges, compute (mu, midH)
    float bestMu = 1.0;
    float bestMidH = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= hex.edgeCount) break;
        Edge e = readEdge(hex, i);
        if (!e.isCliff) continue;
        applyCliffEdge(unitDir, e, hex, bestMu, bestMidH);
    }

    // 4. Coastline rounding (only if hasBorder)
    float coastAdjust = 0.0;
    if (hex.heightLevel >= 2 && hex.hasCoast) {
        coastAdjust = computeCoastRound(unitDir, hex);
    }

    // 5. Compose displacement
    float baseH = tierH + rawNoise * NOISE_AMP;
    float h = mix(bestMidH, baseH, bestMu) + coastAdjust;

    // 6. Apply wall geometry (when wallFlag == 1.0, snap down to
    //    wall bottom radius — same as today's wall vertex emission)
    if (wallFlag > 0.5) {
        h = wallBottomHeight(hex, unitDir);
    }

    vec3 worldPos = unitDir * planetRadius * (1.0 + h);
    vWorldPos = worldPos;
    vUnitDir = unitDir;
    vLocalUV = localUV;
    vWallFlag = wallFlag;
    vTierHeight = tierH;
    vCliffMask = 1.0 - bestMu; // 1.0 in cliff zone, 0.0 elsewhere
    gl_Position = viewProj * vec4(worldPos, 1.0);
}
```

Total ops per vertex:
- Cubemap sample: ~1 cycle
- Hex data read: 4 texel fetches
- Cliff edge loop: 6 × ~50 ops = 300 ops
- Coast rounding: ~50 ops
- Total: ~600 ops + texture samples

At 1M hexes × 1300 verts × 60 fps × 600 ops ≈ **45 GFLOPS**.
Within budget for any modern GPU including integrated.

## Fragment shader

Mostly unchanged from today. Inputs change:
- `vColor` → derived from `vUnitDir` + `vLocalUV` + per-hex texture lookup
- `vCliffProximity` → received as `vCliffMask` from vertex shader
- Lighting model identical (sun + ambient)

Specifically: fragment shader reads `hexDataTex` at this hex to get
terrain id, looks up terrain palette, blends with neighbor terrain
(which it gets the same way the vertex shader does — by walking
the hex edges and finding the nearest border).

The existing `terrain-material.ts` shader can be ported nearly
verbatim; the only structural change is moving from "data baked
into vertex color" to "data fetched from texture."

## Normals strategy

Today: per-triangle face normal + `smoothNormalsPass` for top
faces, raw face normal for walls.

With GPU displacement, recommendation is **finite-difference
analytic normals in vertex shader**:

```glsl
vec3 computeNormal(vec3 unitDir, ...) {
    float eps = 0.0005;
    // Build orthogonal tangent basis at unitDir
    vec3 t1 = normalize(cross(unitDir, vec3(0,1,0)));
    vec3 t2 = cross(unitDir, t1);

    float h0 = sampleHeight(unitDir);
    float h1 = sampleHeight(normalize(unitDir + t1 * eps));
    float h2 = sampleHeight(normalize(unitDir + t2 * eps));

    vec3 d1 = (unitDir + t1 * eps) * (1.0 + h1) - unitDir * (1.0 + h0);
    vec3 d2 = (unitDir + t2 * eps) * (1.0 + h2) - unitDir * (1.0 + h0);
    return normalize(cross(d1, d2));
}
```

Cost: 3× the height function evaluations per vertex. With most of
that being a cubemap sample, ~3× the per-vert cost we already
budgeted. Still within 150 GFLOPS at 1M hexes — fine.

This gives **smooth analytic normals** (no need for the smoothing
pass). Cliff-erosion regions naturally get sharper normals because
the height function has a steeper gradient there.

For walls (wallFlag=1.0) skip the height computation and use the
normal of the radial outward direction at the wall midpoint —
same as today.

## Editing operations

| Operation | Today | With GPU displacement |
|-----------|-------|------------------------|
| Paint terrain | `updateCellTerrain` rebuilds vertex colors for cell + neighbors (~5–10ms) | Write 1 byte to `hexDataTex` (~1µs) |
| Change heightLevel | Not implemented today (would require chunk rebuild) | Write 1 byte to `hexDataTex`, plus 1 byte to each affected neighbor's neighbor-list entry (~10 writes total, ~10µs) |
| Add/remove cliff | Derived from heightLevel; same 1-byte updates above | Same |

Painting is **1000× faster** than today. Real-time brush dragging
becomes trivially possible.

## Chunking + LOD still apply, but light

- **Chunking**: same as today. Visibility culling still useful;
  GPU shader still runs once per visible vertex per frame.
- **LOD**: still useful at 1M hexes for vertex-count budget (1.3B
  verts at SUB=3 doesn't fit in GPU memory even as flat positions),
  but rebuilds become **flat-mesh tessellation only** — no
  displacement, no smoothing. ~10–50ms per chunk vs 21s today.
- **No tier-change pop**: shader output is identical regardless
  of mesh density (analytic). Smooth transition.
- **No seam problem**: shader is consistent everywhere. Adjacent
  vertices at same unit-direction get same displacement.

So this plan effectively **subsumes the per-chunk LOD work** —
the LOD machinery becomes a 50-line "swap which flat mesh you
draw based on camera distance" rather than a 400-line rebuild
scheduler.

## Implementation phases

### Phase 1: Bake noise + flat mesh build (~300 lines)

- Add `noise-bake.ts`: render `fbmNoise` to a cubemap target via
  a one-shot fullscreen-quad shader, or do CPU bake into a
  Float32Array and upload. ~150 lines.
- Modify `globe-mesh.ts`: add a `buildFlatChunkMesh` path that
  emits unit-direction positions only. Existing displacement
  loop and smoothing become unused. Keep them around behind a
  feature flag for fallback. ~100 lines new.
- Add hex data texture builder: pack `cells[]` into RGBA8 texture
  + neighbor lookup texture. ~50 lines.

### Phase 2: Vertex shader port (~400 lines GLSL)

- Port `computeHeightWithCliffErosion` to GLSL. The math itself
  is mostly straightforward; the loop structures need fixed-size
  unrolling (max 6 edges).
- Port `applyCliffEdge`, `distToSegment`, `distToBorderWithTarget`,
  `smoothDistanceToTargetEdges`. All map to GLSL cleanly.
- Port `cornerPatchHeight` if corner patches are kept (they may
  become unnecessary with shader displacement since the gap
  problem is gone).
- Add finite-difference normal computation.

### Phase 3: Fragment shader port (~150 lines)

- Move terrain blending from vertex-encoded RGBA to texture-based
  lookup.
- Keep cliff/coast paint masks (already computed in vertex shader).
- Existing `terrain-material.ts` provides the structure.

### Phase 4: Edit path rewrite (~100 lines)

- `setHexTerrain`: replace `updateCellTerrain` with a single
  `texSubImage2D` call that writes the new terrain byte.
- New `setHexHeightLevel`: same pattern, plus updates to the
  neighbor-list entries of all 6 (or 5) neighbors.
- Remove `colorsBuffer` and `positionsBuffer` plumbing (CPU
  mirrors no longer needed).

### Phase 5: LOD lite (~100 lines, optional, only at 1M+ scale)

- Pre-build flat meshes at SUB=0/1/2/3 per chunk.
- Per-frame tier picker per chunk (same logic as the per-chunk
  LOD plan, but the picker just selects which buffer to bind).
- Hemisphere culling already in place.

**Total: ~1050 lines.** Roughly 1.5–2 weeks focused work. (No
fallback path — discrete-GPU target means we delete the CPU
displacement path once the GPU path is verified.)

## What stays the same

- `icosphere.ts` — hex grid generation unchanged.
- `terrain-gen.ts` — terrain assignment unchanged.
- `globe-chunks.ts` — chunk assignment + visibility unchanged.
- `globe.ts` engine wiring — minor edits to texture upload path.
- All visuals, all noise constants, all heightLevels, all
  terrain types.
- Camera + picking — pickable mesh is still per chunk; flat-mesh
  picking returns the unit direction, then the cell lookup is
  the same as today.

## What gets removed

- `mesh-smoothing.ts:smoothLandSeamPositions` etc. — no longer
  needed (shader output is consistent at coincident points).
- The `[SEAM DIAGNOSTIC]` block — no seams to diagnose.
- `buildCornerGapPatchMesh` — corner gaps were a CPU artifact.
- The `CliffsTab` per-chunk rebuild on cliff edits — replaced
  with texture write.
- `colorsBuffer` / `positionsBuffer` per-chunk CPU mirrors.
- The async build yield (build is fast enough sync now).

## Risks and unknowns

1. **GLSL fbmNoise port correctness.** The CPU `fbmNoise` and a
   GLSL port must produce *identical* values to within FP
   precision, or the cubemap bake (CPU) and runtime samples (GPU)
   won't agree. Mitigation: bake on GPU instead of CPU using a
   shader-side fbmNoise — then there's only one implementation
   to validate.

2. **Pentagon edge handling.** The vertex shader's edge loop
   assumes 6 edges; pentagons have 5. The `edgeCount` field
   handles this with an early-out, but cliff/coast math near a
   pentagon corner needs verification.

3. **Per-hex data texture size at 1M.** 1024×1024 = exactly 1M.
   Pushing past 1M hexes requires a 2048×1024 texture (still
   fine) or a buffer texture.

4. ~~Mobile / integrated GPU compatibility.~~ **Resolved**:
   target is desktop with discrete GPU. No fallback path needed.

5. **Painting/editing immediate visual feedback.** Today the
   color buffer write is followed by `setVerticesData` which
   forces a GPU upload. Texture writes are async; the change
   shows up the next frame (which is what we want). No risk
   here actually.

6. **Anti-aliasing of cliff edges.** Today cliff fragments are
   identified by the cliff-erosion mu mask; FXAA smooths the
   transitions. The same mu mask is computed by the vertex
   shader and passed to fragment, so this should work identically.

## Open questions

1. **Bake noise on CPU or GPU?** Recommendation: CPU bake first.
   - **CPU bake**: deterministic across devices (GPU FP precision
     varies between vendors), reuses existing `fbmNoise.ts`, no
     render-to-cubemap infrastructure, can run in a Web Worker
     during page load. First-bake cost ~3 s; cache the result to
     IndexedDB so subsequent loads skip it.
   - **GPU bake**: ~3000× faster (1ms vs 3s), enables runtime
     re-baking if noise scale/seed becomes a UI setting.
   - The "implementation drift" worry is mostly a non-issue:
     runtime shader only *samples* the baked cubemap, never calls
     `fbmNoise`. Drift only matters if other CPU-side code (picking,
     AI) needs to agree with GPU heights — and the fix there is
     "have CPU helpers also sample the cubemap," not GPU baking.

2. **Single noise channel or three?** Today uses raw, cliff,
   mid noise — different scales/offsets of fbm. If GPU bake is
   used, baking three channels is free (3× the render-target
   memory but 1× the bake time). Probably bake all three.

3. **Hex corner storage layout?** Buffer texture vs 2D texture
   indexed by hexId. Probably buffer texture for cleaner layout.

4. ~~Keep fallback CPU path?~~ **Resolved**: no fallback (discrete
   GPU target). Cut ~150 lines from the estimate.

5. **At what scale do we cut over?** Implement GPU displacement
   behind an opt-in toggle (like `setDebugMode`). Validate visual
   parity via offscreen-render diff, then make it default and
   delete the CPU path.

## Comparison vs the (1)+(2)+(3)+(5) path

|                        | Current path (chunking + LOD + cache) | GPU displacement (#4) |
|------------------------|----------------------------------------|------------------------|
| Lines to write         | ~150 (LOD lite) or ~600 (full)         | ~1050                  |
| Effort                 | days                                   | ~1.5–2 weeks           |
| Hits 16k smoothly      | yes (already does)                     | yes                    |
| Hits 100k smoothly     | yes                                    | yes                    |
| Hits 1M smoothly       | only with full per-chunk LOD + Worker  | yes, naturally         |
| Build time at 1M       | minutes incrementally                  | ~50ms total            |
| Edit responsiveness    | painting OK, height change requires rebuild | painting + height instant |
| Visual transition between LODs | requires hysteresis + seam stitching | none — shader is continuous |
| Cache management       | required for usable feel               | not needed             |
| Risk                   | low                                    | medium (shader port)   |

**The (4) path replaces three other approaches with one.**
Bigger upfront cost; better end state.

## Decision

Decisions taken:
1. **Visual parity test**: render CPU and GPU paths to offscreen
   targets at the same camera, diff pixel-by-pixel, gate the
   default-cutover on near-zero diff. Implement this as part of
   Phase 2 so we have a regression check while porting the shader.
2. **Target devices**: desktop with discrete GPU. No integrated /
   mobile fallback. Drop the ~150 lines of fallback wrapping.
3. **Stash code**: not reused. Port from `hex-heights.ts` /
   `hex-distance-fields.ts` / `hex-borders.ts` directly. Cleaner
   start; the stash had architectural assumptions (uniform
   icosphere) that don't apply here.

Ready to start when you are. Phase 1 (CPU bake noise → cubemap +
flat-mesh build path) is the right kickoff because it's
self-contained and produces a verifiable artifact (the cubemap)
without needing the shader yet.
