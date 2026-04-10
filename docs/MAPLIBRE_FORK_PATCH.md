# MapLibre GL JS Fork — Oceanliners Changes

## Overview

Forked from MapLibre GL JS v5.22.0 to add **stencil-based fill clipping** — a fill layer can be clipped to only render inside another fill layer's polygon area (e.g., hex country fill clipped to land polygons).

## The Problem

MapLibre has no native polygon clipping/masking. Country hex fills extend past coastlines into the ocean. The `land` GeoJSON object from Natural Earth has an 81K-vertex ring that causes rendering artifacts on globe projection, making GeoJSON-based ocean masks unreliable.

## The Solution: Stencil Bit 7

Uses bit 7 of the 8-bit stencil buffer as a "land mask". MapLibre already uses bits 0-6 for tile clipping (preventing overdraw at tile boundaries). Bit 7 is unused and reserved for our clip mask.

### How It Works

1. A fill layer marked as `isClipMaskSource = true` writes stencil bit 7 as it renders (same shader, same triangles — pixel-perfect alignment)
2. A fill layer with `clipToSource = '<source-id>'` only renders where bit 7 is set
3. The stencil bit is written/tested alongside normal tile clipping

### Render Flow Per Frame

```
clearStencil()              → all 8 bits cleared to 0
  ↓
Translucent pass:
  land-fill layer renders:
    _renderTileClippingMasks  → writes tile refs to bits 0-6 (mask 0x7F)
    drawFill with isClipMaskSource:
      stencilModeForClipMaskWrite → writes bit 7 (0x80) on every rendered pixel
      (uses gl.ALWAYS — no tile ref check needed for the write)
  ↓
  hex-fill layer renders:
    _renderTileClippingMasks  → writes hex tile refs to bits 0-6
    drawFill with clipToSource:
      stencilModeForClippingWithLandMask → tests (stencil & 0xFF) == (hexTileRef | 0x80)
      Only pixels where BOTH tile clipping AND land mask pass are rendered
```

## Files Modified

### `src/style/style_layer/fill_style_layer.ts`

Added two runtime properties to `FillStyleLayer`:

```typescript
/** When set, this fill layer will only render pixels inside the specified source's polygons */
clipToSource: string | null = null;

/** When true, this fill layer writes stencil bit 7 as it renders — making it a clip mask source */
isClipMaskSource: boolean = false;
```

These are NOT style spec properties — they're set programmatically at runtime:

```javascript
const landLayer = map.style._layers['land-fill'];
landLayer.isClipMaskSource = true;

const hexLayer = map.style._layers['hex-fill'];
hexLayer.clipToSource = 'land';
```

### `src/render/painter.ts`

**Added fields:**
- `_landClipMaskRendered: boolean` — guards against redundant clip mask rendering per frame

**Modified `clearStencil()`:**
- Resets `_landClipMaskRendered = false` each frame

**Modified `_renderTileClippingMasks()`:**
- Changed stencil write mask from `0xFF` to `0x7F` (only writes bits 0-6, preserves bit 7)
- Changed overflow threshold from `256` to `128` (tile IDs now use 7 bits max)

**Modified `stencilModeForClipping()`:**
- Changed test mask from `0xFF` to `0x7F` (only tests bits 0-6)

**Added `stencilModeForClipMaskWrite()`:**
```typescript
// Unconditionally writes bit 7 on every pixel the fill renders
stencilModeForClipMaskWrite(_tileID): StencilMode {
    return new StencilMode({func: gl.ALWAYS, mask: 0}, 0x80, 0x80, gl.KEEP, gl.KEEP, gl.REPLACE);
}
```

**Added `stencilModeForClippingWithLandMask()`:**
```typescript
// Tests both tile clipping (bits 0-6) AND land mask (bit 7)
stencilModeForClippingWithLandMask(tileID): StencilMode {
    const tileRef = this._tileClippingMaskIDs[tileID.key];
    return new StencilMode({func: gl.EQUAL, mask: 0xFF}, tileRef | 0x80, 0x00, gl.KEEP, gl.KEEP, gl.REPLACE);
}
```

**Added `renderLandClipMask()`:**
- Legacy method (no longer used) — originally rendered a separate stencil pass.
- Replaced by `isClipMaskSource` approach where the land fill writes bit 7 during its own rendering.

### `src/render/draw_fill.ts`

**Modified `drawFill()`:**
- Skip opacity-zero early return if `layer.isClipMaskSource` (clip mask layers with opacity 0 must still render to write stencil)

**Modified `drawFillTiles()`:**
- Stencil mode selection based on layer flags:
  ```typescript
  if (layer.isClipMaskSource) {
      stencil = painter.stencilModeForClipMaskWrite(coord);
  } else if (layer.clipToSource) {
      stencil = painter.stencilModeForClippingWithLandMask(coord);
  } else {
      stencil = painter.stencilModeForClipping(coord);
  }
  ```

## Usage in the Editor

```javascript
// Land fill layer — writes stencil bit 7
map.addSource('land', { type: 'geojson', data: countriesGeo });
map.addLayer({
    id: 'land-fill', type: 'fill', source: 'land',
    paint: { 'fill-color': '#D4C9B8', 'fill-opacity': 0.999 }
    // opacity < 1 forces translucent pass — same pass as hex fill
});
map.style._layers['land-fill'].isClipMaskSource = true;

// Hex fill layer — clipped to land
map.addLayer({
    id: 'hex-fill', type: 'fill', source: 'hexes',
    paint: { 'fill-color': ['feature-state', 'fill'], 'fill-opacity': 0.85 }
});
map.style._layers['hex-fill'].clipToSource = 'land';
```

## Important Notes

1. **Opacity 0.999**: The land fill must render in the translucent pass (same as hex fill) so stencil bit 7 is written before the hex fill reads it. Setting opacity < 1 forces this.

2. **Stencil budget**: Tile IDs now use bits 0-6 (max 127 IDs vs original 255). With typical GeoJSON sources creating <20 tiles, this is not a practical limitation.

3. **Globe projection**: The stencil approach works on globe because it operates at the pixel level after projection. The same triangles that render the fill also write the stencil — projection is handled identically.

4. **No style spec changes**: The properties are runtime-only, avoiding any style validation or serialization changes.

## Building

```bash
cd /Users/kennethmei/maplibre-fork
npm install
npm run build-prod   # produces dist/maplibre-gl.js
npm run build-css    # produces dist/maplibre-gl.css
```

Link into the game project:
```bash
rm -rf /path/to/game/node_modules/maplibre-gl
ln -s /Users/kennethmei/maplibre-fork /path/to/game/node_modules/maplibre-gl
rm -rf /path/to/game/node_modules/.vite  # clear Vite cache
```
