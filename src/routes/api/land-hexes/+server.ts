/**
 * API endpoint: Generate H3 resolution 4 land hexes for the Country Painter editor.
 * Uses topo.objects.countries for detection and clipping (matches rendered land fill).
 * Custom edge-bucketed point-in-polygon makes 81K-vertex polygons fast.
 * Results cached to static/data/land-hexes-r4.json.
 */
import { json } from '@sveltejs/kit';
import { getRes0Cells, cellToChildren, cellToLatLng, cellToBoundary, gridDisk } from 'h3-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as topojson from 'topojson-client';
import { polygon as turfPolygon, featureCollection } from '@turf/helpers';
import { intersect as turfIntersect } from '@turf/intersect';

const H3_RESOLUTION = 4;

// ── Edge-bucketed point-in-polygon ─────────────────────────
// Pre-sorts polygon edges into latitude bands. A query only tests
// edges in the same band (~200 instead of 81K). ~300x speedup.

interface Edge { lon1: number; lat1: number; lon2: number; lat2: number; }

const BUCKET_SIZE = 0.5; // degrees per bucket

class FastPolygonTester {
	private buckets = new Map<number, Edge[]>();
	readonly feature: GeoJSON.Feature; // original feature for turf/intersect
	readonly minLon: number;
	readonly maxLon: number;
	readonly minLat: number;
	readonly maxLat: number;

	constructor(coords: number[][][], feature: GeoJSON.Feature) {
		this.feature = feature;
		let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

		for (const ring of coords) {
			for (let i = 0; i < ring.length - 1; i++) {
				const [lon1, lat1] = ring[i];
				const [lon2, lat2] = ring[i + 1];
				if (lon1 < minLon) minLon = lon1;
				if (lon1 > maxLon) maxLon = lon1;
				if (lat1 < minLat) minLat = lat1;
				if (lat1 > maxLat) maxLat = lat1;

				const bMin = Math.floor(Math.min(lat1, lat2) / BUCKET_SIZE);
				const bMax = Math.floor(Math.max(lat1, lat2) / BUCKET_SIZE);
				for (let b = bMin; b <= bMax; b++) {
					if (!this.buckets.has(b)) this.buckets.set(b, []);
					this.buckets.get(b)!.push({ lon1, lat1, lon2, lat2 });
				}
			}
		}
		this.minLon = minLon; this.maxLon = maxLon;
		this.minLat = minLat; this.maxLat = maxLat;
	}

	contains(lon: number, lat: number): boolean {
		if (lon < this.minLon || lon > this.maxLon || lat < this.minLat || lat > this.maxLat)
			return false;
		const bucket = Math.floor(lat / BUCKET_SIZE);
		const edges = this.buckets.get(bucket);
		if (!edges) return false;
		let inside = false;
		for (const { lon1, lat1, lon2, lat2 } of edges) {
			if ((lat1 > lat) !== (lat2 > lat)) {
				const xInt = lon1 + (lat - lat1) / (lat2 - lat1) * (lon2 - lon1);
				if (lon < xInt) inside = !inside;
			}
		}
		return inside;
	}
}

// ── Spatial index ──────────────────────────────────────────

const GRID_SIZE = 2;

function buildSpatialIndex(geo: GeoJSON.FeatureCollection): {
	testers: FastPolygonTester[];
	grid: Map<string, number[]>;
} {
	const testers: FastPolygonTester[] = [];
	const grid = new Map<string, number[]>();

	for (const feature of geo.features) {
		const geom = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
		const polygonCoords = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

		for (const coords of polygonCoords) {
			const idx = testers.length;
			const feat: GeoJSON.Feature = {
				type: 'Feature', properties: {},
				geometry: { type: 'Polygon', coordinates: coords }
			};
			const tester = new FastPolygonTester(coords, feat);
			testers.push(tester);

			const gxMin = Math.floor(tester.minLon / GRID_SIZE);
			const gxMax = Math.floor(tester.maxLon / GRID_SIZE);
			const gyMin = Math.floor(tester.minLat / GRID_SIZE);
			const gyMax = Math.floor(tester.maxLat / GRID_SIZE);
			for (let gx = gxMin; gx <= gxMax; gx++) {
				for (let gy = gyMin; gy <= gyMax; gy++) {
					const key = `${gx},${gy}`;
					if (!grid.has(key)) grid.set(key, []);
					grid.get(key)!.push(idx);
				}
			}
		}
	}

	return { testers, grid };
}

// ── Helpers ────────────────────────────────────────────────

interface LandHex {
	h3: string;
	lat: number;
	lon: number;
	clip?: number[][];
}

function getCachePath(): string {
	return join(process.cwd(), 'static', 'data', 'land-hexes-r4.json');
}

function loadTopoJSON(): any {
	const paths = [
		join(process.cwd(), 'static', 'data', 'countries-10m.json'),
		join(process.cwd(), 'build', 'client', 'data', 'countries-10m.json')
	];
	for (const p of paths) {
		try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { continue; }
	}
	throw new Error('Could not load countries-10m.json');
}

// ── Generation ─────────────────────────────────────────────

function generateLandHexes(): LandHex[] {
	const topo = loadTopoJSON();
	const landGeo = topojson.feature(
		topo, topo.objects.countries
	) as unknown as GeoJSON.FeatureCollection;

	console.log('[Country Painter] Building spatial index...');
	const { testers, grid } = buildSpatialIndex(landGeo);
	console.log(`[Country Painter] Index: ${testers.length} polygons`);

	function isOnLand(lat: number, lon: number): boolean {
		const key = `${Math.floor(lon / GRID_SIZE)},${Math.floor(lat / GRID_SIZE)}`;
		const candidates = grid.get(key);
		if (!candidates) return false;
		for (const idx of candidates) {
			if (testers[idx].contains(lon, lat)) return true;
		}
		return false;
	}

	function findClipCandidates(minLon: number, minLat: number, maxLon: number, maxLat: number): number[] {
		const out = new Set<number>();
		const gxMin = Math.floor(minLon / GRID_SIZE);
		const gxMax = Math.floor(maxLon / GRID_SIZE);
		const gyMin = Math.floor(minLat / GRID_SIZE);
		const gyMax = Math.floor(maxLat / GRID_SIZE);
		for (let gx = gxMin; gx <= gxMax; gx++) {
			for (let gy = gyMin; gy <= gyMax; gy++) {
				const idxs = grid.get(`${gx},${gy}`);
				if (idxs) for (const i of idxs) out.add(i);
			}
		}
		return [...out];
	}

	// ── Phase 1: find land hexes ────────────────────────────────
	console.log(`[Country Painter] Phase 1: finding land hexes...`);
	const res0 = getRes0Cells();
	const allCells = new Set<string>();
	for (const base of res0) {
		for (const child of cellToChildren(base, H3_RESOLUTION)) allCells.add(child);
	}

	const landCells: LandHex[] = [];
	let checked = 0;
	for (const h3Index of allCells) {
		const [lat, lon] = cellToLatLng(h3Index);
		if (isOnLand(lat, lon)) {
			landCells.push({ h3: h3Index, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
		}
		if (++checked % 50000 === 0) {
			console.log(`[Country Painter]   ${checked}/${allCells.size}, found ${landCells.length}`);
		}
	}
	console.log(`[Country Painter] Phase 1: ${landCells.length} land hexes`);

	// ── Phase 2: detect coastal hexes ───────────────────────────
	const landSet = new Set(landCells.map((c) => c.h3));
	const coastalIndices: number[] = [];
	for (let i = 0; i < landCells.length; i++) {
		// Check 1: any neighbor not a land hex
		const neighbors = gridDisk(landCells[i].h3, 1);
		if (neighbors.some((n) => n !== landCells[i].h3 && !landSet.has(n))) {
			coastalIndices.push(i);
			continue;
		}
		// Check 2: any vertex in water
		const boundary = cellToBoundary(landCells[i].h3);
		if (boundary.some(([lat, lon]) => !isOnLand(lat, lon))) {
			coastalIndices.push(i);
		}
	}
	console.log(`[Country Painter] Phase 2: ${coastalIndices.length} coastal, ${landCells.length - coastalIndices.length} interior`);

	// ── Phase 3: clip coastal hexes ─────────────────────────────
	console.log(`[Country Painter] Phase 3: clipping...`);
	let clipped = 0, failed = 0;
	const t0 = Date.now();

	for (const i of coastalIndices) {
		const hex = landCells[i];
		const boundary = cellToBoundary(hex.h3);
		const coords: [number, number][] = boundary.map(([lat, lon]) => [lon, lat] as [number, number]);
		const lons = coords.map((c) => c[0]);
		if (Math.max(...lons) - Math.min(...lons) > 170) continue;

		coords.push(coords[0]);
		const hexPoly = turfPolygon([coords]);

		let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
		for (const [lon, lat] of coords) {
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}

		const candidateIdxs = findClipCandidates(minLon, minLat, maxLon, maxLat);
		const clipRings: number[][][] = [];

		for (const idx of candidateIdxs) {
			const t = testers[idx];
			if (maxLon < t.minLon || minLon > t.maxLon || maxLat < t.minLat || minLat > t.maxLat) continue;
			try {
				const result = turfIntersect(featureCollection([hexPoly, t.feature as any]));
				if (!result) continue;
				const geom = result.geometry;
				if (geom.type === 'Polygon') {
					if (geom.coordinates[0].length >= 4) clipRings.push(geom.coordinates[0]);
				} else if (geom.type === 'MultiPolygon') {
					for (const poly of geom.coordinates) {
						if (poly[0].length >= 4) clipRings.push(poly[0]);
					}
				}
			} catch { /* skip */ }
		}

		if (clipRings.length > 0) {
			// Store as multiClip (array of rings) for hexes that span multiple land polygons
			hex.clip = clipRings[0].map(([lon, lat]: number[]) => [
				Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000
			]);
			if (clipRings.length > 1) {
				(hex as any).multiClip = clipRings.map(ring =>
					ring.map(([lon, lat]: number[]) => [
						Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000
					])
				);
			}
			clipped++;
		} else { failed++; }

		if ((clipped + failed) % 2000 === 0) {
			console.log(`[Country Painter]   ${clipped + failed}/${coastalIndices.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
		}
	}

	console.log(`[Country Painter] Phase 3: ${clipped} clipped, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	return landCells;
}

// ── HTTP handler ───────────────────────────────────────────

export async function GET() {
	const cachePath = getCachePath();

	if (existsSync(cachePath)) {
		try {
			const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
			if (Array.isArray(data) && data.some((d: any) => d.clip)) return json(data);
			console.log('[Country Painter] Cache missing clip data, regenerating...');
		} catch { /* regenerate */ }
	}

	const t0 = Date.now();
	const landCells = generateLandHexes();
	console.log(`[Country Painter] Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	try {
		writeFileSync(cachePath, JSON.stringify(landCells));
		console.log(`[Country Painter] Cached to ${cachePath}`);
	} catch (e) { console.warn('[Country Painter] Cache write failed:', e); }

	return json(landCells);
}
