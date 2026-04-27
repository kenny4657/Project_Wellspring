/**
 * Per-hex corner-position texture (also packs neighbor hex IDs).
 *
 * Layout: same `width` as `hexDataTex`, with `6 × hexDataHeight`
 * rows — 6 pixels per hex (one per corner / edge). Corner `k` of
 * hex `id` lives at:
 *
 *   ivec2 coord = ivec2(id % W, (id / W) * 6 + k);
 *   vec4 v = texelFetch(hexCornersTex, coord, 0);
 *   vec3 corner = v.rgb;
 *   int neighborIdAcrossEdgeK = int(v.a + 0.5);
 *
 * Edge `k` of the hex spans corner `k` to corner `(k+1) % edgeCount`.
 * The neighbor across that edge is encoded in the alpha channel of
 * the corner-`k` pixel. -1 means no neighbor (boundary).
 *
 * Pentagons (5 corners): the unused 6th slot duplicates corner[0]
 * with neighborId = -1, so a fixed-size shader loop with
 * `edgeCount` early-out walks exactly 5 unique edges.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';

/** Find neighbor across edge by canonical-corner reference equality. */
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

/** Build a Map from canonical-corner-key → averaged unit-direction.
 *  icosphere.ts dedupes corners within a single hex but leaves cross-hex
 *  drift: two hexes that share a physical corner can store slightly
 *  different Vector3 values (each computed from a different ico
 *  triangle's slerp). That FP drift means each hex's edge endpoints
 *  differ at the shared seam, so the same world position computes
 *  slightly different distances from each side → mu mismatch → seam
 *  gap. Canonicalizing forces both hexes to use the same value. */
// Maximum slerp-drift distance between two hex copies of the same physical
// corner. Drift is observed up to ~8e-3 near pentagon vertices (where 5
// ico triangles meet and their slerps disagree). Real distinct corners
// are ≥ ~1.05e-2 apart (cell 0's observed min pairwise dist), so an
// 8.5e-3 merge radius sits safely between drift and corner spacing.
const MERGE_RADIUS = 8.5e-3;
const MERGE_RADIUS2 = MERGE_RADIUS * MERGE_RADIUS;
const GRID_STEP = MERGE_RADIUS; // grid cell side equal to merge radius

interface CanonHit { vec: Vector3 }

/** For each input corner, find or create a canonical Vector3 for its
 *  point cluster. Two corners within MERGE_RADIUS are clustered.
 *  Spatial hash keeps lookup O(1) per query. */
function buildCanonicalLookup(cells: HexCell[]): {
	grid: Map<string, CanonHit[]>;
	allCanon: CanonHit[];
} {
	const grid = new Map<string, CanonHit[]>();
	const allCanon: CanonHit[] = [];

	const findOrInsert = (corner: Vector3): CanonHit => {
		const ix = Math.floor(corner.x / GRID_STEP);
		const iy = Math.floor(corner.y / GRID_STEP);
		const iz = Math.floor(corner.z / GRID_STEP);
		// Check this cell + 26 neighbors for an existing canon within radius.
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					const k = `${ix + dx},${iy + dy},${iz + dz}`;
					const list = grid.get(k);
					if (!list) continue;
					for (const c of list) {
						const ddx = c.vec.x - corner.x;
						const ddy = c.vec.y - corner.y;
						const ddz = c.vec.z - corner.z;
						if (ddx * ddx + ddy * ddy + ddz * ddz < MERGE_RADIUS2) return c;
					}
				}
			}
		}
		// Not found — insert.
		const hit: CanonHit = { vec: new Vector3(corner.x, corner.y, corner.z) };
		const k = `${ix},${iy},${iz}`;
		let list = grid.get(k);
		if (!list) { list = []; grid.set(k, list); }
		list.push(hit);
		allCanon.push(hit);
		return hit;
	};

	for (const c of cells) {
		for (const corner of c.corners) findOrInsert(corner);
	}
	return { grid, allCanon };
}

function findCanon(grid: Map<string, CanonHit[]>, corner: Vector3): Vector3 | null {
	const ix = Math.floor(corner.x / GRID_STEP);
	const iy = Math.floor(corner.y / GRID_STEP);
	const iz = Math.floor(corner.z / GRID_STEP);
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				const k = `${ix + dx},${iy + dy},${iz + dz}`;
				const list = grid.get(k);
				if (!list) continue;
				for (const c of list) {
					const ddx = c.vec.x - corner.x;
					const ddy = c.vec.y - corner.y;
					const ddz = c.vec.z - corner.z;
					if (ddx * ddx + ddy * ddy + ddz * ddz < MERGE_RADIUS2) return c.vec;
				}
			}
		}
	}
	return null;
}

export function canonicalizeCells(cells: HexCell[]): void {
	const cornersBefore = cells.reduce((s, c) => s + c.corners.length, 0);
	const corner7sBefore = cells.filter(c => c.corners.length >= 7).length;

	// Inspect a problem cell: dump its corners + min pairwise distance.
	const problem = cells.find(c => c.id === 0);
	if (problem) {
		console.log(`[canon] cell 0 has ${problem.corners.length} corners:`);
		for (const c of problem.corners) {
			console.log(`  (${c.x.toFixed(6)}, ${c.y.toFixed(6)}, ${c.z.toFixed(6)})`);
		}
		let minD = Infinity, maxD = 0;
		for (let i = 0; i < problem.corners.length; i++) {
			for (let j = i + 1; j < problem.corners.length; j++) {
				const a = problem.corners[i], b = problem.corners[j];
				const d = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2);
				if (d < minD) minD = d;
				if (d > maxD) maxD = d;
			}
		}
		console.log(`  min pairwise dist: ${minD.toFixed(6)}, max: ${maxD.toFixed(6)}`);
	}

	// Step 1: build a canonical-vector lookup. Each cluster of corners
	// within MERGE_RADIUS becomes a single canonical Vector3. Spatial
	// hash makes the per-corner query O(1).
	const { grid, allCanon } = buildCanonicalLookup(cells);
	console.log(`[canon] ${cornersBefore} corner instances → ${allCanon.length} unique canonical points (merge ratio ${(cornersBefore / allCanon.length).toFixed(2)})`);

	// Step 2: snap each cell's corners to the canonical vector of their
	// cluster, dedupe (multiple corners hitting the same canonical
	// become one), and re-sort isn't needed because angular order is
	// preserved (all cluster reps are sorted relative to each other).
	for (const c of cells) {
		const seen = new Set<Vector3>();
		const kept: Vector3[] = [];
		for (const corner of c.corners) {
			const canon = findCanon(grid, corner);
			if (canon && !seen.has(canon)) {
				seen.add(canon);
				kept.push(canon); // share the canonical Vector3 across all hexes
			}
		}
		c.corners = kept;
	}

	// Step 3: rebuild neighbor sets from canonical corner overlap.
	// Cells sharing ≥2 canonical corners are neighbors. icosphere.ts
	// only links cells inside the same ico triangle's patch, so this
	// rebuild also catches cross-triangle pairs that were missing.
	const canonToCells = new Map<Vector3, number[]>();
	for (const c of cells) {
		for (const corner of c.corners) {
			let list = canonToCells.get(corner);
			if (!list) { list = []; canonToCells.set(corner, list); }
			if (!list.includes(c.id)) list.push(c.id);
		}
	}
	for (const c of cells) {
		const counts = new Map<number, number>();
		for (const corner of c.corners) {
			const list = canonToCells.get(corner);
			if (!list) continue;
			for (const cId of list) {
				if (cId === c.id) continue;
				counts.set(cId, (counts.get(cId) || 0) + 1);
			}
		}
		c.neighbors.clear();
		for (const [cId, count] of counts) {
			if (count >= 2) c.neighbors.add(cId);
		}
	}

	const cornersAfter = cells.reduce((s, c) => s + c.corners.length, 0);
	const corner7sAfter = cells.filter(c => c.corners.length >= 7).length;
	console.log(`[canonicalize] corners: ${cornersBefore} → ${cornersAfter}, 7+ cells: ${corner7sBefore} → ${corner7sAfter}, total cells: ${cells.length}`);

	const cell0 = cells.find(c => c.id === 0);
	const cell9471 = cells.find(c => c.id === 9471);
	if (cell0 && cell9471) {
		console.log(`[canon] cell 0 neighbors: ${[...cell0.neighbors].sort((a,b)=>a-b).join(',')}`);
		console.log(`[canon] cell 9471 neighbors: ${[...cell9471.neighbors].sort((a,b)=>a-b).join(',')}`);
		// Count shared canonical Vector3s by reference identity.
		const set0 = new Set(cell0.corners);
		let shared = 0;
		for (const c of cell9471.corners) if (set0.has(c)) shared++;
		console.log(`[canon] cell 0 ↔ 9471 share ${shared} canonical corners (need ≥2 for neighbor)`);
	}
}

export interface HexCornersTexture {
	tex: RawTexture;
	width: number;
	height: number;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

export function buildHexCornersTexture(cells: HexCell[], scene: Scene): HexCornersTexture {
	const numHexes = cells.length;
	let maxId = 0;
	for (const c of cells) if (c.id > maxId) maxId = c.id;
	const idCount = maxId + 1;

	const W = nextPow2(Math.ceil(Math.sqrt(idCount)));
	const baseH = nextPow2(Math.ceil(idCount / W));
	// 12 rows per cell to cover the largest observed cells (max 10
	// corners) with margin. Slots beyond edgeCount duplicate corners[0]
	// and store neighborId=-1 so the shader's loop early-out works.
	const H = baseH * 12;

	const data = new Float32Array(W * H * 4);

	const cellByIdMap = new Map<number, HexCell>();
	for (const c of cells) cellByIdMap.set(c.id, c);

	for (let id = 0; id <= maxId; id++) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		const corners = c.corners;
		const edgeCount = corners.length;
		const xCol = id % W;
		const yRowBase = Math.floor(id / W) * 12;
		for (let k = 0; k < 12; k++) {
			const corner = corners[k] ?? corners[0];
			let neighborId = -1;
			if (k < edgeCount) {
				const nb = findNeighborByCorners(c, k, cellByIdMap);
				if (nb) neighborId = nb.id;
			}
			const px = (yRowBase + k) * W + xCol;
			data[px * 4 + 0] = corner.x;
			data[px * 4 + 1] = corner.y;
			data[px * 4 + 2] = corner.z;
			data[px * 4 + 3] = neighborId;
		}
	}

	const tex = new RawTexture(
		data, W, H,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_FLOAT,
	);
	tex.name = 'gpuHexCorners';

	return { tex, width: W, height: H };
}
