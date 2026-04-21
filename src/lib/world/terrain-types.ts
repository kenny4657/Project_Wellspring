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
	color: [number, number, number]; // base RGB (0-1)
}

/** Terrain type index — used as the numeric ID in instance buffers */
export const TERRAIN_TYPES = {
	deep_ocean: 0,
	shallow_ocean: 1,
	coast: 2,
	lake: 3,
	plains: 4,
	grassland: 5,
	desert: 6,
	swamp: 7,
	tundra: 8,
	hills: 9,
	highland: 10,
	mountain: 11,
} as const;

export type TerrainTypeId = keyof typeof TERRAIN_TYPES;

export const TERRAIN_COUNT = Object.keys(TERRAIN_TYPES).length;

/** Scale factor for terrain heights — subtle relative to hex size (~75km) */
const H = 3; // km per tier unit (max displacement ~15km for mountains on 75km hex)

export const TERRAIN_PROFILES: TerrainProfile[] = [
	// Tier 0: Below surface
	{ id: 'deep_ocean',    name: 'Deep Ocean',    tier: 0, height: -1.5 * H, amplitude: 0.3,  frequency: 0.5,  ridged: false, color: [0.12, 0.22, 0.48] },

	// Tier 1: Surface level
	{ id: 'shallow_ocean', name: 'Shallow Ocean', tier: 1, height: -0.5 * H, amplitude: 0.2,  frequency: 1.0,  ridged: false, color: [0.18, 0.38, 0.58] },
	{ id: 'coast',         name: 'Coast',         tier: 1, height:  0.0 * H, amplitude: 0.2,  frequency: 1.5,  ridged: false, color: [0.72, 0.65, 0.45] },
	{ id: 'lake',          name: 'Lake',          tier: 1, height: -0.3 * H, amplitude: 0.1,  frequency: 0.5,  ridged: false, color: [0.15, 0.35, 0.60] },

	// Tier 2: Low land
	{ id: 'plains',        name: 'Plains',        tier: 2, height:  0.2 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.42, 0.58, 0.22] },
	{ id: 'grassland',     name: 'Grassland',     tier: 2, height:  0.2 * H, amplitude: 0.5,  frequency: 1.5,  ridged: false, color: [0.35, 0.55, 0.18] },
	{ id: 'desert',        name: 'Desert',        tier: 2, height:  0.2 * H, amplitude: 0.6,  frequency: 0.8,  ridged: false, color: [0.72, 0.62, 0.38] },
	{ id: 'swamp',         name: 'Swamp',         tier: 2, height:  0.0 * H, amplitude: 0.2,  frequency: 2.0,  ridged: false, color: [0.28, 0.38, 0.18] },
	{ id: 'tundra',        name: 'Tundra',        tier: 2, height:  0.2 * H, amplitude: 0.3,  frequency: 1.0,  ridged: false, color: [0.72, 0.74, 0.70] },

	// Tier 3: Medium
	{ id: 'hills',         name: 'Hills',         tier: 3, height:  0.7 * H, amplitude: 1.2,  frequency: 2.0,  ridged: false, color: [0.45, 0.50, 0.28] },

	// Tier 4: High
	{ id: 'highland',      name: 'Highland',      tier: 4, height:  1.2 * H, amplitude: 0.8,  frequency: 1.0,  ridged: false, color: [0.52, 0.45, 0.32] },

	// Tier 5: Peak
	{ id: 'mountain',      name: 'Mountain',      tier: 5, height:  2.5 * H, amplitude: 2.5,  frequency: 3.0,  ridged: true,  color: [0.62, 0.58, 0.52] },
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
