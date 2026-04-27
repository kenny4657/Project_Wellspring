/**
 * GPU displacement debug — diff actual CPU heights against a TS port
 * of the GPU shader's logic, on the same input. This is the only way
 * to find shader/CPU mismatches without rendering and reading back.
 *
 * Workflow:
 *   await engine.initGpuDisplacement();
 *   const r = await engine.diagnoseGpuDisplacement();
 *   r.print();   // top-K mismatches with hex IDs and unit dirs
 *
 * If a discrepancy is found, the printed entry includes which step
 * of the shader produced the divergence (border target, cliff
 * erosion mu, midH).
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { HexCell } from '../icosphere';
import { fbmNoise } from '../noise';
import {
	type HexBorderInfo,
	getHexBorderInfo,
	getLevelHeight,
	findNeighborAcrossEdge,
	LEVEL_HEIGHTS,
} from '../hex-borders';
import {
	NOISE_AMP, NOISE_SCALE, BASE_HEIGHT, COAST_ROUNDING,
	computeHeightWithCliffErosion,
} from '../hex-heights';

// ── Shader-equivalent classifiers (must match displacement-shader.ts) ──

function isCliffEdge(selfH: number, nbH: number): boolean {
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (selfWater && nbWater) return false;
	const gap = Math.abs(selfH - nbH);
	if (selfWater && nbH <= 2) return false;
	if (nbWater && selfH <= 2) return false;
	return gap > 0;
}

function isSteepCliffEdge(selfH: number, nbH: number): boolean {
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (selfWater && nbWater) return false;
	if (!selfWater && !nbWater) return Math.abs(selfH - nbH) >= 2;
	if (nbWater) return selfH > 2;
	if (selfWater) return nbH > 2;
	return false;
}

function isCoastEdge(selfH: number, nbH: number): boolean {
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (selfWater === nbWater) return false;
	if (selfWater) return nbH <= 2;
	return selfH <= 2;
}

function isExcludedEdge(self: HexCell, nb: HexCell, _cellById: Map<number, HexCell>): boolean {
	const selfH = self.heightLevel;
	const nbH = nb.heightLevel;
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (!selfWater && !nbWater) return true;
	if (!selfWater && nbWater && selfH > 2) return true;
	// CPU's "open water" exclusion (water-water same-tier with ≤2 land
	// neighbors each) is deliberately omitted. CPU relies on the
	// post-hoc smoothing pass to fix the resulting seam mismatch where
	// two open-water hexes fall back to different alternative borders.
	// We have no smoothing pass, so include those edges and let both
	// sides agree on the shared water-water edge as nearest with the
	// symmetric `min(self,nb)` tier height as target.
	return false;
}

function computeBorderTarget(selfH: number, nbH: number): number {
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (selfWater && nbWater) return getLevelHeight(Math.min(selfH, nbH));
	return 0.0;
}

// ── Geometry helpers (match shader) ─────────────────────────

function distAndT(p: Vector3, a: Vector3, b: Vector3): { dist: number; t: number } {
	const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
	const ab2 = abx * abx + aby * aby + abz * abz;
	const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
	const t = ab2 > 1e-12 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2)) : 0;
	const projx = a.x + abx * t, projy = a.y + aby * t, projz = a.z + abz * t;
	const dx = p.x - projx, dy = p.y - projy, dz = p.z - projz;
	return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), t };
}

function meanHexRadius(corners: Vector3[]): number {
	const n = corners.length;
	let cx = 0, cy = 0, cz = 0;
	for (const c of corners) { cx += c.x; cy += c.y; cz += c.z; }
	cx /= n; cy /= n; cz /= n;
	const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
	cx /= cl; cy /= cl; cz /= cl;
	let r = 0;
	for (const c of corners) {
		const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
		r += Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	return r / n;
}

// Polynomial smooth-min from CPU hex-distance-fields.ts
function smoothMin(a: number, b: number, k: number): number {
	if (k <= 0) return Math.min(a, b);
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

// ── Cliff erosion walk (matches shader walkCliffEdges) ──────

interface CliffWalkState { bestMu: number; midWeightSum: number; midWeightedH: number }

function walkCliffEdges(
	unitDir: Vector3,
	selfH: number,
	corners: Vector3[],
	neighborH: number[],
	ownerHexRadius: number,
	cliffNoise: number,
	midNoise: number,
	selfTierH: number,
	state: CliffWalkState,
): void {
	const n = corners.length;
	for (let i = 0; i < n; i++) {
		if (!isCliffEdge(selfH, neighborH[i])) continue;
		const a = corners[i];
		const b = corners[(i + 1) % n];
		const { dist } = distAndT(unitDir, a, b);
		const steep = isSteepCliffEdge(selfH, neighborH[i]);
		let mu: number;
		if (steep) {
			const rampWidth = ownerHexRadius * 0.2;
			// CPU adds cliffNoise * radius * 0.25 to dist for irregular cliff
			// edges, but at dist=0 (a shared cliff edge) the perturbation can
			// shift mu away from 0, leaving h_base * mu in the lerp — and
			// h_base differs by tier between the two cells. CPU smooths this
			// in post; we don't have smoothing, so apply the perturbation
			// only away from the shared edge: clamp to 0 once dist itself
			// is below a small threshold.
			const safeBand = ownerHexRadius * 0.05;
			const perturbed = dist < safeBand
				? dist
				: Math.max(0, dist + cliffNoise * ownerHexRadius * 0.25);
			const t = Math.min(perturbed / rampWidth, 1);
			mu = t * (2 - t);
		} else {
			const rampWidth = ownerHexRadius * 0.7;
			const t = Math.min(dist / rampWidth, 1);
			mu = (1 - Math.cos(t * Math.PI)) / 2;
		}
		const midTier = (selfTierH + getLevelHeight(neighborH[i])) * 0.5;
		const midH = midTier + (Math.abs(midNoise) + 0.15) * NOISE_AMP * 0.3;
		const w = Math.exp(-mu / 0.05);
		state.midWeightSum += w;
		state.midWeightedH += w * midH;
		if (mu < state.bestMu) state.bestMu = mu;
	}
}

// ── Per-cell data fetch (matches shader texelFetches) ───────

interface CellData {
	heightLevel: number;
	corners: Vector3[];
	neighbors: (HexCell | null)[]; // length n
	neighborH: number[];           // length n, neighbor heightLevel (or self.h if missing)
	allSameHeight: boolean;
}

/** Find the neighbor across edge `edgeIdx` of `cell` by matching shared
 *  canonical corner identities (reference equality, valid after
 *  canonicalizeCells). Robust where dot-product matching fails — cells
 *  with 7+ corners can have multiple edges with similar midpoint
 *  directions, and direction-matching loses when two neighbors are
 *  near-aligned. Corner-matching is exact: only one neighbor contains
 *  both endpoints of any given edge. */
function findNeighborByCorners(cell: HexCell, edgeIdx: number, cellById: Map<number, HexCell>): HexCell | null {
	const a = cell.corners[edgeIdx];
	const b = cell.corners[(edgeIdx + 1) % cell.corners.length];
	for (const nId of cell.neighbors) {
		const nb = cellById.get(nId);
		if (!nb) continue;
		let hasA = false;
		let hasB = false;
		for (const c of nb.corners) {
			if (c === a) hasA = true;
			if (c === b) hasB = true;
			if (hasA && hasB) return nb;
		}
	}
	return null;
}

/** For each canonical corner, compute the consensus full-height across
 *  all cells touching it — emulates CPU smoothing pass for corner
 *  vertices (the only vertices truly shared by multiple cells). Each
 *  cell computes its h at the corner from its own perspective, all
 *  results averaged.
 *
 *  Used by sim/shader: at a vertex, if the test point is close enough
 *  to a corner of self, snap h to the canonical corner h. All cells at
 *  that corner snap to the same value → no seam.
 *
 *  Returned map keys are canonical Vector3 refs (shared across cells
 *  after canonicalizeCells), values are pre-noise heights — the noise
 *  contribution is added in shader so per-frame noise mods still work. */
export function computeCornerCanonicalHeights(cells: HexCell[]): Map<Vector3, number> {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellById));

	const sums = new Map<Vector3, { sum: number; count: number }>();
	for (const c of cells) {
		const tierH = getLevelHeight(c.heightLevel);
		const isWater = c.heightLevel <= 1;
		const hexRadius = meanHexRadius(c.corners);
		const borderInfo = borderInfoById.get(c.id)!;
		for (const corner of c.corners) {
			// Use CPU's actual computeHeightWithCliffErosion — this is
			// what CPU would compute at that corner before smoothing.
			const h = computeHeightWithCliffErosion(
				corner.x, corner.y, corner.z, c, borderInfo, hexRadius, tierH, isWater,
				cellById, borderInfoById,
			);
			let d = sums.get(corner);
			if (!d) { d = { sum: 0, count: 0 }; sums.set(corner, d); }
			d.sum += h;
			d.count += 1;
		}
	}
	const out = new Map<Vector3, number>();
	for (const [corner, d] of sums) out.set(corner, d.sum / d.count);
	return out;
}

/** [legacy] target-only version of canonical corner data. Kept around
 *  for reference; superseded by computeCornerCanonicalHeights which
 *  averages full computed h instead of just tie-break targets. */
export function computeCornerCanonicalTargets(cells: HexCell[]): Map<Vector3, number> {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

	const sums = new Map<Vector3, { sum: number; count: number }>();

	for (const c of cells) {
		const n = c.corners.length;
		for (let k = 0; k < n; k++) {
			const corner = c.corners[k];
			// Two edges meet at corner k: edge (k-1, k) and edge (k, k+1).
			const prevK = (k - 1 + n) % n;
			const prevNb = findNeighborByCorners(c, prevK, cellById);
			const nextNb = findNeighborByCorners(c, k, cellById);

			const targets: number[] = [];
			if (prevNb && !isExcludedEdge(c, prevNb, cellById)) {
				targets.push(computeBorderTarget(c.heightLevel, prevNb.heightLevel));
			}
			if (nextNb && !isExcludedEdge(c, nextNb, cellById)) {
				targets.push(computeBorderTarget(c.heightLevel, nextNb.heightLevel));
			}
			if (targets.length === 0) continue; // both excluded; cell doesn't contribute

			// Cell's tie-break target at this corner (matches CPU's "highest").
			const cellTarget = Math.max(...targets);

			let data = sums.get(corner);
			if (!data) { data = { sum: 0, count: 0 }; sums.set(corner, data); }
			data.sum += cellTarget;
			data.count += 1;
		}
	}

	const out = new Map<Vector3, number>();
	for (const [corner, d] of sums) out.set(corner, d.sum / d.count);
	return out;
}

function fetchCellData(cell: HexCell, cellById: Map<number, HexCell>): CellData {
	const n = cell.corners.length;
	const neighbors: (HexCell | null)[] = [];
	const neighborH: number[] = [];
	let allSame = true;
	for (let k = 0; k < n; k++) {
		const nb = findNeighborByCorners(cell, k, cellById);
		neighbors.push(nb);
		neighborH.push(nb ? nb.heightLevel : cell.heightLevel);
		if (nb && nb.heightLevel !== cell.heightLevel) allSame = false;
	}
	return { heightLevel: cell.heightLevel, corners: cell.corners, neighbors, neighborH, allSameHeight: allSame };
}

// ── The shader simulator ─────────────────────────────────────

interface ShaderSimResult {
	h: number;
	hasBorder: boolean;
	borderTarget: number;
	bestMu: number;
	bestMidH: number;
	hBase: number;
}

function simulateShaderHeight(
	unitDir: Vector3,
	cell: HexCell,
	cellById: Map<number, HexCell>,
	cornerTargets?: Map<Vector3, number>,
	cornerHeights?: Map<Vector3, number>,
	cornerHeightsByPosition?: { lookup: (x: number, y: number, z: number) => number | undefined },
	verbose = false,
): ShaderSimResult {
	// Position-based snap: if test point is at any canonical corner (any
	// cell's), snap to that corner's averaged h. Cross-cell unified by
	// position so cells with non-unified Vector3 refs (residual drift in
	// canonicalize) still see the same canonical h at the same position.
	if (cornerHeightsByPosition) {
		const ch = cornerHeightsByPosition.lookup(unitDir.x, unitDir.y, unitDir.z);
		if (ch !== undefined) {
			return {
				h: ch, hasBorder: false, borderTarget: 0,
				bestMu: 0, bestMidH: ch, hBase: ch,
				// (corner-snap shortcut returns; bestMidH preserved for callers)
			};
		}
	}
	const self = fetchCellData(cell, cellById);
	const selfH = self.heightLevel;
	const isWater = selfH <= 1;
	const selfTierH = getLevelHeight(selfH);

	// Noise — use pure CPU fbmNoise (drops cubemap sampling error from comparison)
	const rawNoise = fbmNoise(unitDir.x * NOISE_SCALE, unitDir.y * NOISE_SCALE, unitDir.z * NOISE_SCALE);
	const cliffNoise = fbmNoise(unitDir.x * 120 + 500, unitDir.y * 120 + 500, unitDir.z * 120 + 500);
	const midNoise = rawNoise;

	const interiorNoiseH = isWater ? Math.abs(rawNoise) : (rawNoise + 0.3);
	const borderNoiseH = Math.abs(rawNoise) + 0.15;

	// CPU's allSameHeight short-circuit produces ASYMMETRIC results when
	// adjacent cells take different paths (one takes the short-circuit,
	// the other does the full border walk). For water-water seams that
	// gives 7+ km gaps between adjacent same-tier hexes. Skipping it —
	// the border walk produces equivalent values for genuine all-same
	// cases but stays symmetric across the seam.

	const hexRadius = meanHexRadius(self.corners);
	const n = self.corners.length;

	let minDist = Infinity;
	let nearestEdgeIdx = -1;
	let nearestEdgeT = 0;
	let nearestBorderTarget = -Infinity;
	let hasBorder = false;
	// Coast smooth-min: exp soft-min with N normalization, mirrors
	// the shader. smoothD = -log((sum exp(-d_i / k)) / N) * k.
	// minCoastDist tracks the hard min for the coast-erosion pass below.
	const coastK = 0.22;
	let coastWeightSum = 0;
	let coastN = 0;
	let minCoastDist = Infinity;
	let hasCoastEdge = false;
	let minWaterStepDist = Infinity;
	let hasWaterStepEdge = false;
	// EPS for corner tie-break. CPU uses 1e-4, but at unit-sphere-normalized
	// edge midpoints the chord-to-sphere drift is ~7e-5 — that drift is the
	// same magnitude as 1e-4, causing the tie-break to fire on midpoints
	// (non-corners) and pick wrong-target edges. 1e-7 catches genuine
	// corner ties (where two edges meet at the same vertex) without
	// false-positives at midpoints.
	const EPS = 1e-7;

	for (let i = 0; i < n; i++) {
		const nb = self.neighbors[i];
		if (!nb) continue;
		const excluded = isExcludedEdge(cell, nb, cellById);
		if (verbose) {
			const a0 = self.corners[i];
			const b0 = self.corners[(i + 1) % n];
			const { dist: d0 } = distAndT(unitDir, a0, b0);
			console.log(`  cell ${cell.id} edge ${i}: nb=${nb.id} (tier ${nb.heightLevel}) dist=${d0.toFixed(7)} excluded=${excluded} target=${computeBorderTarget(selfH, self.neighborH[i]).toFixed(4)}`);
		}
		if (excluded) continue;
		const a = self.corners[i];
		const b = self.corners[(i + 1) % n];
		const { dist, t } = distAndT(unitDir, a, b);
		const edgeTarget = computeBorderTarget(selfH, self.neighborH[i]);
		const coast = isCoastEdge(selfH, self.neighborH[i]);

		// Per-position target = edge_target (computeBorderTarget is
		// symmetric per edge, so this is the same from both sides for
		// any shared edge). Corner cases handled by the corner-snap
		// at the top of simulateShaderHeight.
		const posTarget = edgeTarget;

		// Tie-break still uses the per-position target. With cornerTargets
		// active, both sides at a corner produce the SAME posTarget so the
		// tie-break choice doesn't matter for symmetry.
		if (dist < minDist - EPS) {
			minDist = dist;
			nearestEdgeIdx = i;
			nearestEdgeT = t;
			nearestBorderTarget = posTarget;
		} else if (dist < minDist + EPS) {
			if (posTarget > nearestBorderTarget) {
				nearestBorderTarget = posTarget;
				nearestEdgeIdx = i;
				nearestEdgeT = t;
			}
			if (dist < minDist) minDist = dist;
		}
		if (coast && edgeTarget === 0) {
			coastWeightSum += Math.exp(-dist / coastK);
			coastN++;
			if (dist < minCoastDist) minCoastDist = dist;
			hasCoastEdge = true;
		}
		// Water-water with different tiers (deep ↔ shallow):
		const nbH2 = self.neighborH[i];
		if (selfH <= 1 && nbH2 <= 1 && selfH !== nbH2) {
			if (dist < minWaterStepDist) minWaterStepDist = dist;
			hasWaterStepEdge = true;
		}
		hasBorder = true;
	}

	let h: number;
	if (!hasBorder) {
		h = selfTierH + interiorNoiseH * NOISE_AMP;
	} else {
		let dist = minDist;
		if (hasCoastEdge && nearestBorderTarget === 0 && coastWeightSum > 0) {
			const smoothD = -Math.log(coastWeightSum / coastN) * coastK;
			dist = Math.min(dist, smoothD);
		}
		const t01 = Math.min(dist / hexRadius, 1);
		const mu = (1 - Math.cos(t01 * Math.PI)) / 2;
		const isWaterNeighborBorder = nearestBorderTarget < -0.001;
		const borderNoiseCoeff = isWaterNeighborBorder ? NOISE_AMP : NOISE_AMP * 0.3;
		// LAND: mu-independent noise (see shader rationale)
		const noiseCoeff = isWater
			? (NOISE_AMP * mu + borderNoiseCoeff * (1 - mu))
			: NOISE_AMP;
		const noiseH = isWater
			? (interiorNoiseH * mu + borderNoiseH * (1 - mu))
			: interiorNoiseH;
		h = selfTierH * mu + nearestBorderTarget * (1 - mu) + noiseH * noiseCoeff;
		if (nearestBorderTarget === 0 && nearestEdgeIdx >= 0) {
			const coastMid = 4 * nearestEdgeT * (1 - nearestEdgeT);
			const coastBlend = mu * (1 - mu);
			h -= COAST_ROUNDING * coastMid * coastBlend * 4;
		}
	}
	const hBase = h;

	const state: CliffWalkState = { bestMu: 1, midWeightSum: 0, midWeightedH: 0 };
	walkCliffEdges(unitDir, selfH, self.corners, self.neighborH, hexRadius,
		cliffNoise, midNoise, selfTierH, state);

	for (let i = 0; i < n; i++) {
		const nb = self.neighbors[i];
		if (!nb) continue;
		const nbData = fetchCellData(nb, cellById);
		const nbHexRadius = meanHexRadius(nbData.corners);
		const nbTierH = getLevelHeight(nbData.heightLevel);
		walkCliffEdges(unitDir, nbData.heightLevel, nbData.corners, nbData.neighborH,
			nbHexRadius, cliffNoise, midNoise, nbTierH, state);
	}

	let bestMidH = hBase;
	if (state.bestMu < 1 && state.midWeightSum > 0) {
		bestMidH = state.midWeightedH / state.midWeightSum;
		const clamped = Math.max(0, (state.bestMu - 0.05) / 0.95);
		h = bestMidH * (1 - clamped) + hBase * clamped;
	}

	// Water-step pass first, then coast pass — see shader for ordering rationale.
	if (hasWaterStepEdge) {
		const deepTarget = LEVEL_HEIGHTS[0];
		const waterT = Math.min(Math.max(minWaterStepDist / (hexRadius * 0.7), 0), 1);
		const waterMu = (1 - Math.cos(waterT * Math.PI)) / 2;
		h = deepTarget * (1 - waterMu) + h * waterMu;
	}
	if (hasCoastEdge) {
		const coastT = Math.min(Math.max(minCoastDist / (hexRadius * 0.7), 0), 1);
		const coastMu = (1 - Math.cos(coastT * Math.PI)) / 2;
		h = h * coastMu;
	}

	// Land hex: floor above water sphere — see shader for rationale.
	if (!isWater) h = Math.max(h, -0.0001);

	return {
		h,
		hasBorder,
		borderTarget: nearestBorderTarget,
		bestMu: state.bestMu,
		bestMidH,
		hBase,
	};
}

// ── Diagnostic runner ────────────────────────────────────────

interface Mismatch {
	kind: 'cpu_vs_sim' | 'seam';
	cellAId: number;
	cellBId?: number;
	unitDir: [number, number, number];
	hCpu?: number;
	hSimA: number;
	hSimB?: number;
	diff: number;
	notes: string;
}

export interface DiagnoseResult {
	cpuVsSim: Mismatch[];
	seam: Mismatch[];
	totalsCpuVsSim: number;
	totalsSeam: number;
	maxCpuVsSim: number;
	maxSeam: number;
	print: () => void;
}

/** Compute and print final h for each given cell at a unit direction.
 *  Useful when debugging multi-cell corners (3+ cells meeting). */
export function dumpHAtUnitDir(
	cells: HexCell[], cellIds: number[],
	ux: number, uy: number, uz: number,
	planetRadius = 6371,
): void {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const u = new Vector3(ux, uy, uz);
	console.log(`[dumpH] at (${ux.toFixed(6)}, ${uy.toFixed(6)}, ${uz.toFixed(6)}):`);
	const results: { id: number; h: number; tier: number; bestMu: number; bestMidH: number; target: number }[] = [];
	for (const id of cellIds) {
		const c = cellById.get(id);
		if (!c) { console.log(`  cell ${id}: NOT FOUND`); continue; }
		const sim = simulateShaderHeight(u, c, cellById);
		results.push({ id, h: sim.h, tier: c.heightLevel, bestMu: sim.bestMu, bestMidH: sim.bestMidH, target: sim.borderTarget });
	}
	for (const r of results) {
		console.log(`  cell ${r.id} tier ${r.tier}: h=${r.h.toFixed(6)} bestMu=${r.bestMu.toFixed(3)} bestMidH=${r.bestMidH.toFixed(6)} target=${r.target.toFixed(4)}`);
	}
	if (results.length >= 2) {
		let maxDiff = 0;
		for (let i = 0; i < results.length; i++) {
			for (let j = i + 1; j < results.length; j++) {
				const d = Math.abs(results[i].h - results[j].h);
				if (d > maxDiff) maxDiff = d;
			}
		}
		console.log(`  max h-diff = ${maxDiff.toFixed(6)} (${(maxDiff * planetRadius * 1000).toFixed(0)}m world)`);
	}
}

/** Dump verbose sim for both cells at a specific unit direction.
 *  Useful for debugging the rendered-mesh gap finder's pairs. */
export function dumpAtUnitDir(
	cells: HexCell[], cellAId: number, cellBId: number,
	ux: number, uy: number, uz: number,
): void {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const A = cellById.get(cellAId);
	const B = cellById.get(cellBId);
	if (!A || !B) { console.log('Missing cell'); return; }
	console.log(`A=${cellAId} (tier ${A.heightLevel}) corners=${A.corners.length}`);
	for (let i = 0; i < A.corners.length; i++) {
		const c = A.corners[i];
		const dx = ux - c.x, dy = uy - c.y, dz = uz - c.z;
		console.log(`  A.corners[${i}]=(${c.x.toFixed(5)},${c.y.toFixed(5)},${c.z.toFixed(5)}) dist=${Math.sqrt(dx*dx+dy*dy+dz*dz).toExponential(2)}`);
	}
	console.log(`B=${cellBId} (tier ${B.heightLevel}) corners=${B.corners.length}`);
	for (let i = 0; i < B.corners.length; i++) {
		const c = B.corners[i];
		const dx = ux - c.x, dy = uy - c.y, dz = uz - c.z;
		console.log(`  B.corners[${i}]=(${c.x.toFixed(5)},${c.y.toFixed(5)},${c.z.toFixed(5)}) dist=${Math.sqrt(dx*dx+dy*dy+dz*dz).toExponential(2)}`);
	}
	const u = new Vector3(ux, uy, uz);
	console.log(`A's full edge walk:`);
	simulateShaderHeight(u, A, cellById, undefined, undefined, undefined, true);
	console.log(`B's full edge walk:`);
	simulateShaderHeight(u, B, cellById, undefined, undefined, undefined, true);
}

/** Verbose dump of one cell-pair's seam test. Logs each side's edge
 *  iteration so you can see why each picks the target it does.
 *  Use:  engine.dumpSeam(0, 9471) */
export function dumpSeamPair(cells: HexCell[], cellAId: number, cellBId: number): void {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const A = cellById.get(cellAId);
	const B = cellById.get(cellBId);
	if (!A || !B) {
		console.log(`Missing cell: A=${A?.id} B=${B?.id}`);
		return;
	}
	// Find the edge index of A facing B (corner-match, not dot-product).
	let edgeIdxA = -1;
	for (let i = 0; i < A.corners.length; i++) {
		const nb = findNeighborByCorners(A, i, cellById);
		if (nb && nb.id === B.id) { edgeIdxA = i; break; }
	}
	console.log(`A=${A.id} (tier ${A.heightLevel}) edgeIdxA=${edgeIdxA}`);
	const a = A.corners[edgeIdxA];
	const b = A.corners[(edgeIdxA + 1) % A.corners.length];
	const m = new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
	const ml = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
	m.x /= ml; m.y /= ml; m.z /= ml;
	console.log(`  m=(${m.x.toFixed(6)}, ${m.y.toFixed(6)}, ${m.z.toFixed(6)})`);
	const cornerTargets = computeCornerCanonicalTargets(cells);
	const cornerHeights = computeCornerCanonicalHeights(cells);
	console.log(`A's edge walk:`);
	const simA = simulateShaderHeight(m, A, cellById, cornerTargets, cornerHeights, undefined, true);
	console.log(`  → A.h=${simA.h.toFixed(6)} target=${simA.borderTarget.toFixed(4)} bestMu=${simA.bestMu.toFixed(3)}`);
	console.log(`B's edge walk:`);
	const simB = simulateShaderHeight(m, B, cellById, cornerTargets, cornerHeights, undefined, true);
	console.log(`  → B.h=${simB.h.toFixed(6)} target=${simB.borderTarget.toFixed(4)} bestMu=${simB.bestMu.toFixed(3)}`);
}

/** Find actual gaps in the rendered GPU mesh by computing the
 *  shader's height (via the sim, which mirrors shader output) at
 *  every vertex of every flat chunk, then grouping vertices that
 *  share a world-direction bucket and diffing their world-space
 *  rendered positions. The position diff IS the visible gap.
 *
 *  Returns the top-K gaps with hex IDs, world positions, and
 *  classification of why they differ (different cliffs, different
 *  border targets, etc.). */
export interface RenderedGap {
	hexAId: number;
	hexBId: number;
	unitDir: [number, number, number];
	hA: number;
	hB: number;
	worldGapKm: number;
	notesA: string;
	notesB: string;
}

/** Find vertices where a LAND hex (tier ≥ 2) computes h below the
 *  water-sphere height (-0.0005). These show as dark water patches
 *  through the green/brown surface — the user-reported "dotted
 *  pattern" issue. Returns top-K worst offenders by how far below
 *  water-sphere they dip, with the exact unit dir + per-step state. */
export interface WaterClipVertex {
	hexId: number;
	tier: number;
	unitDir: [number, number, number];
	h: number;
	belowWaterSphereM: number; // how far below water sphere in meters
	notes: string;
}

export function findLandUnderwaterVertices(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null }; cellIds: number[] }[],
	planetRadius: number,
	topK = 30,
): { offenders: WaterClipVertex[]; tierStats: Map<number, { total: number; underwater: number }>; print: () => void } {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const cornerTargets = computeCornerCanonicalTargets(cells);

	const WATER_SPHERE_H = -0.0005;
	const offenders: WaterClipVertex[] = [];
	const tierStats = new Map<number, { total: number; underwater: number }>();
	const seenPerHex = new Map<number, Set<string>>();

	for (const chunk of flatChunks) {
		const positions = chunk.mesh.getVerticesData('position');
		const hexIds = chunk.mesh.getVerticesData('hexId');
		if (!positions || !hexIds) continue;

		for (let i = 0; i < hexIds.length; i++) {
			const ux = positions[i * 3];
			const uy = positions[i * 3 + 1];
			const uz = positions[i * 3 + 2];
			const hexId = Math.round(hexIds[i]);
			const cell = cellById.get(hexId);
			if (!cell) continue;
			// Dedupe per (hexId, position bucket) so we don't recount
			// the same canonical vertex across multiple sub-tris.
			const STEP = 1e-5;
			const bucketKey = `${Math.round(ux / STEP)},${Math.round(uy / STEP)},${Math.round(uz / STEP)}`;
			let seen = seenPerHex.get(hexId);
			if (!seen) { seen = new Set(); seenPerHex.set(hexId, seen); }
			if (seen.has(bucketKey)) continue;
			seen.add(bucketKey);

			const tier = cell.heightLevel;
			let stats = tierStats.get(tier);
			if (!stats) { stats = { total: 0, underwater: 0 }; tierStats.set(tier, stats); }
			stats.total++;

			if (tier <= 1) continue; // water hex; below-water is fine

			const sim = simulateShaderHeight(
				new Vector3(ux, uy, uz), cell, cellById, cornerTargets, undefined, undefined,
			);
			if (sim.h < WATER_SPHERE_H) {
				stats.underwater++;
				const belowM = (WATER_SPHERE_H - sim.h) * planetRadius * 1000;
				offenders.push({
					hexId, tier,
					unitDir: [ux, uy, uz],
					h: sim.h,
					belowWaterSphereM: belowM,
					notes: `hasBorder=${sim.hasBorder} target=${sim.borderTarget.toFixed(4)} bestMu=${sim.bestMu.toFixed(3)} bestMidH=${sim.bestMidH.toFixed(5)} hBase=${sim.hBase.toFixed(5)}`,
				});
			}
		}
	}
	offenders.sort((a, b) => b.belowWaterSphereM - a.belowWaterSphereM);

	return {
		offenders, tierStats,
		print() {
			console.log(`[water-clip] tier stats:`);
			for (const [tier, s] of [...tierStats.entries()].sort((a, b) => a[0] - b[0])) {
				const pct = s.total > 0 ? (100 * s.underwater / s.total).toFixed(1) : '0';
				console.log(`  tier ${tier}: ${s.underwater}/${s.total} verts below water sphere (${pct}%)`);
			}
			console.log(`[water-clip] top ${topK} offenders:`);
			for (const o of offenders.slice(0, topK)) {
				console.log(`  cell ${o.hexId} tier=${o.tier}: h=${o.h.toFixed(5)} (${o.belowWaterSphereM.toFixed(0)}m below water) | ${o.notes}`);
			}
		},
	};
}

/** Histogram of land vertex h values near the water sphere boundary
 *  (-0.0005). Helps see if vertices clustered just above the boundary
 *  could z-fight with water depth check. */
export function landHHistogram(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null }; cellIds: number[] }[],
): void {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const cornerTargets = computeCornerCanonicalTargets(cells);

	const buckets = new Map<string, number>();
	const bumpBucket = (label: string) => buckets.set(label, (buckets.get(label) ?? 0) + 1);
	const tier2Buckets = new Map<string, number>();
	const bump2 = (label: string) => tier2Buckets.set(label, (tier2Buckets.get(label) ?? 0) + 1);

	for (const chunk of flatChunks) {
		const positions = chunk.mesh.getVerticesData('position');
		const hexIds = chunk.mesh.getVerticesData('hexId');
		if (!positions || !hexIds) continue;
		for (let i = 0; i < hexIds.length; i++) {
			const ux = positions[i * 3];
			const uy = positions[i * 3 + 1];
			const uz = positions[i * 3 + 2];
			const hexId = Math.round(hexIds[i]);
			const cell = cellById.get(hexId);
			if (!cell || cell.heightLevel <= 1) continue;
			const sim = simulateShaderHeight(new Vector3(ux, uy, uz), cell, cellById, cornerTargets);
			const h = sim.h;
			let label: string;
			if (h < -0.0005) label = 'below water sphere';
			else if (h < -0.0001) label = '-0.0005 to -0.0001 (just above water)';
			else if (h < 0) label = '-0.0001 to 0';
			else if (h < 0.0005) label = '0 to 0.0005';
			else if (h < 0.001) label = '0.0005 to 0.001';
			else if (h < 0.002) label = '0.001 to 0.002';
			else if (h < 0.005) label = '0.002 to 0.005';
			else label = '> 0.005';
			bumpBucket(label);
			if (cell.heightLevel === 2) bump2(label);
		}
	}
	console.log(`[h histogram] ALL land:`);
	for (const [k, v] of [...buckets.entries()].sort()) console.log(`  ${k}: ${v}`);
	console.log(`[h histogram] tier 2 only:`);
	for (const [k, v] of [...tier2Buckets.entries()].sort()) console.log(`  ${k}: ${v}`);
}

/** Topological wedge-gap detector.
 *
 *  For every canonical corner C (a Vector3 ref shared by ≥2 cells after
 *  canonicalize), find all cells whose `corners` contain C. Each such
 *  cell has exactly two edges meeting at C — they cover an angular
 *  wedge from one neighbor-across-edge direction to the other.
 *
 *  If the cells' wedges don't tile the full 360° around C, there's a
 *  topological gap: some angular region around C has NO cell covering
 *  it. Visible result on screen: missing geometry / planet shows
 *  through. Backface culling has nothing to do with it — there's
 *  literally no triangle there.
 *
 *  Reports each corner with:
 *    - cells touching it
 *    - the chain of cells walking around C (start cell → next cell via
 *      shared edge → next cell, etc.)
 *    - whether the chain closes back to start
 *    - if not, the gap location (which two cells are not connected at C). */
export interface WedgeGap {
	corner: [number, number, number];
	cellsAtCorner: number[];
	chain: number[]; // sequence walked starting from first cell
	closed: boolean;
	missingFromCells: number[]; // cells at corner that the chain didn't visit
}
export function findWedgeGaps(
	cells: HexCell[],
	topK = 30,
): { count: number; gaps: WedgeGap[]; print: () => void } {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

	// Build: corner Vector3 ref → list of cells touching it.
	const cellsAtCorner = new Map<Vector3, HexCell[]>();
	for (const c of cells) {
		for (const corner of c.corners) {
			let list = cellsAtCorner.get(corner);
			if (!list) { list = []; cellsAtCorner.set(corner, list); }
			list.push(c);
		}
	}

	const gaps: WedgeGap[] = [];
	for (const [corner, list] of cellsAtCorner) {
		if (list.length < 2) {
			// Single-cell corner — only valid at the planet boundary, which
			// shouldn't exist on a closed sphere. Flag it.
			gaps.push({
				corner: [corner.x, corner.y, corner.z],
				cellsAtCorner: list.map(c => c.id),
				chain: list.map(c => c.id),
				closed: false,
				missingFromCells: [],
			});
			continue;
		}

		// Skip midpoint corners: when 2 cells share 3+ consecutive corners
		// (multi-edge shared boundary), an interior corner has both edges
		// of each cell going to the same neighbor. These cover 360°
		// between just 2 cells; not a topology gap.
		if (list.length === 2) {
			const A = list[0], B = list[1];
			const idxA = A.corners.indexOf(corner);
			const nA = A.corners.length;
			const nbA1 = findNeighborByCorners(A, (idxA - 1 + nA) % nA, cellById);
			const nbA2 = findNeighborByCorners(A, idxA, cellById);
			if (nbA1 && nbA2 && nbA1.id === B.id && nbA2.id === B.id) {
				continue; // midpoint, not a gap
			}
		}

		// Walk: start at list[0]. From it, find the two edges meeting at
		// `corner`. Each edge has a neighbor cell. Pick one neighbor →
		// repeat. Build chain. If chain closes back to start with all cells
		// visited, the wedge tiles fully. Otherwise gap.
		const startCell = list[0];
		const visited = new Set<number>([startCell.id]);
		const chain: number[] = [startCell.id];

		let currCell = startCell;
		let prevCell: HexCell | null = null;
		let safety = 0;
		const maxIters = list.length + 5;
		let closed = false;
		while (safety++ < maxIters) {
			// Find the corner-index of `corner` in currCell.
			const idx = currCell.corners.indexOf(corner);
			if (idx < 0) break;
			const n = currCell.corners.length;
			// The two edges meeting at corner are (idx-1, idx) and (idx, idx+1).
			// Each edge's neighbor:
			const nbA = findNeighborByCorners(currCell, (idx - 1 + n) % n, cellById); // edge ending at corner
			const nbB = findNeighborByCorners(currCell, idx, cellById); // edge starting at corner
			// Pick the neighbor that ISN'T prevCell.
			let next: HexCell | null = null;
			if (nbA && (!prevCell || nbA.id !== prevCell.id)) next = nbA;
			else if (nbB && (!prevCell || nbB.id !== prevCell.id)) next = nbB;
			if (!next) break;
			if (next.id === startCell.id) { closed = true; break; }
			if (visited.has(next.id)) break;
			visited.add(next.id);
			chain.push(next.id);
			prevCell = currCell;
			currCell = next;
		}

		if (!closed || visited.size !== list.length) {
			gaps.push({
				corner: [corner.x, corner.y, corner.z],
				cellsAtCorner: list.map(c => c.id),
				chain,
				closed,
				missingFromCells: list.map(c => c.id).filter(id => !visited.has(id)),
			});
		}
	}

	return {
		count: gaps.length,
		gaps,
		print() {
			console.log(`[wedge-gap] ${gaps.length} corners with topology gaps (out of ${cellsAtCorner.size} canonical corners)`);
			for (const g of gaps.slice(0, topK)) {
				console.log(`  corner (${g.corner.map(x => x.toFixed(5)).join(', ')}): cells=[${g.cellsAtCorner.join(',')}] chain=[${g.chain.join('→')}] closed=${g.closed} missing=[${g.missingFromCells.join(',')}]`);
			}
		},
	};
}

/** Walk every triangle in every flat chunk, compute the displaced
 *  world positions of its 3 vertices, and check whether the triangle
 *  has flipped — its face normal points INWARD (toward planet center)
 *  instead of outward. Flipped triangles are overhangs (cliff steeper
 *  than vertical) and are dropped by backface culling. */
export interface OverhangTri {
	hexId: number;
	tier: number;
	centroid: [number, number, number];
	dotRadial: number;
	hValues: [number, number, number];
}
export function findOverhangTriangles(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null; getIndices?: () => unknown }; cellIds: number[] }[],
	planetRadius: number,
	topK = 30,
): { count: number; samples: OverhangTri[]; tierCounts: Map<number, number>; totalTris: number; print: () => void } {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const samples: OverhangTri[] = [];
	const tierCounts = new Map<number, number>();
	let totalTris = 0;
	let count = 0;
	for (const chunk of flatChunks) {
		const positions = chunk.mesh.getVerticesData('position');
		const hexIds = chunk.mesh.getVerticesData('hexId');
		const indicesRaw = chunk.mesh.getIndices?.() as ArrayLike<number> | null;
		if (!positions || !hexIds || !indicesRaw) continue;
		for (let t = 0; t < indicesRaw.length; t += 3) {
			const i0 = indicesRaw[t], i1 = indicesRaw[t + 1], i2 = indicesRaw[t + 2];
			const ud0 = new Vector3(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
			const ud1 = new Vector3(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
			const ud2 = new Vector3(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
			const id0 = Math.round(hexIds[i0]);
			const id1 = Math.round(hexIds[i1]);
			const id2 = Math.round(hexIds[i2]);
			const c0 = cellById.get(id0);
			const c1 = cellById.get(id1);
			const c2 = cellById.get(id2);
			if (!c0 || !c1 || !c2) continue;
			totalTris++;
			const h0 = simulateShaderHeight(ud0, c0, cellById).h;
			const h1 = simulateShaderHeight(ud1, c1, cellById).h;
			const h2 = simulateShaderHeight(ud2, c2, cellById).h;
			const k0 = (1 + h0), k1 = (1 + h1), k2 = (1 + h2);
			const w0x = ud0.x * k0, w0y = ud0.y * k0, w0z = ud0.z * k0;
			const w1x = ud1.x * k1, w1y = ud1.y * k1, w1z = ud1.z * k1;
			const w2x = ud2.x * k2, w2y = ud2.y * k2, w2z = ud2.z * k2;
			const ax = w1x - w0x, ay = w1y - w0y, az = w1z - w0z;
			const bx = w2x - w0x, by = w2y - w0y, bz = w2z - w0z;
			const nx = ay * bz - az * by;
			const ny = az * bx - ax * bz;
			const nz = ax * by - ay * bx;
			const cx = (w0x + w1x + w2x) / 3;
			const cy = (w0y + w1y + w2y) / 3;
			const cz = (w0z + w1z + w2z) / 3;
			const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
			// Flat mesh fan winds (center, c[i+1], c[i]) which is CW from
			// outside, so default cross product points INWARD. Flip sign so
			// dotRadial > 0 = normal triangle, < 0 = overhang/flipped.
			const dot = -(nx * cx + ny * cy + nz * cz) / cl;
			if (dot < 0) {
				count++;
				const t0 = c0.heightLevel;
				tierCounts.set(t0, (tierCounts.get(t0) ?? 0) + 1);
				samples.push({
					hexId: id0,
					tier: t0,
					centroid: [cx / cl, cy / cl, cz / cl],
					dotRadial: dot,
					hValues: [h0, h1, h2],
				});
			}
		}
	}
	samples.sort((a, b) => a.dotRadial - b.dotRadial);
	return {
		count, samples, tierCounts, totalTris,
		print() {
			console.log(`[overhang] ${count}/${totalTris} triangles flipped inward`);
			for (const [t, n] of [...tierCounts.entries()].sort((a, b) => a[0] - b[0])) {
				console.log(`  tier ${t}: ${n}`);
			}
			console.log(`[overhang] worst ${topK} (most-flipped first):`);
			for (const s of samples.slice(0, topK)) {
				console.log(`  cell ${s.hexId} (tier ${s.tier}) dot=${s.dotRadial.toExponential(2)} h=[${s.hValues.map(x => x.toFixed(5)).join(',')}]`);
			}
		},
	};
}

/** ──────────────────────────────────────────────────────────
 *  findVisibleCracks: the diagnostic that catches what the user sees.
 *
 *  Instead of bucketing arbitrary mesh vertices by spatial proximity
 *  (the existing findRenderedMeshGaps), this walks the cells' mesh
 *  buffers and explicitly groups vertices by their EXACT float32
 *  unit-direction key. Two cells whose meshes contain a vertex at the
 *  EXACT same float32 unit-dir SHOULD displace it to the same world
 *  position — if they don't, that's a crack.
 *
 *  Reports per-cluster:
 *    - max pairwise unit-dir drift (in meters on Earth surface)
 *    - max pairwise h drift (in meters of radial displacement)
 *    - max pairwise WORLD-DISPLACED-POSITION drift (in meters)
 *
 *  The world-position drift is the actual visible crack size.
 *  ──────────────────────────────────────────────────────────  */
export interface VisibleCrack {
	cellIds: number[];
	tierByCell: number[];
	unitDir: [number, number, number];
	hValues: number[];
	maxUnitDirDriftM: number;
	maxHDriftM: number;
	maxWorldDriftM: number;
}
export function findVisibleCracks(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null }; cellIds: number[] }[],
	planetRadius: number,
	thresholdM = 100,
	bucketSize = 5e-4, // ~3km — wider than canonicalize residual
	topK = 30,
): {
	crackCount: number;
	clusterCount: number;
	multiCellClusterCount: number;
	worstClusters: VisibleCrack[];
	tierPairCounts: Map<string, number>;
	print: () => void;
} {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

	// Bucket every flat-mesh vertex by spatial position. After bucketing,
	// any cluster of vertices from MULTIPLE cells in the same bucket are
	// "should-be-coincident" (along a shared corner or sub-edge).
	type Sample = { hexId: number; ux: number; uy: number; uz: number; h: number };
	const buckets = new Map<string, Sample[]>();
	for (const chunk of flatChunks) {
		const positions = chunk.mesh.getVerticesData('position');
		const hexIds = chunk.mesh.getVerticesData('hexId');
		if (!positions || !hexIds) continue;
		const seen = new Set<string>();
		for (let i = 0; i < hexIds.length; i++) {
			const ux = positions[i * 3];
			const uy = positions[i * 3 + 1];
			const uz = positions[i * 3 + 2];
			const hexId = Math.round(hexIds[i]);
			const dedupKey = `${hexId}|${ux.toFixed(7)},${uy.toFixed(7)},${uz.toFixed(7)}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const cell = cellById.get(hexId);
			if (!cell) continue;
			const sim = simulateShaderHeight(new Vector3(ux, uy, uz), cell, cellById);
			const ix = Math.floor(ux / bucketSize);
			const iy = Math.floor(uy / bucketSize);
			const iz = Math.floor(uz / bucketSize);
			const bk = `${ix},${iy},${iz}`;
			let list = buckets.get(bk);
			if (!list) { list = []; buckets.set(bk, list); }
			list.push({ hexId, ux, uy, uz, h: sim.h });
		}
	}

	let crackCount = 0;
	let clusterCount = 0;
	let multiCellClusterCount = 0;
	const worstClusters: VisibleCrack[] = [];
	const tierPairCounts = new Map<string, number>();
	for (const [, list] of buckets) {
		clusterCount++;
		if (list.length < 2) continue;
		const distinctCells = new Set(list.map(s => s.hexId));
		if (distinctCells.size < 2) continue;
		multiCellClusterCount++;
		// Compute pairwise drifts within this cluster.
		let maxUDDrift = 0; // unit-dir drift
		let maxHDrift = 0;
		let maxWDrift = 0;
		let worstA: Sample | null = null;
		let worstB: Sample | null = null;
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i], b = list[j];
				if (a.hexId === b.hexId) continue;
				const dux = a.ux - b.ux, duy = a.uy - b.uy, duz = a.uz - b.uz;
				const ud = Math.sqrt(dux * dux + duy * duy + duz * duz) * planetRadius * 1000;
				if (ud > maxUDDrift) maxUDDrift = ud;
				const hd = Math.abs(a.h - b.h) * planetRadius * 1000;
				if (hd > maxHDrift) maxHDrift = hd;
				// World-displaced position
				const wax = a.ux * (1 + a.h), way = a.uy * (1 + a.h), waz = a.uz * (1 + a.h);
				const wbx = b.ux * (1 + b.h), wby = b.uy * (1 + b.h), wbz = b.uz * (1 + b.h);
				const wdx = wax - wbx, wdy = way - wby, wdz = waz - wbz;
				const wd = Math.sqrt(wdx * wdx + wdy * wdy + wdz * wdz) * planetRadius * 1000;
				if (wd > maxWDrift) {
					maxWDrift = wd;
					worstA = a;
					worstB = b;
				}
			}
		}
		if (maxWDrift > thresholdM) {
			crackCount++;
			if (worstA && worstB) {
				const tA = cellById.get(worstA.hexId)!.heightLevel;
				const tB = cellById.get(worstB.hexId)!.heightLevel;
				const pairKey = `${Math.min(tA, tB)}↔${Math.max(tA, tB)}`;
				tierPairCounts.set(pairKey, (tierPairCounts.get(pairKey) ?? 0) + 1);
			}
			const cellList = [...distinctCells];
			worstClusters.push({
				cellIds: cellList,
				tierByCell: cellList.map(id => cellById.get(id)!.heightLevel),
				unitDir: [list[0].ux, list[0].uy, list[0].uz],
				hValues: list.map(s => s.h),
				maxUnitDirDriftM: maxUDDrift,
				maxHDriftM: maxHDrift,
				maxWorldDriftM: maxWDrift,
			});
		}
	}
	worstClusters.sort((a, b) => b.maxWorldDriftM - a.maxWorldDriftM);

	return {
		crackCount, clusterCount, multiCellClusterCount, worstClusters,
		tierPairCounts,
		print() {
			console.log(`[visible-cracks] ${clusterCount} buckets, ${multiCellClusterCount} multi-cell, ${crackCount} with world-drift > ${thresholdM}m`);
			console.log('[visible-cracks] tier pair counts:');
			for (const [k, v] of [...tierPairCounts.entries()].sort((a, b) => b[1] - a[1])) {
				console.log(`  ${k}: ${v}`);
			}
			console.log(`[visible-cracks] worst ${topK} clusters:`);
			for (const c of worstClusters.slice(0, topK)) {
				console.log(`  cells [${c.cellIds.join(',')}] tiers [${c.tierByCell.join(',')}] world-drift=${c.maxWorldDriftM.toFixed(0)}m (h-drift=${c.maxHDriftM.toFixed(0)}m, ud-drift=${c.maxUnitDirDriftM.toFixed(0)}m) h=[${c.hValues.map(x => x.toFixed(5)).join(',')}]`);
			}
		},
	};
}

export function findRenderedMeshGaps(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null }; cellIds: number[] }[],
	planetRadius: number,
	topK = 30,
): { gaps: RenderedGap[]; totalEdgeMatches: number; print: () => void } {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

	// Precompute canonical corner targets + heights so sim uses
	// consensus values at corners (emulates CPU smoothing pass).
	const cornerTargets = computeCornerCanonicalTargets(cells);

	// Position-bucketed corner heights: group all cells whose corners
	// land in the same spatial bucket (regardless of canonical Vector3
	// identity), average their h values. Handles drift larger than
	// canonicalize MERGE_RADIUS that left some refs unmerged.
	const cellByIdMap = new Map<number, HexCell>();
	for (const c of cells) cellByIdMap.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellByIdMap));

	const SNAP_BUCKET = 2e-3; // larger than max canonicalize drift
	const SNAP_R = 5e-4;
	const SNAP_R2 = SNAP_R * SNAP_R;
	const positionalSums = new Map<string, { sumX: number; sumY: number; sumZ: number; sumH: number; count: number }>();
	for (const c of cells) {
		const tierH = getLevelHeight(c.heightLevel);
		const isWater = c.heightLevel <= 1;
		const hexRadius = meanHexRadius(c.corners);
		const borderInfo = borderInfoById.get(c.id)!;
		for (const corner of c.corners) {
			const h = computeHeightWithCliffErosion(
				corner.x, corner.y, corner.z, c, borderInfo, hexRadius, tierH, isWater,
				cellByIdMap, borderInfoById,
			);
			const ix = Math.floor(corner.x / SNAP_BUCKET);
			const iy = Math.floor(corner.y / SNAP_BUCKET);
			const iz = Math.floor(corner.z / SNAP_BUCKET);
			const k = `${ix},${iy},${iz}`;
			let s = positionalSums.get(k);
			if (!s) { s = { sumX: 0, sumY: 0, sumZ: 0, sumH: 0, count: 0 }; positionalSums.set(k, s); }
			s.sumX += corner.x; s.sumY += corner.y; s.sumZ += corner.z;
			s.sumH += h; s.count++;
		}
	}
	const grid = new Map<string, { x: number; y: number; z: number; h: number }[]>();
	for (const [k, s] of positionalSums) {
		const inv = 1 / s.count;
		grid.set(k, [{ x: s.sumX * inv, y: s.sumY * inv, z: s.sumZ * inv, h: s.sumH * inv }]);
	}
	// Legacy ref-based map for sim's older code path (still used by t-blend etc).
	const cornerHeights: Map<Vector3, number> = new Map();
	const cornerHeightsByPosition = {
		lookup(x: number, y: number, z: number): number | undefined {
			const ix = Math.floor(x / SNAP_BUCKET);
			const iy = Math.floor(y / SNAP_BUCKET);
			const iz = Math.floor(z / SNAP_BUCKET);
			let bestD2 = SNAP_R2;
			let bestH: number | undefined;
			for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
				const list = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
				if (!list) continue;
				for (const c of list) {
					const ddx = c.x - x, ddy = c.y - y, ddz = c.z - z;
					const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
					if (d2 < bestD2) { bestD2 = d2; bestH = c.h; }
				}
			}
			return bestH;
		},
	};

	// Bucket vertex positions by a coarse spatial key. Two vertices in the
	// same bucket from different hexes are candidates for a shared seam.
	const STEP = 1e-4;
	type Sample = { hexId: number; ux: number; uy: number; uz: number; h: number; sim: ShaderSimResult };
	const buckets = new Map<string, Sample[]>();

	for (const chunk of flatChunks) {
		const positions = chunk.mesh.getVerticesData('position');
		const hexIds = chunk.mesh.getVerticesData('hexId');
		if (!positions || !hexIds) continue;

		const seen = new Set<string>();
		for (let i = 0; i < hexIds.length; i++) {
			const ux = positions[i * 3];
			const uy = positions[i * 3 + 1];
			const uz = positions[i * 3 + 2];
			const hexId = Math.round(hexIds[i]);
			const dedupKey = `${hexId}|${Math.round(ux / STEP)},${Math.round(uy / STEP)},${Math.round(uz / STEP)}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const cell = cellById.get(hexId);
			if (!cell) continue;
			const u = new Vector3(ux, uy, uz);
			const sim = simulateShaderHeight(u, cell, cellById, cornerTargets, cornerHeights, cornerHeightsByPosition);
			const bk = `${Math.round(ux / STEP)},${Math.round(uy / STEP)},${Math.round(uz / STEP)}`;
			let list = buckets.get(bk);
			if (!list) { list = []; buckets.set(bk, list); }
			list.push({ hexId, ux, uy, uz, h: sim.h, sim });
		}
	}

	const gaps: RenderedGap[] = [];
	let totalEdgeMatches = 0;
	// Only flag a gap if two vertices are at near-identical positions (true
	// coincidence). Bucket grouping at 1e-4 catches "spatially close" pairs
	// that aren't actually shared (each cell's near-corner sub-tri vertex
	// lives in its own fan triangle interior). True shared vertices are at
	// exactly the same world-direction (sub-tri vertices on shared edges
	// or shared corners after canonicalize).
	const COINCIDENT_R2 = 1e-12;
	for (const [, list] of buckets) {
		if (list.length < 2) continue;
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i], b = list[j];
				if (a.hexId === b.hexId) continue;
				const ddx = a.ux - b.ux, ddy = a.uy - b.uy, ddz = a.uz - b.uz;
				if (ddx * ddx + ddy * ddy + ddz * ddz > COINCIDENT_R2) continue;
				totalEdgeMatches++;
				const diff = Math.abs(a.h - b.h);
				const worldGapKm = diff * planetRadius;
				if (worldGapKm > 0.1) { // > 100m worth tracking
					// Check whether either side hit the corner-snap path.
					const cellA = cellById.get(a.hexId)!;
					const cellB = cellById.get(b.hexId)!;
					let cornerInfoA = 'no-snap';
					let cornerInfoB = 'no-snap';
					if (cornerHeights) {
						for (const corner of cellA.corners) {
							const dx = a.ux - corner.x, dy = a.uy - corner.y, dz = a.uz - corner.z;
							const d2 = dx * dx + dy * dy + dz * dz;
							if (d2 < 1e-7) {
								cornerInfoA = `near-corner d2=${d2.toExponential(2)} canon-h=${cornerHeights.get(corner)?.toFixed(5) ?? '?'}`;
								break;
							}
						}
						for (const corner of cellB.corners) {
							const dx = b.ux - corner.x, dy = b.uy - corner.y, dz = b.uz - corner.z;
							const d2 = dx * dx + dy * dy + dz * dz;
							if (d2 < 1e-7) {
								cornerInfoB = `near-corner d2=${d2.toExponential(2)} canon-h=${cornerHeights.get(corner)?.toFixed(5) ?? '?'}`;
								break;
							}
						}
					}
					gaps.push({
						hexAId: a.hexId, hexBId: b.hexId,
						unitDir: [a.ux, a.uy, a.uz],
						hA: a.h, hB: b.h,
						worldGapKm,
						notesA: `tier=${cellA.heightLevel} target=${a.sim.borderTarget.toFixed(4)} bestMu=${a.sim.bestMu.toFixed(3)} bestMidH=${a.sim.bestMidH.toFixed(5)} ${cornerInfoA}`,
						notesB: `tier=${cellB.heightLevel} target=${b.sim.borderTarget.toFixed(4)} bestMu=${b.sim.bestMu.toFixed(3)} bestMidH=${b.sim.bestMidH.toFixed(5)} ${cornerInfoB}`,
					});
				}
			}
		}
	}
	gaps.sort((a, b) => b.worldGapKm - a.worldGapKm);

	return {
		gaps,
		totalEdgeMatches,
		print() {
			console.log(`[mesh gap] ${gaps.length} gaps > 100m at vertex coincidences (out of ${totalEdgeMatches} compared pairs)`);
			for (const g of gaps.slice(0, topK)) {
				console.log(`  ${g.hexAId}↔${g.hexBId}: gap=${g.worldGapKm.toFixed(2)}km hA=${g.hA.toFixed(5)} hB=${g.hB.toFixed(5)} | A: ${g.notesA} | B: ${g.notesB}`);
			}
		},
	};
}

export function diagnoseGpuDisplacement(
	cells: HexCell[],
	options: { sampleCellCount?: number; pointsPerCell?: number; topK?: number } = {},
): DiagnoseResult {
	const { sampleCellCount = 200, pointsPerCell = 12, topK = 15 } = options;

	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellById));

	const cpuVsSim: Mismatch[] = [];
	const seam: Mismatch[] = [];
	let totalsCpuVsSim = 0, totalsSeam = 0;
	let maxCpuVsSim = 0, maxSeam = 0;

	// Pick a deterministic stride sample of cells.
	const stride = Math.max(1, Math.floor(cells.length / sampleCellCount));
	for (let ci = 0; ci < cells.length; ci += stride) {
		const cell = cells[ci];
		const borderInfo = borderInfoById.get(cell.id)!;
		const tierH = getLevelHeight(cell.heightLevel);
		const isWater = cell.heightLevel <= 1;
		const hexRadius = meanHexRadius(cell.corners);

		// Sample points: corners, edge midpoints, and interior bary points.
		const samples: Vector3[] = [];
		for (const corner of cell.corners) samples.push(corner.clone());
		for (let i = 0; i < cell.corners.length; i++) {
			const a = cell.corners[i];
			const b = cell.corners[(i + 1) % cell.corners.length];
			const m = new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
			const ml = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
			samples.push(new Vector3(m.x / ml, m.y / ml, m.z / ml));
			// 1/3 from edge toward center
			const cx = cell.center.x, cy = cell.center.y, cz = cell.center.z;
			const ix = m.x * 0.6 + cx * 0.4, iy = m.y * 0.6 + cy * 0.4, iz = m.z * 0.6 + cz * 0.4;
			const il = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
			samples.push(new Vector3(ix / il, iy / il, iz / il));
		}
		while (samples.length > pointsPerCell) samples.pop();

		for (const u of samples) {
			const sim = simulateShaderHeight(u, cell, cellById);
			const hCpu = computeHeightWithCliffErosion(
				u.x, u.y, u.z, cell, borderInfo, hexRadius, tierH, isWater,
				cellById, borderInfoById,
			);
			const diff = Math.abs(hCpu - sim.h);
			totalsCpuVsSim++;
			if (diff > maxCpuVsSim) maxCpuVsSim = diff;
			if (diff > 1e-5) {
				cpuVsSim.push({
					kind: 'cpu_vs_sim',
					cellAId: cell.id,
					unitDir: [u.x, u.y, u.z],
					hCpu,
					hSimA: sim.h,
					diff,
					notes: `tier=${cell.heightLevel} hasBorder=${sim.hasBorder} target=${sim.borderTarget.toFixed(4)} bestMu=${sim.bestMu.toFixed(3)} bestMidH=${sim.bestMidH.toFixed(5)}`,
				});
			}
		}

		// Seam check: pick edge midpoints, compare sim from each side.
		for (let i = 0; i < cell.corners.length; i++) {
			const nb = findNeighborAcrossEdge(cell, i, cellById);
			if (!nb) continue;
			if (nb.id <= cell.id) continue; // each pair once
			const a = cell.corners[i];
			const b = cell.corners[(i + 1) % cell.corners.length];
			const m = new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
			const ml = Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z) || 1;
			m.x /= ml; m.y /= ml; m.z /= ml;
			const simA = simulateShaderHeight(m, cell, cellById);
			const simB = simulateShaderHeight(m, nb, cellById);
			const diff = Math.abs(simA.h - simB.h);
			totalsSeam++;
			if (diff > maxSeam) maxSeam = diff;
			if (diff > 1e-5) {
				seam.push({
					kind: 'seam',
					cellAId: cell.id,
					cellBId: nb.id,
					unitDir: [m.x, m.y, m.z],
					hSimA: simA.h,
					hSimB: simB.h,
					diff,
					notes: `A.tier=${cell.heightLevel} B.tier=${nb.heightLevel} A.target=${simA.borderTarget.toFixed(4)} B.target=${simB.borderTarget.toFixed(4)} A.mu=${simA.bestMu.toFixed(3)} B.mu=${simB.bestMu.toFixed(3)}`,
				});
			}
		}
	}

	cpuVsSim.sort((x, y) => y.diff - x.diff);
	seam.sort((x, y) => y.diff - x.diff);

	return {
		cpuVsSim, seam,
		totalsCpuVsSim, totalsSeam,
		maxCpuVsSim, maxSeam,
		print() {
			console.log(`[gpu diag] CPU vs sim: ${cpuVsSim.length}/${totalsCpuVsSim} samples mismatched, max=${maxCpuVsSim.toFixed(6)}`);
			for (const m of cpuVsSim.slice(0, topK)) {
				console.log(`  cell ${m.cellAId}: cpu=${m.hCpu!.toFixed(6)} sim=${m.hSimA.toFixed(6)} diff=${m.diff.toFixed(6)} | ${m.notes}`);
			}
			console.log(`[gpu diag] Seam mismatches: ${seam.length}/${totalsSeam} edges, max=${maxSeam.toFixed(6)}`);
			for (const m of seam.slice(0, topK)) {
				console.log(`  ${m.cellAId}↔${m.cellBId}: A=${m.hSimA.toFixed(6)} B=${m.hSimB!.toFixed(6)} diff=${m.diff.toFixed(6)} | ${m.notes}`);
			}
		},
	};
}
