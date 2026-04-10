# Country Painter Editor — Pitfalls & Learnings

A comprehensive reference for anyone working on the country painter editor, the MapLibre fork, or the hex-based country/province system.

## Editor Location

- Editor page: `src/routes/editor/country-painter/+page.svelte`
- Land hex API: `src/routes/api/editor/land-hexes/+server.ts`
- MapLibre fork: `~/maplibre-fork/` (v5.22.0 with stencil clipping)
- Fork documentation: `~/maplibre-fork/OCEANLINERS_CHANGES.md`
- Land hex cache: `static/data/land-hexes-r4.json` (~7MB, takes ~20min to regenerate)

## Architecture Decisions

### Why H3 Resolution 4?
- ~45km edge length, ~80K land hexes globally
- Resolution 3 (current ocean hexes) was too coarse for country borders
- Resolution 5 would be ~585K hexes — too many for client-side rendering
- The ocean hex grid (res 3) and country hex grid (res 4) are independent systems

### Why a Forked MapLibre?
- MapLibre has no native polygon clipping/masking
- Hex polygons extend past coastlines into ocean — need to clip fill to land
- The fork uses **stencil buffer bit 7** to mask fill layers to land polygons
- See `~/maplibre-fork/OCEANLINERS_CHANGES.md` for full technical details

### Why `countries` Instead of `land`?
- Natural Earth `topo.objects.land` has an 81K-vertex ring that causes rendering artifacts on globe projection (giant arcs, inverted fills, crashes)
- `topo.objects.countries` renders correctly on globe with `fixAntiMeridian`
- Both the rendering AND hex generation/clipping use `countries` so they match
- The `land` object was tried extensively — every approach (splitting, normalizing, PMTiles, polygon-clipping) had issues on globe

## Critical Pitfalls

### 1. Antimeridian Handling on Globe
The Natural Earth `land` object contains a degenerate 81K-vertex polygon ring that wraps from -180° to 180°. On globe projection this causes:
- Giant horizontal arcs across the globe
- Inverted fill areas
- Browser crashes (WebGL context lost)

**Solution**: Use `countries` with `fixAntiMeridian()` — the same function the game's MapView uses. It replaces Antarctica (feature ID '010') with a simple rectangle, and shifts coordinates for polygons crossing the antimeridian (lon < -20 AND lon > 160 → shift negative lons +360).

### 2. Stencil Buffer Management
The forked MapLibre uses bit 7 of the 8-bit stencil buffer for land clipping:
- Bits 0-6: tile clipping (MapLibre's existing system, max 127 IDs)
- Bit 7: land clip mask

**Critical**: The land fill layer MUST render in the **translucent pass** (same pass as hex fill) for the stencil to work. Setting `fill-opacity: 0.999` forces this. If opacity is exactly 1.0, MapLibre renders it in the opaque pass and the stencil bit may not carry over.

**Critical**: The `isClipMaskSource` layer writes stencil using `gl.ALWAYS` (unconditional write). Earlier attempts to test tile ref THEN write bit 7 failed because tile refs didn't match across source boundaries.

### 3. Hex Clipping Data — Multi-Polygon Hexes
Coastal hexes are pre-clipped against land polygons server-side using turf/intersect. A hex can overlap MULTIPLE country polygons (e.g., Isle of Wight + mainland England). The server must collect ALL intersections, not just the first:
- `clip`: single polygon ring (most coastal hexes)
- `multiClip`: array of polygon rings (hexes spanning multiple land features, ~2087 hexes)

If you only take the first intersection (`break` after first match), hexes will have missing land areas.

### 4. Edge-Bucketed Point-in-Polygon
The `land` object's 81K-vertex polygon made turf's `booleanPointInPolygon` O(81K) per check. Custom `FastPolygonTester` class pre-sorts edges into 0.5° latitude bands:
- Each query tests ~200 edges instead of 81K
- ~300x speedup
- Same ray-casting algorithm, same accuracy

### 5. Hex Generation Time
Full regeneration (80K hexes + 9K coastal clips) takes ~20 minutes:
- Phase 1: ~2 min (288K H3 cells → 80K land hexes via point-in-polygon)
- Phase 2: ~1 min (detect coastal hexes via neighbor + vertex checks)
- Phase 3: ~17 min (turf/intersect for each coastal hex against land polygons)

The result is cached to `static/data/land-hexes-r4.json`. Delete this file to force regeneration. The cache is gitignored.

### 6. Vite Dev Server Reloading
Vite watches the `out/` directory (Electron build output) and triggers page reloads when files change there. Fixed by adding to `vite.config.ts`:
```typescript
server: { watch: { ignored: ['**/out/**'] } }
```

### 7. MapLibre Fork Linking
The editor imports `maplibre-gl-fork` via Vite alias. The game imports regular `maplibre-gl`. They're completely independent:
```typescript
// vite.config.ts
resolve: {
    alias: { 'maplibre-gl-fork': '/Users/kennethmei/maplibre-fork/dist/maplibre-gl.js' }
},
optimizeDeps: { include: ['maplibre-gl-fork'] }
```

After rebuilding the fork (`cd ~/maplibre-fork && npm run build-prod`), you MUST:
1. Delete `node_modules/.vite` in the game project
2. Restart the Vite dev server

### 8. Coastal Hex Click Detection
Uses `queryRenderedFeatures` on the `land-fill` layer to check if a click is on rendered land. If yes, the H3 cell at that point is paintable. If the hex isn't in the pre-generated set, it's added dynamically to the GeoJSON source.

On import, `addMissingHexesToSource()` re-adds any dynamically created coastal hexes from saved data.

### 9. Province System Data Model
```
provinces: { [provinceId]: { name, color } }
hexToProvince: { [h3Index]: provinceId }
provinceToCountry: { [provinceId]: countryCode }
```
- Province mode: paint individual hexes into provinces
- Country mode: click a hex → its entire province gets assigned to a country
- `hexToProvince` is NOT `$state` (80K+ entries would be expensive to proxy) — uses `dataVersion` counter for manual reactivity
- `provinces` and `provinceToCountry` ARE `$state` since the sidebar iterates them

### 10. Export/Import
Uses `showSaveFilePicker` (File System Access API) for Chrome/Chromium:
- First save: opens file picker dialog
- Subsequent saves: overwrites the same file silently
- Falls back to download for other browsers
- Version 2 format includes provinces, hexToProvince, provinceToCountry

## Things That Don't Work

### Ocean Mask Approach
Polygon with land-shaped holes rendered on top of hex layer — flickered during zoom due to tessellation stress. Chunked version (60° grid cells) helped but still had issues. Abandoned.

### Splitting Land at Antimeridian
Tried manual ring splitting, polygon-clipping library boxes, coordinate normalization — all produced artifacts on globe (inverted fills, arc lines, missing continents). The 81K ring is fundamentally incompatible with globe projection.

### PMTiles for Land Fill
Converting land to vector tiles via tippecanoe still had the 81K ring artifact (tippecanoe preserves the degenerate geometry). Pre-fixing the GeoJSON before tiling added box edges from polygon-clipping that showed as arcs.

### turf/intersect Performance
Clipping individual hexes against the full `land` object (81K vertices) takes ~2+ hours. Using `countries` (smaller polygons) takes ~17 minutes. Parallelization with worker threads would help but wasn't implemented.

## Reference Overlays
- **Borders**: Modern country borders from `countries` data (gold lines)
- **States**: Admin-1 states/provinces from Natural Earth `static/data/states-10m.json` (orange lines, simplified to 20%)
- Both off by default, toggled independently

## File Dependencies
- `static/data/countries-10m.json` — Natural Earth countries + land (TopoJSON, used by both game and editor)
- `static/data/waterways-10m.json` — Rivers and lakes (TopoJSON)
- `static/data/states-10m.json` — Admin-1 states/provinces (TopoJSON, editor only)
- `static/data/land-hexes-r4.json` — Pre-generated H3 res 4 land hexes with clip data (gitignored, cached)
- `~/maplibre-fork/` — Forked MapLibre with stencil clipping (NOT in the game repo)
