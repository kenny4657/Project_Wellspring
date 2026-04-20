/**
 * Icosahedral hex grid on a sphere.
 * Ported from ardazishvili/Sota (MIT-like license).
 *
 * Algorithm:
 * 1. Start with icosahedron (12 vertices, 20 triangles)
 * 2. For each triangle, lay out a 2D hex grid
 * 3. Project each hex center + corners onto the sphere via barycentric + slerp
 * 4. Deduplicate shared hexes at triangle boundaries
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';

export interface HexCell {
	id: number;
	center: Vector3;        // position on unit sphere
	corners: Vector3[];     // 5 or 6 corner positions on unit sphere
	neighbors: Set<number>; // IDs of adjacent cells
	terrain: number;        // terrain type index
	isPentagon: boolean;
}

// ── Icosahedron ──

function icoPoints(): Vector3[] {
	const s = 2 / Math.sqrt(5);
	const c = 1 / Math.sqrt(5);
	const pts: Vector3[] = [];

	pts.push(new Vector3(0, 1, 0)); // top
	for (let i = 0; i < 5; i++) {
		pts.push(new Vector3(
			s * Math.cos(i * 2 * Math.PI / 5),
			c,
			s * Math.sin(i * 2 * Math.PI / 5)
		));
	}
	for (let i = 0; i < 6; i++) {
		const v = pts[i];
		pts.push(new Vector3(-v.x, -v.y, v.z));
	}
	return pts;
}

function icoIndices(): [number, number, number][] {
	const tris: [number, number, number][] = [];
	// Upper cap
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 1, 0, i + 1]);
	// Lower cap
	for (let i = 0; i < 5; i++) tris.push([(i + 1) % 5 + 7, 6, i + 7]);
	// Middle band
	for (let i = 0; i < 5; i++) tris.push([i + 1, (7 - i) % 5 + 7, (i + 1) % 5 + 1]);
	for (let i = 0; i < 5; i++) tris.push([i + 1, (8 - i) % 5 + 7, (7 - i) % 5 + 7]);
	return tris;
}

// ── Barycentric + Slerp projection ──

function barycentric(x: number, z: number): [number, number, number] {
	const l3 = z * 2.0 / Math.sqrt(3.0);
	const l2 = x + 0.5 * (1 - l3);
	const l1 = 1 - l2 - l3;
	return [l1, l2, l3];
}

function slerp(a: Vector3, b: Vector3, t: number): Vector3 {
	const dot = Vector3.Dot(a, b);
	const clamped = Math.max(-1, Math.min(1, dot));
	const omega = Math.acos(clamped);
	if (Math.abs(omega) < 1e-10) return a.clone();
	const sinOmega = Math.sin(omega);
	const wa = Math.sin((1 - t) * omega) / sinOmega;
	const wb = Math.sin(t * omega) / sinOmega;
	return new Vector3(
		a.x * wa + b.x * wb,
		a.y * wa + b.y * wb,
		a.z * wa + b.z * wb
	);
}

function map2dTo3d(x: number, z: number, s1: Vector3, s2: Vector3, s3: Vector3): Vector3 {
	const [l1, l2, l3] = barycentric(x, z);
	if (Math.abs(l3 - 1) < 1e-10) return s3.clone();
	const l2s = l2 / (l1 + l2);
	const p12 = slerp(s1, s2, l2s);
	return slerp(p12, s3, l3);
}

// ── Discrete key for deduplication ──

function discreteKey(v: Vector3, step: number): string {
	const x = Math.round(v.x / step);
	const y = Math.round(v.y / step);
	const z = Math.round(v.z / step);
	return `${x},${y},${z}`;
}

// ── Main generation ──

/**
 * Generate an icosahedral hex grid on a unit sphere.
 *
 * @param resolution Number of hexes along each edge of an icosahedron face.
 *   Higher = more hexes. Total ≈ 10 * resolution² + 2.
 * @returns Array of HexCells on the unit sphere
 */
export function generateIcoHexGrid(resolution: number): HexCell[] {
	const icoVerts = icoPoints();
	const icoTris = icoIndices();

	const r = (1.0 / 2) / (resolution + 1);  // hex small radius in 2D space
	const R = r * 2 / Math.sqrt(3);           // hex circumradius in 2D space
	const diameter = 2 * R;
	const startX = -0.5;
	const startZ = 0;

	const keyStep = r / 3.0;

	// Polygon maps: discreteKey → cell data
	const cellMap = new Map<string, { center: Vector3; corners: Vector3[]; isPentagon: boolean }>();
	const cellKeyToId = new Map<string, number>();
	let nextId = 0;

	// Neighbor tracking per triangle patch
	const globalNeighbors = new Map<number, Set<number>>();

	// Functions for triangle boundary
	const f1 = (x: number) => Math.sqrt(3) * x + Math.sqrt(3) / 2;
	const f2 = (x: number) => -Math.sqrt(3) * x + Math.sqrt(3) / 2;

	// Pentagon detection
	const isPentagonIJ = (i: number, j: number): boolean => {
		return (i === resolution + 1) ||
			(i === 0 && (j === 0 || j === resolution + 1));
	};

	for (let t = 0; t < 20; t++) {
		const [i0, i1, i2] = icoTris[t];
		const v0 = icoVerts[i0];
		const v1 = icoVerts[i1];
		const v2 = icoVerts[i2];

		// Track cells created in this triangle for neighbor detection
		const patchCells = new Map<string, number>(); // "i,j" → cellId

		for (let i = 0; i < resolution + 2; i++) {
			for (let j = 0; j < resolution + 2; j++) {
				// 2D hex center position within triangle
				let cx = startX + 2 * r * j;
				const cz = startZ + diameter * 3.0 * i / 4.0;
				if (i & 1) cx += r; // odd row offset

				// Skip if clearly outside triangle
				if (cz < -r / 2 || cz > f1(cx) + r / 2 || cz > f2(cx) + r / 2) continue;

				// Project center to sphere
				const mappedCenter = map2dTo3d(cx, cz, v0, v1, v2).normalize();

				// Deduplicate
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

				// Generate 6 corner points
				const numCorners = isPent ? 5 : 6;
				const startAngle = -Math.PI / 6;
				for (let k = 0; k < numCorners; k++) {
					const angle = startAngle + k * Math.PI / 3;
					const px = cx + Math.cos(angle) * R;
					const pz = cz + Math.sin(angle) * R;

					// Skip corners that are far outside the triangle
					// (close corners are fine — they'll be projected correctly by slerp)
					if (pz >= -r * 1.5 && pz <= f1(px) + r * 1.5 && pz <= f2(px) + r * 1.5) {
						const mappedCorner = map2dTo3d(px, pz, v0, v1, v2).normalize();
						// Avoid duplicate corners (check distance)
						let isDupe = false;
						for (const existing of cell.corners) {
							if (Vector3.Distance(existing, mappedCorner) < keyStep * 0.5) {
								isDupe = true;
								break;
							}
						}
						if (!isDupe) cell.corners.push(mappedCorner);
					}
				}
			}
		}

		// Build neighbor relationships within this triangle patch
		for (const [ij, cellId] of patchCells) {
			const [i, j] = ij.split(',').map(Number);
			// 6 axial neighbors in offset coordinates
			const neighborOffsets = (i & 1)
				? [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]   // odd row
				: [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]]; // even row

			for (const [di, dj] of neighborOffsets) {
				const nKey = `${i + di},${j + dj}`;
				const nId = patchCells.get(nKey);
				if (nId !== undefined && nId !== cellId) {
					globalNeighbors.get(cellId)!.add(nId);
					globalNeighbors.get(nId)!.add(cellId);
				}
			}
		}
	}

	// Sort corners of each cell by angle around center
	for (const [, cell] of cellMap) {
		if (cell.corners.length < 3) continue;
		const n = cell.center;
		// Build local tangent frame
		const up = Math.abs(n.y) < 0.999 ? Vector3.Up() : Vector3.Right();
		const right = Vector3.Cross(up, n).normalize();
		const fwd = Vector3.Cross(n, right).normalize();

		cell.corners.sort((a, b) => {
			const da = a.subtract(n);
			const db = b.subtract(n);
			const angleA = Math.atan2(Vector3.Dot(da, fwd), Vector3.Dot(da, right));
			const angleB = Math.atan2(Vector3.Dot(db, fwd), Vector3.Dot(db, right));
			return angleA - angleB;
		});
	}

	// Build final cell array
	const cells: HexCell[] = [];
	for (const [key, data] of cellMap) {
		const id = cellKeyToId.get(key)!;
		cells.push({
			id,
			center: data.center,
			corners: data.corners,
			neighbors: globalNeighbors.get(id) || new Set(),
			terrain: 0, // default: deep_ocean
			isPentagon: data.isPentagon
		});
	}

	return cells;
}
