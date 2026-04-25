/**
 * Per-edge classification for hex cells.
 *
 * Determines which edges are coastlines, cliffs, gentle land seams, etc.,
 * and produces the per-cell `HexBorderInfo` that downstream distance fields
 * and height computation consume.
 */
import type { HexCell } from './icosphere';

/** Height offsets per discrete height level (fraction of globe radius).
 *  Height level is independent of terrain type. */
export const LEVEL_HEIGHTS = [
	-0.020,  // level 0: deep water
	-0.008,  // level 1: shallow water
	 0.000,  // level 2: lowland
	 0.005,  // level 3: midland
	 0.010,  // level 4: highland
];

export const CORNER_KEY_SCALE = 1e6;

export function getLevelHeight(level: number): number {
	return LEVEL_HEIGHTS[Math.min(level, LEVEL_HEIGHTS.length - 1)] ?? 0;
}

/** Border info for any hex — controls which edges get cosine ramps.
 *  Works for both water hexes (coastline + depth transitions) and
 *  land hexes (coastline smoothing toward water). */
export interface HexBorderInfo {
	excludedEdges: boolean[];  // true = edge excluded from distance calc (no ramp)
	edgeTargets: number[];     // ramp target height per non-excluded edge
	allSameHeight: boolean;    // ALL neighbors at exact same height level (deep ocean fast path)
	hasBorder: boolean;        // has at least one non-excluded edge
	edgeNeighborTerrains: number[]; // terrain ID of neighbor across each edge (-1 if same terrain)
	hasTerrainBorder: boolean;      // any edge borders a different terrain type
	coastEdges: boolean[];     // true = edge borders water↔land transition
	hasCoast: boolean;         // any edge is a coastline
	cliffEdges: boolean[];     // true = edge has land-land height difference
	hasCliff: boolean;         // any edge is a cliff
	steepCliffEdges: boolean[];  // true = edge has 2+ level height difference
	hasSteepCliff: boolean;      // any edge is a steep cliff
	gentleLandEdges: boolean[];  // true = land-land edge with 0-1 level diff
	hasGentleLandEdge: boolean;
}

/**
 * Per-edge classification result. `edgeTarget` is the height the edge
 * ramps toward (used to build corner/interior surfaces). The flags below
 * drive distance fields, shader coloring, and exclusion from the ramp.
 *
 * Semantics quick-reference:
 *   coast      — water↔land edge that SHOULD render a beach (low-land shores only).
 *   cliff      — any edge across a height difference (land↔land or land↔water high-drop).
 *   steepCliff — cliff with 2+ level diff → rock texture, steep ramp geometry.
 *   gentleLand — land↔land with ≤1 level diff → no cliff texture, smooth ramp.
 *   excluded   — edge ignored by the coastal-ramp distance competition
 *                (cliffs handle their own geometry; same-depth water edges
 *                drop out so the ramp can extend broadly across the hex).
 */
export interface EdgeClass {
	edgeTarget: number;
	excluded: boolean;
	coast: boolean;
	cliff: boolean;
	steepCliff: boolean;
	gentleLand: boolean;
}

export const EMPTY_EDGE: EdgeClass = {
	edgeTarget: 0, excluded: false,
	coast: false, cliff: false, steepCliff: false, gentleLand: false,
};

/** Water hex edge whose neighbor is also water.
 *  Target: minimum depth of the two hexes (shared lower bowl).
 *  Excluded only when both hexes are "open water" (≤2 land neighbors each)
 *  so the coastline ramp of a nearby shore hex can sweep through. Small
 *  lakes keep edges active so the water body retains hex shape. */
export function classifyWaterToWater(cell: HexCell, nb: HexCell, cellById: Map<number, HexCell>): EdgeClass {
	const target = getLevelHeight(Math.min(cell.heightLevel, nb.heightLevel));
	let excluded = false;
	if (cell.heightLevel === nb.heightLevel) {
		const cellLand = countLandNeighbors(cell, cellById);
		const nbLand = countLandNeighbors(nb, cellById);
		if (cellLand <= 2 && nbLand <= 2) excluded = true;
	}
	return { ...EMPTY_EDGE, edgeTarget: target, excluded };
}

/** Water hex edge whose neighbor is LOW land (heightLevel ≤ 2).
 *  Ramp the water edge up to sea level and flag as coast → shader paints
 *  the beach band. This is the ordinary gentle shoreline. */
export function classifyWaterToLowLand(): EdgeClass {
	return { ...EMPTY_EDGE, edgeTarget: 0, coast: true };
}

/** Water hex edge whose neighbor is a CLIFF (land heightLevel > 2).
 *  Ramp to sea level for clean geometry joining with the cliff foot, but
 *  do NOT flag as coast — distToCoast will ignore this edge so no sand is
 *  painted directly against the cliff. If an adjacent edge of the same
 *  water hex is a low-land coast, its coastProximity naturally fades off
 *  along this edge away from the shared corner → graceful beach taper. */
export function classifyWaterToCliff(): EdgeClass {
	return { ...EMPTY_EDGE, edgeTarget: 0 };
}

/** Low-land hex edge whose neighbor is water.
 *  Ramp land down to sea level and flag as coast (beach on the land side). */
export function classifyLowLandToWater(): EdgeClass {
	return { ...EMPTY_EDGE, edgeTarget: 0, coast: true };
}

/** High-land hex edge whose neighbor is water: coastal cliff.
 *  Marked as a steep cliff (rock texture) and excluded from the ramp
 *  distance field — the cliff erosion logic handles the face geometry. */
export function classifyCliffToWater(): EdgeClass {
	return { ...EMPTY_EDGE, cliff: true, steepCliff: true, excluded: true };
}

/** Land hex edge whose neighbor is also land.
 *  All such edges are excluded from the coastal ramp — cliff erosion
 *  handles height differences. Flags depend on the level gap:
 *    gap 0      → gentleLand (blend seam, no cliff)
 *    gap 1      → cliff + gentleLand (soft slope, no rock texture)
 *    gap ≥ 2    → cliff + steepCliff (rock face + steep ramp) */
export function classifyLandToLand(cell: HexCell, nb: HexCell): EdgeClass {
	const gap = Math.abs(nb.heightLevel - cell.heightLevel);
	return {
		edgeTarget: 0, excluded: true, coast: false,
		cliff: gap > 0,
		steepCliff: gap >= 2,
		gentleLand: gap <= 1,
	};
}

/** Dispatch to the correct per-edge classifier. */
export function classifyEdge(cell: HexCell, nb: HexCell, cellById: Map<number, HexCell>): EdgeClass {
	const cellIsWater = cell.heightLevel <= 1;
	const nbIsWater = nb.heightLevel <= 1;

	if (cellIsWater && nbIsWater) return classifyWaterToWater(cell, nb, cellById);
	if (cellIsWater && !nbIsWater) return nb.heightLevel > 2 ? classifyWaterToCliff() : classifyWaterToLowLand();
	if (!cellIsWater && nbIsWater) return cell.heightLevel > 2 ? classifyCliffToWater() : classifyLowLandToWater();
	return classifyLandToLand(cell, nb);
}

export function cornerKey(x: number, y: number, z: number): string {
	return `${Math.round(x * CORNER_KEY_SCALE)},${Math.round(y * CORNER_KEY_SCALE)},${Math.round(z * CORNER_KEY_SCALE)}`;
}

/** Find the neighbor across a given hex edge (by edge midpoint direction). */
export function findNeighborAcrossEdge(cell: HexCell, edgeIdx: number, cellById: Map<number, HexCell>): HexCell | null {
	const n = cell.corners.length;
	const midX = (cell.corners[edgeIdx].x + cell.corners[(edgeIdx + 1) % n].x) / 2;
	const midY = (cell.corners[edgeIdx].y + cell.corners[(edgeIdx + 1) % n].y) / 2;
	const midZ = (cell.corners[edgeIdx].z + cell.corners[(edgeIdx + 1) % n].z) / 2;
	const dirX = midX - cell.center.x;
	const dirY = midY - cell.center.y;
	const dirZ = midZ - cell.center.z;

	let closestNb: HexCell | null = null;
	let closestDot = -Infinity;
	for (const nId of cell.neighbors) {
		const nb = cellById.get(nId);
		if (!nb) continue;
		const dot = dirX * (nb.center.x - cell.center.x) +
		            dirY * (nb.center.y - cell.center.y) +
		            dirZ * (nb.center.z - cell.center.z);
		if (dot > closestDot) { closestDot = dot; closestNb = nb; }
	}
	return closestNb;
}

export function countLandNeighbors(cell: HexCell, cellById: Map<number, HexCell>): number {
	let count = 0;
	for (const nId of cell.neighbors) {
		const nb = cellById.get(nId);
		if (nb && nb.heightLevel > 1) count++;
	}
	return count;
}

export function getHexBorderInfo(cell: HexCell, cellById: Map<number, HexCell>): HexBorderInfo {
	const n = cell.corners.length;
	const excludedEdges: boolean[] = new Array(n).fill(false);
	const edgeTargets: number[] = new Array(n).fill(0);
	const edgeNeighborTerrains: number[] = new Array(n).fill(-1);
	const coastEdges: boolean[] = new Array(n).fill(false);
	const cliffEdges: boolean[] = new Array(n).fill(false);
	const steepCliffEdges: boolean[] = new Array(n).fill(false);
	const gentleLandEdges: boolean[] = new Array(n).fill(false);
	let excludedCount = 0;
	let exactSameCount = 0;
	let hasTerrainBorder = false;
	let hasCoast = false;
	let hasCliff = false;
	let hasSteepCliff = false;
	let hasGentleLandEdge = false;
	const isWater = cell.heightLevel <= 1;

	for (let i = 0; i < n; i++) {
		const nb = findNeighborAcrossEdge(cell, i, cellById);
		if (!nb) continue;

		// Track terrain-type differences for color blending (land↔land only;
		// water hexes use coastline ramps instead of cross-terrain blending).
		if (nb.terrain !== cell.terrain && nb.heightLevel > 1 && cell.heightLevel > 1) {
			edgeNeighborTerrains[i] = nb.terrain;
			hasTerrainBorder = true;
		}

		if (nb.heightLevel === cell.heightLevel) exactSameCount++;

		const ec = classifyEdge(cell, nb, cellById);
		edgeTargets[i] = ec.edgeTarget;
		if (ec.excluded) { excludedEdges[i] = true; excludedCount++; }
		if (ec.coast) { coastEdges[i] = true; hasCoast = true; }
		if (ec.cliff) { cliffEdges[i] = true; hasCliff = true; }
		if (ec.steepCliff) { steepCliffEdges[i] = true; hasSteepCliff = true; }
		if (ec.gentleLand) { gentleLandEdges[i] = true; hasGentleLandEdge = true; }
	}

	return {
		excludedEdges, edgeTargets,
		allSameHeight: isWater && exactSameCount >= n,
		hasBorder: excludedCount < n,
		edgeNeighborTerrains, hasTerrainBorder,
		coastEdges, hasCoast,
		cliffEdges, hasCliff,
		steepCliffEdges, hasSteepCliff,
		gentleLandEdges, hasGentleLandEdge,
	};
}

export function buildCornerTargetMap(cells: HexCell[], borderInfoById: Map<number, HexBorderInfo>): Map<string, number> {
	const cornerTargets = new Map<string, number>();

	for (const cell of cells) {
		const borderInfo = borderInfoById.get(cell.id);
		if (!borderInfo) continue;
		const isWater = cell.heightLevel <= 1;
		const n = cell.corners.length;

		for (let i = 0; i < n; i++) {
			const prev = (i + n - 1) % n;
			let best = cornerTargets.get(cornerKey(cell.corners[i].x, cell.corners[i].y, cell.corners[i].z)) ?? -Infinity;

			if (isWater || !borderInfo.excludedEdges[prev]) {
				best = Math.max(best, borderInfo.edgeTargets[prev]);
			}
			if (isWater || !borderInfo.excludedEdges[i]) {
				best = Math.max(best, borderInfo.edgeTargets[i]);
			}

			if (best > -Infinity) {
				cornerTargets.set(cornerKey(cell.corners[i].x, cell.corners[i].y, cell.corners[i].z), best);
			}
		}
	}

	return cornerTargets;
}

export function getLocalCornerActiveTarget(
	cell: HexCell,
	borderInfo: HexBorderInfo,
	cornerIdx: number
): number | undefined {
	const n = cell.corners.length;
	const prev = (cornerIdx + n - 1) % n;
	let best = -Infinity;

	if (!borderInfo.excludedEdges[prev]) best = Math.max(best, borderInfo.edgeTargets[prev]);
	if (!borderInfo.excludedEdges[cornerIdx]) best = Math.max(best, borderInfo.edgeTargets[cornerIdx]);

	return best > -Infinity ? best : undefined;
}
