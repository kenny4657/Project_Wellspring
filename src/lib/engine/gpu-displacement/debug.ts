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

function isExcludedEdge(selfH: number, nbH: number): boolean {
	const selfWater = selfH <= 1;
	const nbWater = nbH <= 1;
	if (!selfWater && !nbWater) return true;
	if (!selfWater && nbWater && selfH > 2) return true;
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
	neighborH: number[];   // length 6, padded with self.h for missing slots
	neighborIds: (number | null)[];
}

function fetchCellData(cell: HexCell, cellById: Map<number, HexCell>): CellData {
	const n = cell.corners.length;
	const neighborH: number[] = [];
	const neighborIds: (number | null)[] = [];
	for (let k = 0; k < 6; k++) {
		if (k >= n) {
			neighborH.push(cell.heightLevel);
			neighborIds.push(null);
			continue;
		}
		const nb = findNeighborAcrossEdge(cell, k, cellById);
		neighborH.push(nb ? nb.heightLevel : cell.heightLevel);
		neighborIds.push(nb ? nb.id : null);
	}
	return { heightLevel: cell.heightLevel, corners: cell.corners, neighborH, neighborIds };
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

	const hexRadius = meanHexRadius(self.corners);
	const n = self.corners.length;

	let minDist = Infinity;
	let nearestEdgeIdx = -1;
	let nearestEdgeT = 0;
	let nearestBorderTarget = 0;
	let hasBorder = false;
	const coastK = 0.22;
	let coastWeightSum = 0;
	let hasCoastEdge = false;

	for (let i = 0; i < n; i++) {
		const nbH = self.neighborH[i];
		if (isExcludedEdge(selfH, nbH)) continue;
		const a = self.corners[i];
		const b = self.corners[(i + 1) % n];
		const { dist, t } = distAndT(unitDir, a, b);
		const target = computeBorderTarget(selfH, nbH);
		const coast = isCoastEdge(selfH, nbH);
		if (dist < minDist) {
			minDist = dist;
			nearestEdgeIdx = i;
			nearestEdgeT = t;
			nearestBorderTarget = target;
		}
		if (coast) { coastWeightSum += Math.exp(-dist / coastK); hasCoastEdge = true; }
		hasBorder = true;
	}

	let h: number;
	if (!hasBorder) {
		h = selfTierH + interiorNoiseH * NOISE_AMP;
	} else {
		let dist = minDist;
		if (hasCoastEdge && nearestBorderTarget === 0 && coastWeightSum > 0) {
			const smoothD = -Math.log(coastWeightSum) * coastK;
			dist = Math.min(dist, smoothD);
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
		const nbId = self.neighborIds[i];
		if (nbId == null) continue;
		const nb = cellById.get(nbId);
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
