/**
 * Height computation for hex top faces.
 *
 * `computeSurfaceHeight` produces the base displaced height; the cliff
 * erosion variant adds steep / gentle cliff ramps near land-land edges;
 * `cornerPatchHeight` is used by water corner patches that fill the
 * triangular gap left when adjacent hexes disagree on a corner radius.
 */
import type { HexCell } from './icosphere';
import { fbmNoise } from './noise';
import {
	type HexBorderInfo,
	findNeighborAcrossEdge,
	getLevelHeight,
} from './hex-borders';
import {
	distToBorderWithTarget,
	distToSegment,
	smoothDistanceToTargetEdges,
} from './hex-distance-fields';

/** Walls extend down to this floor */
export const BASE_HEIGHT = -0.050;

/** Global noise amplitude (fraction of radius). Continuous across all hexes. */
export const NOISE_AMP = 0.008;

/** Noise scale (unit sphere coords). ~35 gives terrain features within hexes */
export const NOISE_SCALE = 35.0;

export const COAST_ROUNDING = 0.0018;
export const COAST_SMOOTHING = 0.22;
export const CORNER_PATCH_EDGE_T = 0.18;

/** Compute the top-surface height at a point using the same logic as the subdivided top face. */
export function computeSurfaceHeight(
	ux: number, uy: number, uz: number,
	cell: HexCell,
	borderInfo: HexBorderInfo,
	hexRadius: number,
	tierH: number,
	isWaterHex: boolean
): number {
	const rawNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
	// Interior noise: water uses abs(), land biases upward (+0.3)
	const interiorNoiseH = isWaterHex ? Math.abs(rawNoise) : rawNoise + 0.3;
	// Border noise: MUST match on both sides of shared edges.
	// At coastline (borderTarget=0), both water and land use the same formula.
	const borderNoiseH = Math.abs(rawNoise) + 0.15;

	if (isWaterHex && borderInfo.allSameHeight) {
		return tierH + interiorNoiseH * NOISE_AMP;
	}

	if (borderInfo.hasBorder) {
		const nearest = distToBorderWithTarget(ux, uy, uz, cell, borderInfo);
		let dist = nearest.dist;
		const borderTarget = nearest.target;
		const edgeIdx = nearest.edgeIdx;
		const edgeT = nearest.edgeT;

		// Round coastline corners by blending adjacent coast-edge distance fields
		// into a smooth union instead of using a hard nearest-edge switch.
		if (borderTarget === 0) {
			dist = Math.min(dist, smoothDistanceToTargetEdges(ux, uy, uz, cell, borderInfo, 0, hexRadius));
		}

		const t = Math.min(dist / hexRadius, 1.0);
		const mu = (1 - Math.cos(t * Math.PI)) / 2;

		// Noise coefficient must MATCH at shared borders:
		// - Water↔water: border noise = NOISE_AMP (flat neighbor uses full noise)
		// - Water↔land: border noise = NOISE_AMP * 0.3 (both sides use 0.3 at coast)
		const isWaterNeighborBorder = borderTarget < -0.001;
		const borderNoiseCoeff = isWaterNeighborBorder ? NOISE_AMP : NOISE_AMP * 0.3;
		const interiorNoiseCoeff = NOISE_AMP;
		const noiseCoeff = interiorNoiseCoeff * mu + borderNoiseCoeff * (1 - mu);
		// Blend between interior noise shape and border noise shape
		// so both sides of the shared edge use identical noise at dist=0
		const noiseH = interiorNoiseH * mu + borderNoiseH * (1 - mu);
		let h = tierH * mu + borderTarget * (1 - mu) + noiseH * noiseCoeff;

		// Keep coastline continuity exact at the shared edge, but hold the terrain
		// slightly lower around the middle of each coastal edge so the visible
		// shoreline contour reads rounder and less like a straight hex cut.
		if (borderTarget === 0 && edgeIdx >= 0) {
			const coastMid = 4 * edgeT * (1 - edgeT);      // 0 at corners, 1 at edge midpoint
			const coastBlend = mu * (1 - mu);              // 0 on the edge and in the far interior
			h -= COAST_ROUNDING * coastMid * coastBlend * 4;
		}

		return h;
	}

	return tierH + interiorNoiseH * NOISE_AMP;
}

/** Compute the mean corner-distance of a cell — same formula as
 *  computeHexRadius in globe-mesh.ts. Defined locally so cliff erosion
 *  can compute the neighbor's hexRadius for symmetric cliff distance. */
function cellHexRadius(cell: HexCell): number {
	const n = cell.corners.length;
	let r = 0;
	for (let i = 0; i < n; i++) {
		const dx = cell.corners[i].x - cell.center.x;
		const dy = cell.corners[i].y - cell.center.y;
		const dz = cell.corners[i].z - cell.center.z;
		r += Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	return r / n;
}

/** Apply one cliff edge's contribution to bestMu/bestMidH if it produces a
 *  smaller mu than the current best. Used by both the self-edge loop and
 *  the neighbor-edge loop so they stay byte-identical. */
function applyCliffEdge(
	ux: number, uy: number, uz: number,
	a: { x: number; y: number; z: number },
	b: { x: number; y: number; z: number },
	isSteep: boolean,
	ownerHexRadius: number,
	cliffNoise: number,
	midNoise: number,
	selfTierH: number,
	otherTierH: number,
	bestMu: number,
	bestMidH: number,
): { bestMu: number; bestMidH: number } {
	const dist = distToSegment(ux, uy, uz, a.x, a.y, a.z, b.x, b.y, b.z);
	let mu: number;
	if (isSteep) {
		const rampWidth = ownerHexRadius * 0.2;
		const perturbedDist = Math.max(0, dist + cliffNoise * ownerHexRadius * 0.25);
		const t = Math.min(perturbedDist / rampWidth, 1.0);
		mu = t * (2 - t);
	} else {
		const rampWidth = ownerHexRadius * 0.7;
		const t = Math.min(dist / rampWidth, 1.0);
		mu = (1 - Math.cos(t * Math.PI)) / 2;
	}
	if (mu < bestMu) {
		const midTierH = (selfTierH + otherTierH) / 2;
		return {
			bestMu: mu,
			bestMidH: midTierH + (Math.abs(midNoise) + 0.15) * NOISE_AMP * 0.3,
		};
	}
	return { bestMu, bestMidH };
}

/** Compute height with per-edge-type handling:
 *  - Steep cliff edges (2+ level diff): narrow parabolic ramp → steep geometry → cliff texture
 *  - Gentle slope edges (1-level diff): wide cosine ramp → smooth geometry → no cliff texture
 *
 *  Symmetry: each side of a non-cliff shared edge sees the SAME set of
 *  cliff edges (own + 1-hop neighbors' cliff edges) and uses each cliff
 *  edge's *owner* hexRadius for ramp/perturbation. So at every shared
 *  point, both sides compute identical mu and identical heights — no
 *  geometry gap along seams adjacent to a cliff. */
export function computeHeightWithCliffErosion(
	ux: number, uy: number, uz: number,
	cell: HexCell, borderInfo: HexBorderInfo,
	hexRadius: number, tierH: number, isWaterHex: boolean,
	cellById: Map<number, HexCell>,
	borderInfoById?: Map<number, HexBorderInfo>,
): number {
	const h = computeSurfaceHeight(ux, uy, uz, cell, borderInfo, hexRadius, tierH, isWaterHex);

	const cliffNoise = fbmNoise(ux * 120 + 500, uy * 120 + 500, uz * 120 + 500);
	const midNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);

	let bestMu = 1.0;
	let bestMidH = h;
	const n = cell.corners.length;

	// 1) Self's own cliff edges.
	if (borderInfo.hasCliff) {
		for (let i = 0; i < n; i++) {
			if (!borderInfo.cliffEdges[i]) continue;
			const a = cell.corners[i];
			const b = cell.corners[(i + 1) % n];
			const nb = findNeighborAcrossEdge(cell, i, cellById);
			const neighborHeight = nb ? getLevelHeight(nb.heightLevel) : 0;
			const isSteep = borderInfo.steepCliffEdges[i];
			const out = applyCliffEdge(
				ux, uy, uz, a, b, isSteep,
				hexRadius, cliffNoise, midNoise,
				tierH, neighborHeight, bestMu, bestMidH,
			);
			bestMu = out.bestMu; bestMidH = out.bestMidH;
		}
	}

	// 2) Neighbor cliff edges (1-hop) so both sides of any shared edge
	//    see the same cliff distance field. Without this, two same-tier
	//    neighbors near a common cliff compute different cliff-erosion
	//    pulls along their shared edge → height drift → visible gap.
	//
	//    For each non-cliff edge of self, look up the across-neighbor
	//    and consider its cliff edges in the distance calculation.
	//    Each cliff edge's *owner* hexRadius drives its ramp width and
	//    perturbation, so the calculation for that edge is identical
	//    regardless of which adjacent cell triggered the inclusion.
	if (borderInfoById) {
		for (let i = 0; i < n; i++) {
			if (borderInfo.cliffEdges[i]) continue; // already in (1)
			const nb = findNeighborAcrossEdge(cell, i, cellById);
			if (!nb) continue;
			const nbInfo = borderInfoById.get(nb.id);
			if (!nbInfo || !nbInfo.hasCliff) continue;
			const nbHexRadius = cellHexRadius(nb);
			const nbTierH = getLevelHeight(nb.heightLevel);
			const nbN = nb.corners.length;
			for (let j = 0; j < nbN; j++) {
				if (!nbInfo.cliffEdges[j]) continue;
				// Skip neighbor's edge that's the same shared edge with self
				// (we'd be double-counting from self's perspective if it
				// were a cliff edge — but it's not since we filtered above).
				const a = nb.corners[j];
				const b = nb.corners[(j + 1) % nbN];
				const nbNb = findNeighborAcrossEdge(nb, j, cellById);
				const nbNbHeight = nbNb ? getLevelHeight(nbNb.heightLevel) : 0;
				const isSteep = nbInfo.steepCliffEdges[j];
				const out = applyCliffEdge(
					ux, uy, uz, a, b, isSteep,
					nbHexRadius, cliffNoise, midNoise,
					nbTierH, nbNbHeight, bestMu, bestMidH,
				);
				bestMu = out.bestMu; bestMidH = out.bestMidH;
			}
		}
	}

	if (bestMu >= 1.0) return h;
	return bestMidH * (1 - bestMu) + h * bestMu;
}

export function cornerPatchHeight(
	ux: number, uy: number, uz: number,
	borderTarget: number
): number {
	const rawNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
	const noiseH = Math.abs(rawNoise) + 0.15; // matches borderNoiseH in computeSurfaceHeight
	const borderNoise = borderTarget < -0.001 ? NOISE_AMP : NOISE_AMP * 0.3;
	return borderTarget + noiseH * borderNoise;
}
