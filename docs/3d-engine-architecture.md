# 3D Engine Architecture: Country Painter → Strategy Game

## Context

The Country Painter is currently a 2D hex map editor using MapLibre GL JS with H3 resolution 4 (~80K land hexes, ~45km each). The goal is to evolve it into a full 3D hex strategy game with terrain elevation, atmospheric effects, and game-engine-level rendering — requiring 500K+ hexes at 60fps.

This document evaluates rendering approaches and recommends an architecture.

---

## Current Rendering Bottleneck

- ~80K hexes rendered as GeoJSON polygon features via MapLibre
- Each hex = 6-vertex polygon styled via `setFeatureState()`
- Scaling to 500K+ hits two walls: GeoJSON parsing overhead and per-feature state management
- Each H3 resolution bump ~7x's the hex count (res 5 = ~560K, res 6 = ~4M)

---

## Options Evaluated

### 1. deck.gl H3HexagonLayer

- Purpose-built layer for H3 hexagons with instanced rendering
- 500K–1M hexes at 60fps, built-in click/hover with GPU picking
- Integrates with MapLibre via `MapboxOverlay`
- **Limitation:** Adds ~300KB gzipped. Not a game engine — no terrain, atmosphere, or 3D game features.

### 2. Custom WebGL (regl/twgl) in MapLibre CustomLayerInterface

- Data texture approach: 1 pixel = 1 hex color, instanced geometry, single draw call
- 1M+ hexes feasible, ~15-75KB bundle addition
- **Limitation:** Still inside MapLibre — no path to 3D terrain, atmosphere, or game objects.

### 3. PixiJS / Phaser

- 2D game renderers, tops out at ~50K-100K hex objects
- No map projection, no globe support
- **Ruled out:** Scale and projection limitations.

### 4. Three.js / Threlte

- Minimal core (~168KB), InstancedMesh handles 500K+ instances
- Threlte provides good Svelte integration
- **Limitation:** No geospatial features — globe camera, terrain tiles, atmosphere all custom. Would rebuild what Babylon.js 9.0 ships natively.

### 5. CesiumJS

- Purpose-built 3D globe engine with terrain, tiles, and atmosphere
- **Limitation:** Visualization engine, not a game engine. No physics, particles, animation. API designed for GIS entities, not game objects.

### 6. Godot / Unity WebGL Export

- Capable game engines but wrong platform for web-first
- 25-40MB WASM downloads, iframe communication overhead
- **Ruled out:** Bundle size and platform mismatch.

### 7. Babylon.js 9.0 (Recommended)

See detailed recommendation below.

### 8. SDF Hex Rendering (Fullscreen Quad Shader)

- Fragment shader computes hex membership mathematically — unlimited hex count
- **Limitation:** H3 hexes are irregular (icosahedral projection, size varies by latitude, pentagons at vertices). Regular hex SDF doesn't match H3's grid. Impractical without a lookup texture that defeats the elegance.

---

## Recommendation: Babylon.js 9.0 + SvelteKit Hybrid

### Why Babylon.js 9.0

Released March 2026, Babylon.js 9.0 introduced a dedicated geospatial subsystem:

| Feature | Description |
|---|---|
| **Geospatial Camera** | Globe orbit/zoom/tilt, `flyToAsync()`, altitude-aware clip planes |
| **Physically Based Atmosphere** | Rayleigh + Mie scattering, ozone, dynamic day/night cycles, alien planet support |
| **3D Tiles (NASA 3DTilesRenderer)** | Stream Cesium World Terrain or Mapbox elevation tiles |
| **Large World Rendering** | Floating-point precision solved via camera-at-origin offsetting |
| **WebGPU Support** | Production-ready, ~10x draw-call-heavy scene improvement |

Plus full game engine capabilities: Havok physics, particle systems, PBR materials, skeletal animation, post-processing pipeline, WebXR, GUI system, Inspector/debugger.

**Bundle size:** ~1.4 MB total. Tree-shakeable via `@babylonjs/core` deep imports.

### Architecture

```
┌──────────────────────────────────────────────────┐
│  SvelteKit                                       │
│  ┌────────────────────────────────────────────┐  │
│  │ UI Layer (HTML/CSS/Tailwind)               │  │
│  │ - Province/country panels                  │  │
│  │ - Tool selection, menus, modals            │  │
│  │ - Game HUD, tooltips, diplomacy UI         │  │
│  │ - Routing (lobby, settings, etc.)          │  │
│  └────────────────┬───────────────────────────┘  │
│                   │ Svelte stores / event bus     │
│  ┌────────────────▼───────────────────────────┐  │
│  │ Babylon.js Canvas                          │  │
│  │ - Geospatial Camera (globe navigation)     │  │
│  │ - 3D Tiles terrain streaming               │  │
│  │ - PB Atmosphere (sky, scattering)          │  │
│  │ - Hex thin instances (500K+)               │  │
│  │ - Game objects (units, cities, effects)     │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

- **SvelteKit** owns routing, UI panels, data management, and all HTML/CSS
- **Babylon.js** owns the `<canvas>` — rendering, 3D interaction, game world
- Communication via Svelte stores and an event bus
- Reference: [babylonjs-sveltekit starter template](https://github.com/jasonsturges/babylonjs-sveltekit)

### Hex Rendering Strategy

1. **Shader-driven single mesh** — one subdivided hex template (~96 tris), ALL hexes as one thin-instance group, **2 draw calls total** (hexes + rivers)
2. **Per-instance terrain data** — 8 floats per hex: terrain type + 6 neighbor types. Vertex shader displaces geometry; fragment shader selects material and blends transitions
3. **Per-instance color buffer** — RGBA tint per hex for province/country painting, O(1) color updates
4. **Terrain type changes** — update 7 floats in buffer (self + 6 neighbors). No group switching, no mesh rebuild
5. **Same-type merging** — shader applies no blend between same-type neighbors + world-space texturing → hex grid invisible within terrain regions
6. **Different-type transitions** — shader blends materials + displacement meets at shared edge height → automatic shores, cliffs, treelines
7. **LOD (Level of Detail)** — H3 res 3 (~41K) zoomed out, res 4 (~288K) mid-zoom, res 5 at close zoom
8. **Hit testing** — ray-sphere intersection → lat/lng → `latLngToCell()` (O(1) via h3-js)

See [hex-terrain-design.md](hex-terrain-design.md) for full terrain type catalog, shader design, and transition handling.

### Migration Scope

Current app is ~1,092 lines (single Svelte page + one API endpoint).

| Task | Effort | Notes |
|---|---|---|
| Babylon.js scene + geospatial camera | 1-2 days | **DONE** — Phase 1 complete |
| Atmosphere + lighting | 1 day | **DONE** — included in Phase 1 |
| Terrain tile models (procedural) | 2-3 days | ~17 terrain types, hex cylinder + noise displacement |
| Per-terrain-type thin instance groups | 2-3 days | Instance buffer management, terrain type switching |
| Terrain painting tools | 2-3 days | Terrain mode, brushes, area paint |
| Port picking + political painting | 2-3 days | Ray picking → h3-js, province/country brushes |
| Wire UI ↔ Engine via Svelte stores | 1-2 days | Svelte stores bridge |
| Procedural world generation | 3-4 days | Simplex noise continent/biome generation |
| Polish + scale testing + tile art | 3-5 days | LOD, ocean shader, Blender models |
| **Total** | **~3-4 weeks** | Full 3D world builder with custom terrain |

### What This Enables

After migration, the Babylon.js foundation supports:
- Custom world building with ~17 terrain types
- Unique 3D silhouettes per terrain (mountains look like mountains)
- Atmospheric scattering (sunrise/sunset, weather)
- Procedural world generation with tunable parameters
- 3D game objects (units, cities, structures on hex tiles)
- Fog of war, particles, visual effects
- Physics (Havok) for projectiles, destruction
- WebGPU acceleration for draw-call-heavy scenes

### Notable Consideration

No shipped hex strategy game (Civ 6, Humankind, Old World) plays on a true sphere — they all use flat maps with edge wrapping. Civ 6's globe view is cosmetic. A spherical hex gameplay surface would be genuinely novel, which means less prior art to reference but a unique differentiator.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-19 | Babylon.js 9.0 over Three.js | Built-in geospatial camera, atmosphere, 3D tiles. Avoids rebuilding what ships natively. |
| 2026-04-19 | Babylon.js 9.0 over CesiumJS | CesiumJS is a GIS viewer, not a game engine. No physics, particles, animation. |
| 2026-04-19 | Babylon.js 9.0 over Godot/Unity WebGL | Web-first requirement. 25-40MB WASM downloads are prohibitive. |
| 2026-04-19 | Hybrid SvelteKit + canvas over full engine UI | Keep UI accessible, styled with Tailwind, SSR for non-game pages. |
| 2026-04-19 | Shader-driven single mesh over per-terrain-type mesh groups | Fully procedural approach: 1 shared hex mesh, vertex/fragment shader handles all terrain shape + material + transitions. 2 draw calls instead of 26. Terrain changes are buffer updates, not group switches. |
| 2026-04-19 | Custom world building over real-world geography | Game worlds should not be constrained by Earth's geography. Terrain types are freely assignable per hex. |
| 2026-04-19 | Noise-displaced shared mesh over pre-made tile models | All terrain variation via vertex shader noise profiles. Faster iteration (tune parameters, not rebuild meshes), seamless same-type merging, automatic edge transitions. Trade-off: less silhouette control than authored models, sufficient at 45km hex scale. |
| 2026-04-19 | Shader-based transitions over edge piece geometry | Fragment shader blends materials at hex edges where terrain differs. No separate transition meshes, no rebuild on terrain change. Same-type merging is automatic (no blend applied). |
| 2026-04-19 | Keep H3 for hex grid | Despite not using real-world geography, H3 provides grid generation, neighbor lookups, and O(1) picking for free. 12 pentagons are hideable as ocean. |
| 2026-04-19 | H3 LOD (res 3/4/5) over fixed resolution | Balance visual fidelity with performance across zoom levels. |
