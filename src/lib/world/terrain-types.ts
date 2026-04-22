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
	/** Shore→grass transition width as fraction of amplitude (0.01–0.20).
	 *  Higher = wider/smoother blend zone. Default 0.06. */
	blend: number;
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
} as const;

export type TerrainTypeId = keyof typeof TERRAIN_TYPES;

export const TERRAIN_COUNT = Object.keys(TERRAIN_TYPES).length;

/** Scale factor for terrain heights — subtle relative to hex size (~75km) */
const H = 3; // km per tier unit (max displacement ~15km for mountains on 75km hex)

export const TERRAIN_PROFILES: TerrainProfile[] = [
	// palette: [shore, grass, hill, snow] — shore+grass create the visible two-tone blend.
	//                                                                                                            shore                grass                hill                 snow
	// Tier 0: Below surface — sandy ocean floor (water mesh provides blue)
	{ id: 'deep_ocean',    name: 'Deep Ocean',    tier: 0, height: -1.5 * H, amplitude: 0.3,  frequency: 0.5,  ridged: false, color: [0.12, 0.22, 0.48], blend: 0.06, palette: [[0.58, 0.52, 0.38], [0.52, 0.48, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },

	// Tier 1: Surface level — sandy tones
	{ id: 'shallow_ocean', name: 'Shallow Ocean', tier: 1, height: -0.5 * H, amplitude: 0.2,  frequency: 1.0,  ridged: false, color: [0.18, 0.38, 0.58], blend: 0.06, palette: [[0.58, 0.52, 0.38], [0.54, 0.50, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'coast',         name: 'Coast',         tier: 1, height:  0.0 * H, amplitude: 0.2,  frequency: 1.5,  ridged: false, color: [0.72, 0.65, 0.45], blend: 0.06, palette: [[0.65, 0.58, 0.40], [0.58, 0.52, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'lake',          name: 'Lake',          tier: 1, height: -0.3 * H, amplitude: 0.1,  frequency: 0.5,  ridged: false, color: [0.15, 0.35, 0.60], blend: 0.06, palette: [[0.58, 0.52, 0.38], [0.50, 0.48, 0.36], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },

	// Tier 2: Low land
	{ id: 'plains',        name: 'Plains',        tier: 2, height:  0.2 * H, amplitude: 0.4,  frequency: 1.0,  ridged: false, color: [0.42, 0.58, 0.22], blend: 0.06, palette: [[0.65, 0.58, 0.40], [0.38, 0.60, 0.22], [0.48, 0.44, 0.32], [0.82, 0.84, 0.88]] },
	{ id: 'grassland',     name: 'Grassland',     tier: 2, height:  0.2 * H, amplitude: 0.5,  frequency: 1.5,  ridged: false, color: [0.35, 0.55, 0.18], blend: 0.06, palette: [[0.58, 0.52, 0.34], [0.30, 0.56, 0.16], [0.42, 0.44, 0.28], [0.82, 0.84, 0.88]] },
	{ id: 'desert',        name: 'Desert',        tier: 2, height:  0.2 * H, amplitude: 0.6,  frequency: 0.8,  ridged: false, color: [0.72, 0.62, 0.38], blend: 0.06, palette: [[0.62, 0.54, 0.36], [0.56, 0.48, 0.30], [0.52, 0.46, 0.34], [0.82, 0.84, 0.88]] },
	{ id: 'swamp',         name: 'Swamp',         tier: 2, height:  0.0 * H, amplitude: 0.2,  frequency: 2.0,  ridged: false, color: [0.28, 0.38, 0.18], blend: 0.06, palette: [[0.36, 0.32, 0.20], [0.24, 0.34, 0.14], [0.34, 0.32, 0.22], [0.78, 0.80, 0.82]] },
	{ id: 'tundra',        name: 'Tundra',        tier: 2, height:  0.2 * H, amplitude: 0.3,  frequency: 1.0,  ridged: false, color: [0.72, 0.74, 0.70], blend: 0.06, palette: [[0.56, 0.54, 0.46], [0.48, 0.50, 0.40], [0.52, 0.50, 0.46], [0.86, 0.88, 0.92]] },

	// Tier 3: Medium
	{ id: 'hills',         name: 'Hills',         tier: 3, height:  0.7 * H, amplitude: 1.2,  frequency: 2.0,  ridged: false, color: [0.45, 0.50, 0.28], blend: 0.06, palette: [[0.58, 0.52, 0.36], [0.40, 0.52, 0.24], [0.50, 0.46, 0.32], [0.82, 0.84, 0.88]] },
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
 *  10 types × 4 bands × 3 channels = 120 floats.
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

const STORAGE_KEY = 'wellspring-terrain-settings';

export interface TerrainSettings {
	palettes: [RGB, RGB, RGB, RGB][];
	blends: number[];
}

function defaultSettings(): TerrainSettings {
	return {
		palettes: TERRAIN_PROFILES.map(p => [...p.palette] as [RGB, RGB, RGB, RGB]),
		blends: TERRAIN_PROFILES.map(p => p.blend),
	};
}

/** Load palettes + blends from localStorage, falling back to defaults. */
export function loadTerrainSettings(): TerrainSettings {
	if (typeof localStorage === 'undefined') return defaultSettings();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaultSettings();
		const saved = JSON.parse(raw) as Partial<TerrainSettings>;
		const def = defaultSettings();
		return {
			palettes: TERRAIN_PROFILES.map((p, i) => saved.palettes?.[i] ?? def.palettes[i]),
			blends: TERRAIN_PROFILES.map((p, i) => saved.blends?.[i] ?? def.blends[i]),
		};
	} catch {
		return defaultSettings();
	}
}

/** Save palettes + blends to localStorage. */
export function saveTerrainSettings(settings: TerrainSettings): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** For backwards compat — load just palettes. */
export function loadTerrainPalettes(): [RGB, RGB, RGB, RGB][] {
	return loadTerrainSettings().palettes;
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
