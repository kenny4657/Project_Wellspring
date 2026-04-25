/**
 * Icosahedral hex grid on a sphere.
 * Ported from ardazishvili/Sota.
 *
 * Key difference from previous attempt: corners are NEVER skipped.
 * All 6 corners are projected even if outside the current triangle,
 * and the deduplication system merges them from adjacent triangles.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';

export interface HexCell {
	id: number;
	center: Vector3;
	corners: Vector3[];
	neighbors: Set<number>;
	terrain: number;
	/** Discrete height level (0-5), independent of terrain type */
	heightLevel: number;
	isPentagon: boolean;
}

// ── Icosahedron ──

function icoPoints(): Vector3[] {
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

function icoIndices(): [number, number, number][] {
	const tris: [number, number, number][] = [];
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 1, 0, i + 1]);
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 7, 6, i + 7]);
	for (let i = 0; i < 5; i++) tris.push([i + 1, (7 - i) % 5 + 7, (i + 1) % 5 + 1]);
	for (let i = 0; i < 5; i++) tris.push([i + 1, (8 - i) % 5 + 7, (7 - i) % 5 + 7]);
	return tris;
}

// ── Projection ──

function barycentric(x: number, z: number): [number, number, number] {
	const l3 = z * 2.0 / Math.sqrt(3.0);
	const l2 = x + 0.5 * (1 - l3);
	const l1 = 1 - l2 - l3;
	return [l1, l2, l3];
}

function slerp(a: Vector3, b: Vector3, t: number): Vector3 {
	if (t <= 0) return a.clone();
	if (t >= 1) return b.clone();
	const dot = Math.max(-1, Math.min(1, Vector3.Dot(a, b)));
	const omega = Math.acos(dot);
	if (omega < 1e-10) return a.clone();
	const so = Math.sin(omega);
	const wa = Math.sin((1 - t) * omega) / so;
	const wb = Math.sin(t * omega) / so;
	return new Vector3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
}

function map2dTo3d(x: number, z: number, s1: Vector3, s2: Vector3, s3: Vector3): Vector3 {
	const [l1, l2, l3] = barycentric(x, z);
	if (Math.abs(l3 - 1) < 1e-10) return s3.clone();
	const l2s = l2 / (l1 + l2 + 1e-15);
	const p12 = slerp(s1, s2, Math.max(0, Math.min(1, l2s)));
	return slerp(p12, s3, Math.max(0, Math.min(1, l3)));
}

// ── Discrete key ──

function discreteKey(v: Vector3, step: number): string {
	return `${Math.round(v.x / step)},${Math.round(v.y / step)},${Math.round(v.z / step)}`;
}

// ── Face data exposed for GLSL hex lookup ──

/**
 * Per-face data needed to reconstruct (face, i, j) → cellId in a shader.
 * The shader projects a sphere point onto a face's planar triangle, recovers
 * planar barycentric coords, converts to face-local 2D (x, z), then to (i, j).
 *
 * v0/v1/v2 are the icosahedron's *unit-sphere* vertices for this face, in the
 * canonical [i0, i1, i2] order from icoIndices(). Order matters — barycentric
 * coords (l1, l2, l3) align to (v0, v1, v2) and the inverse map below is
 * derived from this ordering.
 */
export interface IcoFaceData {
	v0: { x: number; y: number; z: number };
	v1: { x: number; y: number; z: number };
	v2: { x: number; y: number; z: number };
}

export interface IcoGridWithFaces {
	cells: HexCell[];
	faces: IcoFaceData[];
	/**
	 * Flat lookup grid: faceGrid[face * stride + i * (res+2) + j] = cellId, or -1.
	 * stride = (res+2) * (res+2). 20 faces.
	 */
	faceGrid: Int32Array;
	resolution: number;
}

/** Constants for the face-local 2D grid. Mirror these in GLSL. */
export function faceGridParams(resolution: number) {
	const r = (1.0 / 2) / (resolution + 1);
	const R = r * 2 / Math.sqrt(3);
	const diameter = 2 * R;
	return {
		r,                           // small hex radius (apothem)
		R,                           // large hex radius (circumradius)
		startX: -0.5,
		rowStep: diameter * 3.0 / 4.0, // cz step between rows
		colStep: 2 * r,                // cx step between cols
		oddRowOffset: r,               // cx += r when i is odd
		gridSize: resolution + 2,      // (i, j) range
	};
}

// ── Generation ──

export function generateIcoHexGrid(resolution: number): HexCell[] {
	return generateIcoHexGridWithFaces(resolution).cells;
}

export function generateIcoHexGridWithFaces(resolution: number): IcoGridWithFaces {
	const icoVerts = icoPoints();
	const icoTris = icoIndices();
	const gridSize = resolution + 2;
	const faceGrid = new Int32Array(20 * gridSize * gridSize).fill(-1);
	const faces: IcoFaceData[] = [];

	const r = (1.0 / 2) / (resolution + 1);
	const R = r * 2 / Math.sqrt(3);
	const diameter = 2 * R;
	const startX = -0.5;
	const keyStep = r / 3.0;

	const f1 = (x: number) => Math.sqrt(3) * x + Math.sqrt(3) / 2;
	const f2 = (x: number) => -Math.sqrt(3) * x + Math.sqrt(3) / 2;

	// cellMap stores hex data keyed by discretized sphere position
	const cellMap = new Map<string, { center: Vector3; corners: Vector3[]; isPentagon: boolean }>();
	const cellKeyToId = new Map<string, number>();
	const globalNeighbors = new Map<number, Set<number>>();
	let nextId = 0;

	const isPentagonIJ = (i: number, j: number): boolean => {
		return (i === resolution + 1) || (i === 0 && (j === 0 || j === resolution + 1));
	};

	for (let t = 0; t < 20; t++) {
		const [i0, i1, i2] = icoTris[t];
		const v0 = icoVerts[i0];
		const v1 = icoVerts[i1];
		const v2 = icoVerts[i2];

		// Record this face's sphere-normalized triangle vertices for the GLSL
		// inverse-map. Match the (v0, v1, v2) order the barycentric() function
		// assumes — l1↔v0, l2↔v1, l3↔v2.
		const v0n = v0.clone().normalize();
		const v1n = v1.clone().normalize();
		const v2n = v2.clone().normalize();
		faces.push({
			v0: { x: v0n.x, y: v0n.y, z: v0n.z },
			v1: { x: v1n.x, y: v1n.y, z: v1n.z },
			v2: { x: v2n.x, y: v2n.y, z: v2n.z },
		});

		const patchCells = new Map<string, number>();

		for (let i = 0; i < resolution + 2; i++) {
			for (let j = 0; j < resolution + 2; j++) {
				let cx = startX + 2 * r * j;
				const cz = diameter * 3.0 * i / 4.0;
				if (i & 1) cx += r;

				// Skip hexes clearly outside triangle (with generous tolerance)
				if (cz < -r / 2 || cz > f1(cx) + r / 2 || cz > f2(cx) + r / 2) continue;

				const mappedCenter = map2dTo3d(cx, cz, v0, v1, v2).normalize();
				const key = discreteKey(mappedCenter, keyStep);
				const isPent = isPentagonIJ(i, j);

				if (!cellMap.has(key)) {
					cellMap.set(key, { center: mappedCenter, corners: [], isPentagon: isPent });
					cellKeyToId.set(key, nextId);
					globalNeighbors.set(nextId, new Set());
					nextId++;
				}

				const cellId = cellKeyToId.get(key)!;
				const cell = cellMap.get(key)!;
				patchCells.set(`${i},${j}`, cellId);
				faceGrid[t * gridSize * gridSize + i * gridSize + j] = cellId;

				// Generate corners — only project those within the triangle
				// Corners outside this triangle will be contributed by adjacent triangles
				// via the deduplication system (same hex center → corners accumulate)
				for (let k = 0; k < 6; k++) {
					const angle = -Math.PI / 6 + k * Math.PI / 3;
					const px = cx + Math.cos(angle) * R;
					const pz = cz + Math.sin(angle) * R;

					// Check if corner is inside triangle (with small tolerance)
					if (pz < -0.01 || pz > f1(px) + 0.01 || pz > f2(px) + 0.01) continue;

					const mappedCorner = map2dTo3d(px, pz, v0, v1, v2).normalize();

					// Deduplicate corners by distance
					let isDupe = false;
					for (const existing of cell.corners) {
						if (Vector3.DistanceSquared(existing, mappedCorner) < keyStep * keyStep * 0.25) {
							isDupe = true;
							break;
						}
					}
					if (!isDupe) cell.corners.push(mappedCorner);
				}
			}
		}

		// Neighbors within this patch
		for (const [ij, cellId] of patchCells) {
			const [i, j] = ij.split(',').map(Number);
			const offsets = (i & 1)
				? [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
				: [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
			for (const [di, dj] of offsets) {
				const nId = patchCells.get(`${i + di},${j + dj}`);
				if (nId !== undefined && nId !== cellId) {
					globalNeighbors.get(cellId)!.add(nId);
					globalNeighbors.get(nId)!.add(cellId);
				}
			}
		}
	}

	// Sort corners angularly and limit to 5-6
	for (const [, cell] of cellMap) {
		if (cell.corners.length < 3) continue;
		const n = cell.center;
		const up = Math.abs(n.y) < 0.999 ? Vector3.Up() : Vector3.Right();
		const right = Vector3.Cross(up, n).normalize();
		const fwd = Vector3.Cross(n, right).normalize();

		cell.corners.sort((a, b) => {
			const da = a.subtract(n);
			const db = b.subtract(n);
			return Math.atan2(Vector3.Dot(da, fwd), Vector3.Dot(da, right))
				- Math.atan2(Vector3.Dot(db, fwd), Vector3.Dot(db, right));
		});

		// Remove near-duplicate corners that survived the per-insertion check
		// (can happen when corners from different triangles land at similar positions)
		const merged: Vector3[] = [cell.corners[0]];
		for (let i = 1; i < cell.corners.length; i++) {
			let dupe = false;
			for (const m of merged) {
				if (Vector3.DistanceSquared(cell.corners[i], m) < keyStep * keyStep * 0.5) {
					dupe = true; break;
				}
			}
			if (!dupe) merged.push(cell.corners[i]);
		}
		cell.corners = merged;
	}

	// Build final array
	const cells: HexCell[] = [];
	for (const [key, data] of cellMap) {
		if (data.corners.length < 3) continue; // skip degenerate
		const id = cellKeyToId.get(key)!;
		cells.push({
			id, center: data.center, corners: data.corners,
			neighbors: globalNeighbors.get(id) || new Set(),
			terrain: 0, heightLevel: 0, isPentagon: data.isPentagon
		});
	}

	return { cells, faces, faceGrid, resolution };
}
