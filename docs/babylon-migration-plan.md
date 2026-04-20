# Babylon.js 9.0 Migration Plan

## Overview

Migrate the Country Painter from MapLibre GL JS (2D map with globe projection) to Babylon.js 9.0 (full 3D game engine with geospatial subsystem). This transforms the hex editor into a foundation for a **3D strategy game with custom world building** — terrain tiles, atmospheric effects, and game-engine-level rendering.

**Current state:** ~1,092 lines across 2 files. MapLibre renders ~80K H3 res-4 hexes as GeoJSON polygons with `setFeatureState()` coloring. SvelteKit app with Tailwind UI.

**Target state:** Babylon.js 9.0 renders a 3D globe with per-terrain-type hex tile models, atmosphere, and custom world building tools. The world is **not constrained by real-world geography** — terrain types (mountains, oceans, forests, etc.) are freely assignable per hex. SvelteKit continues to own all UI.

---

## Architecture

```
src/
├── routes/
│   ├── +page.svelte              # Top-level layout: sidebar UI + canvas
│   ├── +page.ts                  # ssr = false
│   └── api/land-hexes/+server.ts # H3 hex grid generation
├── lib/
│   ├── engine/
│   │   ├── globe.ts              # Babylon scene, engine, camera, atmosphere
│   │   ├── hex-renderer.ts       # Per-terrain-type thin instance groups
│   │   ├── hex-tiles.ts          # Load/manage hex tile models (glTF or procedural)
│   │   └── picking.ts            # Ray-sphere → lat/lng → h3 hit testing
│   ├── world/
│   │   ├── terrain-types.ts      # Terrain type definitions, tiers, properties
│   │   ├── world-map.ts          # Hex→terrain assignment, world state
│   │   └── world-gen.ts          # Procedural world generation (optional)
│   ├── stores/
│   │   ├── world-state.ts        # World map + province/country data (shared state)
│   │   └── ui-state.ts           # Tool, mode, selection, toggles
│   └── geo/
│       └── coords.ts             # Sphere coordinate math (decoupled from Earth)
├── app.css                       # Tailwind + custom styles
└── app.html
```

### Separation of Concerns

| Layer | Responsibility | Tech |
|-------|---------------|------|
| **UI** | Sidebar, panels, tools, menus, modals, HUD | Svelte 5 + Tailwind |
| **State** | World map, terrain, province/country data, editor mode | Svelte stores |
| **Engine** | 3D rendering, camera, atmosphere, terrain tiles, hexes | Babylon.js 9.0 |
| **World** | Terrain type definitions, world generation, map state | Pure TypeScript |
| **Geo** | Coordinate transforms, H3 operations | h3-js |

The Svelte UI never touches Babylon.js objects directly. The engine layer exposes a clean API surface:

```typescript
// Engine API contract (what the UI layer calls)
interface GlobeEngine {
  init(canvas: HTMLCanvasElement): Promise<void>;
  dispose(): void;

  // Hex terrain
  setHexTerrain(h3Index: string, terrain: TerrainType): void;
  setHexColor(h3Index: string, color: string): void;
  clearHexColor(h3Index: string): void;
  refreshAllColors(colorResolver: (h3: string) => string | null): void;

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

## Phase 2: Terrain Tile Models + Hex Grid (Days 3-7)

### Goal
Generate the hex grid on the globe and render terrain-type tile models as per-type thin instance groups. Each hex has an assignable terrain type with a unique 3D model. Performance target: 60fps with 80K hexes across ~17 terrain types (~17 draw calls).

See [hex-terrain-design.md](hex-terrain-design.md) for full terrain type catalog, model specs, and transition handling.

### Tasks

1. **Create `src/lib/world/terrain-types.ts`**
   - Define terrain type enum and properties:
     ```typescript
     interface TerrainTypeDef {
       id: string;
       name: string;
       tier: number;          // elevation tier 0-5
       defaultColor: string;  // base color when unpainted
     }
     ```
   - Define ~17 initial terrain types with tiers (deep_ocean through mountain, including lake)
   - Define tier height constants (world-space units per tier)

2. **Create `src/lib/engine/hex-tiles.ts`**
   - **Procedural tile model generation** (prototype phase):
     ```typescript
     function createTerrainMesh(type: TerrainTypeDef, scene: Scene): Mesh {
       // Hex cylinder base at terrain tier height
       // Displace top vertices with terrain-specific noise
       // Add skirt geometry extending 2 tiers below
     }
     ```
   - Generate one source mesh per terrain type on init
   - Later: replace procedural models with Blender-authored glTF assets

3. **Create `src/lib/engine/hex-renderer.ts`**
   - Manage per-terrain-type thin instance groups:
     ```typescript
     class HexRenderer {
       private groups: Map<string, ThinInstanceGroup>;  // terrainType → group
       private hexIndex: Map<string, { terrain: string; bufferIndex: number }>;

       setHexTerrain(h3: string, terrain: string): void;  // move between groups
       setHexColor(h3: string, color: string): void;       // update color buffer
       clearHexColor(h3: string): void;
     }
     ```
   - Each `ThinInstanceGroup` holds:
     - Source mesh (from hex-tiles.ts)
     - `Float32Array` for instance matrices (16 floats each)
     - `Float32Array` for instance colors (4 floats each)
     - Current instance count
     - `Map<string, number>` for h3→bufferIndex within the group

4. **Generate hex grid positions**
   - Use H3 `getRes0Cells()` + `cellToChildren()` to enumerate all cells at target resolution
   - For each cell: compute globe position + surface-tangent rotation matrix
   - All hexes start as `deep_ocean` (default world is all ocean)
   - The `/api/land-hexes` endpoint is no longer needed for world building — hex positions come directly from H3 at any resolution

5. **Instance matrix computation**
   - For each hex:
     ```typescript
     const pos = latLngToWorld(lat, lng, EARTH_RADIUS_KM + tierHeight);
     const normal = pos.normalize();
     // Build rotation matrix aligning hex flat-face with sphere surface
     // Compose: rotation × translation
     matrix.copyToArray(matricesData, index * 16);
     ```
   - When terrain type changes: recompute matrix with new tier height

6. **Per-instance color buffer**
   - `Float32Array(groupSize * 4)` per group — RGBA province/country tint
   - Unpainted hexes use alpha=0 (terrain model's natural color shows)
   - Painted hexes use alpha=0.6-0.85 (tint over terrain)
   - `thinInstanceSetBuffer("color", colorData, 4, false)` — dynamic buffer

7. **Material setup**
   - PBR material per terrain type (or shared with per-type color):
     - Base color from terrain type definition
     - Instance color attribute multiplied as tint overlay
     - Lit by scene lights (terrain should respond to atmosphere/sun)
     - Hex edge darkening via fragment shader distance-to-edge

### Validation
- Globe covered in ocean hex tiles (default world)
- `setHexTerrain(h3, 'mountain')` visually changes the hex to a mountain model
- `setHexColor(h3, '#C45B5B')` tints the hex with a province color
- Terrain changes are smooth (no frame hitches on group buffer rebuild)
- 17 draw calls confirmed via Babylon Inspector
- 60fps maintained during orbit/zoom with 80K hexes

---

## Phase 3: Terrain Painting & World Building Tools (Days 8-10)

### Goal
The editor supports painting terrain types onto hexes — building continents, mountain ranges, islands, and oceans from a blank globe. This replaces the old geographic overlay system (TopoJSON borders/rivers) which is no longer needed since the world is custom-built.

### Tasks

1. **Add Terrain mode to editor**
   - Third editor mode alongside Province and Country: `editorMode: 'terrain' | 'province' | 'country'`
   - Terrain mode sidebar shows terrain type palette (icons + names for all ~17 types)
   - Selected terrain type is the active "brush"

2. **Terrain painting tools**
   - **Single hex brush**: click assigns selected terrain type to hex under cursor
   - **Area brush** (ring radius 1-3): paint terrain in a `gridDisk(h3, radius)` area
   - **Fill brush**: flood-fill connected hexes sharing the same terrain type
   - **Erase**: reset hex to `deep_ocean`
   - Painting calls `engine.setHexTerrain(h3, terrainType)` for each affected hex

3. **Ocean rendering**
   - The base globe sphere serves as the ocean floor / deep water
   - Ocean hex tiles (deep_ocean, shallow_ocean) sit at low elevation tiers
   - Water visual: apply Babylon's `WaterMaterial` or a custom animated shader to the globe sphere
   - Land hexes rise above the water level, creating natural coastlines

4. **Province/country borders as game objects**
   - Instead of real-world border overlays, borders are derived from province assignments
   - Render province boundaries as GreasedLine meshes along hex edges where adjacent hexes belong to different provinces
   - Recompute on province/country changes (not every frame)
   - Toggle visibility from UI

5. **World state persistence**
   - Update export format to version 3:
     ```typescript
     { version: 3, hexResolution: 4,
       hexes: { [h3]: { terrain: 'mountain', province?: 'prov_1' } },
       provinces, countries, provinceToCountry }
     ```
   - Import supports v2 (all hexes are plains, political data preserved) and v3

### Validation
- Clicking a hex in terrain mode changes its 3D model (e.g., ocean → mountain)
- Area brush paints terrain in a ring of hexes around click point
- Province borders render automatically along political boundaries
- Export/import round-trips terrain assignments correctly
- Performance: terrain type changes are smooth (no visible lag)

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

## Phase 6: Procedural World Generation (Days 14-17)

### Goal
Auto-generate playable worlds instead of requiring manual hex-by-hex painting. Procedural generators create continents, mountain ranges, biome distribution, and coastlines.

### Tasks

1. **Create `src/lib/world/world-gen.ts`**
   - Continent generation using multi-octave simplex noise on the sphere
   - Noise value thresholds determine terrain type:
     ```
     < -0.3  → deep_ocean
     -0.3–0.0 → shallow_ocean
     0.0–0.05 → coast
     0.05–0.3 → plains/grassland
     0.3–0.5  → forest/hills (secondary noise selects)
     0.5–0.7  → highland
     > 0.7    → mountain
     ```
   - Temperature gradient (latitude-based) shifts biomes: tundra at poles, jungle at equator
   - Moisture gradient (secondary noise) shifts biomes: desert vs grassland vs forest

2. **Generation parameters**
   - Seed (reproducible worlds)
   - Continent count / size
   - Mountain frequency
   - Ocean-to-land ratio
   - Temperature/moisture influence

3. **UI for world generation**
   - "New World" dialog with parameter sliders
   - "Regenerate" button with same seed + modified params
   - Preview before committing (generate in background, show progress)

4. **Island and feature placement**
   - After base terrain: scatter islands, volcanoes, reefs at random ocean positions
   - Mountain range continuity: use ridged noise to create linear mountain chains
   - River placement: trace downhill paths from mountains to coast (future phase)

### Validation
- Generated worlds have recognizable continents, mountain ranges, coastlines
- Different seeds produce different but plausible worlds
- Generation completes in <5 seconds for 80K hexes
- Generated world is editable (terrain painting still works after generation)

---

## Phase 7: Polish, Scale Testing & Tile Art (Days 18-22)

### Goal
Resolution scaling test, visual polish, performance optimization, and tile model refinement.

### Tasks

1. **Resolution scaling test**
   - Generate hex grid at resolution 5 (~560K hexes)
   - Test thin instance rendering at 500K+ across 17 groups — measure FPS, memory, load time
   - If needed, implement LOD:
     - At far zoom: render res-3 instances (simplified terrain, ~41K hexes)
     - At mid zoom: res-4 (~288K hexes)
     - At close zoom: res-5 with full terrain detail
     - Use `cellToParent()` / `cellToChildren()` from h3-js

2. **Tile model refinement**
   - Replace procedural terrain models with Blender-authored glTF assets (one type at a time)
   - Add surface detail: vertex color variation, normal maps per terrain type
   - Tune skirt geometry depth and texturing
   - Consider edge-matched transition pieces for critical pairings (land→ocean coast)

3. **Visual polish**
   - Atmosphere tuning: sunrise/sunset colors, haze density
   - Ocean shader: animated water with subtle waves on the globe sphere
   - Anti-aliasing: enable MSAA or FXAA post-process
   - Hex hover: glow or outline effect on hovered hex
   - Province border lines: auto-generated GreasedLine along political boundaries

4. **Performance optimization**
   - Profile with Babylon's Inspector: `scene.debugLayer.show()`
   - Confirm ~17 draw calls (one per terrain type group)
   - Frustum culling: split terrain groups into hemisphere chunks for back-face culling
   - WebGPU: test with `new WebGPUEngine(canvas)` for draw-call improvement

5. **Remove MapLibre dependencies**
   - Remove `maplibre-gl` from package.json
   - Remove `vendor/maplibre-gl/` directory
   - Remove MapLibre CSS import
   - Remove TopoJSON data files (`countries-10m.json`, `waterways-10m.json`, `states-10m.json`)
   - Remove `topojson-client`, `@turf/*` dependencies
   - Clean up any leftover MapLibre-specific code

---

## Dependency Changes

### Add
| Package | Purpose | Size (gzipped) |
|---------|---------|----------------|
| `@babylonjs/core` | Engine, scene, camera, meshes, materials | ~400-600KB |
| `@babylonjs/addons` | Atmosphere (PBR scattering) | ~100KB |
| `@babylonjs/materials` | Water material, advanced materials | ~50KB |
| `@babylonjs/loaders` | glTF loader for hex tile models | ~50KB |
| `simplex-noise` (or similar) | Procedural world generation | ~5KB |

### Remove
| Package | Reason |
|---------|--------|
| `maplibre-gl` (vendored) | Replaced by Babylon.js |
| `@turf/boolean-point-in-polygon` | No longer needed (no geographic data processing) |
| `@turf/intersect` | No longer needed |
| `@turf/helpers` | No longer needed |
| `topojson-client` | No longer needed (no real-world overlays) |

### Keep
| Package | Reason |
|---------|--------|
| `h3-js` | H3 hex grid — used for grid generation, neighbor lookups, and picking |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Babylon.js 9.0 geospatial API is underdocumented or unstable | HIGH | Phase 1 validates the API immediately. **RESOLVED**: GeospatialCamera is in `@babylonjs/core/Cameras`, Atmosphere in `@babylonjs/addons/atmosphere`. Both confirmed working in 9.3.1. |
| Per-terrain-type thin instance groups add draw call overhead | MEDIUM | ~17 draw calls is trivial. WebGPU render bundles reduce this further. Profile in Phase 7. |
| Terrain type change (moving hex between groups) causes frame hitch | MEDIUM | Buffer operations are O(1) per hex (swap-remove + append). Batch multiple changes and call `bufferUpdated` once per affected group. |
| Tile model quality (procedural) doesn't look good enough | MEDIUM | Procedural models are the prototype. Replace with Blender-authored glTF assets per terrain type in Phase 7. The rendering system doesn't care where the mesh comes from. |
| H3 pentagons (12 total) create visual artifacts | LOW | Place pentagons in ocean. At 80K hexes, 12 pentagons are unnoticeable. |
| Bundle size increase (~1.5MB+) | LOW | Acceptable for a game application. Tree-shake aggressively with deep imports. |
| Export format backwards compatibility | LOW | Version field in export JSON. Import handler supports v2 (political data only → all hexes become plains) and v3 (terrain + political). |

---

## What's Preserved

- **Political layer**: provinces, countries, hex assignments, colors — unchanged concept
- **UI layout and styling**: sidebar stays identical, expands with terrain mode
- **H3 library**: same hex grid, same resolution system, same `latLngToCell` for picking
- **Save/load**: v2 import supported (political data migrated, terrain defaults to plains)

## What Changes

- **World model**: real Earth geography → custom world building with assignable terrain types
- **Rendering backend**: MapLibre GeoJSON → Babylon.js per-terrain-type thin instance groups
- **Hex identity**: flat colored polygon → 3D terrain tile model with unique silhouette
- **Color management**: `setFeatureState()` → per-group instance color buffers
- **Picking**: MapLibre `queryRenderedFeatures` → ray-sphere intersection + h3-js
- **Geographic overlays**: TopoJSON borders/rivers → removed (borders derived from province assignments)
- **Elevation**: real-world DEM data → terrain type elevation tiers (discrete, designer-controlled)
- **Editor modes**: 2 modes (province/country) → 3 modes (terrain/province/country)
- **File structure**: single 786-line file → modular `lib/engine/` + `lib/world/` + `lib/stores/` + `lib/geo/`

---

## Decision Points

1. ~~**Geospatial package name**~~: **RESOLVED** — `GeospatialCamera` in `@babylonjs/core/Cameras/geospatialCamera`, `Atmosphere` in `@babylonjs/addons/atmosphere/atmosphere`.

2. **Globe coordinate system**: Using km-based coordinates matching `GeospatialCamera`'s `planetRadius` (EARTH_RADIUS_KM = 6371). **RESOLVED** in Phase 1 implementation.

3. **Hex border rendering**: Shader-based edge detection vs. GreasedLine outlines vs. wireframe pass. Decide during Phase 2 based on visual quality.

4. **Tile model source**: Procedural (prototype) → Blender glTF (production). Start procedural, replace incrementally. Decision per terrain type during Phase 7.

5. **Color update strategy**: Instance color buffer vs. data texture. Start with buffer, switch if per-hex update performance is insufficient.

6. **Transition handling**: Deep skirts (Phase 2, simple) → edge-matched transition pieces (Phase 7, if needed). Start simple.
