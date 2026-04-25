/**
 * Globe mesh builder — Sota-style subdivided hex prisms.
 *
 * Each hex top face is tessellated into many triangles via recursive
 * midpoint subdivision, with noise-based radial vertex displacement
 * creating natural terrain undulation. Flat shading (non-shared vertices)
 * gives the faceted rocky look. Side walls are flat quads.
 *
 * The shader determines biome by height (distance from sphere center),
 * not by terrain type. Vertex color alpha encodes wall (0.0) vs top (1.0).
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from './icosphere';
import { fbmNoise } from './noise';

import '@babylonjs/core/Meshes/Builders/linesBuilder';

import {
	type HexBorderInfo,
	getHexBorderInfo,
	getLevelHeight,
	findNeighborAcrossEdge,
	cornerKey,
	buildCornerTargetMap,
	getLocalCornerActiveTarget,
} from './hex-borders';
import {
	distToSegment,
	distToTerrainBorder,
	distToCoast,
	distToGentleLandEdge,
} from './hex-distance-fields';
import {
	BASE_HEIGHT,
	NOISE_AMP,
	NOISE_SCALE,
	CORNER_PATCH_EDGE_T,
	computeSurfaceHeight,
	computeHeightWithCliffErosion,
	cornerPatchHeight,
} from './hex-heights';
import { getTerrainColor, getTopFaceColor } from './vertex-encoding';
import {
	SUBDIVISIONS,
	subdivTriangle,
	smoothNormalsPass,
	smoothWaterCornerPositions,
	smoothLandSeamPositions,
	smoothCoastalSeamPositions,
	subdivideEdge,
	lerpOnSphere,
} from './mesh-smoothing';

// ── Build Globe Mesh ────────────────────────────────────────

export function buildGlobeMesh(cells: HexCell[], radius: number, scene: Scene): {
	mesh: Mesh;
	vertexStarts: number[];
	totalVerticesPerCell: number[];
	colorsBuffer: Float32Array;
	positionsBuffer: Float32Array;
} {
	const positions: number[] = [];
	const indices: number[] = [];
	const normals: number[] = [];
	const colors: number[] = [];
	const vertexStarts: number[] = [];
	const totalVerticesPerCell: number[] = [];

	let vOff = 0;
	const botR = radius * (1 + BASE_HEIGHT);

	// Build cell-by-ID lookup for neighbor queries
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellById));
	const cornerTargets = buildCornerTargetMap(cells, borderInfoById);


	for (let ci = 0; ci < cells.length; ci++) {
		const cell = cells[ci];
		const n = cell.corners.length;
		if (n < 3) { vertexStarts.push(vOff); totalVerticesPerCell.push(0); continue; }

		vertexStarts.push(vOff);
		const startVOff = vOff;

		const color = getTerrainColor(cell.terrain);   // wall faces
		const tierH = getLevelHeight(cell.heightLevel);
		const isWaterHex = cell.heightLevel <= 1;

		// Border info for coastline ramps + terrain blending
		const borderInfo = borderInfoById.get(cell.id)!;
		let hexRadius = 0;
		for (let i = 0; i < n; i++) {
			const dx = cell.corners[i].x - cell.center.x;
			const dy = cell.corners[i].y - cell.center.y;
			const dz = cell.corners[i].z - cell.center.z;
			hexRadius += Math.sqrt(dx * dx + dy * dy + dz * dz);
		}
		hexRadius /= n;

		// ── Subdivided top face ─────────────────────────────
		for (let i = 0; i < n; i++) {
			const c0 = cell.corners[(i + 1) % n];
			const c1 = cell.corners[i];
			const triVerts: number[] = [];
			subdivTriangle(
				cell.center.x, cell.center.y, cell.center.z,
				c0.x, c0.y, c0.z,
				c1.x, c1.y, c1.z,
				SUBDIVISIONS, triVerts
			);

			for (let j = 0; j < triVerts.length; j += 9) {
				const displaced: number[] = [];

				for (let k = 0; k < 3; k++) {
					const ux = triVerts[j + k * 3];
					const uy = triVerts[j + k * 3 + 1];
					const uz = triVerts[j + k * 3 + 2];
					const h = computeHeightWithCliffErosion(ux, uy, uz, cell, borderInfo, hexRadius, tierH, isWaterHex, cellById);
					const r = radius * (1 + h);
					displaced.push(ux * r, uy * r, uz * r);
				}

				// Face normal from displaced positions
				// Babylon.js uses left-handed coords (CW front faces), so negate
				// the right-hand cross product to get outward-pointing normals.
				const e1x = displaced[3] - displaced[0];
				const e1y = displaced[4] - displaced[1];
				const e1z = displaced[5] - displaced[2];
				const e2x = displaced[6] - displaced[0];
				const e2y = displaced[7] - displaced[1];
				const e2z = displaced[8] - displaced[2];
				let nx = -(e1y * e2z - e1z * e2y);
				let ny = -(e1z * e2x - e1x * e2z);
				let nz = -(e1x * e2y - e1y * e2x);
				const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
				nx /= nl; ny /= nl; nz /= nl;

				// Compute per-vertex terrain blend for all 3 vertices first
				const triNIds = [-1, -1, -1];
				const triBFs = [0, 0, 0];
				if (borderInfo.hasTerrainBorder) {
					for (let k = 0; k < 3; k++) {
						const tb = distToTerrainBorder(
							triVerts[j + k * 3], triVerts[j + k * 3 + 1], triVerts[j + k * 3 + 2],
							cell, borderInfo, hexRadius);
						if (tb.neighborTerrainId >= 0) {
							triBFs[k] = Math.min(tb.dist / hexRadius, 0.999);
							triNIds[k] = tb.neighborTerrainId;
						}
					}
				}
				// Use same neighborId for all 3 vertices to prevent interpolation
				// artifacts: GPU interpolates G across the triangle, and floor()
				// on the interpolated value jumps at integer boundaries, creating
				// faint lines with wrong terrain colors.
				let chosenNId = -1;
				let minBF = Infinity;
				for (let k = 0; k < 3; k++) {
					if (triNIds[k] >= 0 && triBFs[k] < minBF) {
						minBF = triBFs[k];
						chosenNId = triNIds[k];
					}
				}

				for (let k = 0; k < 3; k++) {
					const vx = triVerts[j + k * 3];
					const vy = triVerts[j + k * 3 + 1];
					const vz = triVerts[j + k * 3 + 2];

					// Per-vertex cliff proximity + cliff neighbor terrain for water hexes
					let cliffProx = 0;
					let cliffNbTerrain = -1;
					if (borderInfo.hasSteepCliff) {
						let minCliffDist = Infinity;
						for (let ei = 0; ei < n; ei++) {
							if (!borderInfo.steepCliffEdges[ei]) continue;
							const ea = cell.corners[ei];
							const eb = cell.corners[(ei + 1) % n];
							const d = distToSegment(vx, vy, vz, ea.x, ea.y, ea.z, eb.x, eb.y, eb.z);
							if (d < minCliffDist) {
								minCliffDist = d;
								if (isWaterHex) {
									const cliffNb = findNeighborAcrossEdge(cell, ei, cellById);
									if (cliffNb) cliffNbTerrain = cliffNb.terrain;
								}
							}
						}
						if (Number.isFinite(minCliffDist)) {
							cliffProx = Math.max(0, 1.0 - minCliffDist / (hexRadius * 0.3));
						}
						// In mixed hexes (both steep + gentle edges), suppress
						// cliff proximity near gentle edges so the shader doesn't
						// draw cliff texture on the gentle-slope faces
						if (cliffProx > 0 && borderInfo.hasGentleLandEdge) {
							const gd = distToGentleLandEdge(vx, vy, vz, cell, borderInfo);
							const gt = Math.min(gd / (hexRadius * 0.35), 1.0);
							const gentleFade = gt * gt * (3 - 2 * gt);
							cliffProx *= gentleFade;
						}
					}

					// Coast proximity in alpha
					let alpha = 1.0;
					if (borderInfo.hasCoast) {
						const cd = distToCoast(vx, vy, vz, cell, borderInfo);
						alpha = 0.5 + 0.5 * Math.min(cd / hexRadius, 1.0);
					}
					// For water hexes with cliff proximity, encode cliff neighbor's
					// terrain in G channel so shader uses correct cliff palette
					const effectiveNId = (isWaterHex && cliffProx > 0 && cliffNbTerrain >= 0) ? cliffNbTerrain : chosenNId;
					const effectiveBF = (isWaterHex && cliffProx > 0 && cliffNbTerrain >= 0) ? 0.01 : triBFs[k];
					const topColor = getTopFaceColor(cell.terrain, cell.heightLevel, effectiveNId, effectiveBF, cliffProx);
					positions.push(displaced[k * 3], displaced[k * 3 + 1], displaced[k * 3 + 2]);
					normals.push(nx, ny, nz);
					colors.push(topColor[0], topColor[1], topColor[2], alpha);
					indices.push(vOff++);
				}
			}
		}

		// ── Side walls ──────────────────────────────────────
		// Water hexes: cosine ramps handle all transitions — no walls.
		// Land hexes: walls only at land→land height transitions.
		// Coastline edges (land→water) use smooth ramps, not walls.
		if (isWaterHex) {
			// Water hexes use cosine ramps — skip all walls
		} else
		for (let i = 0; i < n; i++) {
			const c0 = cell.corners[i];
			const c1 = cell.corners[(i + 1) % n];

			const nb = findNeighborAcrossEdge(cell, i, cellById);
			if (!nb) continue;

			// Skip coastline edges — ramp handles the transition
			if (nb.heightLevel <= 1) continue;

			// No walls for land-land edges — cliff erosion handles those
			if (nb.heightLevel > 1) continue;

			// Only emit wall from the HIGHER hex.
			if (nb.heightLevel >= cell.heightLevel) continue;

			// For 1-level diffs, wall bottom matches neighbor's surface (gentle step).
			// For 2+ level diffs, wall goes to BASE_HEIGHT (full cliff).
			const heightDiff = Math.abs(cell.heightLevel - nb.heightLevel);
			const nbBorderInfo = borderInfoById.get(nb.id)!;
			let nbHexRadius = 0;
			for (let ci2 = 0; ci2 < nb.corners.length; ci2++) {
				const dx2 = nb.corners[ci2].x - nb.center.x;
				const dy2 = nb.corners[ci2].y - nb.center.y;
				const dz2 = nb.corners[ci2].z - nb.center.z;
				nbHexRadius += Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
			}
			nbHexRadius /= nb.corners.length;
			const nbTierH = getLevelHeight(nb.heightLevel);
			const nbIsWater = nb.heightLevel <= 1;

			const edgePoints: number[] = [];
			subdivideEdge(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, SUBDIVISIONS, edgePoints);

			for (let p = 0; p < edgePoints.length - 3; p += 3) {
				const ux0 = edgePoints[p];
				const uy0 = edgePoints[p + 1];
				const uz0 = edgePoints[p + 2];
				const ux1 = edgePoints[p + 3];
				const uy1 = edgePoints[p + 4];
				const uz1 = edgePoints[p + 5];

				const h0 = computeHeightWithCliffErosion(ux0, uy0, uz0, cell, borderInfo, hexRadius, tierH, isWaterHex, cellById);
				const h1 = computeHeightWithCliffErosion(ux1, uy1, uz1, cell, borderInfo, hexRadius, tierH, isWaterHex, cellById);
				const topR0 = radius * (1 + h0);
				const topR1 = radius * (1 + h1);

				// Wall bottom: neighbor's surface for gentle steps and coastal cliffs,
				// BASE_HEIGHT only for land-land cliffs.
				let wallBotR0: number, wallBotR1: number;
				if (heightDiff <= 1 || nbIsWater) {
					const nbH0 = computeHeightWithCliffErosion(ux0, uy0, uz0, nb, nbBorderInfo, nbHexRadius, nbTierH, nbIsWater, cellById);
					const nbH1 = computeHeightWithCliffErosion(ux1, uy1, uz1, nb, nbBorderInfo, nbHexRadius, nbTierH, nbIsWater, cellById);
					wallBotR0 = radius * (1 + nbH0);
					wallBotR1 = radius * (1 + nbH1);
				} else {
					wallBotR0 = botR;
					wallBotR1 = botR;
				}

				// Skip wall segment if erosion closed the gap (top ≈ bottom)
				if (Math.abs(topR0 - wallBotR0) < 0.5 && Math.abs(topR1 - wallBotR1) < 0.5) continue;

				const midX = (ux0 + ux1) * 0.5;
				const midY = (uy0 + uy1) * 0.5;
				const midZ = (uz0 + uz1) * 0.5;
				let wnx = midX - cell.center.x;
				let wny = midY - cell.center.y;
				let wnz = midZ - cell.center.z;
				const wnLen = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
				wnx /= wnLen; wny /= wnLen; wnz /= wnLen;

				const wallOff = vOff;

				positions.push(ux0 * topR0, uy0 * topR0, uz0 * topR0);
				normals.push(wnx, wny, wnz);
				colors.push(color[0], color[1], color[2], 0.0);

				positions.push(ux1 * topR1, uy1 * topR1, uz1 * topR1);
				normals.push(wnx, wny, wnz);
				colors.push(color[0], color[1], color[2], 0.0);

				positions.push(ux0 * wallBotR0, uy0 * wallBotR0, uz0 * wallBotR0);
				normals.push(wnx, wny, wnz);
				colors.push(color[0], color[1], color[2], 0.0);

				positions.push(ux1 * wallBotR1, uy1 * wallBotR1, uz1 * wallBotR1);
				normals.push(wnx, wny, wnz);
				colors.push(color[0], color[1], color[2], 0.0);

				indices.push(wallOff + 0, wallOff + 1, wallOff + 2);
				indices.push(wallOff + 1, wallOff + 3, wallOff + 2);
				vOff += 4;
			}
		}

		totalVerticesPerCell.push(vOff - startVOff);
	}

	const positionsF32 = new Float32Array(positions);
	const colorsF32 = new Float32Array(colors);
	const normalsF32 = new Float32Array(normals);

	// ── Smooth normals pass (Sota-style) ────────────────────
	// Average normals at coincident vertex positions for top-face vertices.
	// This makes terrain look continuous across triangle/hex boundaries.
	// Wall vertices (alpha=0) are excluded to keep cliff faces sharp.
	smoothWaterCornerPositions(positionsF32, colorsF32, vOff);
	smoothLandSeamPositions(positionsF32, colorsF32, vOff);
	smoothCoastalSeamPositions(positionsF32, colorsF32, vOff);
	// Smooth normals AFTER all position adjustments so normals
	// reflect the final vertex positions (not pre-adjustment positions)
	smoothNormalsPass(positionsF32, normalsF32, colorsF32, vOff);

	// ── Diagnostic: find height mismatches at coincident land vertices ──
	{
		const map = new Map<string, number[]>();
		for (let i = 0; i < vOff; i++) {
			if (colorsF32[i * 4 + 3] < 0.05) continue; // skip walls
			const r = colorsF32[i * 4], b = colorsF32[i * 4 + 2];
			if (b > r + 0.05) continue; // skip water
			const px = positionsF32[i * 3], py = positionsF32[i * 3 + 1], pz = positionsF32[i * 3 + 2];
			const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
			const key = `${Math.round(px / len / 0.0001)},${Math.round(py / len / 0.0001)},${Math.round(pz / len / 0.0001)}`;
			let list = map.get(key);
			if (!list) { list = []; map.set(key, list); }
			list.push(i);
		}
		// Only report SAME-LEVEL gaps (< 50km) — large gaps are intentional height steps
		let gapCount = 0;
		let maxGap = 0;
		const gapExamples: string[] = [];
		for (const [key, indices] of map.entries()) {
			if (indices.length <= 1) continue;
			// Cluster by radius to separate intentional height levels
			const radii = indices.map(i => {
				const px = positionsF32[i * 3], py = positionsF32[i * 3 + 1], pz = positionsF32[i * 3 + 2];
				return Math.sqrt(px * px + py * py + pz * pz);
			});
			// Sort and find same-level clusters
			const sorted = radii.slice().sort((a, b) => a - b);
			for (let s = 0; s < sorted.length; ) {
				let e = s + 1;
				while (e < sorted.length && sorted[e] - sorted[e-1] < 50) e++;
				const clusterGap = sorted[e-1] - sorted[s];
				if (clusterGap > 0.5 && e - s > 1) {
					gapCount++;
					if (clusterGap > maxGap) maxGap = clusterGap;
					if (gapExamples.length < 10) {
						const clusterRadii = sorted.slice(s, e).map(r => r.toFixed(2));
						gapExamples.push(`  gap=${clusterGap.toFixed(2)}km, n=${e-s}, radii=[${clusterRadii.join(', ')}], key=${key}`);
					}
				}
				s = e;
			}
		}
		console.log(`[SEAM DIAGNOSTIC] Same-level land gaps > 0.5km: ${gapCount}, max: ${maxGap.toFixed(2)}km`);
		for (const ex of gapExamples) console.log(ex);
	}

	const mesh = new Mesh('globeHex', scene);
	const vertexData = new VertexData();
	vertexData.positions = positionsF32;
	vertexData.indices = new Uint32Array(indices);
	vertexData.normals = normalsF32;
	vertexData.colors = colorsF32;
	vertexData.applyToMesh(mesh, true);

	return { mesh, vertexStarts, totalVerticesPerCell, colorsBuffer: colorsF32, positionsBuffer: positionsF32 };
}

export function buildCornerGapPatchMesh(cells: HexCell[], radius: number, scene: Scene): Mesh {
	const positions: number[] = [];
	const indices: number[] = [];
	const normals: number[] = [];
	const colors: number[] = [];

	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellById));
	const cornerTargets = buildCornerTargetMap(cells, borderInfoById);

	let vOff = 0;

	for (const cell of cells) {
		if (cell.heightLevel > 1) continue;

		const borderInfo = borderInfoById.get(cell.id);
		if (!borderInfo?.hasBorder) continue;

		const n = cell.corners.length;
		if (n < 3) continue;

		let hexRadius = 0;
		for (let i = 0; i < n; i++) {
			const dx = cell.corners[i].x - cell.center.x;
			const dy = cell.corners[i].y - cell.center.y;
			const dz = cell.corners[i].z - cell.center.z;
			hexRadius += Math.sqrt(dx * dx + dy * dy + dz * dz);
		}
		hexRadius /= n;

		const tierH = getLevelHeight(cell.heightLevel);
		const topColor = getTopFaceColor(cell.terrain, cell.heightLevel, -1, 0);

		for (let i = 0; i < n; i++) {
			const corner = cell.corners[i];
			const sharedTarget = cornerTargets.get(cornerKey(corner.x, corner.y, corner.z));
			if (sharedTarget === undefined) continue;

			const localTarget = getLocalCornerActiveTarget(cell, borderInfo, i);
			if (localTarget !== undefined && sharedTarget <= localTarget + 1e-9) continue;

			const prevCorner = cell.corners[(i + n - 1) % n];
			const nextCorner = cell.corners[(i + 1) % n];
			const prevDir = lerpOnSphere(corner, prevCorner, CORNER_PATCH_EDGE_T);
			const nextDir = lerpOnSphere(corner, nextCorner, CORNER_PATCH_EDGE_T);

			const apexH = cornerPatchHeight(corner.x, corner.y, corner.z, sharedTarget);
			const prevH = computeSurfaceHeight(
				prevDir.x, prevDir.y, prevDir.z,
				cell, borderInfo, hexRadius, tierH, true
			);
			const nextH = computeSurfaceHeight(
				nextDir.x, nextDir.y, nextDir.z,
				cell, borderInfo, hexRadius, tierH, true
			);

			const apexR = radius * (1 + apexH);
			const prevR = radius * (1 + prevH);
			const nextR = radius * (1 + nextH);

			const displaced = [
				corner.x * apexR, corner.y * apexR, corner.z * apexR,
				prevDir.x * prevR, prevDir.y * prevR, prevDir.z * prevR,
				nextDir.x * nextR, nextDir.y * nextR, nextDir.z * nextR
			];

			const e1x = displaced[3] - displaced[0];
			const e1y = displaced[4] - displaced[1];
			const e1z = displaced[5] - displaced[2];
			const e2x = displaced[6] - displaced[0];
			const e2y = displaced[7] - displaced[1];
			const e2z = displaced[8] - displaced[2];
			let nx = -(e1y * e2z - e1z * e2y);
			let ny = -(e1z * e2x - e1x * e2z);
			let nz = -(e1x * e2y - e1y * e2x);
			const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			nx /= nl;
			ny /= nl;
			nz /= nl;

			for (let k = 0; k < 3; k++) {
				positions.push(displaced[k * 3], displaced[k * 3 + 1], displaced[k * 3 + 2]);
				normals.push(nx, ny, nz);
				colors.push(topColor[0], topColor[1], topColor[2], 1.0);
				indices.push(vOff++);
			}
		}
	}

	const mesh = new Mesh('cornerGapPatches', scene);
	if (positions.length === 0) return mesh;

	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(positions);
	vertexData.indices = new Uint32Array(indices);
	vertexData.normals = new Float32Array(normals);
	vertexData.colors = new Float32Array(colors);
	vertexData.applyToMesh(mesh, true);
	mesh.isPickable = false;
	return mesh;
}

/** Update colors for a cell and its neighbors when terrain is painted.
 *  Recomputes per-vertex terrain blend for all affected cells. */
export function updateCellTerrain(
	mesh: Mesh,
	cells: HexCell[],
	cellIndex: number,
	vertexStarts: number[],
	totalVerticesPerCell: number[],
	radius: number,
	colorsBuffer: Float32Array,
	positionsBuffer: Float32Array
): void {
	// Build lookup maps
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const cellIdToIdx = new Map<number, number>();
	for (let i = 0; i < cells.length; i++) cellIdToIdx.set(cells[i].id, i);

	// Collect affected cells: painted cell + all its neighbors
	const affected = new Set<number>();
	affected.add(cellIndex);
	const cell = cells[cellIndex];
	for (const nId of cell.neighbors) {
		const nIdx = cellIdToIdx.get(nId);
		if (nIdx !== undefined) affected.add(nIdx);
	}

	for (const ci of affected) {
		const c = cells[ci];
		const n = c.corners.length;
		const wallColor = getTerrainColor(c.terrain);
		const tierH = getLevelHeight(c.heightLevel);
		const borderInfo = getHexBorderInfo(c, cellById);

		let hexRadius = 0;
		for (let i = 0; i < n; i++) {
			const dx = c.corners[i].x - c.center.x;
			const dy = c.corners[i].y - c.center.y;
			const dz = c.corners[i].z - c.center.z;
			hexRadius += Math.sqrt(dx * dx + dy * dy + dz * dz);
		}
		hexRadius /= n;

		const start = vertexStarts[ci];
		const count = totalVerticesPerCell[ci];

		for (let i = 0; i < count; ) {
			const vi0 = (start + i) * 4;
			const isWall = colorsBuffer[vi0 + 3] < 0.05;

			if (isWall) {
				// Wall vertices — update color individually
				colorsBuffer[vi0] = wallColor[0];
				colorsBuffer[vi0 + 1] = wallColor[1];
				colorsBuffer[vi0 + 2] = wallColor[2];
				i++;
			} else {
				// Top-face triangle — process 3 vertices together
				// to ensure same neighborId (prevents interpolation artifacts)
				const triNIds = [-1, -1, -1];
				const triBFs = [0, 0, 0];
				const triUVs: number[][] = [[], [], []];
				for (let k = 0; k < 3; k++) {
					const pi = (start + i + k) * 3;
					const px = positionsBuffer[pi], py = positionsBuffer[pi + 1], pz = positionsBuffer[pi + 2];
					const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
					triUVs[k] = [px / len, py / len, pz / len];
					if (borderInfo.hasTerrainBorder) {
						const tb = distToTerrainBorder(triUVs[k][0], triUVs[k][1], triUVs[k][2], c, borderInfo, hexRadius);
						if (tb.neighborTerrainId >= 0) {
							triBFs[k] = Math.min(tb.dist / hexRadius, 0.999);
							triNIds[k] = tb.neighborTerrainId;
						}
					}
				}
				// Pick neighborId from vertex closest to border
				let chosenNId = -1;
				let minBF = Infinity;
				for (let k = 0; k < 3; k++) {
					if (triNIds[k] >= 0 && triBFs[k] < minBF) {
						minBF = triBFs[k];
						chosenNId = triNIds[k];
					}
				}
				for (let k = 0; k < 3; k++) {
					const vi = (start + i + k) * 4;
					let alpha = 1.0;
					if (borderInfo.hasCoast) {
						const cd = distToCoast(triUVs[k][0], triUVs[k][1], triUVs[k][2], c, borderInfo);
						alpha = 0.5 + 0.5 * Math.min(cd / hexRadius, 1.0);
					}
					const topColor = getTopFaceColor(c.terrain, c.heightLevel, chosenNId, triBFs[k]);
					colorsBuffer[vi] = topColor[0];
					colorsBuffer[vi + 1] = topColor[1];
					colorsBuffer[vi + 2] = topColor[2];
					colorsBuffer[vi + 3] = alpha;
				}
				i += 3;
			}
		}
	}

	mesh.setVerticesData(VertexBuffer.ColorKind, new Float32Array(colorsBuffer), true);
}

/** Build wireframe (optional overlay) */
export function buildHexEdgeLines(cells: HexCell[], radius: number, scene: Scene): Mesh {
	const lines: Vector3[][] = [];
	for (const cell of cells) {
		const tH = getLevelHeight(cell.heightLevel);
		const nc = cell.corners.length;
		for (let i = 0; i < nc; i++) {
			const a = cell.corners[i], b = cell.corners[(i + 1) % nc];
			const na = fbmNoise(a.x * NOISE_SCALE, a.y * NOISE_SCALE, a.z * NOISE_SCALE);
			const nb = fbmNoise(b.x * NOISE_SCALE, b.y * NOISE_SCALE, b.z * NOISE_SCALE);
			const ra = radius * (1 + tH + na * NOISE_AMP) * 1.001;
			const rb = radius * (1 + tH + nb * NOISE_AMP) * 1.001;
			lines.push([new Vector3(a.x * ra, a.y * ra, a.z * ra), new Vector3(b.x * rb, b.y * rb, b.z * rb)]);
		}
	}
	const lineSystem = MeshBuilder.CreateLineSystem('hexEdges', { lines }, scene);
	lineSystem.color = new Color3(0.05, 0.05, 0.05);
	lineSystem.isPickable = false;
	return lineSystem;
}
