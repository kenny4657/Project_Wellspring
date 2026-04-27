/**
 * Per-cell cliff edge table (GPU displacement Phase 6).
 *
 * Pre-bakes the set of cliff edges visible from each cell so the vertex
 * shader doesn't have to walk 12 1-hop neighbors per vertex. See
 * docs/cliff-edge-prebake.md for design notes.
 *
 * Layout:
 *   hexDataTex.A bits 4-7: cliff edge count (0..12, clamped at 12)
 *   hexCliffEdgesTex (this texture): RGBA32F, 24 texels per cell
 *     slot i, texel 0: (a.x, a.y, a.z, midTier)
 *     slot i, texel 1: (b.x, b.y, b.z, flags) where flags = isSteep|isRock<<1
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import { getLevelHeight } from '../hex-borders';

// 24 covers cells with many cliff neighbors (observed up to 16 at
// 7+ corner cells near tier-2/3/4 transition zones). The alpha-byte
// encoding now uses 6 bits for the count (bits 2-7), so the max is
// 63 if we ever need to bump higher.
const MAX_EDGES_PER_CELL = 24;
const TEXELS_PER_EDGE = 2;
const TEXELS_PER_CELL = MAX_EDGES_PER_CELL * TEXELS_PER_EDGE;
const FLOATS_PER_CELL = TEXELS_PER_CELL * 4;

// ── Edge classifiers (mirror the shader's predicates) ────────
function isCliffEdge(selfH: number, nbH: number): boolean {
	return selfH !== nbH;
}
function isSteepCliffEdge(selfH: number, nbH: number): boolean {
	const sw = selfH <= 1;
	const nw = nbH <= 1;
	if (sw && nw) return false;
	if (!sw && !nw) return Math.abs(selfH - nbH) >= 2;
	if (nw) return selfH > 2;
	if (sw) return nbH > 2;
	return false;
}
function isRockCliff(selfH: number, nbH: number): boolean {
	const sw = selfH <= 1;
	const nw = nbH <= 1;
	if (sw && nw) return false;
	const gap = Math.abs(selfH - nbH);
	if (gap === 0) return false;
	if (sw && nbH <= 2) return false;
	if (nw && selfH <= 2) return false;
	return true;
}

// ── Edge endpoint accessors ──────────────────────────────────
/** Find the neighbor cell across edge `k` of `c` by canonical-corner
 *  reference equality. Same algorithm as in hex-data-tex.ts. */
function findNeighborByCorners(
	c: HexCell, k: number, cellByIdMap: Map<number, HexCell>,
): HexCell | null {
	const a = c.corners[k];
	const b = c.corners[(k + 1) % c.corners.length];
	for (const nId of c.neighbors) {
		const nb = cellByIdMap.get(nId);
		if (!nb) continue;
		let hasA = false, hasB = false;
		for (const cn of nb.corners) {
			if (cn === a) hasA = true;
			if (cn === b) hasB = true;
			if (hasA && hasB) return nb;
		}
	}
	return null;
}

/** A baked cliff edge in canonical form: endpoints are stable Vector3
 *  refs (after canonicalizeCells), `midTier` is computed from the
 *  OWNER cell so cells reading this edge from either side reconstruct
 *  the same h ramp. Two cells across a shared cliff get different
 *  owner-tier values; cliff erosion's weighted average over 1-hop set
 *  symmetrizes them in the original walk. We replicate that here by
 *  passing one entry per (cell-perspective) and letting the weighted
 *  average run as before. */
interface BakedEdge {
	a: Vector3;
	b: Vector3;
	midTier: number;
	isSteep: boolean;
	isRock: boolean;
}

/** Collect all cliff edges visible from cell `c`: own cliff edges +
 *  cliff edges of every immediate neighbor. Edges from a neighbor are
 *  recorded with the NEIGHBOR's tier as the owner — matches what the
 *  shader's 1-hop walk does today. */
function collectCellCliffEdges(
	c: HexCell, cellByIdMap: Map<number, HexCell>,
): BakedEdge[] {
	const edges: BakedEdge[] = [];
	// Dedupe by canonical (a, b) corner pair. After canonicalizeCells, the
	// corner Vector3 instances are shared across cells, so the same physical
	// edge yields the same key regardless of which cell recorded it.
	// Without dedup, edges are recorded multiple times (once per visiting
	// perspective) and the multiplicity differs per cell — cell A sees
	// B-C edge twice (B's perspective + C's perspective, both in A's 1-hop)
	// while cell D might see it once. Asymmetric multiplicity → asymmetric
	// weighted-avg midH → gap. Also: cells like 12908/12910 overflow the
	// 12-slot cap without dedup (16-17 raw entries → truncation drops a
	// different subset per cell, also gap).
	const seen = new Set<string>();

	const recordCellEdges = (owner: HexCell): void => {
		const n = owner.corners.length;
		const ownerH = owner.heightLevel;
		for (let k = 0; k < n; k++) {
			const nb = findNeighborByCorners(owner, k, cellByIdMap);
			if (!nb) continue;
			if (!isCliffEdge(ownerH, nb.heightLevel)) continue;
			const a = owner.corners[k];
			const b = owner.corners[(k + 1) % n];
			const ka = `${a.x.toFixed(7)},${a.y.toFixed(7)},${a.z.toFixed(7)}`;
			const kb = `${b.x.toFixed(7)},${b.y.toFixed(7)},${b.z.toFixed(7)}`;
			const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({
				a,
				b,
				midTier: (getLevelHeight(ownerH) + getLevelHeight(nb.heightLevel)) * 0.5,
				isSteep: isSteepCliffEdge(ownerH, nb.heightLevel),
				isRock: isRockCliff(ownerH, nb.heightLevel),
			});
		}
	};

	recordCellEdges(c);
	for (const nbId of c.neighbors) {
		const nb = cellByIdMap.get(nbId);
		if (nb) recordCellEdges(nb);
	}
	return edges;
}

export interface CliffEdgesTexture {
	tex: RawTexture;
	data: Float32Array;
	width: number;
	height: number;
	/** Per-cell edge count (matches the bits packed into hexDataTex.A 4-7). */
	counts: Uint8Array;
}

export function buildCliffEdgesTexture(cells: HexCell[], scene: Scene): CliffEdgesTexture {
	const cellByIdMap = new Map<number, HexCell>();
	let maxId = 0;
	for (const c of cells) {
		cellByIdMap.set(c.id, c);
		if (c.id > maxId) maxId = c.id;
	}

	const numCells = maxId + 1;
	// Texture geometry: width 256, height covers `numCells * TEXELS_PER_CELL`.
	const W = 256;
	const totalTexels = numCells * TEXELS_PER_CELL;
	const H = Math.max(1, Math.ceil(totalTexels / W));
	const data = new Float32Array(W * H * 4);
	const counts = new Uint8Array(numCells);

	let truncatedCells = 0;
	for (const c of cells) {
		const edges = collectCellCliffEdges(c, cellByIdMap);
		if (edges.length > MAX_EDGES_PER_CELL) {
			truncatedCells++;
			edges.length = MAX_EDGES_PER_CELL;
		}
		counts[c.id] = edges.length;

		const base = c.id * FLOATS_PER_CELL;
		for (let i = 0; i < edges.length; i++) {
			const e = edges[i];
			const off = base + i * 8;
			data[off + 0] = e.a.x;
			data[off + 1] = e.a.y;
			data[off + 2] = e.a.z;
			data[off + 3] = e.midTier;
			data[off + 4] = e.b.x;
			data[off + 5] = e.b.y;
			data[off + 6] = e.b.z;
			data[off + 7] = (e.isSteep ? 1 : 0) | ((e.isRock ? 1 : 0) << 1);
		}
	}

	if (truncatedCells > 0) {
		console.warn(`[cliff-edges-tex] ${truncatedCells} cell(s) had > ${MAX_EDGES_PER_CELL} cliff edges; truncated.`);
	}

	const tex = new RawTexture(
		data, W, H,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_FLOAT,
	);
	tex.name = 'gpuHexCliffEdges';

	return { tex, data, width: W, height: H, counts };
}

/** Rebuild the cliff edge table for a specific cell — used when its
 *  height level (or a neighbor's, transitively) changes. Updates the
 *  CPU-side `data` and `counts`; caller is responsible for re-uploading
 *  the texture. */
export function rebuildCellCliffEdges(
	tex: CliffEdgesTexture,
	cellByIdMap: Map<number, HexCell>,
	cellId: number,
): void {
	const c = cellByIdMap.get(cellId);
	if (!c) return;
	const edges = collectCellCliffEdges(c, cellByIdMap);
	if (edges.length > MAX_EDGES_PER_CELL) edges.length = MAX_EDGES_PER_CELL;
	tex.counts[cellId] = edges.length;

	const base = cellId * FLOATS_PER_CELL;
	for (let i = 0; i < MAX_EDGES_PER_CELL; i++) {
		const off = base + i * 8;
		if (i < edges.length) {
			const e = edges[i];
			tex.data[off + 0] = e.a.x;
			tex.data[off + 1] = e.a.y;
			tex.data[off + 2] = e.a.z;
			tex.data[off + 3] = e.midTier;
			tex.data[off + 4] = e.b.x;
			tex.data[off + 5] = e.b.y;
			tex.data[off + 6] = e.b.z;
			tex.data[off + 7] = (e.isSteep ? 1 : 0) | ((e.isRock ? 1 : 0) << 1);
		} else {
			// Zero unused slots so a stale higher-count read can't pick them up.
			tex.data[off + 0] = 0;
			tex.data[off + 1] = 0;
			tex.data[off + 2] = 0;
			tex.data[off + 3] = 0;
			tex.data[off + 4] = 0;
			tex.data[off + 5] = 0;
			tex.data[off + 6] = 0;
			tex.data[off + 7] = 0;
		}
	}
}

export const CLIFF_EDGES_MAX_PER_CELL = MAX_EDGES_PER_CELL;
export const CLIFF_EDGES_TEXELS_PER_CELL = TEXELS_PER_CELL;
