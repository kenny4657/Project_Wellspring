/**
 * Procedural terrain generation.
 * Assigns BOTH terrain type AND height level to each hex cell.
 * These are independent: a grassland can be at height 1 or 3,
 * a mountain can be at height 4 or 5.
 */
import type { HexCell } from './icosphere';
import { fbm } from './noise';

/**
 * Assign terrain type and height level to each cell.
 *
 * Height level (0-3) is driven by a "continent" noise field — this determines
 * the physical elevation. Terrain type is influenced by height but also by
 * separate detail noise, so the same height level can have different terrain types.
 *
 * Height levels:
 *   0 = deep water, 1 = shallow water, 2 = lowland, 3 = midland
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

		// ── Height level (0-3) from continent noise ─────────
		let heightLevel: number;
		if (continent < 0.38) heightLevel = 0;       // deep water
		else if (continent < 0.44) heightLevel = 1;   // shallow water
		else if (continent < 0.58) heightLevel = 2;   // lowland
		else heightLevel = 3;                          // midland

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
				t = 4; // plains (default)
			}
		}

		cell.terrain = t;
		cell.heightLevel = heightLevel;
	}
}
