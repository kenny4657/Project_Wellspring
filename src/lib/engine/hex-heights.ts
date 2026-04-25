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

/** Compute height with per-edge-type handling:
 *  - Steep cliff edges (2+ level diff): narrow parabolic ramp → steep geometry → cliff texture
 *  - Gentle slope edges (1-level diff): wide cosine ramp → smooth geometry → no cliff texture
 *  The min-mu logic naturally handles corners where different edge types meet. */
export function computeHeightWithCliffErosion(
	ux: number, uy: number, uz: number,
	cell: HexCell, borderInfo: HexBorderInfo,
	hexRadius: number, tierH: number, isWaterHex: boolean,
	cellById: Map<number, HexCell>
): number {
	const h = computeSurfaceHeight(ux, uy, uz, cell, borderInfo, hexRadius, tierH, isWaterHex);
	if (!borderInfo.hasCliff) return h;

	const n = cell.corners.length;
	const cliffNoise = fbmNoise(ux * 120 + 500, uy * 120 + 500, uz * 120 + 500);
	const midNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);

	let bestMu = 1.0;
	let bestMidH = h;

	for (let i = 0; i < n; i++) {
		if (!borderInfo.cliffEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const dist = distToSegment(ux, uy, uz, a.x, a.y, a.z, b.x, b.y, b.z);

		const isSteep = borderInfo.steepCliffEdges[i];
		let mu: number;

		if (isSteep) {
			// Steep cliff (2+ level): narrow parabolic ramp → creates steep faces
			const rampWidth = hexRadius * 0.2;
			const perturbedDist = Math.max(0, dist + cliffNoise * hexRadius * 0.25);
			const t = Math.min(perturbedDist / rampWidth, 1.0);
			mu = t * (2 - t);
		} else {
			// Gentle slope (1-level): wide cosine ramp → smooth faces, no cliff texture
			const rampWidth = hexRadius * 0.7;
			const t = Math.min(dist / rampWidth, 1.0);
			mu = (1 - Math.cos(t * Math.PI)) / 2;
		}

		if (mu < bestMu) {
			bestMu = mu;
			const nb = findNeighborAcrossEdge(cell, i, cellById);
			const neighborHeight = nb ? getLevelHeight(nb.heightLevel) : 0;
			const midTierH = (tierH + neighborHeight) / 2;
			bestMidH = midTierH + (Math.abs(midNoise) + 0.15) * NOISE_AMP * 0.3;
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
