/**
 * Distance-field helpers used to drive coastal ramps, cliff erosion,
 * terrain-blend bands, and the smooth corner unions on hex top faces.
 *
 * All functions take a sample point on the unit sphere (in world-direction
 * space) plus a hex cell and its precomputed `HexBorderInfo`, and return
 * a Euclidean distance / additional metadata. Distances are unit-sphere
 * approximations — fine at the scale of a single hex.
 */
import type { HexCell } from './icosphere';
import { fbmNoise } from './noise';
import {
	type HexBorderInfo,
	findNeighborAcrossEdge,
	getLevelHeight,
} from './hex-borders';

import { COAST_SMOOTHING } from './hex-heights';

/** Distance from point P to line segment AB (Euclidean approximation on unit sphere) */
export function distToSegment(
	px: number, py: number, pz: number,
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number
): number {
	return distToSegmentWithT(px, py, pz, ax, ay, az, bx, by, bz).dist;
}

export function distToSegmentWithT(
	px: number, py: number, pz: number,
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number
): { dist: number; t: number } {
	const abx = bx - ax, aby = by - ay, abz = bz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const ab2 = abx * abx + aby * aby + abz * abz;
	const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2)) : 0;
	const dx = ax + t * abx - px;
	const dy = ay + t * aby - py;
	const dz = az + t * abz - pz;
	return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), t };
}

/** Compute minimum distance to ANY non-excluded edge, and return the ramp target.
 *  Exact-corner snaps are intentionally omitted for water cells; mismatch
 *  corners are filled by dedicated patch geometry instead of distorting the
 *  whole distance field around them. */
export function distToBorderWithTarget(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): { dist: number; target: number; edgeIdx: number; edgeT: number } {
	const n = cell.corners.length;
	let minDist = Infinity;
	let target = -Infinity;
	let edgeIdx = -1;
	let edgeT = 0.5;
	const EPS = 1e-4;
	for (let i = 0; i < n; i++) {
		if (borderInfo.excludedEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const sample = distToSegmentWithT(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (sample.dist < minDist - EPS) {
			minDist = sample.dist;
			target = borderInfo.edgeTargets[i];
			edgeIdx = i;
			edgeT = sample.t;
		} else if (sample.dist < minDist + EPS) {
			// Multiple edges at similar distance (corner) — use highest target
			if (borderInfo.edgeTargets[i] > target) {
				target = borderInfo.edgeTargets[i];
				edgeIdx = i;
				edgeT = sample.t;
			}
			if (sample.dist < minDist) minDist = sample.dist;
		}
	}
	return { dist: minDist, target, edgeIdx, edgeT };
}

/** Find distance to the nearest edge that borders a different terrain type.
 *  Returns { dist, neighborTerrainId } or { dist: Infinity, neighborTerrainId: -1 } if none. */
export function distToTerrainBorder(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo, hexRadius: number
): { dist: number; neighborTerrainId: number } {
	const n = cell.corners.length;
	let minDist = Infinity;
	let neighborTerrain = -1;
	for (let i = 0; i < n; i++) {
		if (borderInfo.edgeNeighborTerrains[i] < 0) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		let d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		// If this edge is also a cliff, perturb the terrain blend distance
		// with the same noise as cliff erosion so colors follow the cliff contour
		if (borderInfo.cliffEdges[i]) {
			const cliffNoise = fbmNoise(vx * 120 + 500, vy * 120 + 500, vz * 120 + 500);
			d = Math.max(0, d + cliffNoise * hexRadius * 0.25);
		}
		if (d < minDist) {
			minDist = d;
			neighborTerrain = borderInfo.edgeNeighborTerrains[i];
		}
	}
	return { dist: minDist, neighborTerrainId: neighborTerrain };
}

/** Distance from a vertex to the nearest steep cliff edge (2+ levels).
 *  Only checks the cell's OWN edges — no neighbor propagation.
 *  Each hex is responsible for its own cliff texture. A "pass" hex with
 *  only 1-level diffs gets zero proximity → no cliff texture. */
export function distToSteepCliff(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): number {
	const n = cell.corners.length;
	let minDist = Infinity;
	for (let i = 0; i < n; i++) {
		if (!borderInfo.steepCliffEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) minDist = d;
	}
	return minDist;
}

/** Distance from a vertex to the nearest gentle land edge (0-1 level diff).
 *  Used to suppress cliff proximity near gentle edges in mixed hexes. */
export function distToGentleLandEdge(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): number {
	const n = cell.corners.length;
	let minDist = Infinity;
	for (let i = 0; i < n; i++) {
		if (!borderInfo.gentleLandEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) minDist = d;
	}
	return minDist;
}

/** Distance from a vertex to the nearest coast edge (water↔land boundary).
 *  Returns Infinity if no coast edges exist on this hex. */
export function distToCoast(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): number {
	const n = cell.corners.length;
	let minDist = Infinity;
	for (let i = 0; i < n; i++) {
		if (!borderInfo.coastEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) minDist = d;
	}
	return minDist;
}

/** Distance from a vertex to the nearest cliff edge and the neighbor's height level. */
export function distToCliffWithTarget(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo, cellById: Map<number, HexCell>
): { dist: number; neighborHeight: number } {
	const n = cell.corners.length;
	let minDist = Infinity;
	let neighborHeight = 0;
	for (let i = 0; i < n; i++) {
		if (!borderInfo.cliffEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) {
			minDist = d;
			const nb = findNeighborAcrossEdge(cell, i, cellById);
			neighborHeight = nb ? getLevelHeight(nb.heightLevel) : 0;
		}
	}
	return { dist: minDist, neighborHeight };
}

export function smoothMin(a: number, b: number, k: number): number {
	if (k <= 0) return Math.min(a, b);
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

export function smoothDistanceToTargetEdges(
	vx: number, vy: number, vz: number,
	cell: HexCell,
	borderInfo: HexBorderInfo,
	targetHeight: number,
	hexRadius: number
): number {
	const n = cell.corners.length;
	const k = hexRadius * COAST_SMOOTHING;
	let result = Infinity;

	for (let i = 0; i < n; i++) {
		if (borderInfo.excludedEdges[i]) continue;
		if (Math.abs(borderInfo.edgeTargets[i] - targetHeight) > 1e-9) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		result = Number.isFinite(result) ? smoothMin(result, d, k) : d;
	}

	return result;
}
