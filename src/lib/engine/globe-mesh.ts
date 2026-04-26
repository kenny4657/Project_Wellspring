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
import { getTerrainColor, getTopFaceColor, encodeTopVertexColor } from './vertex-encoding';
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
import type { ChunkAssignment, ChunkRuntime } from './globe-chunks';

// ── Build Globe Mesh ────────────────────────────────────────

/** Average distance from cell center to its corners — used as the per-cell
 *  characteristic radius for distance-field falloff scaling. */
function computeHexRadius(cell: HexCell): number {
	const n = cell.corners.length;
	let hexRadius = 0;
	for (let i = 0; i < n; i++) {
		const dx = cell.corners[i].x - cell.center.x;
		const dy = cell.corners[i].y - cell.center.y;
		const dz = cell.corners[i].z - cell.center.z;
		hexRadius += Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	return hexRadius / n;
}

/** Mutable cursor for vOff so phase helpers can advance it as they emit verts. */
type VertexOffset = { value: number };

/** Build all top-face triangles for one cell: subdivide each fan triangle,
 *  displace by terrain height, compute per-vertex RGBA, and append to the
 *  shared mesh buffers. */
function buildCellTopFace(
	cell: HexCell,
	borderInfo: HexBorderInfo,
	cellById: Map<number, HexCell>,
	borderInfoById: Map<number, HexBorderInfo>,
	hexRadius: number,
	tierH: number,
	radius: number,
	isWaterHex: boolean,
	positions: number[],
	normals: number[],
	colors: number[],
	indices: number[],
	vOffRef: VertexOffset,
): void {
	const n = cell.corners.length;
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
				const h = computeHeightWithCliffErosion(ux, uy, uz, cell, borderInfo, hexRadius, tierH, isWaterHex, cellById, borderInfoById);
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

				const rgba = encodeTopVertexColor(
					cell, vx, vy, vz, borderInfo, cellById, hexRadius,
					chosenNId, triBFs[k]
				);
				positions.push(displaced[k * 3], displaced[k * 3 + 1], displaced[k * 3 + 2]);
				normals.push(nx, ny, nz);
				colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
				indices.push(vOffRef.value++);
			}
		}
	}
}

/** Build all wall quads for one (land) cell where it sits above a lower
 *  neighbor. Skips coast/water-water transitions (cosine ramps) and
 *  land-land transitions (cliff erosion). */
function buildCellWalls(
	cell: HexCell,
	borderInfo: HexBorderInfo,
	borderInfoById: Map<number, HexBorderInfo>,
	cellById: Map<number, HexCell>,
	hexRadius: number,
	tierH: number,
	radius: number,
	botR: number,
	isWaterHex: boolean,
	color: [number, number, number],
	positions: number[],
	normals: number[],
	colors: number[],
	indices: number[],
	vOffRef: VertexOffset,
): void {
	if (isWaterHex) return; // Water hexes use cosine ramps — no walls
	const n = cell.corners.length;
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
		const nbHexRadius = computeHexRadius(nb);
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

			const wallOff = vOffRef.value;

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
			vOffRef.value += 4;
		}
	}
}

export interface BuildGlobeMeshResult {
	chunks: ChunkRuntime[];
	/** cellIdx → chunkIdx (denormalized from ChunkAssignment for fast lookup). */
	chunkOfCell: number[];
	/** Total vertex count in cell ci (across whatever chunk owns it). */
	totalVerticesPerCell: number[];
}

export async function buildGlobeMesh(
	cells: HexCell[],
	radius: number,
	scene: Scene,
	chunkAssignment: ChunkAssignment,
	yieldEvery = 500,
): Promise<BuildGlobeMeshResult> {
	const positions: number[] = [];
	const indices: number[] = [];
	const normals: number[] = [];
	const colors: number[] = [];
	const vertexStarts: number[] = [];
	const totalVerticesPerCell: number[] = [];
	const indexStarts: number[] = [];
	const indexCountPerCell: number[] = [];

	const botR = radius * (1 + BASE_HEIGHT);

	// Build cell-by-ID lookup for neighbor queries
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const borderInfoById = new Map<number, HexBorderInfo>();
	for (const c of cells) borderInfoById.set(c.id, getHexBorderInfo(c, cellById));
	const cornerTargets = buildCornerTargetMap(cells, borderInfoById);

	const vOffRef: VertexOffset = { value: 0 };
	for (let ci = 0; ci < cells.length; ci++) {
		const cell = cells[ci];
		const n = cell.corners.length;
		if (n < 3) {
			vertexStarts.push(vOffRef.value);
			totalVerticesPerCell.push(0);
			indexStarts.push(indices.length);
			indexCountPerCell.push(0);
			continue;
		}

		vertexStarts.push(vOffRef.value);
		indexStarts.push(indices.length);
		const startVOff = vOffRef.value;
		const startIdx = indices.length;

		const color = getTerrainColor(cell.terrain);   // wall faces
		const tierH = getLevelHeight(cell.heightLevel);
		const isWaterHex = cell.heightLevel <= 1;

		// Border info for coastline ramps + terrain blending
		const borderInfo = borderInfoById.get(cell.id)!;
		const hexRadius = computeHexRadius(cell);

		buildCellTopFace(cell, borderInfo, cellById, borderInfoById, hexRadius, tierH, radius, isWaterHex,
			positions, normals, colors, indices, vOffRef);
		buildCellWalls(cell, borderInfo, borderInfoById, cellById, hexRadius, tierH, radius, botR, isWaterHex, color,
			positions, normals, colors, indices, vOffRef);

		totalVerticesPerCell.push(vOffRef.value - startVOff);
		indexCountPerCell.push(indices.length - startIdx);

		// Async yield: spread the build across frames so the main thread
		// stays responsive on big maps.
		if (yieldEvery > 0 && ci > 0 && ci % yieldEvery === 0) {
			await new Promise<void>(r => setTimeout(r, 0));
		}
	}

	const vOff = vOffRef.value;

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

	// ── Split the global buffers into per-chunk Babylon meshes ─────
	// Smoothing has run on the global flat buffers, so seams across
	// chunk boundaries are already consistent. Now we slice each
	// cell's vertex range out into the chunk it was assigned to.
	const chunks = splitGlobalBuffersIntoChunks(
		cells, scene, chunkAssignment,
		positionsF32, normalsF32, colorsF32, indices,
		vertexStarts, totalVerticesPerCell,
		indexStarts, indexCountPerCell,
	);

	return {
		chunks,
		chunkOfCell: chunkAssignment.chunkOfCell.slice(),
		totalVerticesPerCell,
	};
}

/** Slice the global flat buffers into per-chunk Babylon meshes.
 *  Each cell's vertex range is copied verbatim into its chunk's
 *  buffers, and indices are remapped from global → chunk-local.
 *  Smoothing (which ran on the global buffers) is preserved
 *  exactly: shared seam vertices on opposite sides of a chunk
 *  boundary were snapped to identical positions before slicing. */
function splitGlobalBuffersIntoChunks(
	cells: HexCell[],
	scene: Scene,
	assignment: ChunkAssignment,
	positions: Float32Array,
	normals: Float32Array,
	colors: Float32Array,
	indices: number[],
	vertexStarts: number[],
	totalVerticesPerCell: number[],
	indexStarts: number[],
	indexCountPerCell: number[],
): ChunkRuntime[] {
	const numChunks = assignment.cellsByChunk.length;
	const chunks: ChunkRuntime[] = [];

	for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
		const cellIds = assignment.cellsByChunk[chunkIdx];
		// Pre-count vertex + index totals so we can allocate typed
		// arrays of the exact final size (no growing).
		let totalV = 0;
		let totalI = 0;
		for (const ci of cellIds) {
			totalV += totalVerticesPerCell[ci];
			totalI += indexCountPerCell[ci];
		}

		const chunkPositions = new Float32Array(totalV * 3);
		const chunkNormals = new Float32Array(totalV * 3);
		const chunkColors = new Float32Array(totalV * 4);
		const chunkIndices = new Uint32Array(totalI);
		const cellLocalStart = new Map<number, number>();
		const cellVertexCount = new Map<number, number>();

		let writeV = 0;
		let writeI = 0;
		for (const ci of cellIds) {
			const srcVStart = vertexStarts[ci];
			const vCount = totalVerticesPerCell[ci];
			const srcIStart = indexStarts[ci];
			const iCount = indexCountPerCell[ci];
			cellLocalStart.set(ci, writeV);
			cellVertexCount.set(ci, vCount);

			// Copy vertex attributes for this cell's range.
			chunkPositions.set(positions.subarray(srcVStart * 3, (srcVStart + vCount) * 3), writeV * 3);
			chunkNormals.set(normals.subarray(srcVStart * 3, (srcVStart + vCount) * 3), writeV * 3);
			chunkColors.set(colors.subarray(srcVStart * 4, (srcVStart + vCount) * 4), writeV * 4);

			// Translate indices from global → chunk-local.
			const offset = writeV - srcVStart;
			for (let k = 0; k < iCount; k++) {
				chunkIndices[writeI + k] = indices[srcIStart + k] + offset;
			}

			writeV += vCount;
			writeI += iCount;
		}

		const mesh = new Mesh(`globeHex_${chunkIdx}`, scene);
		const vertexData = new VertexData();
		vertexData.positions = chunkPositions;
		vertexData.indices = chunkIndices;
		vertexData.normals = chunkNormals;
		vertexData.colors = chunkColors;
		vertexData.applyToMesh(mesh, true);

		chunks.push({
			mesh,
			centroid: assignment.centroids[chunkIdx],
			cellIds: cellIds.slice(),
			cellLocalStart,
			cellVertexCount,
			colorsBuffer: chunkColors,
			positionsBuffer: chunkPositions,
			currentLOD: SUBDIVISIONS,
		});
	}

	return chunks;
}

/** LOD-rebuild scaffold. Not wired up in this pass — exists so that
 *  approach (3) can replace a chunk's mesh without restructuring the
 *  pipeline. Today's chunks are all built at SUBDIVISIONS=3. */
export function rebuildChunkAtLOD(_chunkIdx: number, _newLOD: number): void {
	throw new Error('rebuildChunkAtLOD not yet implemented (LOD is approach #3)');
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

		const hexRadius = computeHexRadius(cell);

		const tierH = getLevelHeight(cell.heightLevel);
		// Corner-gap patches are tiny filler tris; a fixed encoding (no
		// cliff/coast modulation) is intentional — encodeTopVertexColor
		// would over-darken these patches at coastal corners.
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

/** Recolor the 3 vertices of a single top-face triangle in place.
 *  Reads positions from `positionsBuffer`, writes RGBA into `colorsBuffer`.
 *  Same per-triangle neighborId rule as the build path: GPU interpolation +
 *  floor() on the G channel produces hairline artifacts unless all 3 verts
 *  agree on the neighbor terrain id. */
function updateCellTopFaceTriangle(
	c: HexCell,
	borderInfo: HexBorderInfo,
	cellById: Map<number, HexCell>,
	hexRadius: number,
	triStart: number,
	colorsBuffer: Float32Array,
	positionsBuffer: Float32Array,
): void {
	const triNIds = [-1, -1, -1];
	const triBFs = [0, 0, 0];
	const triUVs: number[][] = [[], [], []];
	for (let k = 0; k < 3; k++) {
		const pi = (triStart + k) * 3;
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
		const vi = (triStart + k) * 4;
		const rgba = encodeTopVertexColor(
			c, triUVs[k][0], triUVs[k][1], triUVs[k][2],
			borderInfo, cellById, hexRadius, chosenNId, triBFs[k]
		);
		colorsBuffer[vi] = rgba[0];
		colorsBuffer[vi + 1] = rgba[1];
		colorsBuffer[vi + 2] = rgba[2];
		colorsBuffer[vi + 3] = rgba[3];
	}
}

/** Update colors for a cell and its neighbors when terrain is painted.
 *  Chunk-aware: writes only to the chunk(s) containing the affected
 *  cells and re-uploads the color buffer for those chunks alone.
 *  When the painted cell + its neighbors all live in one chunk that's
 *  one upload; in the worst case (cell on a chunk seam) it's a small
 *  handful of chunks, never the full globe. */
export function updateCellTerrain(
	chunks: ChunkRuntime[],
	chunkOfCell: number[],
	cells: HexCell[],
	cellIndex: number,
): void {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);
	const cellIdToIdx = new Map<number, number>();
	for (let i = 0; i < cells.length; i++) cellIdToIdx.set(cells[i].id, i);

	// Painted cell + its neighbors are all dirty.
	const affected = new Set<number>();
	affected.add(cellIndex);
	const paintedCell = cells[cellIndex];
	for (const nId of paintedCell.neighbors) {
		const nIdx = cellIdToIdx.get(nId);
		if (nIdx !== undefined) affected.add(nIdx);
	}

	const dirtyChunks = new Set<number>();
	for (const ci of affected) {
		const c = cells[ci];
		const chunkIdx = chunkOfCell[ci];
		const chunk = chunks[chunkIdx];
		const start = chunk.cellLocalStart.get(ci);
		const count = chunk.cellVertexCount.get(ci);
		if (start === undefined || count === undefined) continue;

		const wallColor = getTerrainColor(c.terrain);
		const borderInfo = getHexBorderInfo(c, cellById);
		const hexRadius = computeHexRadius(c);

		for (let i = 0; i < count; ) {
			const vi0 = (start + i) * 4;
			const isWall = chunk.colorsBuffer[vi0 + 3] < 0.05;

			if (isWall) {
				chunk.colorsBuffer[vi0] = wallColor[0];
				chunk.colorsBuffer[vi0 + 1] = wallColor[1];
				chunk.colorsBuffer[vi0 + 2] = wallColor[2];
				i++;
			} else {
				updateCellTopFaceTriangle(
					c, borderInfo, cellById, hexRadius,
					start + i, chunk.colorsBuffer, chunk.positionsBuffer,
				);
				i += 3;
			}
		}
		dirtyChunks.add(chunkIdx);
	}

	for (const chunkIdx of dirtyChunks) {
		const chunk = chunks[chunkIdx];
		chunk.mesh.setVerticesData(VertexBuffer.ColorKind, chunk.colorsBuffer, true);
	}
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
