# Babylon.js 9.0 Migration Plan

## Overview

Migrate the Country Painter from MapLibre GL JS (2D map with globe projection) to Babylon.js 9.0 (full 3D game engine with geospatial subsystem). This transforms the hex editor into a foundation for a 3D strategy game with terrain, atmospheric effects, and game-engine-level rendering.

**Current state:** ~1,092 lines across 2 files. MapLibre renders ~80K H3 res-4 hexes as GeoJSON polygons with `setFeatureState()` coloring. SvelteKit app with Tailwind UI.

**Target state:** Babylon.js 9.0 renders the globe, terrain, atmosphere, and 500K+ hexes via thin instances. SvelteKit continues to own all UI. The two communicate through Svelte stores and an event bus.

---

## Architecture

```
src/
├── routes/
│   ├── +page.svelte              # Top-level layout: sidebar UI + canvas
│   ├── +page.ts                  # ssr = false
│   └── api/land-hexes/+server.ts # H3 hex generation (KEEP AS-IS)
├── lib/
│   ├── engine/
│   │   ├── globe.ts              # Babylon scene, engine, camera, atmosphere
│   │   ├── hex-renderer.ts       # Thin instance hex mesh + data texture
│   │   ├── overlays.ts           # Borders, rivers, lakes as GreasedLine meshes
│   │   └── picking.ts           # Ray-sphere → lat/lng → h3 hit testing
│   ├── stores/
│   │   ├── map-state.ts          # Province/country/hex data (shared state)
│   │   └── ui-state.ts           # Tool, mode, selection, toggles
│   └── geo/
│       ├── coords.ts             # lat/lng ↔ ECEF conversion, hex positioning
│       └── topo-loader.ts        # TopoJSON → 3D line geometry converter
├── app.css                       # Tailwind + custom styles
└── app.html
```

### Separation of Concerns

| Layer | Responsibility | Tech |
|-------|---------------|------|
| **UI** | Sidebar, panels, tools, menus, modals, HUD | Svelte 5 + Tailwind |
| **State** | Province/country data, hex assignments, editor mode | Svelte stores |
| **Engine** | 3D rendering, camera, atmosphere, terrain, hexes | Babylon.js 9.0 |
| **Geo** | Coordinate transforms, TopoJSON parsing, H3 operations | h3-js, topojson-client |

The Svelte UI never touches Babylon.js objects directly. The engine layer exposes a clean API surface:

```typescript
// Engine API contract (what the UI layer calls)
interface GlobeEngine {
  init(canvas: HTMLCanvasElement): Promise<void>;
  dispose(): void;

  // Hex rendering
  setHexColor(h3Index: string, color: string): void;
  clearHexColor(h3Index: string): void;
  refreshAllColors(hexToProvince: Record<string, string>, colorResolver: (h3: string) => string | null): void;

  // Overlays
  setLayerVisible(layer: 'borders' | 'rivers' | 'states' | 'grid', visible: boolean): void;

  // Camera
  flyTo(lat: number, lng: number, altitude?: number): void;

  // Events (engine → UI)
  onHexClick: (h3Index: string, button: number) => void;
  onHexHover: (h3Index: string | null) => void;
}
```

---

## Phase 1: Babylon.js Scene + Globe (Days 1-2)

### Goal
A spinning 3D globe with atmosphere that you can orbit, zoom, and tilt. No hexes yet — just proving the engine works in SvelteKit.

### Tasks

1. **Install dependencies**
   ```
   npm install @babylonjs/core @babylonjs/materials
   ```
   Check npm for the geospatial package — likely `@babylonjs/geospatial` or included in core as of 9.0. If geospatial module isn't a separate package, the camera and atmosphere may be importable from `@babylonjs/core`.

2. **Create `src/lib/engine/globe.ts`**
   - Initialize `Engine` with WebGPU preference, WebGL2 fallback
   - Create `Scene`
   - Set up `GeoCamera` (or `ArcRotateCamera` orbiting a sphere if geospatial camera API isn't finalized):
     ```typescript
     // Geospatial camera (preferred — if available)
     const camera = new GeoCamera("geo", {
       latitude: 35, longitude: -20, altitude: 20_000_000
     }, scene);

     // Fallback: ArcRotateCamera on sphere
     const camera = new ArcRotateCamera("cam", -Math.PI/2, Math.PI/3, 3,
       Vector3.Zero(), scene);
     camera.lowerRadiusLimit = 1.2; // just above surface
     camera.upperRadiusLimit = 5;   // far orbit
     ```
   - Add `HemisphericLight` for base illumination
   - Add `DirectionalLight` for sun (drives atmosphere day/night)
   - Create globe sphere mesh:
     ```typescript
     const globe = MeshBuilder.CreateSphere("globe", { diameter: 2, segments: 64 }, scene);
     const globeMat = new StandardMaterial("globeMat", scene);
     globeMat.diffuseColor = new Color3(0.83, 0.79, 0.72); // #D4C9B8 land color
     globe.material = globeMat;
     ```
   - Add `PhysicallyBasedAtmosphere` (or equivalent from geospatial module)
   - Start render loop: `engine.runRenderLoop(() => scene.render())`

3. **Create `src/lib/geo/coords.ts`**
   - `latLngToWorld(lat, lng, altitude?)`: Convert geographic coordinates to 3D position on the globe sphere
     ```typescript
     export function latLngToWorld(lat: number, lng: number, r: number = 1): Vector3 {
       const phi = (90 - lat) * DEG2RAD;
       const theta = (lng + 180) * DEG2RAD;
       return new Vector3(
         -r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi),
          r * Math.sin(phi) * Math.sin(theta)
       );
     }
     ```
   - `worldToLatLng(position)`: Reverse transform for picking
   - If using Babylon's geospatial module, these may be provided as `geodeticToCartesian` / `cartesianToGeodetic`

4. **Mount in `+page.svelte`**
   ```svelte
   <script>
     import { onMount, onDestroy } from 'svelte';
     let canvasEl: HTMLCanvasElement;
     let engine: GlobeEngine;

     onMount(async () => {
       const { createGlobeEngine } = await import('$lib/engine/globe');
       engine = await createGlobeEngine(canvasEl);
     });

     onDestroy(() => engine?.dispose());
   </script>

   <canvas bind:this={canvasEl} class="w-full h-full"></canvas>
   ```

### Validation
- Globe renders with atmosphere glow at the edges
- Orbit/zoom/tilt controls work
- No MapLibre dependencies loaded

---

## Phase 2: Hex Thin Instances on Globe (Days 3-5)

### Goal
Render all ~80K land hexes as thin instances on the globe surface. Each hex is individually colorable. Performance target: 60fps with 80K hexes, headroom for 500K.

### Tasks

1. **Create `src/lib/engine/hex-renderer.ts`**

2. **Build hex template geometry**
   - Regular hexagon: 6 outer vertices + center, 6 triangles
   - Use `MeshBuilder.CreateDisc("hex", { radius: hexRadius, tessellation: 6 }, scene)` as the base mesh
   - The radius in world units depends on globe scale. At globe radius = 1 unit, H3 res-4 hexes (~45km) subtend ~0.007 radians → radius ≈ 0.007 units

3. **Compute instance matrices**
   - For each hex in `landHexes`:
     ```typescript
     const pos = latLngToWorld(hex.lat, hex.lon, 1.001); // slightly above globe surface
     const normal = pos.normalize(); // surface normal = position on unit sphere
     const matrix = Matrix.Identity();
     // Compose: translate to position, rotate to align flat face with surface
     // Use lookAt or quaternion from normal to orient the hex
     ```
   - Pack all matrices into `Float32Array(hexCount * 16)`
   - This is computed once on load, not per-frame

4. **Set up color buffer**
   - `Float32Array(hexCount * 4)` — RGBA per hex
   - Initialize all to transparent (alpha = 0)
   - Register as thin instance attribute:
     ```typescript
     hexMesh.thinInstanceSetBuffer("matrix", matricesData, 16, true);  // static
     hexMesh.thinInstanceSetBuffer("color", colorData, 4, false);      // dynamic
     ```

5. **H3 index → buffer index mapping**
   - `Map<string, number>` mapping H3 cell ID to its index in the instance buffers
   - Enables O(1) color updates: `setHexColor(h3, color)` → write 4 floats → `bufferUpdated("color")`

6. **Data texture alternative** (evaluate during implementation)
   - Instead of a color buffer attribute, use a texture where pixel (x, y) = hex color
   - H3 index maps to texture coordinate
   - Color update = `gl.texSubImage2D` on one pixel
   - Requires a custom shader (Node Material or ShaderMaterial) to sample the texture using instance ID
   - Advantage: updating 1 hex doesn't require re-uploading the entire color buffer
   - Decision: start with color buffer (simpler), switch to data texture if update performance is a bottleneck

7. **Hex border rendering**
   - Option A: Second thin-instance pass with `CreateDisc` in wireframe mode
   - Option B: GreasedLine hex outlines (better visual control, screen-space width)
   - Option C: Fragment shader edge detection (compute distance to hex edge in shader, darken near edges)
   - Recommendation: Option C for performance — no extra geometry, just a shader tweak. Implement in the hex material's fragment shader.

8. **Material setup**
   - Custom `ShaderMaterial` or `NodeMaterial` that:
     - Reads per-instance color from the color attribute
     - Applies fill with configurable opacity (0.85 for painted, 0 for unpainted)
     - Optionally darkens edges for hex border effect
     - Supports unlit rendering (hex colors should be exact, not affected by lighting)

### Validation
- All 80K hexes visible on globe, correctly positioned and oriented
- Zooming in shows individual hex shapes
- `setHexColor` changes a single hex color in <1ms
- `refreshAllColors` completes in <50ms for 80K hexes
- 60fps maintained during orbit/zoom

---

## Phase 3: Geographic Overlays (Days 6-8)

### Goal
Render country borders, rivers, lakes, and state boundaries as 3D line/polygon meshes on the globe surface, replacing MapLibre's GeoJSON layers.

### Tasks

1. **Create `src/lib/geo/topo-loader.ts`**
   - Load and parse the three TopoJSON files from `/data/`:
     - `countries-10m.json` → country borders (lines) + land fill (polygons)
     - `waterways-10m.json` → rivers (lines) + lakes (polygons)
     - `states-10m.json` → state/province boundaries (lines)
   - Convert to GeoJSON via `topojson-client` (same as current code)
   - Handle antimeridian wrapping (port existing `fixAntiMeridian()`)

2. **Create `src/lib/engine/overlays.ts`**

3. **GeoJSON → 3D geometry conversion**
   - For each GeoJSON feature:
     ```typescript
     function geoJsonToWorldPoints(coordinates: number[][]): Vector3[] {
       return coordinates.map(([lng, lat]) =>
         latLngToWorld(lat, lng, 1.002) // slightly above hex layer
       );
     }
     ```
   - Line features (borders, rivers) → `GreasedLine` meshes
     - Screen-space width (constant pixel width regardless of zoom)
     - Color per overlay type (gold for borders, blue for rivers, orange for states)
   - Polygon features (lakes) → `MeshBuilder.CreatePolygon` or triangulated mesh
     - Project vertices onto sphere surface
     - Use earcut or Babylon's built-in polygon triangulation

4. **GreasedLine for borders/rivers**
   ```typescript
   import { GreasedLineMeshBuilder } from "@babylonjs/core";

   const borderLine = GreasedLineMeshBuilder.CreateGreasedLine("borders", {
     points: allBorderSegments, // array of Vector3 arrays
     width: 2,                 // screen-space pixels
   }, scene);
   borderLine.material.color = new Color3(1, 0.84, 0); // gold
   ```

5. **Water rendering**
   - Ocean: The globe background is already ocean color (the globe sphere shows through where there's no land)
   - Actually, invert this: make the globe sphere blue/ocean colored, and render land as a separate layer
   - Or: use the globe sphere as ocean, hex fill as land color

6. **Layer visibility toggles**
   - Each overlay is a separate Babylon.js mesh or mesh group
   - `mesh.setEnabled(visible)` for toggling
   - Map to existing UI toggle buttons

7. **Performance considerations**
   - Merge all border segments into a single GreasedLine mesh per overlay type
   - Natural Earth 10m data has many vertices — consider simplifying with Douglas-Peucker before converting to 3D
   - Lakes can use a simple flat blue material

### Validation
- Country borders render as gold lines on the globe
- Rivers and lakes render in blue
- State boundaries render in orange
- All overlays togglable from existing UI buttons
- No visual gaps at antimeridian or poles

---

## Phase 4: Picking & Painting Interaction (Days 9-11)

### Goal
Port the paint/erase/pick tools. Click on the globe → identify the hex → apply brush action. Drag painting works smoothly.

### Tasks

1. **Create `src/lib/engine/picking.ts`**

2. **Ray-sphere intersection**
   ```typescript
   function pickGlobe(scene: Scene, pointerX: number, pointerY: number): { lat: number; lng: number } | null {
     const ray = scene.createPickingRay(pointerX, pointerY, Matrix.Identity(), camera);
     // Intersect ray with unit sphere (globe)
     const origin = ray.origin;
     const dir = ray.direction;
     const a = Vector3.Dot(dir, dir);
     const b = 2 * Vector3.Dot(origin, dir);
     const c = Vector3.Dot(origin, origin) - 1; // radius² = 1
     const discriminant = b * b - 4 * a * c;
     if (discriminant < 0) return null;
     const t = (-b - Math.sqrt(discriminant)) / (2 * a);
     if (t < 0) return null;
     const hitPoint = origin.add(dir.scale(t));
     return worldToLatLng(hitPoint);
   }
   ```

3. **Lat/lng → H3 cell**
   - Use existing `latLngToCell(lat, lng, H3_RES)` from h3-js
   - Check against `landHexSet` — same logic as current `getHexAtPoint()`
   - For coastal hexes: dynamically add to instance buffer (append new matrix + color, update thin instance count)

4. **Pointer event handling**
   ```typescript
   scene.onPointerObservable.add((pointerInfo) => {
     switch (pointerInfo.type) {
       case PointerEventTypes.POINTERDOWN:
         const hit = pickGlobe(scene, scene.pointerX, scene.pointerY);
         if (hit) {
           const h3 = latLngToCell(hit.lat, hit.lng, H3_RES);
           onHexClick(h3);
           isPainting = true;
           camera.detachControl(); // disable orbit while painting
         }
         break;
       case PointerEventTypes.POINTERMOVE:
         if (isPainting) { /* same pick + applyBrush logic */ }
         // Update hover state regardless
         break;
       case PointerEventTypes.POINTERUP:
         isPainting = false;
         camera.attachControl(canvas, true);
         break;
     }
   });
   ```

5. **Brush application**
   - Port `applyBrush()` logic from current `+page.svelte:411-469`
   - Province mode: `hexToProvince[h3] = selectedProvince` → `hexRenderer.setHexColor(h3, color)`
   - Country mode: iterate province hexes → bulk `setHexColor`
   - Erase: `hexRenderer.clearHexColor(h3)`
   - All state mutations go through Svelte stores, engine reacts

6. **Hover highlighting**
   - On pointermove, compute hovered hex
   - Temporarily brighten/outline the hovered hex
   - Options: modify instance color briefly, or render a separate highlight ring mesh that follows the cursor hex

7. **Camera control conflict resolution**
   - When painting: disable camera orbit (current approach: `dragPan.disable()`)
   - When not painting: camera controls active
   - Right-click: always camera orbit (painting is left-click only)

### Validation
- Click on globe correctly identifies the hex under cursor
- Paint tool colors hexes in real-time during drag
- Erase tool clears hex colors
- Pick tool selects the province/country
- Camera orbits freely when not painting
- No painting on ocean (same land check as current)

---

## Phase 5: Wire Up UI ↔ Engine (Days 12-13)

### Goal
Connect the existing Svelte sidebar UI to the Babylon.js engine. All current features work: province/country CRUD, mode switching, color editing, export/import, stat counters.

### Tasks

1. **Create `src/lib/stores/map-state.ts`**
   - Move province/country/hex data from `+page.svelte` script vars into Svelte stores
   - `provinces`, `countries`, `hexToProvince`, `provinceToCountry` become writable stores
   - `hexesByProvince`, `provincesByCountry` become derived stores
   - The engine subscribes to store changes and updates rendering

2. **Create `src/lib/stores/ui-state.ts`**
   - `editorMode`, `selectedProvince`, `selectedCountry`, `tool`, `showGrid`, `showBorders`, `showStates`, `showHexBorders`
   - Engine subscribes to visibility toggles → `mesh.setEnabled()`

3. **Refactor `+page.svelte`**
   - Remove all MapLibre code (imports, `initMap`, `addLayers`, `buildHexGeoJSON`, `refreshMapColors`, `setupInteractions`, `getHexAtPoint`, `fixAntiMeridian`)
   - Keep: UI template (sidebar HTML), province/country management functions, export/import, utility functions
   - Replace `<div bind:this={mapContainer}>` with `<canvas bind:this={canvasEl}>`
   - Wire engine events to store updates:
     ```typescript
     engine.onHexClick = (h3) => applyBrush(h3);
     engine.onHexHover = (h3) => hoveredHexId = h3;
     ```

4. **Mode switching**
   - When `editorMode` changes → `engine.refreshAllColors(hexToProvince, colorResolver)`
   - `colorResolver` returns province color or country color based on mode
   - Same logic as current `refreshMapColors()` but the engine handles the rendering

5. **Export/Import**
   - Export: unchanged — serializes store data to JSON
   - Import: parse JSON → update stores → `engine.refreshAllColors()`

6. **Color change**
   - Province/country color picker → update store → `engine.refreshAllColors()`
   - Or for single-province changes, iterate affected hexes and call `setHexColor` individually

### Validation
- All sidebar buttons/controls function identically to current app
- Mode switch (Province ↔ Country) updates hex colors correctly
- Export produces same JSON format (backwards compatible)
- Import of existing save files works
- Stats counters update in real-time during painting

---

## Phase 6: Terrain Elevation (Days 14-18)

### Goal
Load real-world elevation data and displace hex vertices vertically, creating visible mountains, valleys, and coastal shelves.

### Tasks

1. **Set up Cesium Ion account and access token**
   - Register at cesium.com/ion
   - Get access token for Cesium World Terrain (Asset ID 1)
   - Store token in `.env` (excluded from git)

2. **Load 3D Tiles terrain**
   ```typescript
   // Using Babylon's 3D Tiles integration
   const tilesRenderer = new TilesRenderer({
     ionAssetId: 1,
     ionAccessToken: import.meta.env.VITE_CESIUM_TOKEN,
   }, scene);
   ```
   - If Babylon's 3D Tiles API isn't suitable for elevation sampling, alternative:
     - Use Mapbox Terrain RGB tiles or AWS Terrain Tiles
     - Fetch elevation raster tiles, decode elevation from RGB values
     - Build an elevation cache: `getElevation(lat, lng): number`

3. **Elevation sampling for hex positions**
   ```typescript
   async function getHexElevation(lat: number, lng: number): Promise<number> {
     // Option A: Raycast against loaded 3D Tiles terrain
     // Option B: Sample from elevation tile cache
     // Option C: Use a DEM heightmap texture lookup
   }
   ```

4. **Displace hex instance matrices**
   - After elevation data loads, update each hex's matrix:
     ```typescript
     for (let i = 0; i < hexCount; i++) {
       const hex = landHexes[i];
       const elevation = await getElevation(hex.lat, hex.lon);
       const r = 1 + elevation / EARTH_RADIUS; // normalize to globe scale
       const pos = latLngToWorld(hex.lat, hex.lon, r);
       // Recompute matrix with new position
       newMatrix.copyToArray(matricesData, i * 16);
     }
     hexMesh.thinInstanceBufferUpdated("matrix");
     ```

5. **Visual terrain mesh (optional but recommended)**
   - Don't just displace hexes — render terrain geometry between/beneath them
   - Options:
     - A) Use 3D Tiles terrain as a visual mesh beneath the hex layer
     - B) Generate a custom terrain mesh from elevation data, hex-aligned
     - C) Extrude hex meshes downward to create "hex columns" (strategy game style)
   - Recommendation: Start with hex displacement only (A), add hex extrusion later for game feel

6. **LOD for terrain**
   - Close zoom: full elevation detail
   - Far zoom: flattened or simplified elevation
   - 3D Tiles handles this automatically if used as the terrain source

### Validation
- Mountains visibly rise above sea level
- Coastal hexes sit near zero elevation
- No visual gaps between hexes at elevation transitions
- Performance maintained (elevation is baked into matrices, not computed per-frame)

---

## Phase 7: Polish & Scale Testing (Days 19-21)

### Goal
Resolution scaling test, visual polish, performance optimization, and cleanup.

### Tasks

1. **Resolution scaling test**
   - Generate hex data at resolution 5 (~560K hexes)
   - Test thin instance rendering at 500K+ — measure FPS, memory, load time
   - If needed, implement LOD:
     - Compute res-3 parent cells and their aggregate colors
     - At far zoom: render res-3 instances, at mid zoom: res-4, at close zoom: res-5
     - Use `cellToParent()` and `cellToChildren()` from h3-js

2. **Visual polish**
   - Atmosphere tuning: sunrise/sunset colors, haze density
   - Hex edge rendering: subtle darkened borders for painted hexes
   - Ocean shader: animated water with subtle waves (Babylon's Water material or custom)
   - Anti-aliasing: enable MSAA or FXAA post-process
   - Hex hover: glow or outline effect on hovered hex

3. **Performance optimization**
   - Profile with Babylon's Inspector: `scene.debugLayer.show()`
   - Ensure single draw call for all hexes (thin instances)
   - Texture compression for globe/terrain
   - Frustum culling: thin instances cull as one unit — consider splitting into hemisphere chunks for back-face culling
   - WebGPU: test with `new WebGPUEngine(canvas)` for draw-call improvement

4. **Remove MapLibre dependencies**
   - Remove `maplibre-gl` from package.json
   - Remove `vendor/maplibre-gl/` directory
   - Remove MapLibre CSS import
   - Clean up any leftover MapLibre-specific code

5. **Update export format**
   - Bump version to 3
   - Add `hexResolution` field (may vary with LOD)
   - Maintain backwards compatibility: import v2 files still works

---

## Dependency Changes

### Add
| Package | Purpose | Size (gzipped) |
|---------|---------|----------------|
| `@babylonjs/core` | Engine, scene, camera, meshes, materials | ~400-600KB |
| `@babylonjs/materials` | PBR, water material, advanced materials | ~50KB |
| `@babylonjs/geospatial` (if exists) | GeoCamera, Atmosphere, 3D Tiles | TBD |

### Remove
| Package | Reason |
|---------|--------|
| `maplibre-gl` (vendored) | Replaced by Babylon.js |
| `@turf/boolean-point-in-polygon` | Only used in hex generation API (keep if API stays) |
| `@turf/intersect` | Only used in hex generation API (keep if API stays) |
| `@turf/helpers` | Only used in hex generation API (keep if API stays) |

### Keep
| Package | Reason |
|---------|--------|
| `h3-js` | H3 hex grid operations — used in both generation and picking |
| `topojson-client` | TopoJSON parsing for borders/rivers/lakes |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Babylon.js 9.0 geospatial API is underdocumented or unstable | HIGH | Phase 1 validates the API immediately. Fallback: ArcRotateCamera on a sphere with custom atmosphere shader. The hex rendering (thin instances) is a mature, well-documented API regardless. |
| Thin instances at 500K cause frame drops on integrated GPUs | MEDIUM | Implement LOD (res 3/4/5 by zoom level). Split into hemisphere chunks for culling. Test on target hardware early. |
| Elevation data integration is complex | MEDIUM | Phase 6 is designed as optional — the app is fully functional after Phase 5. Elevation can be added incrementally. |
| GreasedLine doesn't handle globe wrapping at antimeridian | LOW | Split line segments that cross the antimeridian into two segments (same approach as current `fixAntiMeridian`). |
| Bundle size increase (~1MB+) | LOW | Acceptable for a game application. Tree-shake aggressively with deep imports. |
| Export format backwards compatibility | LOW | Version field in export JSON. Import handler supports v2 and v3 formats. |

---

## What's Preserved

- **All game data**: provinces, countries, hex assignments, colors — unchanged
- **Save file format**: v2 import supported, v3 adds engine metadata
- **UI layout and styling**: sidebar stays identical, just swap map canvas
- **API endpoint**: `/api/land-hexes` unchanged — same hex generation pipeline
- **H3 library**: same hex grid, same resolution system, same `latLngToCell` for picking
- **Coastal hex handling**: same dynamic hex addition logic

## What Changes

- **Rendering backend**: MapLibre GeoJSON → Babylon.js thin instances
- **Color management**: `setFeatureState()` → direct buffer writes
- **Picking**: MapLibre `queryRenderedFeatures` → ray-sphere intersection + h3-js
- **Overlays**: MapLibre layers → GreasedLine meshes
- **Projection**: MapLibre globe → Babylon.js 3D sphere
- **File structure**: single 786-line file → modular `lib/engine/` + `lib/stores/` + `lib/geo/`

---

## Decision Points (Require Investigation at Implementation Time)

1. **Geospatial package name**: Check npm for `@babylonjs/geospatial` vs bundled in core. This determines import paths for GeoCamera and Atmosphere.

2. **Globe coordinate system**: If using Babylon's geospatial module, it likely uses ECEF (meters). If rolling our own, we use a unit sphere. This affects all coordinate math.

3. **Hex border rendering**: Shader-based edge detection vs. GreasedLine outlines vs. wireframe pass. Decide during Phase 2 based on visual quality.

4. **Terrain source**: Cesium Ion 3D Tiles vs. Mapbox Terrain RGB vs. custom DEM. Decide during Phase 6 based on API availability and visual quality.

5. **Color update strategy**: Instance color buffer vs. data texture. Start with buffer, switch if per-hex update performance is insufficient.
