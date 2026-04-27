# Cliff Edge Pre-Bake (GPU Displacement Phase 6)

Replaces the per-vertex 1-hop neighbor walk with a per-cell pre-baked
cliff edge table. The current 1-hop walk is the dominant vertex shader
cost in regions near tier transitions; replacing it with a tight texture
lookup gives an estimated 30-50% frame time reduction on those regions.

## Problem

Today's vertex shader, for every vertex of a cell with `hasCliffWithin1Hop`,
runs:

```glsl
walkCliffEdges(self);                       // 6-12 edge tests
for (int i = 0; i < 12; i++) {              // 1-hop loop
    int nbId = nbIds[i];
    if (nbId < 0) continue;
    readHexData(nbId);                      // 1 texelFetch (probe)
    if (!nbHasCliffNbr) continue;
    readNeighbors(nbId);                    // 2 texelFetches
    readCornersAndNeighborIds(nbId);        // 12 texelFetches
    walkCliffEdges(nb);                     // 6-12 edge tests
}
```

Per vertex on a coast/cliff cell:
- ~50-80 texelFetches just to access neighbor data
- Up to 12 + 144 = 156 edge-distance computations
- Loop body has heavy branch divergence between qualifying/non-qualifying neighbors

For ~30-50% of visible mesh vertices (those with `hasCliffWithin1Hop=true`),
this cost runs every frame. It's the single largest contributor to GPU time.

## Insight

Every vertex in a given cell asks the same question: "what cliff edges
are reachable from somewhere inside this cell?" The answer is a *property
of the cell*, not of the vertex. We compute it 200+ times per cell per
frame today (once per vertex). Compute once at build time, store it,
read once per vertex.

## Data structure

Per cell, a small table of cliff edges:

```ts
interface CliffEdge {
    a: Vector3;        // edge endpoint A on unit sphere
    b: Vector3;        // edge endpoint B on unit sphere
    midTier: number;   // (selfTierH + nbTierH) * 0.5 for the edge's owner cell
    isSteep: boolean;  // narrow rampWidth (0.2*r) vs gentle (0.7*r)
    isRock: boolean;   // gates fragment-shader brown coloring
}
```

The set per cell: union of (a) every cliff edge of self, plus (b) every
cliff edge of each immediate neighbor. Duplicates removed (an edge
shared between two cliff-adjacent cells is stored once).

For the typical coastal cell, this is 3-6 entries. For a cell with many
varied neighbors, up to ~12. Cells with `hasCliffWithin1Hop=false`
store 0.

## Texture layout

Two textures:

1. **`hexCliffCountTex`** — 1 byte per cell, packed into an existing
   spare nibble of `hexDataTex` (alpha channel bits 4-7 are unused).
   Tells the shader how many cliff edges to read.

2. **`hexCliffEdgesTex`** — RGBA32F. 12 slots per cell × 2 texels per
   edge = 24 texels per cell.

   Per-edge layout:
   ```
   texel 0: (a.x, a.y, a.z, midTier)
   texel 1: (b.x, b.y, b.z, flags)    // flags: bit0=isSteep, bit1=isRock
   ```

   Width 256, height = ceil(16384 × 24 / 256) ≈ 1536. Total ≈ 6 MB.

   Cells with fewer than 12 edges leave trailing slots zeroed; the
   loop terminates at `i >= cliffCount`.

## Shader changes

Replace the entire `walkCliffEdges(self) + 1-hop loop` block:

```glsl
int cliffCount = readCliffCount(id);                     // 1 fetch (in hexDataTex)
if (cliffCount > 0) {
    for (int i = 0; i < 12; i++) {
        if (i >= cliffCount) break;
        vec4 e0 = readCliffEdgeA(id, i);                 // 1 fetch
        vec4 e1 = readCliffEdgeB(id, i);                 // 1 fetch
        vec3 a = e0.xyz;
        vec3 b = e1.xyz;
        float midTier = e0.w;
        int flags = int(e1.w + 0.5);
        bool isSteep = (flags & 1) != 0;
        bool isRock  = (flags & 2) != 0;
        // ... existing ramp math, accumulate bestMu/midWeightSum/midWeightedH/rockMu
    }
}
```

Per vertex on a coast/cliff cell: ~7-13 fetches, ~3-6 distance computations.
Down from ~50-80 + 156. **5-10× reduction.**

## CPU build

In `gpu-displacement/cliff-edges-tex.ts` (new file, ~200 lines):

```ts
export function buildCliffEdgesTexture(cells: HexCell[], scene: Scene)
    : { tex: RawTexture; counts: Uint8Array; data: Float32Array; width: number; height: number }
```

Algorithm per cell `c`:
1. Collect candidate edges from `c` and from each neighbor `nb`.
2. For each candidate (between cell X and its neighbor Y at edge slot k):
   - Skip if not a cliff (use existing `isCliffEdge` from `hex-borders.ts`).
   - Compute `midTier`, `isSteep`, `isRock`.
   - Use a canonical key `(min(X.id, Y.id), max(X.id, Y.id))` to deduplicate.
3. Pack into the cell's 12 slots; truncate or warn if more than 12.

Uses existing `hex-borders.ts` classifiers — no shader/CPU drift since
the same predicates run.

## Edit invalidation

Two edit operations exist; their effects on the cliff edge tables differ:

### `setHexTerrain` (terrain change only)

Cliff status depends only on `heightLevel`, not on `terrain`. Tables
unchanged. **No invalidation needed.** Painting stays at the current
~1µs per stroke.

### `setHexHeightLevel` (tier change)

Changing cell C's tier can:
- Create or destroy a cliff edge between C and any of C's 6 neighbors
- Promote/demote that edge's `isSteep` (gap may cross the ≥2 threshold)
- Promote/demote `isRock` (water-vs-tall-land threshold crossing)
- Affect the cliff edge table of any cell within 2 hops of C
  (because C's cliff edges appear in 1-hop neighbors' tables, which
  appear in 2-hop neighbors' tables via their 1-hop walk... actually
  only 2 hops out is the affected radius)

Invalidation set: **C + all 1-hop neighbors + all 2-hop neighbors**.
Typical: ~25 cells.

For each affected cell, rebuild its cliff edge table by re-running the
build algorithm above. Then upload the changed slice of the texture.

Cost: ~25 cells × ~12 edges × small math = sub-millisecond. Plus a
texture sub-rect upload.

Still way faster than today's "no live height path" — currently height
edits aren't supported at all on the CPU mesh.

## Expected gains

- **Vertices in deep-interior** (no cliff within 1-hop): unchanged from
  current, since `hasCliffWithin1Hop` already short-circuits.
- **Vertices near a transition** (the bottleneck today): from ~50-80
  fetches to ~7-13 fetches. **5-10× per-vertex reduction.**
- **Frame total**: depends on view, but typically 30-50% reduction
  given those expensive vertices are 30-50% of visible mesh.
- **Edit cost**: terrain edit unchanged (instant); height edit goes
  from "unsupported" to "sub-millisecond plus texture upload".

## Risks

1. **Cell exceeds 12 cliff edges.** A pentagon adjacent to many varied
   neighbors might. Mitigation: truncate (keep first 12), warn at
   build time. Visual impact would be missing cliff erosion from one
   edge in an extreme corner case — barely visible.

2. **Edit invalidation correctness.** Easy to under-invalidate (visual
   stale state) or over-invalidate (perf hit). Mitigation: a debug
   mode that rebuilds ALL tables on every edit and diffs vs
   incremental rebuild. Run in tests.

3. **Texture format support.** RGBA32F is required. Already used by
   `hexCornersTex`, so the platform is verified.

4. **Sim-mirror staleness.** `debug.ts`'s `simulateShaderHeight` has
   the old per-cell walk. Doesn't matter for correctness (sim only
   runs for diagnostics), but the diagnostic comparisons would diverge
   from rendered output. Update sim to mirror the new shader.

## Implementation order

1. **`cliff-edges-tex.ts`**: build function + texture upload. ~200 lines.
2. **Wire texture into `gpu-displacement/index.ts` and the shader
   material**. ~30 lines.
3. **Shader: replace 1-hop walk with new texture lookup**. ~80 lines
   GLSL.
4. **Sim mirror in `debug.ts`**: same algorithm port. ~50 lines.
5. **`setHexHeightLevel` invalidation**: rebuild affected cells'
   cliff edge tables and re-upload. ~80 lines.
6. **Verification**: visual diff against pre-change build, perf
   measurement.

Total: ~440 lines, mostly mechanical.

## What this does NOT change

- Land surface noise, scratchy texture, color blending — all
  fragment-side, unaffected.
- Cross-terrain blend in vertex shader — uses `readTerrainId`, not
  cliff data. Unaffected.
- `hasCliffWithin1Hop` flag — still useful as a fast skip for cells
  with `cliffCount == 0`. Could even be derived from `cliffCount`,
  but keeping it as a separate bit avoids one fetch.
- Corner-snap idea — orthogonal. This pre-bake works on its own;
  corner-snap could layer on top later if we still need it.
