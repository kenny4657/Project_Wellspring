# Hex Resolution Analysis — Country/Province System

## Context

The country painter editor uses H3 hexagonal grid cells to define country and province boundaries. This document analyzes the tradeoffs of different hex resolutions for both the editor (tool) and the game (runtime).

## H3 Resolution Comparison

| Resolution | Edge Length | Total Global Cells | Land Hexes (~29%) | Coastal Hexes (~11% of land) |
|-----------|------------|-------------------|-------------------|------------------------------|
| 3 (ocean grid) | ~120 km | 41,162 | ~12,000 | ~1,300 |
| 4 (current editor) | ~45 km | 288,122 | ~80,740 | ~9,095 |
| 5 (proposed) | ~17 km | 2,016,842 | ~565,000 | ~63,000 |
| 6 | ~6.5 km | 14,117,882 | ~4,100,000 | ~450,000 |

Note: H3 scales by **~7x per resolution level**, not linearly. There are no fractional resolutions.

## Resolution 4 (Current — 45km)

### Border Accuracy
- A hex is ~90km across — border width is roughly London to Bristol
- Cannot distinguish Wales from England, or individual French regions
- Adequate for continental-scale borders (France vs Germany), not for sub-national detail

### Performance (Measured)
- Generation: ~20 minutes (cached to disk, one-time)
- Cache file: 7 MB
- Client rendering: 80K GeoJSON features — smooth at all zoom levels
- Feature state updates (painting): instant

## Resolution 5 (Proposed — 17km)

### Border Accuracy
- A hex is ~34km across — London to Guildford
- Can distinguish Wales, Scotland, Brittany, individual departments
- Good for historical border painting at the province level

### Performance — Editor (Rendering Each Hex)

| Metric | Value | Notes |
|--------|-------|-------|
| Generation time | 2-3 hours | Bottleneck: turf/intersect for 63K coastal hexes |
| With worker threads (12 cores) | ~15 min | M4 Max has 16 cores |
| Cache file size | ~50-70 MB | With clip + multiClip data |
| Initial load (localhost) | ~1-2s | JSON parse ~0.5s |
| Browser memory | ~500 MB | Parsed GeoJSON + MapLibre tile cache |
| Rendering at zoom 4-6 | Smooth | MapLibre tiles internally, only draws visible hexes |
| Rendering 14K hexes (UK) | 121 FPS | Tested with Playwright on M4 Max |

**Verdict**: Feasible for the editor tool. M4 Max handles it fine. Worker thread parallelization needed for generation.

### Performance — Game (Data-Only, Provinces Rendered)

If hexes are **not rendered individually** but used only as data to define province boundaries, the constraints collapse entirely:

| Metric | Rendered Hexes | Data-Only Hexes |
|--------|---------------|-----------------|
| GeoJSON features on map | 565,000 | 0 |
| MapLibre memory | ~500 MB | 0 |
| FPS impact | potential drops | none |
| What's actually rendered | individual hexes | merged province polygons (~200-500) |

**Province polygon approach**:
- `hexToProvince` lookup table: 565K entries, ~20MB in memory, instant lookups
- Rendered on map: ~200-500 province polygons (merged from hexes), ~25K total coordinates
- When player modifies a province: re-merge affected province with turf/union (~10ms per province)
- MapLibre handles 500 polygons trivially

**Verdict**: Resolution 5 is free performance-wise for the game. No rendering overhead — only the merged province polygons are drawn.

## Resolution 6 (6.5km — Not Recommended)

- 4.1 million land hexes
- Generation would take ~12+ hours even with parallelization
- Cache file: ~500MB
- No practical benefit over res 5 for country/province borders
- Only useful for city-level granularity (not needed for this game's era)

## Key Architectural Decision

**Editor (tool)**: Can render individual hexes for painting. Res 5 is feasible with:
- Worker thread parallelization for generation
- Pre-computed clip data cached to disk

**Game (runtime)**: Should NOT render individual hexes. Instead:
1. Store `hexToProvince` mapping as data
2. At map load, merge each province's hexes into a single polygon using turf/union
3. Render ~200-500 province polygons on the map
4. When player modifies borders (adds/removes hexes from provinces), re-merge only the affected provinces
5. Province polygons are clipped to land at merge time (turf/intersect against countries data)

This separation means the hex resolution choice only affects:
- Border painting precision (editor)
- Province modification granularity (game)
- One-time generation cost (cached)

It does NOT affect:
- Game rendering performance
- Map FPS
- Memory usage during gameplay

## Generation Performance Optimization

### Current Bottleneck: Phase 3 (Coastal Hex Clipping)
- ~9K hexes at res 4 → 17 min
- ~63K hexes at res 5 → estimated 2-3 hours
- Each hex: turf/intersect against land polygons (variable vertex count)

### Worker Thread Parallelization
- M4 Max: 12 performance + 4 efficiency cores = 16 cores
- Phase 3 is embarrassingly parallel (each hex clips independently)
- With 12 workers: ~15 min for res 5 (vs 2-3 hours single-threaded)
- Implementation: `worker_threads` module, each worker gets the land spatial index + a chunk of coastal hexes

### Edge-Bucketed Point-in-Polygon
Already implemented in `FastPolygonTester` class:
- Pre-sorts polygon edges into 0.5° latitude bands
- Each point-in-polygon query tests ~200 edges instead of 81K
- ~300x speedup over turf's `booleanPointInPolygon`
- Same algorithm works at any resolution

## Future Considerations

1. **Player-modifiable borders**: If players can change province boundaries in-game, the hex-to-province mapping needs to be saved per game. At res 5, this is ~20MB per save (compressible to ~2MB with gzip).

2. **Historical eras**: Different eras (1830, 1870, 1900) could have different province-to-country mappings using the same hex grid. The hexes and provinces stay fixed; only the country assignments change per era.

3. **Province merging at export**: The editor exports raw hex-to-province data. A build step could pre-merge into province polygons, clipped to coastlines, for each era. This removes runtime merging from the game entirely.
