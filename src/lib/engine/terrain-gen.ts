/**
 * Procedural terrain generation using 3D value noise.
 * Assigns terrain types to hex cells based on continent/elevation maps.
 */
import type { HexCell } from './icosphere';

function hash3(ix: number, iy: number, iz: number): number {
	let h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) | 0;
	h = ((h ^ (h >>> 13)) * 1274126177) | 0;
	return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number {
	return t * t * (3 - 2 * t);
}

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
		val += noise3d(x, y, z) * amp;
		max += amp;
		x *= 2; y *= 2; z *= 2;
		amp *= 0.5;
	}
	return val / max;
}

/**
 * Assign terrain types to cells using procedural noise.
 * Creates oceans, continents, and biome variation.
 *
 * Terrain indices match TERRAIN_TYPES in terrain-types.ts:
 *  0=deep_ocean 1=shallow 2=reef 3=coast 4=lake
 *  5=plains 6=grassland 7=desert 8=swamp 9=tundra
 * 10=forest 11=jungle 12=hills 13=highland 14=plateau
 * 15=mountain 16=island
 */
export function assignTerrain(cells: HexCell[]): void {
	const CS = 2.8;  // continent noise scale
	const DS = 7.0;  // detail noise scale

	for (const cell of cells) {
		const { x, y, z } = cell.center;
		const continent = fbm(x * CS, y * CS, z * CS, 5);
		const detail = fbm(x * DS + 100, y * DS + 100, z * DS + 100, 3);
		const latitude = Math.abs(y); // 0 at equator, ~1 at poles

		let t: number;

		if (continent < 0.38) {
			t = 0; // deep_ocean
		} else if (continent < 0.44) {
			t = 1; // shallow_ocean
		} else if (continent < 0.47) {
			t = 3; // coast
		} else {
			const elev = continent + detail * 0.12;

			if (latitude > 0.82) {
				t = 9; // tundra
			} else if (elev < 0.56) {
				t = detail < 0.4 ? 7 : detail < 0.55 ? 5 : 6; // desert / plains / grassland
			} else if (elev < 0.64) {
				t = (latitude < 0.6 && detail > 0.55) ? 11 : 10; // jungle / forest
			} else if (elev < 0.72) {
				t = 12; // hills
			} else if (elev < 0.80) {
				t = detail > 0.5 ? 14 : 13; // plateau / highland
			} else {
				t = 15; // mountain
			}
		}

		cell.terrain = t;
	}
}
