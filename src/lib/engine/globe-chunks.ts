/**
 * Spatial chunking + visibility culling.
 *
 * Splits hex cells into 80 chunks based on which icosahedron sub-face
 * they sit on (20 ico faces × 4 midpoint sub-tris). Each chunk has a
 * centroid direction used for cheap hemisphere culling.
 *
 * Designed so per-chunk LOD (`rebuildChunkAtLOD`) can be wired in
 * later without changing the chunk identity or shape.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { HexCell } from './icosphere';

export const NUM_CHUNKS = 80;

export interface ChunkAssignment {
	/** cellIdx → chunkIdx */
	chunkOfCell: number[];
	/** chunkIdx → list of cellIdx in that chunk */
	cellsByChunk: number[][];
	/** chunkIdx → unit-vector centroid (pointing outward) */
	centroids: Vector3[];
}

export interface ChunkRuntime {
	/** Babylon mesh for this chunk (one per chunk). */
	mesh: Mesh;
	/** Outward unit centroid; used for hemisphere visibility test. */
	centroid: Vector3;
	/** Cells assigned to this chunk (cellIdx). */
	cellIds: number[];
	/** cellIdx → vertex offset within this chunk's buffers. */
	cellLocalStart: Map<number, number>;
	/** cellIdx → vertex count within this chunk's buffers. */
	cellVertexCount: Map<number, number>;
	/** Mutable color buffer (CPU mirror used by setHexTerrain). */
	colorsBuffer: Float32Array;
	/** Mutable position buffer (read by setHexTerrain to recompute UV-direction). */
	positionsBuffer: Float32Array;
	/** Subdivision level used for this chunk's current geometry. (LOD scaffold.) */
	currentLOD: number;
}

// ── Icosahedron primitives (mirrors icosphere.ts) ─────────────

function icoVertsLocal(): Vector3[] {
	const s = 2 / Math.sqrt(5);
	const c = 1 / Math.sqrt(5);
	const pts: Vector3[] = [];
	pts.push(new Vector3(0, 1, 0));
	for (let i = 0; i < 5; i++) {
		pts.push(new Vector3(s * Math.cos(i * 2 * Math.PI / 5), c, s * Math.sin(i * 2 * Math.PI / 5)));
	}
	for (let i = 0; i < 6; i++) {
		const v = pts[i];
		pts.push(new Vector3(-v.x, -v.y, v.z));
	}
	return pts;
}

function icoFacesLocal(): [number, number, number][] {
	const tris: [number, number, number][] = [];
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 1, 0, i + 1]);
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 7, 6, i + 7]);
	for (let i = 0; i < 5; i++) tris.push([i + 1, (7 - i) % 5 + 7, (i + 1) % 5 + 1]);
	for (let i = 0; i < 5; i++) tris.push([i + 1, (8 - i) % 5 + 7, (7 - i) % 5 + 7]);
	return tris;
}

function midSphere(a: Vector3, b: Vector3): Vector3 {
	return new Vector3(a.x + b.x, a.y + b.y, a.z + b.z).normalize();
}

function centroidSphere(a: Vector3, b: Vector3, c: Vector3): Vector3 {
	return new Vector3(a.x + b.x + c.x, a.y + b.y + c.y, a.z + b.z + c.z).normalize();
}

/** 80 chunk centroids = 20 ico faces × 4 midpoint sub-tris. */
export function computeChunkCentroids(): Vector3[] {
	const verts = icoVertsLocal();
	const faces = icoFacesLocal();
	const out: Vector3[] = [];
	for (const [i0, i1, i2] of faces) {
		const a = verts[i0], b = verts[i1], c = verts[i2];
		const mab = midSphere(a, b);
		const mbc = midSphere(b, c);
		const mac = midSphere(a, c);
		out.push(centroidSphere(a, mab, mac));
		out.push(centroidSphere(mab, b, mbc));
		out.push(centroidSphere(mac, mbc, c));
		out.push(centroidSphere(mab, mbc, mac));
	}
	return out;
}

/** Bucket each cell to its nearest centroid by spherical dot product. */
export function assignCellsToChunks(cells: HexCell[]): ChunkAssignment {
	const centroids = computeChunkCentroids();
	const chunkOfCell = new Array<number>(cells.length);
	const cellsByChunk: number[][] = centroids.map(() => []);
	for (let i = 0; i < cells.length; i++) {
		const c = cells[i].center;
		let bestK = 0;
		let bestDot = -Infinity;
		for (let k = 0; k < centroids.length; k++) {
			const cn = centroids[k];
			const d = c.x * cn.x + c.y * cn.y + c.z * cn.z;
			if (d > bestDot) {
				bestDot = d;
				bestK = k;
			}
		}
		chunkOfCell[i] = bestK;
		cellsByChunk[bestK].push(i);
	}
	return { chunkOfCell, cellsByChunk, centroids };
}

/** Hemisphere visibility test. Returns true if chunk should render.
 *  `cameraDirUnit` = camera position projected onto unit sphere
 *  (i.e. cam.normalize()). Threshold of -0.1 keeps chunks that
 *  straddle the horizon enabled, avoiding pop at the limb. */
export function isChunkVisible(
	centroid: Vector3,
	cameraDirX: number,
	cameraDirY: number,
	cameraDirZ: number,
	threshold = -0.1,
): boolean {
	const d = centroid.x * cameraDirX + centroid.y * cameraDirY + centroid.z * cameraDirZ;
	return d > threshold;
}
