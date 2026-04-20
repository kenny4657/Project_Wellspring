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

1. **Thin instances** — one hex geometry, 500K instances, single draw call (~40MB GPU buffer)
2. **Data texture for colors** — 1 pixel per hex, `texSubImage2D` for O(1) color updates
3. **LOD (Level of Detail)** — H3 res 3 (~41K) zoomed out, res 4 (~288K) mid-zoom, res 5 at close zoom
4. **Terrain displacement** — sample elevation from 3D Tiles, offset hex vertices vertically
5. **Hit testing** — ray-sphere intersection → lat/lng → `latLngToCell()` (O(1) via h3-js)

### Migration Scope

Current app is ~1,092 lines (single Svelte page + one API endpoint).

| Task | Effort | Notes |
|---|---|---|
| Babylon.js scene + geospatial camera | 1-2 days | Starter template exists |
| Atmosphere + lighting | 1 day | Built-in, configure only |
| Hex thin instances on globe | 2-3 days | H3 lat/lng → 3D sphere position |
| Terrain elevation | 3-5 days | 3D Tiles integration, vertex displacement |
| Port geographic overlays (borders, rivers) | 3-5 days | TopoJSON → 3D line meshes on sphere |
| Port painting interaction | 2-3 days | Ray picking → h3-js |
| Port UI panels to Babylon bridge | 1-2 days | Svelte stores bridge |
| **Total** | **~2-4 weeks** | Feature parity + terrain + atmosphere |

### What This Enables

After migration, the Babylon.js foundation supports:
- Terrain elevation with hex displacement
- Atmospheric scattering (sunrise/sunset, weather)
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
| 2026-04-19 | Thin instances + data texture over GeoJSON | O(1) color updates, single draw call, 500K–1M hex capacity. |
| 2026-04-19 | H3 LOD (res 3/4/5) over fixed resolution | Balance visual fidelity with performance across zoom levels. |
