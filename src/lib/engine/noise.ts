/**
 * Shared noise utilities for terrain generation and mesh building.
 *
 * hash3 + smoothstep + noise3d form a simple 3D value noise.
 * fbmNoise: 4-octave FBM with scale 2.1, amplitude decay 0.45 (used by globe-mesh).
 * fbm: parameterized FBM with scale 2, amplitude decay 0.5 (used by terrain-gen).
 */

export function hash3(ix: number, iy: number, iz: number): number {
	let h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) | 0;
	h = ((h ^ (h >>> 13)) * 1274126177) | 0;
	return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff;
}

export function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

export function noise3d(x: number, y: number, z: number): number {
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

/** 4-octave FBM with lacunarity 2.1 and gain 0.45, centered around 0. */
export function fbmNoise(x: number, y: number, z: number): number {
	let v = 0, a = 0.5, max = 0;
	for (let i = 0; i < 4; i++) {
		v += noise3d(x, y, z) * a; max += a;
		x *= 2.1; y *= 2.1; z *= 2.1; a *= 0.45;
	}
	return v / max - 0.5; // center around 0
}

/** Parameterized FBM with lacunarity 2 and gain 0.5. */
export function fbm(x: number, y: number, z: number, octaves: number): number {
	let val = 0, amp = 1, max = 0;
	for (let i = 0; i < octaves; i++) {
		val += noise3d(x, y, z) * amp; max += amp;
		x *= 2; y *= 2; z *= 2; amp *= 0.5;
	}
	return val / max;
}
