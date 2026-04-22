/**
 * Terrain type definitions and parameter table.
 *
 * Each terrain type defines a visual profile used by the terrain shader:
 * - tier/height: elevation positioning on the globe
 * - amplitude/frequency/ridged: noise displacement parameters for the vertex shader
 * - color: base RGB color for the fragment shader
 */

export type RGB = [number, number, number];

export interface TerrainProfile {
	id: string;
	name: string;
	tier: number;
	height: number;       // world-space base height (km above globe surface)
	amplitude: number;    // noise displacement strength (km)
	frequency: number;    // noise spatial frequency
	ridged: boolean;      // use ridged noise (sharp peaks)
	color: RGB;           // base RGB (0-1) — used for wall cross-sections
	/** Sota-style 4-band palette: [shore, grass, hill, snow] equivalents.
	 *  The shader blends these by global height h, with shore↔grass creating
	 *  the organic two-tone blend at every tier boundary. */
	palette: [RGB, RGB, RGB, RGB];
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
	// Colors are muted/natural — Sota-style. Shader adds procedural variation.
	// palette: [shore, grass, hill, snow] — shore+grass create the visible two-tone blend.
	//                                                                                                            shore                grass                hill                 snow
	// Tier 0: Below surface — sandy ocean floor (water mesh provides blue)
	{ id: 'deep_ocean',    name: 'Deep Ocean',    tier: 0, height: -1.5 * H, amplitude: 0.3,  frequency: 0.5,  ridged: false, color: [0.12, 0.22, 0.48], palette: [[0.58, 0.52, 0.38], [0.52, 0.48, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },

	// Tier 1: Surface level — sandy tones
	{ id: 'shallow_ocean', name: 'Shallow Ocean', tier: 1, height: -0.5 * H, amplitude: 0.2,  frequency: 1.0,  ridged: false, color: [0.18, 0.38, 0.58], palette: [[0.58, 0.52, 0.38], [0.54, 0.50, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'reef',          name: 'Reef',          tier: 1, height: -0.3 * H, amplitude: 0.5,  frequency: 3.0,  ridged: false, color: [0.15, 0.50, 0.48], palette: [[0.58, 0.52, 0.38], [0.50, 0.52, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'coast',         name: 'Coast',         tier: 1, height:  0.0 * H, amplitude: 0.2,  frequency: 1.5,  ridged: false, color: [0.72, 0.65, 0.45], palette: [[0.65, 0.58, 0.40], [0.58, 0.52, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'lake',          name: 'Lake',          tier: 1, height: -0.3 * H, amplitude: 0.1,  frequency: 0.5,  ridged: false, color: [0.15, 0.35, 0.60], palette: [[0.58, 0.52, 0.38], [0.50, 0.48, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },

	// Tier 2: Low land
	{ id: 'plains',        name: 'Plains',        tier: 2, height:  0.2 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.42, 0.58, 0.22], palette: [[0.65, 0.58, 0.40], [0.38, 0.60, 0.22], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'grassland',     name: 'Grassland',     tier: 2, height:  0.2 * H, amplitude: 0.5,  frequency: 1.5,  ridged: false, color: [0.35, 0.55, 0.18], palette: [[0.58, 0.52, 0.34], [0.30, 0.56, 0.16], [0.42, 0.44, 0.28], [0.82, 0.84, 0.88]] },
	{ id: 'desert',        name: 'Desert',        tier: 2, height:  0.2 * H, amplitude: 0.6,  frequency: 0.8,  ridged: false, color: [0.72, 0.62, 0.38], palette: [[0.62, 0.54, 0.36], [0.56, 0.48, 0.30], [0.52, 0.46, 0.34], [0.82, 0.84, 0.88]] },
	{ id: 'swamp',         name: 'Swamp',         tier: 2, height:  0.0 * H, amplitude: 0.2,  frequency: 2.0,  ridged: false, color: [0.28, 0.38, 0.18], palette: [[0.36, 0.32, 0.20], [0.24, 0.34, 0.14], [0.34, 0.32, 0.22], [0.78, 0.80, 0.82]] },
	{ id: 'tundra',        name: 'Tundra',        tier: 2, height:  0.2 * H, amplitude: 0.3,  frequency: 1.0,  ridged: false, color: [0.72, 0.74, 0.70], palette: [[0.56, 0.54, 0.46], [0.48, 0.50, 0.40], [0.52, 0.50, 0.46], [0.86, 0.88, 0.92]] },

	// Tier 3: Medium
	{ id: 'forest',        name: 'Forest',        tier: 3, height:  0.5 * H, amplitude: 0.8,  frequency: 1.5,  ridged: false, color: [0.15, 0.40, 0.12], palette: [[0.46, 0.42, 0.28], [0.18, 0.42, 0.12], [0.36, 0.36, 0.24], [0.82, 0.84, 0.88]] },
	{ id: 'jungle',        name: 'Jungle',        tier: 3, height:  0.5 * H, amplitude: 1.0,  frequency: 2.0,  ridged: false, color: [0.10, 0.35, 0.08], palette: [[0.40, 0.38, 0.24], [0.14, 0.38, 0.10], [0.30, 0.32, 0.20], [0.78, 0.80, 0.82]] },
	{ id: 'hills',         name: 'Hills',         tier: 3, height:  0.7 * H, amplitude: 1.2,  frequency: 2.0,  ridged: false, color: [0.45, 0.50, 0.28], palette: [[0.58, 0.52, 0.36], [0.40, 0.52, 0.24], [0.50, 0.46, 0.32], [0.82, 0.84, 0.88]] },

	// Tier 4: High
	{ id: 'highland',      name: 'Highland',      tier: 4, height:  1.2 * H, amplitude: 0.8,  frequency: 1.0,  ridged: false, color: [0.52, 0.45, 0.32], palette: [[0.56, 0.50, 0.38], [0.48, 0.44, 0.32], [0.52, 0.50, 0.42], [0.84, 0.86, 0.90]] },
	{ id: 'plateau',       name: 'Plateau',       tier: 4, height:  1.5 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.58, 0.50, 0.35], palette: [[0.60, 0.54, 0.40], [0.52, 0.48, 0.34], [0.50, 0.48, 0.40], [0.84, 0.86, 0.90]] },

	// Tier 5: Peak
	{ id: 'mountain',      name: 'Mountain',      tier: 5, height:  2.5 * H, amplitude: 2.5,  frequency: 3.0,  ridged: true,  color: [0.62, 0.58, 0.52], palette: [[0.52, 0.48, 0.40], [0.44, 0.44, 0.38], [0.52, 0.52, 0.48], [0.86, 0.88, 0.92]] },

	// Special
	{ id: 'island',        name: 'Island',        tier: 2, height:  0.3 * H, amplitude: 0.6,  frequency: 2.0,  ridged: false, color: [0.40, 0.55, 0.25], palette: [[0.62, 0.56, 0.38], [0.36, 0.56, 0.20], [0.46, 0.44, 0.30], [0.82, 0.84, 0.88]] },
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

/** Pack per-terrain palettes into a flat array for shader uniform upload.
 *  17 types × 4 bands × 3 channels = 204 floats.
 *  Shader access: terrainPalette[terrainId * 4 + bandIndex] */
export function packTerrainPalettes(): number[] {
	const data: number[] = [];
	for (let i = 0; i < TERRAIN_COUNT; i++) {
		const p = TERRAIN_PROFILES[i];
		for (let b = 0; b < 4; b++) {
			data.push(p.palette[b][0], p.palette[b][1], p.palette[b][2]);
		}
	}
	return data;
}

const PALETTE_STORAGE_KEY = 'wellspring-terrain-palettes';

/** Load palettes from localStorage, falling back to defaults. */
export function loadTerrainPalettes(): [RGB, RGB, RGB, RGB][] {
	if (typeof localStorage === 'undefined') return TERRAIN_PROFILES.map(p => [...p.palette] as [RGB, RGB, RGB, RGB]);
	try {
		const raw = localStorage.getItem(PALETTE_STORAGE_KEY);
		if (!raw) return TERRAIN_PROFILES.map(p => [...p.palette] as [RGB, RGB, RGB, RGB]);
		const saved = JSON.parse(raw) as [RGB, RGB, RGB, RGB][];
		// Merge with defaults in case new terrains were added
		return TERRAIN_PROFILES.map((p, i) => saved[i] ?? [...p.palette] as [RGB, RGB, RGB, RGB]);
	} catch {
		return TERRAIN_PROFILES.map(p => [...p.palette] as [RGB, RGB, RGB, RGB]);
	}
}

/** Save palettes to localStorage. */
export function saveTerrainPalettes(palettes: [RGB, RGB, RGB, RGB][]): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
}

/** Pack custom palettes array into flat number[] for shader uniform. */
export function packCustomPalettes(palettes: [RGB, RGB, RGB, RGB][]): number[] {
	const data: number[] = [];
	for (let i = 0; i < TERRAIN_COUNT; i++) {
		const pal = palettes[i] ?? TERRAIN_PROFILES[i].palette;
		for (let b = 0; b < 4; b++) {
			data.push(pal[b][0], pal[b][1], pal[b][2]);
		}
	}
	return data;
}
