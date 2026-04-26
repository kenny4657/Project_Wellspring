/**
 * GPU displacement (approach #4) — Phase 1 entry point.
 *
 * Builds the data artifacts the vertex shader will need:
 *   - Noise cubemap (RG: rawNoise, cliffNoise)
 *   - Per-hex data + neighbor textures
 *   - Per-chunk flat unit-sphere meshes
 *
 * Does **not** render anything yet. Phase 2 wires these into a
 * vertex/fragment shader.
 */
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import type { ChunkAssignment } from '../globe-chunks';
import { bakeNoiseCubemapData, uploadNoiseCubemap, verifyNoiseBake, type NoiseBakeData } from './noise-bake';
import { buildFlatChunkMeshes, type FlatChunkMesh } from './flat-mesh';
import { buildHexDataTextures, type HexDataTextures } from './hex-data-tex';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';

export interface GpuDisplacementResources {
	noiseCubemap: RawCubeTexture;
	noiseBakeData: NoiseBakeData;
	hexTextures: HexDataTextures;
	flatChunks: FlatChunkMesh[];
	verify: () => { maxRawError: number; maxCliffError: number };
}

export async function initGpuDisplacement(
	cells: HexCell[],
	chunkAssignment: ChunkAssignment,
	scene: Scene,
	noiseRes = 1024,
): Promise<GpuDisplacementResources> {
	const t0 = performance.now();

	const noiseBakeData = bakeNoiseCubemapData(noiseRes);
	const t1 = performance.now();

	const noiseCubemap = uploadNoiseCubemap(noiseBakeData, scene);
	const t2 = performance.now();

	const hexTextures = buildHexDataTextures(cells, scene);
	const t3 = performance.now();

	const flatChunks = buildFlatChunkMeshes(cells, scene, chunkAssignment);
	const t4 = performance.now();

	console.log(
		`[GPU displacement] Phase 1 init: ` +
		`bake=${(t1 - t0).toFixed(0)}ms, ` +
		`upload=${(t2 - t1).toFixed(0)}ms, ` +
		`hexTex=${(t3 - t2).toFixed(0)}ms, ` +
		`flatMesh=${(t4 - t3).toFixed(0)}ms ` +
		`(total ${(t4 - t0).toFixed(0)}ms)`,
	);

	return {
		noiseCubemap,
		noiseBakeData,
		hexTextures,
		flatChunks,
		verify: () => verifyNoiseBake(noiseBakeData, 64),
	};
}
