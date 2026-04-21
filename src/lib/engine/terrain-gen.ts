/**
 * Procedural terrain generation.
 * Assigns BOTH terrain type AND height level to each hex cell.
 * These are independent: a grassland can be at height 1 or 3,
 * a mountain can be at height 4 or 5.
 */
import type { HexCell } from './icosphere';

function hash3(ix: number, iy: number, iz: number): number {
	let h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) | 0;
	h = ((h ^ (h >>> 13)) * 1274126177) | 0;
	return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

function noise3d(x: number, y: number, z: number): number {
	const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
	const fx = smoothstep(x - ix), fy = smoothstep(y - iy), fz = smoothstep(z - iz);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	return lerp(
		lerp(lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx),
			lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
		lerp(lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx),
			lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
		fz
	);
}

function fbm(x: number, y: number, z: number, octaves: number): number {
	let val = 0, amp = 1, max = 0;
	for (let i = 0; i < octaves; i++) {
		val += noise3d(x, y, z) * amp; max += amp;
		x *= 2; y *= 2; z *= 2; amp *= 0.5;
	}
	return val / max;
}

/**
 * Assign terrain type and height level to each cell.
 *
 * Height level (0-5) is driven by a "continent" noise field — this determines
 * the physical elevation. Terrain type is influenced by height but also by
 * separate detail noise, so the same height level can have different terrain types.
 *
 * Height levels:
 *   0 = deep water, 1 = shallow water, 2 = lowland, 3 = midland, 4 = highland, 5 = peak
 */
export function assignTerrain(cells: HexCell[]): void {
	const CS = 2.8;  // continent noise scale
	const DS = 7.0;  // detail noise scale

	for (const cell of cells) {
		const { x, y, z } = cell.center;

		// Continent noise determines height level (elevation)
		const continent = fbm(x * CS, y * CS, z * CS, 5);
		const detail = fbm(x * DS + 100, y * DS + 100, z * DS + 100, 3);
		const latitude = Math.abs(y);

		// ── Height level (0-5) from continent noise ─────────
		let heightLevel: number;
		if (continent < 0.38) heightLevel = 0;       // deep water
		else if (continent < 0.44) heightLevel = 1;   // shallow water
		else if (continent < 0.52) heightLevel = 2;   // lowland
		else if (continent < 0.62) heightLevel = 3;   // midland
		else if (continent < 0.74) heightLevel = 4;   // highland
		else heightLevel = 5;                          // peak

		// ── Terrain type (independent of height) ────────────
		let t: number;
		if (heightLevel <= 1) {
			// Water hexes: terrain type by depth
			t = heightLevel === 0 ? 0 : 1; // deep_ocean / shallow_ocean
		} else {
			// Land hexes: terrain type by biome factors (latitude, detail noise)
			if (latitude > 0.82) {
				t = 8; // tundra
			} else if (detail < 0.35) {
				t = 6; // desert
			} else if (detail < 0.48) {
				t = 4; // plains
			} else if (detail < 0.58) {
				t = 5; // grassland
			} else if (detail > 0.6) {
				t = 9; // hills
			} else {
				t = 5; // grassland
			}

			// High terrain gets special types
			if (heightLevel >= 4 && detail < 0.4) t = 10; // highland
			if (heightLevel >= 5) t = 11; // mountain (only at peak elevation)
		}

		cell.terrain = t;
		cell.heightLevel = heightLevel;
	}
}
