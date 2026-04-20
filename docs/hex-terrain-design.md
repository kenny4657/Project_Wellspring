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
| 1 | Surface level | Shallow Ocean, Reef, Coast, Lake |
| 2 | Low | Plains, Grassland, Desert, Swamp, Tundra |
| 3 | Medium | Forest, Hills, Jungle |
| 4 | High | Highland, Plateau |
| 5 | Peak | Mountain |

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
| `lake` | 1 | Inland body of fresh water | Flat water surface, slightly below land level | Earth/grassy banks |
| `island` | 2 | Small raised land surrounded by water at base | Beach ring → green center | Beach/cliff dropping to water |

Expandable later with: ice_shelf, canyon, river_delta, mesa, badlands, glacier, volcano, etc.

---

## Rivers (Hex Edge Features)

Rivers are **not a terrain type**. They are **edge features** — they flow along the boundaries between hexes, not through hex centers. This is how Civilization 5/6, Humankind, and most hex strategy games handle rivers.

### Data Model

Each hex has 6 edges. A river can exist on any edge. Edges are shared between two adjacent hexes, so river data is stored once per edge, not per hex.

```typescript
/** A hex edge is identified by the hex on one side + the edge direction (0-5) */
interface RiverSegment {
  h3: string;       // hex on the "upstream" side
  edge: number;     // edge index 0-5 (which of the 6 hex edges)
  flowDirection: number; // which end the river flows toward (for rendering arrow/width)
}

/** Added to WorldMap */
interface WorldMap {
  // ... existing fields ...
  rivers: RiverSegment[];  // all river segments in the world
}
```

### Edge Indexing

H3 hex edges are indexed 0-5, starting from the top edge and going clockwise:

```
      ___0___
     /       \
   5/         \1
   /           \
   \           /
   4\         /2
     \___3___/
```

Two adjacent hexes share an edge. To avoid duplicate river data, each edge is stored only once — on the hex with the lexicographically smaller H3 index. The neighbor's corresponding edge index can be computed from H3's `gridDisk` neighbor ordering.

### Rendering

Rivers are rendered as **GreasedLine meshes** positioned along hex edges on the globe surface:

```typescript
function buildRiverGeometry(rivers: RiverSegment[], scene: Scene): Mesh {
  const segments: Vector3[][] = [];

  for (const river of rivers) {
    // Get the two vertices of this hex edge
    const boundary = cellToBoundary(river.h3); // 6 vertices [lat, lng]
    const v1 = latLngToWorld(boundary[river.edge], RIVER_HEIGHT);
    const v2 = latLngToWorld(boundary[(river.edge + 1) % 6], RIVER_HEIGHT);
    segments.push([v1, v2]);
  }

  return GreasedLineMeshBuilder.CreateGreasedLine("rivers", {
    points: segments,
    width: 3,  // screen-space pixels
  }, scene);
}
```

- Rivers render as blue lines along hex edges, slightly above the terrain surface
- Width can vary by flow accumulation (thin tributaries → wide main river)
- All river segments are merged into a single GreasedLine mesh (1 draw call)
- Rivers are rebuilt when river data changes (not per-frame)

### River Painting Tools

In Terrain mode, the editor adds river-specific tools:

- **River brush**: click a hex edge to toggle a river segment on/off
  - Hit testing: identify which edge is closest to the click point within the hex
  - Visual feedback: highlight the edge under cursor before clicking
- **River path tool**: click two hexes, auto-trace a downhill path between them along hex edges
  - Uses terrain tier as elevation — rivers flow from high tier to low tier
  - A* or greedy pathfinding preferring downhill edges
- **River erase**: click a river segment to remove it

### Edge Hit Testing

To determine which hex edge the user clicked near:

```typescript
function getClosestEdge(h3: string, clickLatLng: {lat, lng}): number {
  const boundary = cellToBoundary(h3); // 6 vertices
  let closestEdge = 0;
  let minDist = Infinity;

  for (let i = 0; i < 6; i++) {
    const v1 = boundary[i];
    const v2 = boundary[(i + 1) % 6];
    const midpoint = [(v1[0]+v2[0])/2, (v1[1]+v2[1])/2];
    const dist = haversine(clickLatLng, midpoint);
    if (dist < minDist) {
      minDist = dist;
      closestEdge = i;
    }
  }
  return closestEdge;
}
```

### Rivers vs. Terrain Interaction

| Terrain Context | River Behavior |
|----------------|----------------|
| River between two land hexes | Standard river rendering (blue line on land) |
| River entering a lake hex | River terminates at lake edge (lake is the destination) |
| River entering ocean/coast | River mouth — could widen or show delta effect |
| River between ocean hexes | Invalid — rivers don't exist in open ocean |
| River along a mountain edge | Visually: river in a gorge/valley between peaks |

### Why Not River-as-Terrain-Type?

A "river hex" terrain type would mean an entire 45km hex is a river — far too wide. Real rivers are narrow features that cross between territories. Making them edge features gives:

- **Geographic accuracy**: rivers are boundaries, not regions
- **Gameplay utility**: rivers as natural borders between provinces/countries
- **Visual clarity**: thin lines between hexes, not giant blue hexes
- **Strategic meaning**: crossing a river edge could have movement/combat penalties

---

## Rendering Architecture

### Per-Terrain-Type Thin Instance Groups

All hexes sharing a terrain type share the same source mesh. Each terrain type is a separate thin-instance group.

```
Rendering Registry
┌──────────────────┬──────────────┬───────────────┬──────────────────┐
│ Component        │ Source Mesh  │ Instance Count│ Draw Calls       │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ BASE TILES       │              │               │                  │
│  deep_ocean      │ ocean.glb    │ ~25,000       │ 1                │
│  plains          │ plains.glb   │ ~12,000       │ 1                │
│  mountain        │ mountain.glb │ ~3,000        │ 1                │
│  forest          │ forest.glb   │ ~8,000        │ 1                │
│  lake            │ lake.glb     │ ~1,500        │ 1                │
│  ...             │ ...          │ ...           │ ...              │
│  (subtotal)      │ ~17 meshes   │ ~80,000       │ ~17              │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ EDGE PIECES      │              │               │                  │
│  shore           │ shore.glb    │ ~15,000       │ 1                │
│  cliff           │ cliff.glb    │ ~8,000        │ 1                │
│  slope           │ slope.glb    │ ~12,000       │ 1                │
│  treeline        │ treeline.glb │ ~6,000        │ 1                │
│  ...             │ ...          │ ...           │ ...              │
│  (subtotal)      │ ~8 meshes    │ ~100,000      │ ~8               │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ RIVERS           │ GreasedLine  │ 1 merged mesh │ 1                │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ TOTAL            │ ~26 meshes   │ ~180,000 inst │ ~26 draw calls   │
└──────────────────┴──────────────┴───────────────┴──────────────────┘
```

~26 draw calls for 80K hexes + transitions + rivers. Scales linearly with hex count — at 500K hexes, still ~26 draw calls.

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
  rivers: RiverSegment[];          // edge features (see Rivers section)
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
- **River brush**: click hex edges to place/remove river segments (see Rivers section)
- **River path tool**: click two hexes to auto-trace a downhill river path between them

---

## Terrain Transitions & Merging

The fundamental challenge: **thin instances share geometry**, but a lake hex surrounded by other lakes should look different from a lake hex bordered by mountains. Same-type hexes should merge seamlessly (no visible hex grid); different-type hexes need explicit transition visuals.

### Two-Layer Architecture: Base Tiles + Edge Pieces

Each hex is rendered as two components:

```
Layer 1: BASE TILE (thin instances, ~17 draw calls)
  - Fills the full hex footprint
  - NO border/edge features — designed to tile seamlessly with same-type neighbors
  - A lake base tile is just flat water filling the entire hex
  - A plains base tile is flat grass filling the entire hex

Layer 2: EDGE PIECES (thin instances, placed per-edge where terrain differs)
  - Small meshes covering one hex edge (~1/6 of the hex perimeter)
  - Only placed where this hex's terrain type ≠ neighbor's terrain type
  - Provides the visual transition: shores, treelines, cliff faces, etc.
  - NOT placed between same-type hexes → hex boundary disappears
```

This solves both problems:
- **Same-type merging**: no edge pieces between adjacent lakes → continuous water surface
- **Different-type transitions**: shore piece between lake and plains → visible coastline

### Visual Example

```
Three lake hexes + one plains hex:

    ┌─────────┐
    │  LAKE   │         ← base tile: flat water
    │         │
    ├─ ─ ─ ─ ┤         ← NO edge piece (same type) → seamless water
    │  LAKE   │
    │         │
    ├─────────┤         ← NO edge piece (same type) → seamless water
    │  LAKE   │
    │      ≈≈≈│shore    ← EDGE PIECE: lake→plains shore on right edge
    ├─────────┤
    │ PLAINS  │
    │         │
    └─────────┘
```

### Edge Piece Types

Edge pieces are categorized by the transition they represent. Each is a thin-instance group.

| Edge Piece | When Placed | Visual |
|------------|-------------|--------|
| `shore` | Water ↔ Land (any tier 0-1 ↔ tier 2+) | Sandy/rocky beach strip |
| `cliff` | Low land ↔ High land (2+ tier difference) | Vertical rock face |
| `slope` | Adjacent land tiers (1 tier difference) | Gentle grassy/rocky incline |
| `treeline` | Open land ↔ Forest/Jungle | Trees thinning to grass |
| `waterline` | Lake ↔ Ocean types | Subtle water color boundary |
| `ice_edge` | Tundra ↔ Non-tundra | Frost/snow fading to earth |
| `desert_edge` | Desert ↔ Non-desert green | Sand-to-grass gradient |

Not every terrain pair needs a unique edge piece. A lookup table maps terrain pair → edge piece type:

```typescript
type EdgePieceType = 'shore' | 'cliff' | 'slope' | 'treeline' | 'waterline' | 'ice_edge' | 'desert_edge' | 'generic';

function getEdgePiece(terrainA: TerrainType, terrainB: TerrainType): EdgePieceType | null {
  // Same terrain type → no edge piece (seamless merge)
  if (terrainA === terrainB) return null;

  const tierA = TERRAIN_TIERS[terrainA];
  const tierB = TERRAIN_TIERS[terrainB];
  const isWaterA = tierA <= 1;
  const isWaterB = tierB <= 1;

  // Water ↔ Land
  if (isWaterA !== isWaterB) return 'shore';

  // Both water but different types
  if (isWaterA && isWaterB) return 'waterline';

  // Large elevation difference
  if (Math.abs(tierA - tierB) >= 2) return 'cliff';

  // Small elevation difference
  if (tierA !== tierB) return 'slope';

  // Same tier, different type — contextual
  if (terrainA === 'forest' || terrainB === 'forest' ||
      terrainA === 'jungle' || terrainB === 'jungle') return 'treeline';
  if (terrainA === 'tundra' || terrainB === 'tundra') return 'ice_edge';
  if (terrainA === 'desert' || terrainB === 'desert') return 'desert_edge';

  return 'generic';
}
```

### Edge Piece Geometry

Each edge piece is a **wedge-shaped mesh** covering one edge of the hex:

```
        Hex center
           *
          /|\
         / | \
        /  |  \
       / EDGE  \
      /  PIECE  \
     /_____|_____\
     v1          v2      ← hex boundary vertices
```

- Spans from hex center to the edge midpoint to the two edge vertices
- ~8-16 triangles per edge piece
- Oriented in model space so it can be instanced along any of the 6 edges via rotation
- One model per edge piece type, rotated to the correct edge via the instance matrix

### Edge Piece Instance Data

```typescript
interface EdgePieceInstance {
  h3: string;           // which hex this edge belongs to
  edge: number;         // edge index 0-5
  type: EdgePieceType;  // shore, cliff, slope, etc.
}
```

Instance matrix encodes:
1. Translation to hex position on globe
2. Rotation to align with globe surface normal
3. Additional rotation around the normal to orient to the correct edge (edge × 60°)

### Rendering Budget

| Component | Draw Calls | Typical Instance Count |
|-----------|-----------|----------------------|
| Base tiles (~17 terrain types) | ~17 | 80,000 total |
| Edge pieces (~8 types) | ~8 | ~100,000 total (many hexes have 3-4 differing edges) |
| Rivers | 1 | 1 merged mesh |
| **Total** | **~26** | — |

~26 draw calls is still very comfortable. Edge piece instances add ~8 MB GPU buffer (100K × 80 bytes).

### Edge Piece Rebuild

Edge pieces are **recomputed whenever terrain changes**:

```typescript
function rebuildEdgePieces(hexes: Map<string, HexState>): EdgePieceInstance[] {
  const pieces: EdgePieceInstance[] = [];

  for (const [h3, state] of hexes) {
    const neighbors = gridDisk(h3, 1).filter(n => n !== h3); // 6 neighbors

    for (let edge = 0; edge < 6; edge++) {
      const neighbor = neighbors[edge];
      const neighborState = hexes.get(neighbor);
      const neighborTerrain = neighborState?.terrain ?? 'deep_ocean';

      const pieceType = getEdgePiece(state.terrain, neighborTerrain);
      if (pieceType) {
        pieces.push({ h3, edge, type: pieceType });
      }
    }
  }

  return pieces;
}
```

This rebuild is O(N) where N = total hexes. For 80K hexes: ~480K neighbor lookups, completes in <50ms. Can be optimized to rebuild only affected hexes on local terrain changes.

### Skirt Geometry (Still Needed)

Edge pieces handle the **horizontal transition** between terrain types. Skirts handle the **vertical gap** between different elevation tiers. Both are needed:

- **Edge piece**: visual transition (shore, treeline, cliff texture)
- **Skirt**: structural fill preventing see-through gaps between hexes at different heights

Base tile models still include skirt geometry extending 2 tiers below their surface. The skirts are only visible where there's a significant elevation difference AND the edge piece doesn't fully cover the gap.

### Same-Type Merging Details

For merging to look seamless, base tile models must:

1. **Have matching edge profiles** — the surface height/texture at all 6 edges must be identical across all instances of the same type. This means terrain noise/displacement must fade to a consistent value at hex edges.

2. **Use world-space texturing** — texture coordinates based on world position (triplanar mapping), not model-local UVs. This prevents visible texture seams between adjacent same-type hexes.

3. **Match material properties exactly** — same roughness, color, normal map at the boundary.

```typescript
// In the procedural terrain mesh generator:
function terrainNoise(x: number, z: number, type: TerrainType): number {
  const distFromCenter = Math.sqrt(x*x + z*z) / HEX_RADIUS;
  const centerNoise = fbm(x, z, type.noiseProfile);

  // Fade displacement to zero near hex edges → seamless same-type tiling
  const edgeFade = smoothstep(0.7, 1.0, distFromCenter);
  return centerNoise * (1 - edgeFade);
}
```

This ensures the hex edge is always at a consistent height, so adjacent same-type hexes connect perfectly. The terrain variation (bumps, dunes, mounds) only appears in the center ~70% of each hex.

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
