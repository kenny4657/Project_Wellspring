/**
 * Per-hex corner-position texture (also packs neighbor hex IDs).
 *
 * Layout: same `width` as `hexDataTex`, with `6 × hexDataHeight`
 * rows — 6 pixels per hex (one per corner / edge). Corner `k` of
 * hex `id` lives at:
 *
 *   ivec2 coord = ivec2(id % W, (id / W) * 6 + k);
 *   vec4 v = texelFetch(hexCornersTex, coord, 0);
 *   vec3 corner = v.rgb;
 *   int neighborIdAcrossEdgeK = int(v.a + 0.5);
 *
 * Edge `k` of the hex spans corner `k` to corner `(k+1) % edgeCount`.
 * The neighbor across that edge is encoded in the alpha channel of
 * the corner-`k` pixel. -1 means no neighbor (boundary).
 *
 * Pentagons (5 corners): the unused 6th slot duplicates corner[0]
 * with neighborId = -1, so a fixed-size shader loop with
 * `edgeCount` early-out walks exactly 5 unique edges.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import { findNeighborAcrossEdge } from '../hex-borders';

/** Build a Map from canonical-corner-key → averaged unit-direction.
 *  icosphere.ts dedupes corners within a single hex but leaves cross-hex
 *  drift: two hexes that share a physical corner can store slightly
 *  different Vector3 values (each computed from a different ico
 *  triangle's slerp). That FP drift means each hex's edge endpoints
 *  differ at the shared seam, so the same world position computes
 *  slightly different distances from each side → mu mismatch → seam
 *  gap. Canonicalizing forces both hexes to use the same value. */
function buildCanonicalCorners(cells: HexCell[]): Map<string, Vector3> {
	const STEP = 1e-5; // bucket size; smaller than any real corner spacing
	const groups = new Map<string, { sum: Vector3; count: number }>();
	const keyOf = (v: Vector3) =>
		`${Math.round(v.x / STEP)},${Math.round(v.y / STEP)},${Math.round(v.z / STEP)}`;
	for (const c of cells) {
		for (const corner of c.corners) {
			const k = keyOf(corner);
			const g = groups.get(k);
			if (g) {
				g.sum.x += corner.x; g.sum.y += corner.y; g.sum.z += corner.z;
				g.count++;
			} else {
				groups.set(k, { sum: new Vector3(corner.x, corner.y, corner.z), count: 1 });
			}
		}
	}
	const out = new Map<string, Vector3>();
	for (const [k, g] of groups) {
		const avg = new Vector3(g.sum.x / g.count, g.sum.y / g.count, g.sum.z / g.count);
		const len = Math.sqrt(avg.x * avg.x + avg.y * avg.y + avg.z * avg.z) || 1;
		avg.x /= len; avg.y /= len; avg.z /= len;
		out.set(k, avg);
	}
	return out;
}

function canonKey(v: Vector3): string {
	const STEP = 1e-5;
	return `${Math.round(v.x / STEP)},${Math.round(v.y / STEP)},${Math.round(v.z / STEP)}`;
}

export function canonicalizeCells(cells: HexCell[]): void {
	const canon = buildCanonicalCorners(cells);
	for (const c of cells) {
		for (let k = 0; k < c.corners.length; k++) {
			const cv = canon.get(canonKey(c.corners[k]));
			if (cv) {
				c.corners[k].x = cv.x;
				c.corners[k].y = cv.y;
				c.corners[k].z = cv.z;
			}
		}
	}
}

export interface HexCornersTexture {
	tex: RawTexture;
	width: number;
	height: number;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

export function buildHexCornersTexture(cells: HexCell[], scene: Scene): HexCornersTexture {
	const numHexes = cells.length;
	let maxId = 0;
	for (const c of cells) if (c.id > maxId) maxId = c.id;
	const idCount = maxId + 1;

	const W = nextPow2(Math.ceil(Math.sqrt(idCount)));
	const baseH = nextPow2(Math.ceil(idCount / W));
	const H = baseH * 6;

	const data = new Float32Array(W * H * 4);

	const cellByIdMap = new Map<number, HexCell>();
	for (const c of cells) cellByIdMap.set(c.id, c);

	for (let id = 0; id <= maxId; id++) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		const corners = c.corners;
		const edgeCount = corners.length;
		const xCol = id % W;
		const yRowBase = Math.floor(id / W) * 6;
		for (let k = 0; k < 6; k++) {
			const corner = corners[k] ?? corners[0]; // pad pentagons
			let neighborId = -1;
			if (k < edgeCount) {
				const nb = findNeighborAcrossEdge(c, k, cellByIdMap);
				if (nb) neighborId = nb.id;
			}
			const px = (yRowBase + k) * W + xCol;
			data[px * 4 + 0] = corner.x;
			data[px * 4 + 1] = corner.y;
			data[px * 4 + 2] = corner.z;
			data[px * 4 + 3] = neighborId;
		}
	}

	const tex = new RawTexture(
		data, W, H,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_FLOAT,
	);
	tex.name = 'gpuHexCorners';

	return { tex, width: W, height: H };
}
