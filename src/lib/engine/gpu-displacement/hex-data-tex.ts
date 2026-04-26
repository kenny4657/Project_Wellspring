/**
 * Per-hex data textures for GPU displacement.
 *
 * Two textures, both indexed by `hexId`:
 *   1. hexDataTex (RGBA8) — terrain, heightLevel, edgeCount, flags
 *   2. hexNeighborsTex (RGBA8) — packed neighbor heightLevels for
 *      cliff detection. Up to 6 neighbors per hex; pentagons use 5
 *      and the unused slot is set to the same hex's heightLevel
 *      (so cliff math sees no jump there).
 *
 * Layout choice: square texture sized to the next power-of-two that
 * fits all hexes. Width is the next pow2 ≥ ceil(sqrt(numHexes)).
 * For 1M hexes that's 1024×1024 exactly.
 *
 * Shader access:
 *   ivec2 coord = ivec2(hexId % W, hexId / W);
 *   vec4 d = texelFetch(hexDataTex, coord, 0);
 *   vec4 nb = texelFetch(hexNeighborsTex, coord, 0);
 *
 * Editing (Phase 4 will use this) is a single `texSubImage2D` call.
 */
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import { findNeighborAcrossEdge } from '../hex-borders';

export interface HexDataTextures {
	hexDataTex: RawTexture;
	hexNeighborsTex: RawTexture;
	width: number;
	height: number;
	/** CPU mirror — kept for fast `setHexTerrain` / `setHexHeightLevel`
	 *  edits without re-reading the texture. */
	dataBytes: Uint8Array;
	neighborBytes: Uint8Array;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

export function buildHexDataTextures(cells: HexCell[], scene: Scene): HexDataTextures {
	const numHexes = cells.length;
	const w = nextPow2(Math.ceil(Math.sqrt(numHexes)));
	const h = nextPow2(Math.ceil(numHexes / w));

	const dataBytes = new Uint8Array(w * h * 4);
	const neighborBytes = new Uint8Array(w * h * 4);

	// Cell.id is what the shader uses as the lookup index. Build a
	// lookup so we can find a cell by its id (cells[] is in build
	// order, not id order; ids may have gaps from degenerate cells).
	const cellByIdMap = new Map<number, HexCell>();
	for (const c of cells) cellByIdMap.set(c.id, c);

	let maxId = 0;
	for (const c of cells) if (c.id > maxId) maxId = c.id;

	for (let id = 0; id <= maxId; id++) {
		const c = cellByIdMap.get(id);
		const off = id * 4;
		if (!c) {
			// Gap in id space (shouldn't usually happen). Fill with
			// neutral values: heightLevel=0, terrain=0, etc.
			continue;
		}
		// hexDataTex layout:
		//   R = heightLevel (0–4)
		//   G = terrain     (0–14)
		//   B = isPentagon flag in bit 0, edgeCount in bits 4..7
		//   A = reserved
		dataBytes[off + 0] = c.heightLevel;
		dataBytes[off + 1] = c.terrain;
		const edgeCount = c.corners.length;
		dataBytes[off + 2] = (c.isPentagon ? 1 : 0) | (edgeCount << 4);
		dataBytes[off + 3] = 0;

		// hexNeighborsTex layout — neighbor heightLevel PER EDGE,
		// packed 4-bits each into 3 bytes (RGB). Slot k is the
		// neighbor across edge k (corner k → corner (k+1)). Pentagons
		// pad slot 5 with the cell's own heightLevel so cliff/coast
		// detection sees a no-op there.
		const heights: number[] = [];
		for (let k = 0; k < 6; k++) {
			if (k >= edgeCount) {
				heights.push(c.heightLevel);
				continue;
			}
			const nb = findNeighborAcrossEdge(c, k, cellByIdMap);
			heights.push(nb ? nb.heightLevel : c.heightLevel);
		}
		// Pack pairs into bytes (4 bits each, since heightLevel is 0–4).
		neighborBytes[off + 0] = (heights[0] & 0xf) | ((heights[1] & 0xf) << 4);
		neighborBytes[off + 1] = (heights[2] & 0xf) | ((heights[3] & 0xf) << 4);
		neighborBytes[off + 2] = (heights[4] & 0xf) | ((heights[5] & 0xf) << 4);
		neighborBytes[off + 3] = 0;
	}

	const hexDataTex = new RawTexture(
		dataBytes, w, h,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false,                                // generateMipMaps
		false,                                // invertY
		Constants.TEXTURE_NEAREST_NEAREST,    // hex data is integer-coded, no filtering
		Constants.TEXTURETYPE_UNSIGNED_BYTE,
	);
	hexDataTex.name = 'gpuHexData';

	const hexNeighborsTex = new RawTexture(
		neighborBytes, w, h,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_UNSIGNED_BYTE,
	);
	hexNeighborsTex.name = 'gpuHexNeighbors';

	return { hexDataTex, hexNeighborsTex, width: w, height: h, dataBytes, neighborBytes };
}
