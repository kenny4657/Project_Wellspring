/**
 * CPU bake of `fbmNoise` into a 2-channel cubemap.
 *
 * Channel R: rawNoise = fbmNoise(unitDir * NOISE_SCALE)
 * Channel G: cliffNoise = fbmNoise(unitDir * 120 + 500)
 *
 * `midNoise` from the CPU height function is identical to rawNoise
 * (same input, same fn), so it doesn't need a separate channel.
 *
 * Phase 1 of the GPU displacement plan. Decoupled from rendering;
 * produces a Babylon `RawCubeTexture` ready for the vertex shader
 * (Phase 2) to sample via cubemap lookup.
 */
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import { fbmNoise } from '../noise';
import { NOISE_SCALE } from '../hex-heights';

/** Cube face index → (uv, faceIdx) → (x, y, z) on cube before normalization.
 *  Convention matches WebGL TEXTURE_CUBE_MAP_POSITIVE_X etc. order:
 *  0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z.
 *  u runs left→right, v runs top→bottom. */
function faceUVToDir(face: number, u: number, v: number): [number, number, number] {
	// Map (u,v) ∈ [0,1] → (s,t) ∈ [-1,1]
	const s = 2 * u - 1;
	const t = 1 - 2 * v;
	switch (face) {
		case 0: return [1, t, -s];   // +X
		case 1: return [-1, t, s];   // -X
		case 2: return [s, 1, -t];   // +Y
		case 3: return [s, -1, t];   // -Y
		case 4: return [s, t, 1];    // +Z
		case 5: return [-s, t, -1];  // -Z
		default: return [0, 0, 0];
	}
}

export interface NoiseBakeData {
	/** 6 face Float32Arrays in WebGL cubemap order (+X, -X, +Y, -Y, +Z, -Z).
	 *  Each face is RG-interleaved (R = rawNoise, G = cliffNoise).
	 *  Length = resolution * resolution * 2. */
	faces: Float32Array[];
	resolution: number;
}

/** Bake noise into 6 face buffers. Pure CPU; no Babylon dependency. */
export function bakeNoiseCubemapData(resolution = 1024): NoiseBakeData {
	const faces: Float32Array[] = [];
	const sz = resolution * resolution * 2;
	for (let f = 0; f < 6; f++) {
		const buf = new Float32Array(sz);
		for (let py = 0; py < resolution; py++) {
			const v = (py + 0.5) / resolution;
			for (let px = 0; px < resolution; px++) {
				const u = (px + 0.5) / resolution;
				const [cx, cy, cz] = faceUVToDir(f, u, v);
				const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
				const ux = cx / len, uy = cy / len, uz = cz / len;
				const raw = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
				const cliff = fbmNoise(ux * 120 + 500, uy * 120 + 500, uz * 120 + 500);
				const i = (py * resolution + px) * 2;
				buf[i] = raw;
				buf[i + 1] = cliff;
			}
		}
		faces.push(buf);
	}
	return { faces, resolution };
}

/** Upload baked noise data to a GPU cubemap. RG32F format with linear
 *  filtering. Cube map sampling lets the vertex shader fetch with a
 *  unit-direction (no manual face selection). */
export function uploadNoiseCubemap(data: NoiseBakeData, scene: Scene): RawCubeTexture {
	// Babylon's RawCubeTexture order is documented in WebGL spec order:
	// [+X, -X, +Y, -Y, +Z, -Z] — exactly our face order.
	const tex = new RawCubeTexture(
		scene,
		data.faces,
		data.resolution,
		Constants.TEXTUREFORMAT_RG,
		Constants.TEXTURETYPE_FLOAT,
		false, // generateMipMaps
		false, // invertY
		Constants.TEXTURE_LINEAR_LINEAR,
	);
	tex.name = 'gpuDisplacementNoise';
	return tex;
}

/** Sanity-check the bake by sampling at known unit directions and
 *  comparing to a fresh `fbmNoise` call. Off-by-pixel discrepancies
 *  are expected (cubemap snaps to pixel centers); large drifts mean
 *  the face-orientation math is wrong.
 *
 *  Returns the max absolute error across N test directions and logs
 *  the first few mismatches. Useful in dev console:
 *    `engine.gpu.verifyNoiseBake()` */
export function verifyNoiseBake(data: NoiseBakeData, samples = 32): {
	maxRawError: number;
	maxCliffError: number;
} {
	let maxRaw = 0, maxCliff = 0;
	for (let i = 0; i < samples; i++) {
		const theta = Math.acos(1 - 2 * (i + 0.5) / samples);
		const phi = Math.PI * (1 + Math.sqrt(5)) * i;
		const ux = Math.sin(theta) * Math.cos(phi);
		const uy = Math.sin(theta) * Math.sin(phi);
		const uz = Math.cos(theta);
		const expectedRaw = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
		const expectedCliff = fbmNoise(ux * 120 + 500, uy * 120 + 500, uz * 120 + 500);
		const sampled = sampleBakedCubemap(data, ux, uy, uz);
		const dRaw = Math.abs(sampled.raw - expectedRaw);
		const dCliff = Math.abs(sampled.cliff - expectedCliff);
		if (dRaw > maxRaw) maxRaw = dRaw;
		if (dCliff > maxCliff) maxCliff = dCliff;
	}
	return { maxRawError: maxRaw, maxCliffError: maxCliff };
}

/** CPU-side cubemap sampler (nearest-neighbor). Used for bake
 *  verification only — runtime sampling happens in the shader. */
function sampleBakedCubemap(
	data: NoiseBakeData,
	dx: number, dy: number, dz: number,
): { raw: number; cliff: number } {
	const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
	let face: number, sc: number, tc: number, ma: number;
	if (ax >= ay && ax >= az) {
		ma = ax;
		if (dx > 0) { face = 0; sc = -dz; tc = dy; }
		else { face = 1; sc = dz; tc = dy; }
	} else if (ay >= az) {
		ma = ay;
		if (dy > 0) { face = 2; sc = dx; tc = -dz; }
		else { face = 3; sc = dx; tc = dz; }
	} else {
		ma = az;
		if (dz > 0) { face = 4; sc = dx; tc = dy; }
		else { face = 5; sc = -dx; tc = dy; }
	}
	const u = 0.5 * (sc / ma + 1);
	const v = 0.5 * (1 - tc / ma);
	const px = Math.min(data.resolution - 1, Math.floor(u * data.resolution));
	const py = Math.min(data.resolution - 1, Math.floor(v * data.resolution));
	const i = (py * data.resolution + px) * 2;
	return { raw: data.faces[face][i], cliff: data.faces[face][i + 1] };
}
