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

### Shader-Driven Single-Mesh Approach (Recommended)

All hexes share **one subdivided hex mesh template**. Terrain shape, elevation, material, and transitions are handled entirely in the vertex and fragment shaders via per-instance attributes. No separate edge piece geometry. No per-terrain-type mesh groups.

```
Rendering Registry
┌──────────────────┬──────────────┬───────────────┬──────────────────┐
│ Component        │ Source Mesh  │ Instance Count│ Draw Calls       │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ Hex tiles        │ 1 shared     │ 80,000        │ 1                │
│                  │ subdivided   │               │                  │
│                  │ hex mesh     │               │                  │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ Rivers           │ GreasedLine  │ 1 merged mesh │ 1                │
├──────────────────┼──────────────┼───────────────┼──────────────────┤
│ TOTAL            │ 2 meshes     │ ~80,000 inst  │ 2 draw calls     │
└──────────────────┴──────────────┴───────────────┴──────────────────┘
```

2 draw calls for 80K hexes + rivers. At 500K hexes, still 2 draw calls.

### Why This Works

Going fully procedural means the GPU can compute everything that was previously baked into different mesh geometries:

| Pre-made model approach | Shader-driven approach |
|------------------------|----------------------|
| 17 different mesh shapes | 1 mesh, vertex shader selects displacement profile |
| 8 edge piece meshes | Fragment shader blends materials at hex edges |
| ~26 draw calls | 2 draw calls |
| Moving hex between groups on terrain change | Update 7 instance attributes (self + neighbors) |
| Edge piece rebuild on terrain change | No rebuild — shader reads neighbor data per-frame |

### Shared Hex Mesh Template

One hex mesh used by all instances. Subdivided enough for terrain displacement:

```
Subdivision 0:  6 triangles    (~18 vertices)   — flat hex
Subdivision 1:  24 triangles   (~37 vertices)   — gentle bumps
Subdivision 2:  96 triangles   (~61 vertices)   — visible terrain shape  ← target
Subdivision 3:  384 triangles  (~217 vertices)  — detailed terrain
```

**Target: subdivision level 2** (~96 triangles, ~61 vertices per hex)
- 80K hexes × 96 tris = 7.7M triangles — well within budget
- 500K hexes × 96 tris = 48M triangles — feasible, may need LOD

The mesh includes **skirt vertices** extending below the hex footprint (ring of downward-facing triangles at each edge). The vertex shader positions skirts based on the hex's elevation tier.

### Instance Data Per Hex

Each thin instance carries:

| Attribute | Stride | Purpose |
|-----------|--------|---------|
| `matrix` | 16 floats | Position + rotation on globe surface |
| `terrainData` | 8 floats | Terrain type (1) + 6 neighbor types + padding |
| `color` | 4 floats | Province/country tint (RGBA) |

Total per instance: 112 bytes. For 80K hexes: ~9 MB GPU buffer. For 500K: ~56 MB.

```typescript
// Per-instance attribute layout
terrainData[0] = terrainTypeIndex;       // 0-16, indexes into terrain params
terrainData[1] = neighborType_edge0;     // neighbor terrain type for edge 0
terrainData[2] = neighborType_edge1;     // ... edge 1
terrainData[3] = neighborType_edge2;     // ... edge 2
terrainData[4] = neighborType_edge3;     // ... edge 3
terrainData[5] = neighborType_edge4;     // ... edge 4
terrainData[6] = neighborType_edge5;     // ... edge 5
terrainData[7] = 0;                      // padding / future use
```

### Vertex Shader: Terrain Displacement

The vertex shader transforms the flat subdivided hex into terrain-specific geometry:

```glsl
// Terrain parameters table (uniform buffer, one row per terrain type)
// Each row: [tier_height, noise_amplitude, noise_frequency, noise_ridged]
uniform vec4 terrainParams[17];

// Per-instance attributes
attribute float terrainType;
attribute float neighbor0, neighbor1, neighbor2, neighbor3, neighbor4, neighbor5;

void main() {
    vec4 params = terrainParams[int(terrainType)];
    float tierHeight = params.x;
    float amplitude = params.y;
    float frequency = params.z;

    // 1. Compute distance from hex center (0 at center, 1 at edge)
    float distFromCenter = length(localPosition.xz) / HEX_RADIUS;

    // 2. Determine which edge this vertex is nearest to (0-5)
    int nearestEdge = computeNearestEdge(localPosition.xz);
    float neighborType = getNeighborType(nearestEdge); // from instance attributes

    // 3. Terrain noise displacement (only affects Y)
    float noise = fbmNoise(localPosition.xz * frequency, 4); // 4 octaves
    if (params.w > 0.5) noise = ridgedNoise(noise);           // ridged for mountains

    // 4. Edge fade: blend displacement toward neighbor's expected height at edge
    float edgeFade = smoothstep(0.6, 1.0, distFromCenter);
    vec4 neighborParams = terrainParams[int(neighborType)];
    float neighborHeight = neighborParams.x;
    float blendedHeight = mix(
        tierHeight + noise * amplitude,     // this hex's terrain
        (tierHeight + neighborHeight) / 2.0, // meeting height at edge
        edgeFade
    );

    // 5. Apply displacement
    localPosition.y = blendedHeight;

    // 6. Skirt vertices: extend downward
    if (isSkirtVertex) {
        localPosition.y = min(tierHeight, neighborHeight) - SKIRT_DEPTH;
    }
}
```

**Terrain parameter examples:**

| Type | Tier Height | Amplitude | Frequency | Ridged |
|------|------------|-----------|-----------|--------|
| `deep_ocean` | -2.0 | 0.1 | 0.5 | no |
| `shallow_ocean` | -0.5 | 0.05 | 1.0 | no |
| `lake` | -0.3 | 0.02 | 0.5 | no |
| `plains` | 0.0 | 0.1 | 1.0 | no |
| `grassland` | 0.0 | 0.15 | 1.5 | no |
| `desert` | 0.0 | 0.2 | 0.8 | no |
| `hills` | 0.5 | 0.4 | 2.0 | no |
| `forest` | 0.3 | 0.3 | 1.5 | no |
| `highland` | 1.0 | 0.1 | 1.0 | no |
| `mountain` | 2.0 | 1.0 | 3.0 | yes |

### Fragment Shader: Material + Edge Blending

The fragment shader selects the terrain material and blends at edges:

```glsl
// Material table: one set of properties per terrain type
// Encoded in a texture atlas or array texture
uniform sampler2DArray terrainMaterials; // [albedo, normal, roughness] per type

void main() {
    int myType = int(terrainType);
    float distFromCenter = length(localUV) / HEX_RADIUS;
    int nearestEdge = computeNearestEdge(localUV);
    int neighborType = int(getNeighborType(nearestEdge));

    // Sample this hex's material (triplanar mapping for seamless tiling)
    vec4 myColor = triplanarSample(terrainMaterials, myType, worldPos, normal);

    if (myType == neighborType || distFromCenter < 0.6) {
        // Same type or far from edge — pure material, no blending
        fragColor = myColor;
    } else {
        // Different type near edge — blend materials
        vec4 neighborColor = triplanarSample(terrainMaterials, neighborType, worldPos, normal);
        float blend = smoothstep(0.6, 0.95, distFromCenter);
        fragColor = mix(myColor, neighborColor, blend * 0.5);

        // Special transitions
        if (isWaterType(myType) != isWaterType(neighborType)) {
            // Water↔land: add shore foam/sand at the transition
            fragColor = mix(fragColor, shoreColor, blend * 0.7);
        }
    }

    // Apply province/country tint
    fragColor = mix(fragColor, instanceColor, instanceColor.a);
}
```

### Same-Type Merging (Automatic)

When two adjacent hexes share the same terrain type:
- `neighborType == myType` → no edge blending → pure material
- Both hexes' vertex displacement fades to the **same meeting height** at the shared edge
- **World-space triplanar texturing** ensures no texture seam at the boundary
- The hex grid line is completely invisible between same-type hexes
- Multiple lake hexes → continuous flat water surface, no hex boundaries visible

### Terrain Type Change

When a hex changes terrain type (e.g., plains → mountain):

```typescript
function setHexTerrain(h3: string, newTerrain: TerrainType): void {
  const index = hexBufferIndex[h3];

  // 1. Update this hex's terrain type
  terrainData[index * 8] = TERRAIN_INDEX[newTerrain];

  // 2. Update all 6 neighbors' neighbor data (they now border a different type)
  const neighbors = gridDisk(h3, 1).filter(n => n !== h3);
  for (let edge = 0; edge < 6; edge++) {
    const neighborIndex = hexBufferIndex[neighbors[edge]];
    if (neighborIndex !== undefined) {
      const oppositeEdge = (edge + 3) % 6; // neighbor's edge facing us
      terrainData[neighborIndex * 8 + 1 + oppositeEdge] = TERRAIN_INDEX[newTerrain];
    }
  }

  // 3. Upload changed region of buffer
  mesh.thinInstanceBufferUpdated("terrainData");
}
```

This is **O(1) per hex** — update 7 values in the buffer (1 self + 6 neighbors), no mesh rebuild, no group switching. The shader handles the visual change next frame automatically.

### Babylon.js Implementation: Node Material

The terrain shader is built using Babylon's **Node Material Editor** (NME), which provides:

- Custom instance attribute inputs (`terrainData`, `color`)
- Noise generation blocks (`SimplexPerlin3DBlock`)
- Texture array sampling
- Triplanar mapping blocks
- Visual shader graph — no raw GLSL needed
- Works with both WebGL2 and WebGPU

The Node Material is created once and assigned to the shared hex mesh. All terrain logic lives in the shader graph.

### Comparison: Per-Type Models vs. Shader-Driven

| Concern | Per-type models (previous) | Shader-driven (recommended) |
|---------|--------------------------|---------------------------|
| Draw calls | ~26 | 2 |
| Terrain change | Move between groups, rebuild edges | Update 7 floats in buffer |
| Edge transitions | Separate geometry, rebuild needed | Automatic via shader |
| Same-type merging | Edge pieces omitted between same type | Automatic — no edge = no blend |
| Visual variety | Each type has unique geometry | Displacement profiles per type |
| Silhouette distinctiveness | High (dedicated mesh per type) | Medium-high (noise-driven peaks) |
| Asset pipeline | Model each type (Blender or procedural) | Tune parameters per type |
| Iteration speed | Slow (rebuild meshes) | Fast (tweak uniforms in real-time) |
| Complexity | Engine-side (buffer management) | Shader-side (Node Material graph) |
| GPU memory | ~14 MB (26 groups × buffers) | ~9 MB (1 group × buffer) |

**Main tradeoff**: shader-driven terrain has slightly less silhouette control than dedicated models. A mountain won't have an artist-sculpted peak — it'll have a noise-displaced peak driven by parameters. At 45km hexes viewed from orbit, this is more than sufficient. If close-up detail matters later, individual terrain types can be given more sophisticated noise profiles or even replaced with authored meshes (the per-type group approach can be mixed in for specific types).

---

## Shared Hex Mesh Specification

### Geometry

One subdivided hex mesh used by all instances. The vertex shader transforms it into terrain-specific shapes.

- **Hex footprint**: regular hexagon, flat-top orientation, inscribed radius matching H3 cell size
- **Origin**: center of hex base, Y=0 at the base plane
- **Orientation**: flat edge faces +Z in model space
- **Subdivision level 2**: ~96 triangles, ~61 vertices per hex (target)
  - 80K hexes × 96 tris = 7.7M triangles — well within budget
  - 500K hexes × 96 tris = 48M triangles — feasible with LOD
- **Skirt ring**: additional ring of downward-facing triangles at each hex edge (~12 extra triangles). Vertex shader positions them based on neighbor elevation.

### Mesh Generation

```typescript
function createSharedHexMesh(scene: Scene): Mesh {
  // Create a flat hex disc with enough subdivision for displacement
  const hex = MeshBuilder.CreateDisc("hexTemplate", {
    radius: HEX_RADIUS,
    tessellation: 6,        // hexagonal shape
    sideOrientation: Mesh.DOUBLESIDE,
  }, scene);

  // Subdivide twice for ~96 triangles on the top face
  // (or build custom geometry with concentric hex rings of vertices)

  // Add skirt vertices: duplicate each edge vertex, offset downward
  // These will be positioned by the vertex shader based on neighbor data

  return hex;
}
```

The mesh is created once at initialization. All 80K+ thin instances share this single mesh. Terrain differentiation happens entirely in the shader.

### Terrain Parameter Tuning

Instead of modeling each terrain type, you tune a **parameter table**:

```typescript
const TERRAIN_PARAMS: Record<TerrainType, TerrainProfile> = {
  deep_ocean:    { tier: 0, height: -2.0, amplitude: 0.1,  frequency: 0.5, ridged: false },
  shallow_ocean: { tier: 1, height: -0.5, amplitude: 0.05, frequency: 1.0, ridged: false },
  lake:          { tier: 1, height: -0.3, amplitude: 0.02, frequency: 0.5, ridged: false },
  plains:        { tier: 2, height:  0.0, amplitude: 0.1,  frequency: 1.0, ridged: false },
  desert:        { tier: 2, height:  0.0, amplitude: 0.2,  frequency: 0.8, ridged: false },
  forest:        { tier: 3, height:  0.3, amplitude: 0.3,  frequency: 1.5, ridged: false },
  hills:         { tier: 3, height:  0.5, amplitude: 0.4,  frequency: 2.0, ridged: false },
  mountain:      { tier: 5, height:  2.0, amplitude: 1.0,  frequency: 3.0, ridged: true  },
  // ... etc
};
```

Iteration is instant — change a number, see the result next frame. No mesh rebuilding, no asset pipeline. Expose these in a dev UI for live tuning.

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

The fundamental challenge: a lake hex surrounded by other lakes should look like one continuous body of water (no visible hex grid), while a lake hex bordered by mountains needs a visible shore transition.

The shader-driven approach solves both automatically:

### Same-Type Merging (Automatic)

When the fragment shader detects `neighborType == myType`:
- No edge blending is applied → pure material
- Both hexes' vertex displacement fades to the **same meeting height** at the shared edge
- World-space triplanar texturing ensures no texture seam at the boundary
- **The hex grid line is completely invisible** between same-type hexes
- Multiple lake hexes → continuous flat water surface

```
Three lake hexes + one plains hex:

    ┌─────────┐
    │  LAKE   │         ← flat water surface
    │         │
    ├─ ─ ─ ─ ┤         ← same type: shader applies no blend → seamless
    │  LAKE   │
    │         │
    ├─ ─ ─ ─ ┤         ← same type: seamless
    │  LAKE   │
    │      ≈≈≈│shore    ← different type: shader blends lake→plains material
    ├─────────┤            + vertex displacement meets at shared edge height
    │ PLAINS  │
    │         │
    └─────────┘
```

### Different-Type Transitions (Shader-Driven)

When `neighborType != myType`, the shader applies contextual blending near the hex edge:

| Transition | Vertex Behavior | Fragment Behavior |
|------------|----------------|-------------------|
| Water ↔ Land | Heights meet at a "shore height" midpoint | Blend water→sand→grass, add foam |
| Low ↔ High land (2+ tiers) | Sharp height difference, cliff-like | Blend in rock/cliff material at transition |
| Adjacent land (1 tier) | Gradual slope at edge | Smooth material blend |
| Open ↔ Forest | Slight height increase toward forest | Blend grass→undergrowth→canopy color |
| Any ↔ Tundra | Heights meet normally | Blend in frost/ice texture |
| Any ↔ Desert | Heights meet normally | Blend in sand texture |

The transition type is determined implicitly from the terrain parameters — no lookup table needed. The shader computes height difference and terrain category (water vs land) from the uniform `terrainParams` table.

### Edge Height Meeting Point

When two hexes of different types share an edge, their vertex displacement must agree on a shared height at the boundary. The vertex shader blends:

```
Meeting height = average of both terrains' tier heights

Edge 0.6-1.0 of hex → lerp from (tier_height + noise) toward meeting_height
```

This creates natural slopes, shores, and cliffs without any explicit transition geometry:
- Lake (tier 1, height -0.3) next to plains (tier 2, height 0.0) → meeting at -0.15 → gentle shore slope
- Plains (tier 2, height 0.0) next to mountain (tier 5, height 2.0) → meeting at 1.0 → dramatic cliff face
- Mountain skirt vertices extend down to plains height → visible rock wall

### Skirt Vertices

The shared hex mesh includes a ring of skirt vertices at each edge. The vertex shader positions these based on neighbor terrain:

```glsl
if (isSkirtVertex) {
    // Extend downward to the lower of the two terrains
    float neighborHeight = terrainParams[int(neighborType)].x;
    localPosition.y = min(tierHeight, neighborHeight) - SKIRT_DEPTH;
}
```

Skirts are only visible where there's a significant elevation difference between neighbors. Between same-height hexes, skirts are hidden below the surface.

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
