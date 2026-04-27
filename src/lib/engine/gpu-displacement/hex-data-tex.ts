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

/** Find neighbor across edge by canonical-corner reference equality.
 *  Robust where dot-product matching fails (7+ corner cells where two
 *  edges have similar midpoint directions). Requires canonicalizeCells
 *  to have run so corners are shared Vector3 references across hexes. */
function findNeighborByCorners(cell: HexCell, edgeIdx: number, cellByIdMap: Map<number, HexCell>): HexCell | null {
	const a = cell.corners[edgeIdx];
	const b = cell.corners[(edgeIdx + 1) % cell.corners.length];
	for (const nId of cell.neighbors) {
		const nb = cellByIdMap.get(nId);
		if (!nb) continue;
		let hasA = false, hasB = false;
		for (const c of nb.corners) {
			if (c === a) hasA = true;
			if (c === b) hasB = true;
			if (hasA && hasB) return nb;
		}
	}
	return null;
}

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
	// hexNeighborsTex uses 2 pixels (rows) per cell to hold up to 12
	// neighbor nibbles. Layout: row (id/w)*2 + 0 = slots 0..7,
	// row (id/w)*2 + 1 = slots 8..11 (last 4 bytes unused).
	const neighborH = h * 2;
	const neighborBytes = new Uint8Array(w * neighborH * 4);

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
		//   A = bit 0: hasCliffNbr (any cross-tier neighbor) — lets the
		//        shader skip 1-hop fetches into neighbors that can't
		//        contribute any cliff erosion.
		dataBytes[off + 0] = c.heightLevel;
		dataBytes[off + 1] = c.terrain;
		const edgeCount = c.corners.length;
		dataBytes[off + 2] = (c.isPentagon ? 1 : 0) | (edgeCount << 4);
		let hasCliffNbr = 0;
		for (let k = 0; k < edgeCount; k++) {
			const nb = findNeighborByCorners(c, k, cellByIdMap);
			if (nb && nb.heightLevel !== c.heightLevel) { hasCliffNbr = 1; break; }
		}
		dataBytes[off + 3] = hasCliffNbr;

		// hexNeighborsTex layout — neighbor heightLevel PER EDGE,
		// packed 4-bits each across 2 RGBA8 pixels (rows). Pixel 0:
		// slots 0..7 in RGBA. Pixel 1: slots 8..11 in R+G (B+A unused).
		// Cells with fewer slots pad with the cell's own heightLevel
		// so cliff/coast detection sees a no-op there. 12 slots cover
		// every observed cell (max 10) with a margin.
		const heights: number[] = [];
		for (let k = 0; k < 12; k++) {
			if (k >= edgeCount) {
				heights.push(c.heightLevel);
				continue;
			}
			const nb = findNeighborByCorners(c, k, cellByIdMap);
			heights.push(nb ? nb.heightLevel : c.heightLevel);
		}
		const xCol = id % w;
		const yRowBase = Math.floor(id / w) * 2;
		const px0 = (yRowBase * w + xCol) * 4;
		const px1 = ((yRowBase + 1) * w + xCol) * 4;
		neighborBytes[px0 + 0] = (heights[0] & 0xf) | ((heights[1] & 0xf) << 4);
		neighborBytes[px0 + 1] = (heights[2] & 0xf) | ((heights[3] & 0xf) << 4);
		neighborBytes[px0 + 2] = (heights[4] & 0xf) | ((heights[5] & 0xf) << 4);
		neighborBytes[px0 + 3] = (heights[6] & 0xf) | ((heights[7] & 0xf) << 4);
		neighborBytes[px1 + 0] = (heights[8] & 0xf) | ((heights[9] & 0xf) << 4);
		neighborBytes[px1 + 1] = (heights[10] & 0xf) | ((heights[11] & 0xf) << 4);
		neighborBytes[px1 + 2] = 0;
		neighborBytes[px1 + 3] = 0;
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
		neighborBytes, w, neighborH,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_UNSIGNED_BYTE,
	);
	hexNeighborsTex.name = 'gpuHexNeighbors';

	return { hexDataTex, hexNeighborsTex, width: w, height: h, dataBytes, neighborBytes };
}
