# Persistent Mesh Cache — Implementation Plan

Implements approach **(5) Persistent mesh cache** from
[scaling-to-1m-hexes-legacy.md](scaling-to-1m-hexes-legacy.md).

## Status: deferred — fold into (3) LOD

A whole-globe cache works at low hex counts but doesn't scale.
At 1M hexes a snapshot is ~42 GB (verts + indices + colors) — well
past IndexedDB practical limits, and bigger than most users' free
disk. The cache only fits at 16k–60k hex counts (~560 MB to ~2.1
GB), where the build is 27s today and caching cuts it to ~100ms —
useful for iteration but not for hitting 1M.

The cache only becomes valuable at scale once (3) LOD is in,
because LOD partitions a chunk into multiple cheaper representations
(SUB=0 far, SUB=3 near) and the cache stores **(chunkId, lodTier)**
combinations rather than one giant globe-wide blob. Per-chunk-per-tier
caching makes camera movement smooth: the first visit to a region
builds chunks at higher LOD, the second visit reads them from cache.

That's a different shape of cache than "snapshot the whole globe."
Building the whole-globe version now and replacing it with per-chunk
later is throwaway work.

**Decision: fold cache into the LOD implementation as a sub-module.**

LOD already needs a `buildChunkAtLOD(chunkId, lodTier)` function
that produces the chunk's vertex buffers. Caching just stores that
function's output keyed by `(chunkId, lodTier, terrainGenVersion,
buildVersion)` and short-circuits the next call. ~100 lines on top
of LOD, vs ~200 lines as standalone.

## What the cache layer needs to do (when implemented as part of LOD)

- **Key**: `chunk{N}-lod{T}-v{BUILD}-tg{TG}` per chunk-tier pair.
- **Value**: per-chunk buffers (positions, indices, colors,
  cellLocalStart, cellVertexCount). Skip normals + hexDebug — fast
  to recompute on load.
- **Storage**: IndexedDB, single object store, one record per key.
- **Invalidation**: bump `BUILD` constant when build math changes,
  bump `TG` when terrain-gen output changes. Old keys become
  unreachable; cleaned up on a periodic sweep or never (browser
  evicts under quota pressure).
- **Read path**: in `buildChunkAtLOD`, check cache first. Hit →
  deserialize buffers, recompute normals + hexDebug, attach to
  Babylon mesh.
- **Write path**: after a fresh build of a chunk-tier, write to
  cache asynchronously (don't block the build pipeline).
- **Quota handling**: catch `QuotaExceededError`, log, continue
  without writing. Browser will evict least-recently-used entries
  under pressure.
- **Force rebuild UI**: button in View panel that calls
  `cache.clearAll()` then `location.reload()`. Also exposed as
  `window.engine.clearCache()`.

## Cache size at 1M hexes (with LOD)

Per-chunk verts at each LOD tier (rough — 1M hexes / 80 chunks =
12.5k hexes per chunk, average):

| Tier  | SUBDIVISIONS | Verts/chunk | Bytes/chunk (28 B/vert + indices) |
|-------|--------------|-------------|------------------------------------|
| far   | 0            | ~225k       | ~10 MB                             |
| mid-far | 1          | ~900k       | ~40 MB                             |
| mid   | 2            | ~3.6M       | ~160 MB                            |
| close | 3            | ~14.4M      | ~640 MB                            |

In practice, a session only ever cache-fills the chunks the camera
visits at the tiers it visits. Far tier is whole-globe (80 chunks ×
10 MB = 800 MB). Close tier is only ever a handful of chunks the
camera parks over (~5 chunks × 640 MB = 3.2 GB worst case, usually
much less).

Total cache footprint for a heavily-explored 1M world: ~2–4 GB.
Within IndexedDB practical limits on desktop with healthy disk.

## What stays in this doc

If the project ever wants the standalone-cache stopgap (16k–60k
sweet spot), the original plan is preserved below for reference.

---

## Stopgap version (whole-globe snapshot, deferred / not building)

For 16k–60k hex counts only. Cache size ~560 MB at 16k. Single
record per cacheKey holds everything. Replaced once LOD lands.

### What gets cached (stopgap)

- Per-chunk: positions, indices, colors, cellIds, cellLocalStart,
  cellVertexCount, centroid.
- Cells: id, center, corners, neighbors, terrain, heightLevel,
  isPentagon (flat typed-array layout with prefix-sum offsets for
  variable-length per-cell data).
- Top-level: totalVerticesPerCell, chunkOfCell.
- **Skip** normals + hexDebug — recompute on load.

### Cache key (stopgap)

```
wellspring-globe-v{BUILD}-res{ICO_RESOLUTION}-tg{TG}
```

- `BUILD` — bump when mesh build changes meaning.
- `TG` — bump when terrain-gen output changes.

### Auto-disable rule (stopgap)

If estimated snapshot size > 1 GB, skip writing. The build still
runs; cache is silently disabled. This prevents trying to cache
60k+ hex counts where the snapshot won't fit.

### Files (stopgap, if built)

- New: `src/lib/engine/globe-cache.ts` — IDB wrapper, serialization.
- Modified: `src/lib/engine/globe.ts` — read-on-init, write-after-build.
- Modified: `src/lib/engine/globe-mesh.ts` — `restoreChunksFromSnapshot`
  helper.
- Modified: `src/routes/globe/+page.svelte` — "Rebuild mesh" button,
  cache hit/miss perf row.

### Why we're not building this now

(3) LOD is the next priority and it changes the cache shape from
"one snapshot per globe" to "one record per chunk-per-tier." The
stopgap code would be discarded when LOD lands. Skip and build the
right version once LOD machinery exists.
