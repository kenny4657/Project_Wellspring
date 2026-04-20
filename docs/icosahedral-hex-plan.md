# Icosahedral Hex Globe — Adaptation Plan

## Reference: [ardazishvili/Sota](https://github.com/ardazishvili/Sota) (C++/Godot 4)

## Why This Approach

Our current approach — placing flat hex tiles tangent to a sphere via instance matrices — fundamentally cannot tile without gaps or z-fighting overlap. Sota solves this by **projecting hex vertices directly onto the sphere surface** via icosahedral subdivision. The hexes curve with the sphere — no gaps, no overlap, no z-fighting.

---

## How Sota Works

### Step 1: Icosahedron Base
Start with a regular icosahedron (12 vertices, 20 equilateral triangular faces). Each face is a flat equilateral triangle.

### Step 2: Hex Grid Per Triangle
For each of the 20 triangular faces, lay out a 2D hex grid (flat-top hexagons in axial rows). The `patch_resolution` parameter controls how many hexes fit inside each triangle. Each hex has a center point and 6 corner points in 2D space within the triangle.

### Step 3: Barycentric → Sphere Projection
Each 2D point (hex center or corner) is converted to 3D sphere coordinates:
1. Compute **barycentric coordinates** (l1, l2, l3) of the 2D point within the triangle
2. Use **spherical linear interpolation (slerp)** to map to the sphere surface:
   ```
   p12 = slerp(vertex1, vertex2, l2/(l1+l2))
   result = slerp(p12, vertex3, l3)
   ```
3. The result is a point on the unit sphere

This means hex corners follow the sphere curvature — they're not flat tiles placed on top.

### Step 4: Deduplication
Hexes from adjacent icosahedron triangles share edges. To prevent duplicate vertices, hex centers are quantized to a discrete grid (`VertexToNormalDiscretizer`) and looked up in a map. If a hex at that position already exists, its corner points are merged.

### Step 5: Pentagon Handling
At the 12 icosahedron vertices, hexes degenerate into pentagons (5 sides instead of 6). The code explicitly detects these positions and creates `Pentagon` objects instead of `Hexagon` objects.

### Step 6: Terrain Heights (Prism Mode)
Each hex gets a height offset based on its biome (WATER=0, PLAIN=0.02, HILL=0.07, MOUNTAIN=0.15). The vertex offset is **radial** (along the normalized position vector), creating a natural elevation on the sphere:
```cpp
vertex += vertex.normalized() * height;
```
Side faces (prism walls) are added between the base hex corners and the raised top face.

### Step 7: Biome Shader
The fragment shader determines biome by measuring vertex distance from sphere center:
```glsl
float h = (distance_from_center - bottom_offset) / amplitude;
if (h < 0) color = water_texture;
else if (h < hill_ratio) color = mix(plain_texture, hill_texture, h * scale);
else color = mix(hill_texture, mountain_texture, (h - hill_ratio) * scale);
```

---

## Adaptation for Babylon.js

### What Changes

| Current | New |
|---------|-----|
| H3 grid → flat hex tiles positioned by instance matrices | Icosahedral subdivision → curved hex vertices on sphere |
| `CreateGround` mesh clipped to hex | Each hex is its own mesh with vertices on sphere surface |
| Thin instances (one shared mesh for all hexes) | Single merged mesh for entire globe (all hexes baked in) |
| Per-instance `terrainData` attributes | Per-vertex terrain data via vertex colors or UV channels |
| `latLngToCell` for picking | Ray-sphere intersection → find nearest hex center |

### What Stays

- Babylon.js 9.0 + SvelteKit
- GeospatialCamera for orbit/zoom
- CustomMaterial for shader injection
- Terrain type system (17 types, biome colors)
- Click-to-paint interaction
- Atmosphere (re-enable later)

### Architecture

```
src/lib/engine/
├── globe.ts              # Scene, camera, lights (KEEP)
├── icosphere.ts          # NEW: icosahedral hex grid generation
├── globe-mesh.ts         # NEW: builds merged Babylon mesh from hex data
├── terrain-material.ts   # UPDATE: biome shader (height-based texture blend)
├── picking.ts            # UPDATE: ray-sphere → nearest hex center
└── hex-renderer.ts       # REMOVE: thin instances no longer used
```

### Implementation Steps

#### Step 1: Icosahedral Hex Grid Generation (`icosphere.ts`)

Port Sota's `calculate_shapes()` to TypeScript:

```typescript
interface HexCell {
  id: number;
  center: Vector3;       // position on unit sphere
  corners: Vector3[];    // 5 or 6 corner positions on unit sphere  
  neighbors: number[];   // IDs of adjacent cells
  terrain: TerrainTypeId;
  isPentagon: boolean;
}

function generateIcoHexGrid(resolution: number): HexCell[] {
  // 1. Generate icosahedron (12 vertices, 20 triangles)
  // 2. For each triangle, lay 2D hex grid
  // 3. Map each hex center + corners to sphere via barycentric + slerp
  // 4. Deduplicate shared hexes at triangle boundaries
  // 5. Return array of HexCells
}
```

Key functions to port:
- `ico_points()` → 12 icosahedron vertices
- `ico_indices()` → 20 triangle face indices
- `barycentric(point)` → barycentric coordinates
- `map2d_to_3d(point, v1, v2, v3)` → sphere projection via slerp
- Pentagon detection at icosahedron vertices

**Resolution → hex count:**
- Resolution 5: ~500 hexes
- Resolution 10: ~2,000 hexes
- Resolution 20: ~8,000 hexes
- Resolution 30: ~18,000 hexes
- Resolution 40: ~32,000 hexes

#### Step 2: Globe Mesh Builder (`globe-mesh.ts`)

Build a single Babylon.js `Mesh` containing all hex faces:

```typescript
function buildGlobeMesh(cells: HexCell[], radius: number, scene: Scene): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];  // per-vertex terrain color

  for (const cell of cells) {
    const centerIdx = positions.length / 3;
    // Add center vertex
    const pos = cell.center.scale(radius);
    positions.push(pos.x, pos.y, pos.z);
    normals.push(cell.center.x, cell.center.y, cell.center.z);
    colors.push(...terrainColor(cell.terrain), 1.0);

    // Add corner vertices
    for (const corner of cell.corners) {
      const cp = corner.scale(radius);
      positions.push(cp.x, cp.y, cp.z);
      normals.push(corner.x, corner.y, corner.z);
      colors.push(...terrainColor(cell.terrain), 1.0);
    }

    // Triangulate: center → corner[i] → corner[i+1]
    const n = cell.corners.length;
    for (let i = 0; i < n; i++) {
      indices.push(centerIdx, centerIdx + 1 + i, centerIdx + 1 + (i + 1) % n);
    }
  }

  // Build single Babylon mesh
  const mesh = new Mesh('globe', scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.colors = colors;
  vertexData.applyToMesh(mesh);
  return mesh;
}
```

Advantages of single merged mesh:
- **Zero z-fighting** — no overlapping geometry
- **Zero gaps** — vertices are shared at hex boundaries
- **1 draw call** for entire globe
- **No thin instances** — simpler, more reliable

#### Step 3: Terrain Material (`terrain-material.ts`)

Update CustomMaterial to use Sota's height-based biome blending:

```glsl
// Fragment shader injection
float dist = length(vPositionW);  // distance from origin
float h = (dist - planetRadius) / heightRange;

if (h < waterLevel) {
    diffuseColor = waterColor;
} else if (h < hillLevel) {
    diffuseColor = mix(plainColor, hillColor, (h - waterLevel) / (hillLevel - waterLevel));
} else {
    diffuseColor = mix(hillColor, mountainColor, (h - hillLevel) / (1.0 - hillLevel));
}
```

For now use per-vertex colors (from the mesh builder). Later add biome textures.

#### Step 4: Terrain Painting

When the user paints a hex:
1. Ray-sphere intersection → find click point on sphere
2. Find nearest `HexCell.center` to the click point
3. Update the cell's terrain type
4. Rebuild the affected vertex colors in the mesh
5. Update the vertex buffer

#### Step 5: Prism Heights (Elevation)

For terrain with height (hills, mountains):
- Offset hex center + corner vertices radially: `vertex += vertex.normalized() * height`
- Add side face triangles between base corners and raised top corners
- Creates visible cliff walls between different elevation tiers

---

## Hex Count Comparison

| Approach | Resolution | Hex Count | Draw Calls |
|----------|-----------|-----------|------------|
| Current (H3 res 3) | - | 41,162 | 1 (thin instances) |
| Icosphere res 20 | 20 | ~8,000 | 1 (merged mesh) |
| Icosphere res 30 | 30 | ~18,000 | 1 (merged mesh) |
| Icosphere res 40 | 40 | ~32,000 | 1 (merged mesh) |

Start with resolution 20-30 for development. Scale up once rendering is solid.

---

## What We Lose

- **H3 library dependency** — no longer needed (grid is icosahedral, not H3)
- **Thin instance system** — replaced by merged mesh
- **`latLngToCell` picking** — replaced by nearest-center search

## What We Gain

- **Zero tiling artifacts** — hexes are part of the sphere geometry
- **Proper terrain elevation** — radial vertex offset, cliff walls
- **Biome-based shading** — height determines terrain appearance
- **Pentagon handling** — 12 pentagons at icosahedron vertices (can be ocean)
- **Much simpler architecture** — one mesh, one material, no instance buffer management
