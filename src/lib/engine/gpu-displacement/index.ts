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
import { buildHexCornersTexture, canonicalizeCells, type HexCornersTexture } from './hex-corners-tex';
import { buildCornerHeightsTexture, type CornerHeightsTexture } from './corner-heights-tex';
import { createDisplacementMaterial } from './displacement-shader';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';

export interface GpuDisplacementResources {
	noiseCubemap: RawCubeTexture;
	noiseBakeData: NoiseBakeData;
	hexTextures: HexDataTextures;
	hexCorners: HexCornersTexture;
	cornerHeights: CornerHeightsTexture;
	flatChunks: FlatChunkMesh[];
	material: ShaderMaterial;
	verify: () => { maxRawError: number; maxCliffError: number };
}

export async function initGpuDisplacement(
	cells: HexCell[],
	chunkAssignment: ChunkAssignment,
	scene: Scene,
	planetRadius: number,
	noiseRes = 1024,
): Promise<GpuDisplacementResources> {
	const t0 = performance.now();

	// Canonicalize corner positions across hexes. icosphere.ts can leave
	// FP drift between two hexes that share a physical corner — that drift
	// causes seam mismatches in the GPU shader (each side computes slightly
	// different distances from its own corner copy). One-time fix.
	canonicalizeCells(cells);

	const noiseBakeData = bakeNoiseCubemapData(noiseRes);
	const t1 = performance.now();

	const noiseCubemap = uploadNoiseCubemap(noiseBakeData, scene);
	const t2 = performance.now();

	const hexTextures = buildHexDataTextures(cells, scene);
	const hexCorners = buildHexCornersTexture(cells, scene);
	const cornerHeights = buildCornerHeightsTexture(cells, scene);
	const t3 = performance.now();

	const flatChunks = buildFlatChunkMeshes(cells, scene, chunkAssignment, cornerHeights.idByRef);
	const t4 = performance.now();

	const material = createDisplacementMaterial(scene, {
		noiseCubemap,
		hexTextures,
		hexCorners,
		cornerHeights,
	}, planetRadius);
	for (const chunk of flatChunks) {
		chunk.mesh.material = material;
	}
	const t5 = performance.now();

	console.log(
		`[GPU displacement] init: ` +
		`bake=${(t1 - t0).toFixed(0)}ms, ` +
		`upload=${(t2 - t1).toFixed(0)}ms, ` +
		`hexTex=${(t3 - t2).toFixed(0)}ms, ` +
		`flatMesh=${(t4 - t3).toFixed(0)}ms, ` +
		`material=${(t5 - t4).toFixed(0)}ms ` +
		`(total ${(t5 - t0).toFixed(0)}ms)`,
	);

	return {
		noiseCubemap,
		noiseBakeData,
		hexTextures,
		hexCorners,
		cornerHeights,
		flatChunks,
		material,
		verify: () => verifyNoiseBake(noiseBakeData, 64),
	};
}
