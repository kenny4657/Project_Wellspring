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
import { buildCliffEdgesTexture, type CliffEdgesTexture } from './cliff-edges-tex';
import { createDisplacementMaterial } from './displacement-shader';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';

export interface GpuDisplacementResources {
	noiseCubemap: RawCubeTexture;
	noiseBakeData: NoiseBakeData;
	hexTextures: HexDataTextures;
	hexCorners: HexCornersTexture;
	cliffEdges: CliffEdgesTexture;
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
	const cliffEdges = buildCliffEdgesTexture(cells, scene);
	// Patch cliff edge counts into hexDataTex.A bits 2-7 (6 bits, max 63).
	// Bits 0-1 keep the existing hasCliffNbr / hasCliffWithin1Hop flags.
	for (let id = 0; id < cliffEdges.counts.length; id++) {
		const count = Math.min(cliffEdges.counts[id], 63);
		const off = id * 4 + 3;
		if (off >= hexTextures.dataBytes.length) break;
		hexTextures.dataBytes[off] = (hexTextures.dataBytes[off] & 0x03) | (count << 2);
	}
	hexTextures.hexDataTex.update(hexTextures.dataBytes);
	const t3 = performance.now();

	const flatChunks = buildFlatChunkMeshes(cells, scene, chunkAssignment);
	const t4 = performance.now();

	const material = createDisplacementMaterial(scene, {
		noiseCubemap,
		hexTextures,
		hexCorners,
		cliffEdges,
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
		cliffEdges,
		flatChunks,
		material,
		verify: () => verifyNoiseBake(noiseBakeData, 64),
	};
}
