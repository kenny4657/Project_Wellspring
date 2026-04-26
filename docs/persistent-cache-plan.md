# Persistent Mesh Cache — Implementation Plan

Implements approach **(5) Persistent mesh cache** from
[scaling-to-1m-hexes-legacy.md](scaling-to-1m-hexes-legacy.md).
Goal: turn the 27s mesh build into a ~100–500ms cache load on
subsequent page loads. First-run cost is unchanged.

## What gets cached

The expensive output of `buildGlobeMesh` — per-chunk vertex/index
buffers — plus the inputs that produced them so we can detect
staleness.

**Cached:**
- Per-chunk: `positions` (Float32Array), `indices` (Uint32Array),
  `colors` (Float32Array), `cellIds` (Int32Array), `cellLocalStart`
  (Int32Array), `cellVertexCount` (Int32Array), `centroid` (xyz).
- Cells: minimal record per cell — `id`, `center` (xyz), `corners`
  (flattened xyz array), `neighbors` (Int32Array of ids), `terrain`,
  `heightLevel`, `isPentagon`.
- Top-level: `totalVerticesPerCell` (Int32Array), `chunkOfCell`
  (Int32Array).

**Not cached** (cheap to recompute on load):
- `normals` — re-derive from displaced positions, then run
  `smoothNormalsPass` once.
- `hexDebugColor` attribute — Knuth-hash bake is trivial.
- Border info, distance fields — they're builder-internal, not
  needed at runtime.

Skipping normals + hexDebug saves ~30% of the cache size.

## Cache size budget

Per-vertex bytes after skipping normals + hexDebug:
positions (12) + colors (16) = 28 bytes.

| Hex count | Verts (est) | Cache size | Verdict |
|-----------|-------------|------------|---------|
| 4k (res=20)  | ~5 M    | ~140 MB    | comfortable |
| 16k (res=40) | ~20 M   | ~560 MB    | OK on desktop, tight on mobile |
| 60k (res=80) | ~75 M   | ~2.1 GB    | over IndexedDB default quotas |
| 250k         | ~310 M  | ~8.7 GB    | not viable |
| 1M           | ~1.2 B  | ~33 GB     | not viable |

**Auto-disable rule**: if estimated cache size > 1 GB, skip writing
to cache. Log a warning. The build still runs every load at that
scale; cache is for the lower-hex-count regime where we iterate.

(Once approach (3) LOD is implemented, far chunks at low SUBDIVISIONS
have far fewer verts, and the cache budget for 1M+ becomes feasible
again — cache can re-enable.)

## Cache key / invalidation

Single string key:

```
wellspring-globe-v{CACHE_VERSION}-res{ICO_RESOLUTION}-tg{TERRAIN_GEN_VERSION}
```

- `CACHE_VERSION` — manual bump constant in `globe-cache.ts`.
  Increment whenever the mesh build changes meaning (height
  formula, cliff erosion, smoothing, vertex layout).
- `ICO_RESOLUTION` — picked up from `globe.ts`.
- `TERRAIN_GEN_VERSION` — manual bump in `terrain-gen.ts`.
  Increment when procedural terrain output changes.

If the key doesn't match, treat as a miss and rebuild.

Painting (`setHexTerrain`) is **not** invalidating — paints only
mutate color buffers in place; the cached mesh remains valid for
re-use. (Paints are not persisted today; orthogonal feature.)

## Storage layer

IndexedDB, single database `wellspring`, single object store
`globe-snapshots`. Key = the version string above. Value = a single
record containing all cached data as transferable buffers.

Schema (TypeScript shape; serialized as `{ ...fields }` directly to
IDB which handles ArrayBuffers natively):

```ts
interface GlobeSnapshot {
  cacheKey: string;
  createdAt: number;
  cellCount: number;
  cells: {
    ids: Int32Array;            // length = cellCount
    centersXYZ: Float32Array;   // length = cellCount * 3
    cornersFlat: Float32Array;  // packed xyz
    cornersOffsets: Int32Array; // length = cellCount + 1, prefix sum
    neighborsFlat: Int32Array;
    neighborsOffsets: Int32Array;
    terrains: Int32Array;
    heightLevels: Int32Array;
    isPentagonBits: Uint8Array;
  };
  totalVerticesPerCell: Int32Array;
  chunkOfCell: Int32Array;
  chunks: Array<{
    centroidXYZ: Float32Array;        // length 3
    cellIds: Int32Array;
    cellLocalStart: Int32Array;
    cellVertexCount: Int32Array;
    positions: Float32Array;
    indices: Uint32Array;
    colors: Float32Array;
  }>;
}
```

Reasons for this layout:
- Flat typed arrays are what IDB stores efficiently — no JSON
  serialization, no per-cell object overhead.
- Prefix-sum offsets for variable-length per-cell data (corners,
  neighbors) — same trick used in compressed sparse row matrices.
- Single record per snapshot keeps load to one `IDBObjectStore.get`
  call.

## Load path

In `createGlobeEngine`:

```
1. Try cache.read(cacheKey)
2a. HIT:
    - Deserialize cells → HexCell[]
    - For each cached chunk: create Mesh, applyToMesh with
      positions/colors/indices, compute normals + smoothNormalsPass,
      bake hexDebugColor, attach to chunkRuntime
    - Skip generateIcoHexGrid, assignTerrain, buildGlobeMesh entirely
2b. MISS:
    - Run today's path (generateIcoHexGrid + assignTerrain +
      buildGlobeMesh)
    - After build completes, if size budget OK: cache.write(snapshot)
```

Normals recomputation: per-triangle face normals from displaced
positions, then smoothNormalsPass. Roughly 100–500ms on 16k hexes,
vs 27s for the full build — easy win.

## Save path

After successful first build (post-smoothing, post-split):

```
const snapshot = serializeSnapshot(cells, chunks, ...);
const sizeBytes = estimateSnapshotSize(snapshot);
if (sizeBytes < CACHE_SIZE_LIMIT) {
  await cache.write(cacheKey, snapshot);
}
```

Keep one snapshot per `cacheKey` value. Older snapshots with
different keys can be cleaned up on write (delete-then-put pattern).

Write is async and non-blocking — happens after the engine returns.

## Force rebuild UI

Button in the View section of the sidebar in `+page.svelte`,
labeled **"Rebuild mesh"**. Behavior:

```
1. Call engine.clearCache() (awaits cache.delete(cacheKey))
2. window.location.reload()
```

Why reload instead of in-place rebuild: the engine's mesh build is
async and the entire scene is built around the chunk runtime; safer
to nuke and rebuild than to surgically replace meshes mid-session.

Add it under the existing "View" panel section, alongside the grid
toggle. Place near the bottom so it's not the first thing seen.

Also expose a console method: `window.engine.clearCache()` for dev.

## Files touched

- New file: [src/lib/engine/globe-cache.ts](../src/lib/engine/globe-cache.ts)
  — IndexedDB wrapper, serialization, version constant.
- [src/lib/engine/globe.ts](../src/lib/engine/globe.ts) — integrate
  read-on-init, write-after-build, expose `clearCache()` API.
- [src/lib/engine/globe-mesh.ts](../src/lib/engine/globe-mesh.ts) —
  factor out a `restoreChunksFromSnapshot(snapshot, scene)` helper
  that builds chunk meshes directly from cached buffers (skipping
  the build loop).
- [src/routes/globe/+page.svelte](../src/routes/globe/+page.svelte)
  — "Rebuild mesh" button, perf overlay row showing "Cache: hit/miss"
  and load source ("cache" vs "build").

## Edge cases

- **Quota exceeded on write**: catch `QuotaExceededError`, log
  warning, continue without caching. Don't crash the load.
- **Corrupt cache**: if deserialization throws, treat as miss and
  rebuild. Optionally delete the bad entry.
- **Browser without IndexedDB**: detect, skip cache, run normal
  build. (Unlikely in 2026 but the code path costs nothing.)
- **Multiple tabs**: IDB serializes writes; reads are concurrent.
  No special handling needed.
- **Schema migration**: don't try. Just bump CACHE_VERSION on any
  layout change — old entries become unreachable and are cleaned
  up on next write.

## Perf overlay additions

Two new rows under the existing perf block:

- `Cache` — `hit (loaded in 187ms)` or `miss (built in 27.2s)`
- (Replace `Mesh build` with the appropriate label depending on
  source, or keep both and show the inactive one as `—`)

## Open questions

1. **Cache size estimate**: should we measure actual size by
   serializing first, or estimate from totalVerticesPerCell? The
   estimate is simpler and probably fine — exact bytes don't matter.
2. **Should we cache pre-smoothing or post-smoothing buffers?**
   Post-smoothing is what we'd skip rebuilding. Recommend
   post-smoothing — that's the slow part.
3. **Cache the icosphere generation output too?** Generating the
   hex grid is ~1s at res=40; not the bottleneck but easy to add
   since cells are already serialized.
