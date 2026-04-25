/**
 * Mesh post-processing helpers: triangle subdivision on the unit sphere,
 * normal averaging at coincident top-face vertices, and the position
 * smoothing passes that close gaps at water corners, land seams, and
 * coastal seams.
 *
 * All position/color buffers are interleaved Float32Arrays as produced by
 * the main globe builder; alpha < 0.05 indicates a wall vertex (those are
 * skipped by every smoothing pass to keep cliff faces sharp).
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

/** Subdivision levels for hex face tessellation (3 ≈ Sota's divisions=7) */
export const SUBDIVISIONS = 3;

/** Recursively subdivide a triangle on the unit sphere */
export function subdivTriangle(
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number,
	cx: number, cy: number, cz: number,
	level: number,
	out: number[] // flat array of xyz triplets
): void {
	if (level === 0) {
		out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
		return;
	}
	// Midpoints projected onto unit sphere
	let mx1 = (ax + bx) * 0.5, my1 = (ay + by) * 0.5, mz1 = (az + bz) * 0.5;
	let l1 = Math.sqrt(mx1 * mx1 + my1 * my1 + mz1 * mz1) || 1;
	mx1 /= l1; my1 /= l1; mz1 /= l1;

	let mx2 = (bx + cx) * 0.5, my2 = (by + cy) * 0.5, mz2 = (bz + cz) * 0.5;
	let l2 = Math.sqrt(mx2 * mx2 + my2 * my2 + mz2 * mz2) || 1;
	mx2 /= l2; my2 /= l2; mz2 /= l2;

	let mx3 = (cx + ax) * 0.5, my3 = (cy + ay) * 0.5, mz3 = (cz + az) * 0.5;
	let l3 = Math.sqrt(mx3 * mx3 + my3 * my3 + mz3 * mz3) || 1;
	mx3 /= l3; my3 /= l3; mz3 /= l3;

	const nl = level - 1;
	subdivTriangle(ax, ay, az, mx1, my1, mz1, mx3, my3, mz3, nl, out);
	subdivTriangle(mx1, my1, mz1, bx, by, bz, mx2, my2, mz2, nl, out);
	subdivTriangle(mx3, my3, mz3, mx2, my2, mz2, cx, cy, cz, nl, out);
	subdivTriangle(mx1, my1, mz1, mx2, my2, mz2, mx3, my3, mz3, nl, out);
}

// ── Smooth Normals (Sota-style SmoothShadesProcessor) ───────

/** Average normals at coincident vertex positions for seamless terrain.
 *  Only processes top-face vertices (color alpha > 0.5). Wall vertices keep flat normals. */
export function smoothNormalsPass(
	positions: Float32Array, normals: Float32Array, colors: Float32Array, vertexCount: number
): void {
	// Use finer quantization (0.1 km) to avoid splitting coincident vertices
	// into different buckets at rounding boundaries
	const step = 0.1;
	const map = new Map<string, number[]>();

	// Build spatial hash of top-face vertices only
	for (let i = 0; i < vertexCount; i++) {
		if (colors[i * 4 + 3] < 0.05) continue; // skip wall vertices
		const px = positions[i * 3];
		const py = positions[i * 3 + 1];
		const pz = positions[i * 3 + 2];
		const key = `${Math.round(px / step)},${Math.round(py / step)},${Math.round(pz / step)}`;
		let list = map.get(key);
		if (!list) { list = []; map.set(key, list); }
		list.push(i);
	}

	// Average normals at coincident positions
	for (const indices of map.values()) {
		if (indices.length <= 1) continue;
		let sx = 0, sy = 0, sz = 0;
		for (const i of indices) {
			sx += normals[i * 3];
			sy += normals[i * 3 + 1];
			sz += normals[i * 3 + 2];
		}
		const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
		sx /= len; sy /= len; sz /= len;
		for (const i of indices) {
			normals[i * 3] = sx;
			normals[i * 3 + 1] = sy;
			normals[i * 3 + 2] = sz;
		}
	}
}

// ── Smooth Water Corner Positions ────────────────────────────
/** Average positions of water vertices at shared hex corners.
 *  Groups by ANGULAR position (unit sphere direction) so vertices at the
 *  same corner but different radii get averaged — eliminating corner gaps
 *  where adjacent water hexes compute different heights. */
export function smoothWaterCornerPositions(
	positions: Float32Array, colors: Float32Array, vertexCount: number
): void {
	const map = new Map<string, number[]>();

	for (let i = 0; i < vertexCount; i++) {
		if (colors[i * 4 + 3] < 0.05) continue; // skip walls
		const b = colors[i * 4 + 2];
		const heightLvl = Math.floor(b * 10 + 0.001);
		if (heightLvl >= 2) continue; // water only (level 0-1)
		const px = positions[i * 3];
		const py = positions[i * 3 + 1];
		const pz = positions[i * 3 + 2];
		const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
		const key = `${Math.round(px / len / 0.0001)},${Math.round(py / len / 0.0001)},${Math.round(pz / len / 0.0001)}`;
		let list = map.get(key);
		if (!list) { list = []; map.set(key, list); }
		list.push(i);
	}

	for (const indices of map.values()) {
		if (indices.length <= 1) continue;
		let avgR = 0;
		const i0 = indices[0];
		const dx = positions[i0 * 3], dy = positions[i0 * 3 + 1], dz = positions[i0 * 3 + 2];
		const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
		const ux = dx / dirLen, uy = dy / dirLen, uz = dz / dirLen;
		for (const i of indices) {
			const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
			avgR += Math.sqrt(px * px + py * py + pz * pz);
		}
		avgR /= indices.length;
		for (const i of indices) {
			positions[i * 3] = ux * avgR;
			positions[i * 3 + 1] = uy * avgR;
			positions[i * 3 + 2] = uz * avgR;
		}
	}
}

/** Snap coincident land vertices to the same height.
 *  Groups by angular direction, then clusters by radius — vertices within
 *  50km of each other (consecutive after sorting) are averaged together.
 *  Intentional height level steps (127km) are preserved as separate clusters. */
export function smoothLandSeamPositions(
	positions: Float32Array, colors: Float32Array, vertexCount: number,
	harmonizeCliffProximity: boolean = true
): void {
	const map = new Map<string, number[]>();

	for (let i = 0; i < vertexCount; i++) {
		if (colors[i * 4 + 3] < 0.05) continue;
		const b = colors[i * 4 + 2];
		const heightLvl = Math.floor(b * 10 + 0.001);
		if (heightLvl < 2) continue; // skip water (level 0-1)
		const px = positions[i * 3];
		const py = positions[i * 3 + 1];
		const pz = positions[i * 3 + 2];
		const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
		const key = `${Math.round(px / len / 0.0001)},${Math.round(py / len / 0.0001)},${Math.round(pz / len / 0.0001)}`;
		let list = map.get(key);
		if (!list) { list = []; map.set(key, list); }
		list.push(i);
	}

	for (const indices of map.values()) {
		if (indices.length <= 1) continue;

		// Get shared direction
		const i0 = indices[0];
		const dx = positions[i0 * 3], dy = positions[i0 * 3 + 1], dz = positions[i0 * 3 + 2];
		const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
		const ux = dx / dirLen, uy = dy / dirLen, uz = dz / dirLen;

		// Sort by radius, cluster at gaps > 50km
		const entries = indices.map(i => {
			const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
			return { i, r: Math.sqrt(px * px + py * py + pz * pz) };
		});
		entries.sort((a, b) => a.r - b.r);

		let cs = 0;
		for (let j = 1; j <= entries.length; j++) {
			if (j < entries.length && entries[j].r - entries[j - 1].r < 50) continue;
			// Average cluster [cs, j)
			if (j - cs > 1) {
				let sumR = 0;
				for (let k = cs; k < j; k++) sumR += entries[k].r;
				const avgR = sumR / (j - cs);
				// Find max cliff proximity in cluster so shared-edge vertices match
				let maxProx = 0;
				if (harmonizeCliffProximity) {
					for (let k = cs; k < j; k++) {
						const bVal = colors[entries[k].i * 4 + 2];
						const rawB10 = bVal * 10;
						const prox = (rawB10 - Math.floor(rawB10 + 0.001)) / 0.9;
						if (prox > maxProx) maxProx = prox;
					}
				}
				for (let k = cs; k < j; k++) {
					positions[entries[k].i * 3] = ux * avgR;
					positions[entries[k].i * 3 + 1] = uy * avgR;
					positions[entries[k].i * 3 + 2] = uz * avgR;
					// Harmonize cliff proximity across shared-edge vertices
					if (harmonizeCliffProximity && maxProx > 0) {
						const bVal = colors[entries[k].i * 4 + 2];
						const level = Math.floor(bVal * 10 + 0.001);
						colors[entries[k].i * 4 + 2] = level * 0.1 + Math.min(maxProx, 1.0) * 0.09;
					}
				}
			}
			cs = j;
		}
	}
}

/** Smooth positions at coastal seams where water and land vertices meet.
 *  The water/land smoothing passes operate independently, leaving gaps
 *  at corners where cliff hexes meet water hexes. This averages ALL
 *  non-wall vertices at shared directions to close those gaps. */
export function smoothCoastalSeamPositions(
	positions: Float32Array, colors: Float32Array, vertexCount: number
): void {
	const map = new Map<string, number[]>();
	for (let i = 0; i < vertexCount; i++) {
		if (colors[i * 4 + 3] < 0.05) continue;
		const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
		const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
		const key = `${Math.round(px / len / 0.0001)},${Math.round(py / len / 0.0001)},${Math.round(pz / len / 0.0001)}`;
		let list = map.get(key);
		if (!list) { list = []; map.set(key, list); }
		list.push(i);
	}
	for (const indices of map.values()) {
		if (indices.length <= 1) continue;
		let hasWater = false, hasLand = false;
		for (const i of indices) {
			const b = colors[i * 4 + 2];
			if (Math.floor(b * 10 + 0.001) < 2) hasWater = true;
			else hasLand = true;
		}
		if (!hasWater || !hasLand) continue;
		const i0 = indices[0];
		const dx = positions[i0 * 3], dy = positions[i0 * 3 + 1], dz = positions[i0 * 3 + 2];
		const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
		const ux = dx / dirLen, uy = dy / dirLen, uz = dz / dirLen;
		// Average radius so both sides converge
		let avgR = 0;
		for (const i of indices) {
			const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
			avgR += Math.sqrt(px * px + py * py + pz * pz);
		}
		avgR /= indices.length;
		for (const i of indices) {
			positions[i * 3] = ux * avgR;
			positions[i * 3 + 1] = uy * avgR;
			positions[i * 3 + 2] = uz * avgR;
		}
	}
}

export function lerpOnSphere(a: Vector3, b: Vector3, t: number): Vector3 {
	let x = a.x + (b.x - a.x) * t;
	let y = a.y + (b.y - a.y) * t;
	let z = a.z + (b.z - a.z) * t;
	const len = Math.sqrt(x * x + y * y + z * z) || 1;
	x /= len;
	y /= len;
	z /= len;
	return new Vector3(x, y, z);
}

/** Recursively build the same normalized edge polyline used by the subdivided top face. */
export function subdivideEdge(
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number,
	level: number,
	out: number[]
): void {
	if (level === 0) {
		out.push(ax, ay, az, bx, by, bz);
		return;
	}

	let mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
	const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
	mx /= ml; my /= ml; mz /= ml;

	subdivideEdge(ax, ay, az, mx, my, mz, level - 1, out);
	out.pop(); out.pop(); out.pop(); // avoid duplicating the midpoint
	subdivideEdge(mx, my, mz, bx, by, bz, level - 1, out);
}
