# Terrain Rendering Plan

## Reference Implementation

Adapted from [Bunkerbewohner/threejs-hex-map](https://github.com/Bunkerbewohner/threejs-hex-map) (MIT license).

## Core Techniques

### 1. Texture Atlas (terrain.png)

Instead of solid colors, each terrain type maps to a 256x256 region of a 1024x1024 texture atlas. The fragment shader samples the atlas based on terrain type index. This gives each terrain photographic/painted texture detail — grass has grass blades, desert has sand grain, ocean has water patterns.

```
terrain.png (1024x1024)
┌────────┬────────┬────────┬────────┐
│ ocean  │ coast  │ snow   │        │
│ (0,0)  │ (1,0)  │ (2,0)  │        │
├────────┼────────┼────────┼────────┤
│ plains │ grass  │ desert │        │
│ (0,1)  │ (1,1)  │ (2,1)  │        │
├────────┼────────┼────────┼────────┤
│ tundra │ mount  │        │        │
│ (0,2)  │ (1,2)  │        │        │
└────────┴────────┴────────┴────────┘
Each cell: 256x256 pixels
```

### 2. Transition Blend Masks (transitions.png)

Smooth blending between adjacent terrain types uses pre-painted blend masks. There are 6 masks — one per hex edge direction (NE, E, SE, SW, W, NW). Each mask is a grayscale gradient that fades from 0 (keep this terrain) to 1 (show neighbor terrain) along one hex edge.

The fragment shader calls `terrainTransition()` for each of the 6 neighbors:
```glsl
vec4 terrainTransition(vec4 inputColor, float neighborTerrainIdx, float sector) {
    vec2 neighborUV = cellIndexToUV(neighborTerrainIdx);
    vec2 blendMaskUV = vec2(sector/6.0 + vUV.x/6.0, 1.0 - vUV.y/6.0);
    vec4 neighborColor = texture2D(terrainAtlas, neighborUV);
    vec4 blendMask = texture2D(transitionTexture, blendMaskUV);
    float alpha = min(blendMask.r, clamp(neighborTerrainIdx - myTerrainIdx, 0.0, 1.0));
    return mix(inputColor, neighborColor, alpha);
}
```

### 3. Normal Maps (hills-normal.png)

Hill terrain types get a normal map applied in the fragment shader. This adds visual bumps/undulation without any vertex displacement — the geometry stays flat but the lighting makes it look 3D. The normal map fades out near hex edges (`mix(normal, flatNormal, border^3)`) so it blends smoothly with neighbors.

### 4. Coast Atlas (coast-diffuse.png)

Coastlines (where water meets land) use a 64-variation atlas. The variation is computed from a 6-bit bitmask of which neighbors are water:
```
NE|E|SE|SW|W|NW → 0b000000 to 0b111111 → index 0-63
```

Each variation is a pre-painted coastline piece with alpha transparency, laid over the base terrain texture. The atlas is arranged as 8x8 grid (64 cells).

### 5. Mountain Elevation

Mountain hexes are rendered as a **separate instanced mesh** with vertex displacement:
```glsl
if (border < 0.95) {
    pos.z = 0.2 + (0.5 + sin(uv.s + pos.s * 2.0) * 0.5) * 0.5;
}
```
This creates a wavy, undulating peak shape. Mountains have darker ambient lighting (0.08 vs 0.3) and stronger normal mapping for a more dramatic look.

---

## Implementation Steps

### Step 1: Copy Assets from Reference Repo

Copy these MIT-licensed assets:
- `terrain.png` — terrain texture atlas
- `transitions.png` — blend masks
- `hills-normal.png` — normal map for hills
- `coast-diffuse.png` — coastline variations
- `land-atlas.json` — atlas metadata

Place in `static/assets/hex-terrain/`.

### Step 2: Load Textures in Terrain Material

Update `terrain-material.ts`:
- Load all 4 textures via `Texture` constructor
- Add as uniforms to CustomMaterial via `AddUniform`
- Pass `textureAtlasMeta` uniform (width, height, cellSize)

### Step 3: Rewrite Fragment Shader — Texture Atlas Sampling

Replace solid `diffuseColor = tCol` with:
```glsl
vec2 atlasUV = cellIndexToUV(vTerrainType);
vec4 texColor = texture2D(terrainAtlas, atlasUV);
diffuseColor = texColor.rgb;
```

Each terrain type maps to an atlas cell index. The `cellIndexToUV()` function converts terrain index to atlas UV coordinates.

### Step 4: Add Terrain Transition Blending

For each of 6 neighbors, call `terrainTransition()`:
```glsl
texColor = terrainTransition(texColor, vN0, 0.0); // NE
texColor = terrainTransition(texColor, vN1, 1.0); // E
texColor = terrainTransition(texColor, vN2, 2.0); // SE
texColor = terrainTransition(texColor, vN3, 3.0); // SW
texColor = terrainTransition(texColor, vN4, 4.0); // W
texColor = terrainTransition(texColor, vN5, 5.0); // NW
```

This replaces our current `mix(baseColor, neighborColor, edgeBlend)` with proper texture-based blending using painted blend masks.

### Step 5: Add Normal Map for Hills

For hill terrain types, sample `hills-normal.png` and use it in lighting:
```glsl
if (isHill) {
    vec3 normal = normalize(texture2D(hillsNormal, worldUV * scale).xyz * 2.0 - 1.0);
    normal = mix(normal, vec3(0,1,0), border^3); // fade at edges
}
```

### Step 6: Add Coast Overlay

Compute coast bitmask from neighbor water status, lookup in coast atlas:
```glsl
vec2 coastUV = vec2(coastCell.x/8.0 + vUV.x/8.0, 1.0 - (coastCell.y/8.0 + vUV.y/8.0));
vec4 coastColor = texture2D(coastAtlas, coastUV);
if (coastColor.a > 0.0) {
    color = mix(color, coastColor.rgb, coastColor.a);
}
```

### Step 7: Mountain Mesh

- Filter mountain terrain hexes into a separate thin instance group
- Apply vertex displacement in CustomMaterial vertex shader
- Use darker ambient + stronger normal mapping

---

## Terrain Type → Atlas Cell Mapping

| Terrain Type | Atlas Cell Index | Atlas Position |
|-------------|-----------------|----------------|
| ocean/deep_ocean | 0 | (0,0) |
| coast | 1 | (1,0) |
| snow/tundra | 2 | (2,0) |
| plains | 3 | (0,1) |
| grass/grassland | 4 | (1,1) |
| desert | 5 | (2,1) |
| swamp | 6 | (0,2) |
| mountain | 7 | (1,2) |

Additional terrain types (forest, jungle, hills, highland, plateau, lake, reef, island) will need additional atlas cells — either expand the atlas to 2048x2048 or use a second atlas.

---

## Adaptation Notes for Globe

| Flat Map (reference) | Globe (our project) |
|---------------------|---------------------|
| `offset` Vec2 → world XY | Instance matrix 4x4 → globe position + rotation |
| Z = height | Y = height (local up = radial on globe) |
| Fixed up vector (0,0,1) | Up = surface normal (varies per hex) |
| Planar UVs | UVs from hex mesh local coordinates |
| Raycaster for picking | Ray-sphere intersection + H3 lookup |
