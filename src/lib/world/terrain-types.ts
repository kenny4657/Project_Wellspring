/**
 * Terrain type definitions and parameter table.
 *
 * Each terrain type defines a visual profile used by the terrain shader:
 * - tier/height: elevation positioning on the globe
 * - amplitude/frequency/ridged: noise displacement parameters for the vertex shader
 * - color: base RGB color for the fragment shader
 */

export interface TerrainProfile {
	id: string;
	name: string;
	tier: number;
	height: number;       // world-space base height (km above globe surface)
	amplitude: number;    // noise displacement strength (km)
	frequency: number;    // noise spatial frequency
	ridged: boolean;      // use ridged noise (sharp peaks)
	color: [number, number, number]; // base RGB (0-1) — fallback if no texture
	atlasCell: number;    // index into terrain texture atlas (row-major, 4 cols)
	isHill: boolean;      // apply normal map for hills
	isMountain: boolean;  // render as elevated mountain mesh
}

/** Terrain type index — used as the numeric ID in instance buffers */
export const TERRAIN_TYPES = {
	deep_ocean: 0,
	shallow_ocean: 1,
	reef: 2,
	coast: 3,
	lake: 4,
	plains: 5,
	grassland: 6,
	desert: 7,
	swamp: 8,
	tundra: 9,
	forest: 10,
	jungle: 11,
	hills: 12,
	highland: 13,
	plateau: 14,
	mountain: 15,
	island: 16,
} as const;

export type TerrainTypeId = keyof typeof TERRAIN_TYPES;

export const TERRAIN_COUNT = Object.keys(TERRAIN_TYPES).length;

/** Scale factor for terrain heights — subtle relative to hex size (~75km) */
const H = 3; // km per tier unit (max displacement ~15km for mountains on 75km hex)

export const TERRAIN_PROFILES: TerrainProfile[] = [
	// Atlas layout (4 cols x 3 rows, 256px cells in 1024x1024):
	// Row 0: ocean(0) coast(1) snow(2)
	// Row 1: plains(4) grass(5) desert(6)
	// Row 2: tundra(8) mountain(9)
	// Cell index = cellY * 4 + cellX

	// Tier 0: Below surface
	{ id: 'deep_ocean',    name: 'Deep Ocean',    tier: 0, height: -1.5 * H, amplitude: 0.3,  frequency: 0.5,  ridged: false, color: [0.20, 0.40, 0.75], atlasCell: 0,  isHill: false, isMountain: false },

	// Tier 1: Surface level
	{ id: 'shallow_ocean', name: 'Shallow Ocean', tier: 1, height: -0.5 * H, amplitude: 0.2,  frequency: 1.0,  ridged: false, color: [0.30, 0.55, 0.82], atlasCell: 0,  isHill: false, isMountain: false },
	{ id: 'reef',          name: 'Reef',          tier: 1, height: -0.3 * H, amplitude: 0.5,  frequency: 3.0,  ridged: false, color: [0.30, 0.70, 0.68], atlasCell: 1,  isHill: false, isMountain: false },
	{ id: 'coast',         name: 'Coast',         tier: 1, height:  0.0 * H, amplitude: 0.2,  frequency: 1.5,  ridged: false, color: [0.92, 0.86, 0.65], atlasCell: 1,  isHill: false, isMountain: false },
	{ id: 'lake',          name: 'Lake',          tier: 1, height: -0.3 * H, amplitude: 0.1,  frequency: 0.5,  ridged: false, color: [0.30, 0.58, 0.82], atlasCell: 0,  isHill: false, isMountain: false },

	// Tier 2: Low land
	{ id: 'plains',        name: 'Plains',        tier: 2, height:  0.2 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.70, 0.82, 0.38], atlasCell: 4,  isHill: false, isMountain: false },
	{ id: 'grassland',     name: 'Grassland',     tier: 2, height:  0.2 * H, amplitude: 0.5,  frequency: 1.5,  ridged: false, color: [0.58, 0.80, 0.35], atlasCell: 5,  isHill: false, isMountain: false },
	{ id: 'desert',        name: 'Desert',        tier: 2, height:  0.2 * H, amplitude: 0.6,  frequency: 0.8,  ridged: false, color: [0.95, 0.85, 0.55], atlasCell: 6,  isHill: false, isMountain: false },
	{ id: 'swamp',         name: 'Swamp',         tier: 2, height:  0.0 * H, amplitude: 0.2,  frequency: 2.0,  ridged: false, color: [0.42, 0.55, 0.28], atlasCell: 8,  isHill: false, isMountain: false },
	{ id: 'tundra',        name: 'Tundra',        tier: 2, height:  0.2 * H, amplitude: 0.3,  frequency: 1.0,  ridged: false, color: [0.85, 0.87, 0.83], atlasCell: 8,  isHill: false, isMountain: false },

	// Tier 3: Medium
	{ id: 'forest',        name: 'Forest',        tier: 3, height:  0.5 * H, amplitude: 0.8,  frequency: 1.5,  ridged: false, color: [0.22, 0.58, 0.20], atlasCell: 5,  isHill: true,  isMountain: false },
	{ id: 'jungle',        name: 'Jungle',        tier: 3, height:  0.5 * H, amplitude: 1.0,  frequency: 2.0,  ridged: false, color: [0.15, 0.52, 0.18], atlasCell: 5,  isHill: true,  isMountain: false },
	{ id: 'hills',         name: 'Hills',         tier: 3, height:  0.7 * H, amplitude: 1.2,  frequency: 2.0,  ridged: false, color: [0.65, 0.72, 0.42], atlasCell: 4,  isHill: true,  isMountain: false },

	// Tier 4: High
	{ id: 'highland',      name: 'Highland',      tier: 4, height:  1.2 * H, amplitude: 0.8,  frequency: 1.0,  ridged: false, color: [0.70, 0.62, 0.48], atlasCell: 4,  isHill: true,  isMountain: false },
	{ id: 'plateau',       name: 'Plateau',       tier: 4, height:  1.5 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.75, 0.65, 0.48], atlasCell: 6,  isHill: false, isMountain: false },

	// Tier 5: Peak
	{ id: 'mountain',      name: 'Mountain',      tier: 5, height:  2.5 * H, amplitude: 2.5,  frequency: 3.0,  ridged: true,  color: [0.72, 0.68, 0.62], atlasCell: 9,  isHill: false, isMountain: true  },

	// Special
	{ id: 'island',        name: 'Island',        tier: 2, height:  0.3 * H, amplitude: 0.6,  frequency: 2.0,  ridged: false, color: [0.60, 0.75, 0.40], atlasCell: 5,  isHill: false, isMountain: false },
];

/**
 * Pack terrain profiles into a Float32Array for upload as a shader uniform.
 * 4 floats per terrain type: [height, amplitude, frequency, ridged(0/1)]
 * Colors packed separately: 4 floats per type [r, g, b, 0]
 */
export function packTerrainParams(): { params: Float32Array; colors: Float32Array } {
	const params = new Float32Array(TERRAIN_COUNT * 4);
	const colors = new Float32Array(TERRAIN_COUNT * 4);

	for (let i = 0; i < TERRAIN_COUNT; i++) {
		const p = TERRAIN_PROFILES[i];
		params[i * 4 + 0] = p.height;
		params[i * 4 + 1] = p.amplitude;
		params[i * 4 + 2] = p.frequency;
		params[i * 4 + 3] = p.ridged ? 1.0 : 0.0;

		colors[i * 4 + 0] = p.color[0];
		colors[i * 4 + 1] = p.color[1];
		colors[i * 4 + 2] = p.color[2];
		colors[i * 4 + 3] = 1.0;
	}

	return { params, colors };
}

/** Build GLSL atlas cell mapping: terrain type index → atlas cell index */
export function buildAtlasCellMap(): string {
	const lines = TERRAIN_PROFILES.map((p, i) =>
		`  if (idx == ${i}) return ${p.atlasCell}.0;`
	).join('\n');
	return `float getAtlasCell(int idx) {\n${lines}\n  return 0.0;\n}`;
}

/** Build GLSL hill flag mapping: terrain type index → isHill */
export function buildHillMap(): string {
	const lines = TERRAIN_PROFILES.map((p, i) =>
		`  if (idx == ${i}) return ${p.isHill ? '1.0' : '0.0'};`
	).join('\n');
	return `float getIsHill(int idx) {\n${lines}\n  return 0.0;\n}`;
}
