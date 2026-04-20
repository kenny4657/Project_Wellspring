# Hex Terrain Tile System

## Design Direction

The game world is **not constrained by real-world geography**. Each hex is an independently assignable terrain tile — mountains, islands, forests, oceans, etc. can be placed freely to build custom worlds. This replaces the earlier approach of overlaying data on Earth's geography.

Each terrain type has a **unique 3D tile model** with its own silhouette, surface detail, and elevation. The hex grid provides structure; the terrain tiles provide visual identity.

---

## Terrain Type Catalog

Each terrain type defines a visual model, an elevation tier, and gameplay properties.

### Elevation Tiers

Tiers control vertical positioning on the globe and determine cliff visibility between neighbors.

| Tier | Height | Terrain Types |
|------|--------|---------------|
| 0 | Below surface | Deep Ocean, Trench |
| 1 | Surface level | Shallow Ocean, Reef, Coast |
| 2 | Low | Plains, Grassland, Desert, Swamp, Tundra |
| 3 | Medium | Forest, Hills, Jungle |
| 4 | High | Highland, Plateau |
| 5 | Peak | Mountain, Volcano |

### Terrain Types (Initial Set)

| Type | Tier | Model Description | Top Surface | Side Character |
|------|------|-------------------|-------------|----------------|
| `deep_ocean` | 0 | Concave bowl, dark blue | Smooth concave | Submerged walls (not visible) |
| `shallow_ocean` | 1 | Slight concave, lighter blue | Gentle ripple | Submerged walls |
| `reef` | 1 | Shallow water with coral bumps | Irregular bumps breaking surface | Rocky underwater walls |
| `coast` | 1-2 | Half-water half-land, beach edge | Split surface: sand shelf → water | Sandy cliffs or gentle slope |
| `plains` | 2 | Flat with gentle undulation | Low grass-like bumps | Earth/dirt walls |
| `grassland` | 2 | Flat, slightly more textured than plains | Gentle rolling | Earth walls |
| `desert` | 2 | Flat with dune ripples | Smooth dunes, wind-carved | Sand walls |
| `swamp` | 2 | Low, partially flooded | Pools + mud patches | Muddy walls |
| `tundra` | 2 | Flat, ice-crusted | Cracked ice / permafrost | Frozen earth walls |
| `forest` | 3 | Plains base + canopy volume | Dome/canopy shapes rising from base | Earth walls with root textures |
| `jungle` | 3 | Dense canopy, higher than forest | Thick layered canopy | Vine-covered walls |
| `hills` | 3 | 2-3 rounded mounds | Rolling bumps, moderate height | Grassy/rocky slopes |
| `highland` | 4 | Raised flat plateau | Flat top at elevation | Cliff faces, layered rock |
| `plateau` | 4 | Dramatic mesa shape | Flat top, sharp edges | Vertical cliff walls |
| `mountain` | 5 | Central peak with ridges | Peaked, rocky, possibly snow-capped | Steep rocky faces |
| `volcano` | 5 | Cone with crater | Hollow cone top, possible glow | Steep dark rock |
| `island` | 2 | Small raised land surrounded by water at base | Beach ring → green center | Beach/cliff dropping to water |

Expandable later with: ice_shelf, canyon, river_delta, mesa, badlands, glacier, etc.

---

## Rendering Architecture

### Per-Terrain-Type Thin Instance Groups

All hexes sharing a terrain type share the same source mesh. Each terrain type is a separate thin-instance group.

```
Terrain Type Registry
┌─────────────┬──────────────┬───────────────┬──────────────────┐
│ Terrain Type│ Source Mesh  │ Instance Count│ Draw Call        │
├─────────────┼──────────────┼───────────────┼──────────────────┤
│ deep_ocean  │ ocean.glb    │ ~25,000       │ 1                │
│ plains      │ plains.glb   │ ~12,000       │ 1                │
│ mountain    │ mountain.glb │ ~3,000        │ 1                │
│ forest      │ forest.glb   │ ~8,000        │ 1                │
│ ...         │ ...          │ ...           │ ...              │
├─────────────┼──────────────┼───────────────┼──────────────────┤
│ TOTAL       │ ~17 meshes   │ ~80,000       │ ~17 draw calls   │
└─────────────┴──────────────┴───────────────┴──────────────────┘
```

17 draw calls for 80K hexes. At 500K hexes, still 17 draw calls — only the instance count per group grows.

### Instance Data Per Hex

Each thin instance carries:

| Attribute | Stride | Purpose |
|-----------|--------|---------|
| `matrix` | 16 floats | Position + rotation on globe surface |
| `color` | 4 floats | Province/country tint (RGBA) |

Total per instance: 80 bytes. For 80K hexes: ~6.4 MB GPU buffer. For 500K: ~40 MB.

The matrix encodes:
1. **Translation** — position on globe surface at the terrain type's elevation tier
2. **Rotation** — orient hex flat-face tangent to sphere surface
3. **Scale** — uniform, derived from H3 cell size at that latitude

### Terrain Type Change (Moving Between Groups)

When a hex changes terrain (e.g., plains → mountain via editor):

1. Remove the hex from the old group's instance buffer (swap with last element, shrink count)
2. Add the hex to the new group's instance buffer (append, grow count)
3. Update the index mapping: `hexIndex[h3] = { terrainType, bufferIndex }`
4. Call `thinInstanceBufferUpdated("matrix")` and `thinInstanceBufferUpdated("color")` on both groups

This is an O(1) operation per hex. Batch operations (e.g., flood-fill terrain painting) update multiple hexes then call `bufferUpdated` once per affected group.

---

## Tile Model Specification

### Geometry Constraints

Each tile model must conform to:

- **Hex footprint**: regular hexagon, flat-top orientation, inscribed radius matching H3 cell size
- **Origin**: center of hex base, Y=0 at the base plane
- **Orientation**: flat edge faces +Z in model space
- **Triangle budget**: 24-100 triangles per tile (target ~50 average)
  - 80K hexes x 50 tris = 4M triangles — well within budget
  - 500K hexes x 50 tris = 25M triangles — feasible with LOD
- **Skirt geometry**: extends downward from hex edges to at least 1 tier below the model's native tier. Hides gaps between neighbors at different elevations.

### Skirt Depth Guide

```
Tier 5 (mountain):  skirt extends to tier 3 level  (2 tiers)
Tier 4 (highland):  skirt extends to tier 2 level  (2 tiers)
Tier 3 (hills):     skirt extends to tier 1 level  (2 tiers)
Tier 2 (plains):    skirt extends to tier 0 level  (2 tiers)
Tier 1 (shallow):   skirt extends to tier 0 level  (1 tier)
Tier 0 (deep ocean): no skirt needed (lowest tier)
```

This means a mountain hex next to an ocean hex will have its rocky skirt visible for 5 tiers of height difference, creating dramatic cliff faces.

### Asset Pipeline Options

**Option A: Blender-authored models (highest quality)**
- Model each terrain type in Blender
- Export as glTF (.glb)
- Load in Babylon.js via `SceneLoader.ImportMeshAsync`
- Best for final art, worst for iteration speed

**Option B: Procedural generation (fastest iteration)**
- Generate tile models programmatically in Babylon.js
- `MeshBuilder.CreateCylinder` for hex column base
- Displacement noise for top surface variation
- Different noise profiles per terrain type
- Best for prototyping, can be replaced with Blender models later

**Option C: Hybrid (recommended)**
- Start with procedural generation for all terrain types
- Replace with Blender models one type at a time as art direction solidifies
- The thin-instance system doesn't care where the source mesh came from

### Procedural Generation Sketch

```typescript
function createTerrainMesh(type: TerrainType, scene: Scene): Mesh {
  // Base hex column
  const hex = MeshBuilder.CreateCylinder(`hex_${type}`, {
    height: TIER_HEIGHTS[type.tier],
    diameterTop: HEX_RADIUS * 2,
    diameterBottom: HEX_RADIUS * 2,
    tessellation: 6,           // hexagonal cross-section
    subdivisions: 4,           // vertical segments for skirt detail
  }, scene);

  // Displace top vertices based on terrain profile
  const positions = hex.getVerticesData(VertexBuffer.PositionKind);
  for (let i = 0; i < positions.length; i += 3) {
    if (isTopVertex(positions, i, type.tier)) {
      const noise = terrainNoise(positions[i], positions[i+2], type);
      positions[i + 1] += noise; // Y displacement
    }
  }
  hex.updateVerticesData(VertexBuffer.PositionKind, positions);
  hex.bakeCurrentTransformIntoVertices();
  return hex;
}
```

---

## World State Data Model

### Per-Hex State

```typescript
interface HexState {
  h3: string;              // H3 cell index (grid position)
  terrain: TerrainType;    // Visual tile model + elevation tier
  province?: string;       // Province assignment (political layer)
  // Future: resources, improvements, visibility, etc.
}
```

### World Map

```typescript
interface WorldMap {
  version: 3;
  hexResolution: number;           // H3 resolution (e.g., 4)
  hexes: Record<string, HexState>; // h3 index → hex state
  provinces: Record<string, Province>;
  countries: Record<string, Country>;
  provinceToCountry: Record<string, string>;
}
```

### Default World Generation

When creating a new world, all hexes start as `deep_ocean`. The editor provides terrain painting tools to build land masses. Future: procedural world generators that create continents, mountain ranges, biome distribution automatically.

---

## Editor Modes

The editor expands from 2 modes to 3:

| Mode | What you paint | Brush effect |
|------|---------------|--------------|
| **Terrain** | Terrain types onto hexes | Changes hex model (moves between instance groups) |
| **Province** | Province assignments onto hexes | Changes hex color tint within its instance group |
| **Country** | Country assignments onto provinces | Changes hex color tint for all hexes in province |

### Terrain Painting Tools

- **Single hex brush**: click to assign terrain type
- **Fill brush**: flood-fill connected hexes of the same terrain type
- **Area brush**: paint in a radius (1-3 hex rings)
- **Elevation brush**: raise/lower terrain tier without changing type
- **Smooth**: blend terrain types at edges (auto-assign transitional types like coast, hills)

---

## Transition Handling

### Deep Skirts (Phase 1 — Simple)

Each tile model includes skirt geometry extending 2 tiers below its surface. Adjacent hexes' skirts overlap, hiding gaps. No special transition logic needed.

**Pros**: Simple, no per-edge computation, works with thin instances
**Cons**: Skirt texturing is generic (same rock/dirt regardless of neighbor)

### Edge-Matched Transitions (Phase 2 — If Needed)

If deep skirts don't look good enough, add transition meshes along hex edges:

- For each hex edge, compare this hex's tier to the neighbor's tier
- If different: place a transition mesh piece (cliff, slope, beach, etc.)
- Transition pieces are their own thin-instance groups (cliff_2_to_0, slope_3_to_2, etc.)
- Adds ~6 more draw calls but dramatically improves visual quality

This is what Civ 6 does. It's more work but creates the "polished strategy game" look.

---

## Compatibility with Migration Plan

### What Changes from the Original Plan

| Original Plan | New Direction |
|---------------|---------------|
| Phase 2: single flat hex thin-instance group | Per-terrain-type thin-instance groups (~17 groups) |
| Phase 3: Geographic overlays (TopoJSON borders/rivers) | **Removed** — no real-world geography. Borders are game objects. |
| Phase 6: Real-world elevation (ETOPO, 3D Tiles, Cesium) | **Replaced** — elevation comes from terrain type tiers, not DEM data |
| Data source: `/api/land-hexes` (pre-computed from Earth) | **Replaced** — hex grid generated from H3 at any resolution, all start as ocean |
| Dependencies: `topojson-client`, `@turf/*` | **Removable** — no longer needed for overlays |

### What Stays the Same

- Babylon.js 9.0 + SvelteKit hybrid architecture
- GeospatialCamera for globe navigation
- Physically Based Atmosphere
- H3 for hex grid generation and picking
- Province/country political layer
- Export/import (expanded format)
- Ray-sphere picking → `latLngToCell()`
