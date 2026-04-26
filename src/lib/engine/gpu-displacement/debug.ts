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

interface CliffWalkState { bestMu: number; bestMidH: number }

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
			const perturbed = Math.max(0, dist + cliffNoise * ownerHexRadius * 0.25);
			const t = Math.min(perturbed / rampWidth, 1);
			mu = t * (2 - t);
		} else {
			const rampWidth = ownerHexRadius * 0.7;
			const t = Math.min(dist / rampWidth, 1);
			mu = (1 - Math.cos(t * Math.PI)) / 2;
		}
		if (mu < state.bestMu) {
			const midTier = (selfTierH + getLevelHeight(neighborH[i])) * 0.5;
			state.bestMu = mu;
			state.bestMidH = midTier + (Math.abs(midNoise) + 0.15) * NOISE_AMP * 0.3;
		}
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
	verbose = false,
): ShaderSimResult {
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

	// CPU short-circuit: water hex with all same-tier neighbors uses pure
	// interior height (skips border smoothing entirely).
	if (isWater && self.allSameHeight) {
		const h0 = selfTierH + interiorNoiseH * NOISE_AMP;
		// Cliff erosion still applies even in this branch.
		const state: CliffWalkState = { bestMu: 1, bestMidH: h0 };
		const hexRadius0 = meanHexRadius(self.corners);
		walkCliffEdges(unitDir, selfH, self.corners, self.neighborH, hexRadius0,
			cliffNoise, midNoise, selfTierH, state);
		for (let i = 0; i < self.neighbors.length; i++) {
			const nb = self.neighbors[i]; if (!nb) continue;
			const nbData = fetchCellData(nb, cellById);
			const nbHexRadius = meanHexRadius(nbData.corners);
			walkCliffEdges(unitDir, nbData.heightLevel, nbData.corners, nbData.neighborH,
				nbHexRadius, cliffNoise, midNoise, getLevelHeight(nbData.heightLevel), state);
		}
		const hFinal = state.bestMu < 1 ? state.bestMidH * (1 - state.bestMu) + h0 * state.bestMu : h0;
		return { h: hFinal, hasBorder: false, borderTarget: 0, bestMu: state.bestMu, bestMidH: state.bestMidH, hBase: h0 };
	}

	const hexRadius = meanHexRadius(self.corners);
	const n = self.corners.length;

	let minDist = Infinity;
	let nearestEdgeIdx = -1;
	let nearestEdgeT = 0;
	let nearestBorderTarget = -Infinity;
	let hasBorder = false;
	const coastK = hexRadius * 0.22; // matches CPU smoothDistanceToTargetEdges
	let coastSmoothD = Infinity;     // polynomial smooth-min accumulator over coast edges
	let hasCoastEdge = false;
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
		const target = computeBorderTarget(selfH, self.neighborH[i]);
		const coast = isCoastEdge(selfH, self.neighborH[i]);
		// CPU tie-break: at corners (multiple edges within EPS), pick highest target.
		if (dist < minDist - EPS) {
			minDist = dist;
			nearestEdgeIdx = i;
			nearestEdgeT = t;
			nearestBorderTarget = target;
		} else if (dist < minDist + EPS) {
			if (target > nearestBorderTarget) {
				nearestBorderTarget = target;
				nearestEdgeIdx = i;
				nearestEdgeT = t;
			}
			if (dist < minDist) minDist = dist;
		}
		if (coast && target === 0) {
			coastSmoothD = Number.isFinite(coastSmoothD) ? smoothMin(coastSmoothD, dist, coastK) : dist;
			hasCoastEdge = true;
		}
		hasBorder = true;
	}

	let h: number;
	if (!hasBorder) {
		h = selfTierH + interiorNoiseH * NOISE_AMP;
	} else {
		let dist = minDist;
		if (hasCoastEdge && nearestBorderTarget === 0 && Number.isFinite(coastSmoothD)) {
			dist = Math.min(dist, coastSmoothD);
		}
		const t01 = Math.min(dist / hexRadius, 1);
		const mu = (1 - Math.cos(t01 * Math.PI)) / 2;
		const isWaterNeighborBorder = nearestBorderTarget < -0.001;
		const borderNoiseCoeff = isWaterNeighborBorder ? NOISE_AMP : NOISE_AMP * 0.3;
		const noiseCoeff = NOISE_AMP * mu + borderNoiseCoeff * (1 - mu);
		const noiseH = interiorNoiseH * mu + borderNoiseH * (1 - mu);
		h = selfTierH * mu + nearestBorderTarget * (1 - mu) + noiseH * noiseCoeff;
		if (nearestBorderTarget === 0 && nearestEdgeIdx >= 0) {
			const coastMid = 4 * nearestEdgeT * (1 - nearestEdgeT);
			const coastBlend = mu * (1 - mu);
			h -= COAST_ROUNDING * coastMid * coastBlend * 4;
		}
	}
	const hBase = h;

	const state: CliffWalkState = { bestMu: 1, bestMidH: h };
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

	if (state.bestMu < 1) {
		h = state.bestMidH * (1 - state.bestMu) + hBase * state.bestMu;
	}

	return {
		h,
		hasBorder,
		borderTarget: nearestBorderTarget,
		bestMu: state.bestMu,
		bestMidH: state.bestMidH,
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
	console.log(`A's edge walk:`);
	const simA = simulateShaderHeight(m, A, cellById, true);
	console.log(`  → A.h=${simA.h.toFixed(6)} target=${simA.borderTarget.toFixed(4)} bestMu=${simA.bestMu.toFixed(3)}`);
	console.log(`B's edge walk:`);
	const simB = simulateShaderHeight(m, B, cellById, true);
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

export function findRenderedMeshGaps(
	cells: HexCell[],
	flatChunks: { mesh: { getVerticesData: (kind: string) => number[] | Float32Array | null }; cellIds: number[] }[],
	planetRadius: number,
	topK = 30,
): { gaps: RenderedGap[]; totalEdgeMatches: number; print: () => void } {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

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
			const sim = simulateShaderHeight(u, cell, cellById);
			const bk = `${Math.round(ux / STEP)},${Math.round(uy / STEP)},${Math.round(uz / STEP)}`;
			let list = buckets.get(bk);
			if (!list) { list = []; buckets.set(bk, list); }
			list.push({ hexId, ux, uy, uz, h: sim.h, sim });
		}
	}

	const gaps: RenderedGap[] = [];
	let totalEdgeMatches = 0;
	for (const [, list] of buckets) {
		if (list.length < 2) continue;
		// Compare pairs — we want the WORST diff per bucket.
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i], b = list[j];
				if (a.hexId === b.hexId) continue;
				totalEdgeMatches++;
				const diff = Math.abs(a.h - b.h);
				const worldGapKm = diff * planetRadius;
				if (worldGapKm > 0.1) { // > 100m worth tracking
					gaps.push({
						hexAId: a.hexId, hexBId: b.hexId,
						unitDir: [a.ux, a.uy, a.uz],
						hA: a.h, hB: b.h,
						worldGapKm,
						notesA: `tier=${cellById.get(a.hexId)!.heightLevel} target=${a.sim.borderTarget.toFixed(4)} bestMu=${a.sim.bestMu.toFixed(3)} bestMidH=${a.sim.bestMidH.toFixed(5)}`,
						notesB: `tier=${cellById.get(b.hexId)!.heightLevel} target=${b.sim.borderTarget.toFixed(4)} bestMu=${b.sim.bestMu.toFixed(3)} bestMidH=${b.sim.bestMidH.toFixed(5)}`,
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
