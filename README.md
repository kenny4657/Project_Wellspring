# Country Painter

Interactive hex-based country/province border editor for historical map-making.

Uses H3 resolution 4 hexes (~45km) to paint provinces and assign them to countries.
Built with SvelteKit, MapLibre GL JS (custom fork with stencil clipping), and Natural Earth data.

## Features

- **Province mode**: Create provinces and paint individual hexes into them
- **Country mode**: Assign entire provinces to countries with one click
- **Pick tool**: Click a hex to select its province or country
- **Reference overlays**: Modern country borders, admin-1 states/provinces
- **Stencil-based clipping**: Hex fill is clipped to land polygons via a forked MapLibre
- **Export/Import**: Save your work via File System Access API (overwrites same file)

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173 — that's it.

The MapLibre fork is vendored in `vendor/maplibre-gl/` with pre-built
`dist/maplibre-gl.js` ready to use. No external dependencies needed.

## Rebuilding the MapLibre Fork

If you modify `vendor/maplibre-gl/src/`, rebuild with:

```bash
cd vendor/maplibre-gl
npm install  # first time only
npm run build-prod
npm run build-css
cd ../..
rm -rf node_modules/.vite  # clear Vite cache
npm run dev
```

See `vendor/maplibre-gl/FORK_CHANGES.md` for what's modified from upstream v5.22.0.

## Data Files

Located in `static/data/`:
- `countries-10m.json` — Natural Earth countries (TopoJSON)
- `waterways-10m.json` — Rivers and lakes (TopoJSON)
- `states-10m.json` — Admin-1 states/provinces (TopoJSON, reference overlay)
- `land-hexes-r4.json` — Pre-generated H3 res 4 land hexes with coastal clip data

The hex cache is ~9MB. If missing, the API endpoint will regenerate it (~20 minutes).
Delete the file to force regeneration.

## Architecture

See `docs/COUNTRY_PAINTER_LEARNINGS.md` for detailed architecture, pitfalls, and technical decisions.
