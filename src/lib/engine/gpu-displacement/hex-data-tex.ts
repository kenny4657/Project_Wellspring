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

	// Pass 1: per-cell hasCliffNbr (used for the within-1-hop computation
	// in pass 2; defined as: this cell has any neighbor of a different tier).
	const hasCliffNbrById = new Map<number, boolean>();
	for (const c of cells) {
		let v = false;
		for (let k = 0; k < c.corners.length; k++) {
			const nb = findNeighborByCorners(c, k, cellByIdMap);
			if (nb && nb.heightLevel !== c.heightLevel) { v = true; break; }
		}
		hasCliffNbrById.set(c.id, v);
	}

	// Pass 2: write all texture bytes in one loop now that hasCliffNbr is known.
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
		//   A = bit 0: hasCliffNbr (self has any cross-tier neighbor)
		//       bit 1: hasCliffWithin1Hop (self OR any of self's neighbors
		//              has cross-tier neighbor) — lets the shader skip
		//              the ENTIRE cliff erosion (self + 1-hop) for deep
		//              interior cells far from any tier transition.
		dataBytes[off + 0] = c.heightLevel;
		dataBytes[off + 1] = c.terrain;
		const edgeCount = c.corners.length;
		dataBytes[off + 2] = (c.isPentagon ? 1 : 0) | (edgeCount << 4);
		const own = hasCliffNbrById.get(c.id) ? 1 : 0;
		let oneHop = own;
		if (!oneHop) {
			for (const nbId of c.neighbors) {
				if (hasCliffNbrById.get(nbId)) { oneHop = 1; break; }
			}
		}
		dataBytes[off + 3] = own | (oneHop << 1);

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

/** Phase 4 edit path — write a single hex's terrain byte to the GPU
 *  texture without rebuilding any meshes. Replaces the CPU updateCellTerrain
 *  rebuild that touched up to ~7 cells worth of vertex colors. */
export function writeHexTerrain(tex: HexDataTextures, cellId: number, terrainId: number): void {
	const off = cellId * 4;
	if (off + 1 >= tex.dataBytes.length) return;
	tex.dataBytes[off + 1] = terrainId & 0xff;
	tex.hexDataTex.update(tex.dataBytes);
}

/** Phase 4 edit path — write a hex's height level. Updates self's R byte
 *  in hexDataTex AND every neighbor's neighbor-list nibble in
 *  hexNeighborsTex, plus recomputes hasCliffNbr/hasCliffWithin1Hop bits
 *  for self, neighbors, and 2-hop neighbors (1-hop flag depends on neighbor's
 *  hasCliffNbr).
 *
 *  `cells` is the live cell array (heightLevel will be mutated to match).
 *  `cellByIdMap` is supplied to avoid re-building it per call. */
export function writeHexHeightLevel(
	tex: HexDataTextures,
	cells: HexCell[],
	cellByIdMap: Map<number, HexCell>,
	cellId: number,
	heightLevel: number,
): void {
	const cell = cellByIdMap.get(cellId);
	if (!cell) return;

	cell.heightLevel = heightLevel;
	const off = cellId * 4;
	if (off >= tex.dataBytes.length) return;
	tex.dataBytes[off + 0] = heightLevel & 0xff;

	// Update each neighbor's hexNeighborsTex slot for THIS cell. The
	// edge slot index is wherever this cell appears in the neighbor's
	// edge-walk order.
	for (const nbId of cell.neighbors) {
		const nb = cellByIdMap.get(nbId);
		if (!nb) continue;
		const nbN = nb.corners.length;
		for (let k = 0; k < nbN; k++) {
			const a = nb.corners[k];
			const b = nb.corners[(k + 1) % nbN];
			let hasA = false, hasB = false;
			for (const c of cell.corners) {
				if (c === a) hasA = true;
				if (c === b) hasB = true;
				if (hasA && hasB) break;
			}
			if (!hasA || !hasB) continue;
			// Slot k of nb encodes this cell's heightLevel.
			const xCol = nbId % tex.width;
			const yRowBase = Math.floor(nbId / tex.width) * 2;
			const slotByteOffset = k < 8
				? ((yRowBase * tex.width + xCol) * 4 + Math.floor(k / 2))
				: (((yRowBase + 1) * tex.width + xCol) * 4 + Math.floor((k - 8) / 2));
			const isHighNibble = (k % 2) === 1;
			const cur = tex.neighborBytes[slotByteOffset];
			const newByte = isHighNibble
				? (cur & 0x0f) | ((heightLevel & 0xf) << 4)
				: (cur & 0xf0) | (heightLevel & 0xf);
			tex.neighborBytes[slotByteOffset] = newByte;
			break; // only one slot in nb maps to this cell
		}
	}

	// Recompute hasCliffNbr for self + every neighbor (their cross-tier
	// status may have flipped because self's tier changed).
	const recomputeHasCliffNbr = (c: HexCell): boolean => {
		for (let k = 0; k < c.corners.length; k++) {
			const nb = findNeighborByCorners(c, k, cellByIdMap);
			if (nb && nb.heightLevel !== c.heightLevel) return true;
		}
		return false;
	};

	const affected = new Set<number>([cellId, ...cell.neighbors]);
	const hasCliffMap = new Map<number, boolean>();
	for (const id of affected) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		hasCliffMap.set(id, recomputeHasCliffNbr(c));
	}

	// hasCliffWithin1Hop for self + neighbors + 2-hop (since a 2-hop
	// cell's flag depends on its neighbor's hasCliffNbr, and one of its
	// neighbors might be in `affected`).
	const within1HopAffected = new Set<number>(affected);
	for (const id of affected) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		for (const nbId of c.neighbors) within1HopAffected.add(nbId);
	}
	for (const id of within1HopAffected) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		const own = hasCliffMap.get(id) ?? recomputeHasCliffNbr(c);
		hasCliffMap.set(id, own);
		let oneHop = own;
		if (!oneHop) {
			for (const nbId of c.neighbors) {
				const v = hasCliffMap.get(nbId);
				const nbHas = v !== undefined ? v : recomputeHasCliffNbr(cellByIdMap.get(nbId)!);
				if (nbHas) { oneHop = true; break; }
			}
		}
		const aOff = id * 4 + 3;
		if (aOff < tex.dataBytes.length) {
			tex.dataBytes[aOff] = (own ? 1 : 0) | ((oneHop ? 1 : 0) << 1);
		}
	}

	tex.hexDataTex.update(tex.dataBytes);
	tex.hexNeighborsTex.update(tex.neighborBytes);
	void cells; // signature kept for API symmetry; cellByIdMap is enough
}
