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
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';
import { fbmNoise } from './noise';

import '@babylonjs/core/Meshes/Builders/linesBuilder';

// ── Configuration ───────────────────────────────────────────

/** Height offsets per discrete height level (fraction of globe radius).
 *  Height level is independent of terrain type. */
const LEVEL_HEIGHTS = [
	-0.020,  // level 0: deep water
	-0.008,  // level 1: shallow water
	 0.000,  // level 2: lowland
	 0.020,  // level 3: midland
];

/** Walls extend down to this floor */
const BASE_HEIGHT = -0.030;

/** Global noise amplitude (fraction of radius). Continuous across all hexes. */
const NOISE_AMP = 0.008;

/** Noise scale (unit sphere coords). ~35 gives terrain features within hexes */
const NOISE_SCALE = 35.0;

/** Subdivision levels for hex face tessellation (3 ≈ Sota's divisions=7) */
const SUBDIVISIONS = 3;
const CORNER_KEY_SCALE = 1e6;
const COAST_ROUNDING = 0.0018;
const COAST_SMOOTHING = 0.22;
const CORNER_PATCH_EDGE_T = 0.18;

// ── Helpers ─────────────────────────────────────────────────

/** Wall vertex color: terrain profile RGB (used by textureWall for blue-detection). */
function getTerrainColor(idx: number): [number, number, number] { return TERRAIN_PROFILES[idx]?.color ?? [0.5, 0.5, 0.5]; }
/** Top-face vertex color: R = terrainId/9, G = packed blend data, B = encoded tier height.
 *  G encodes: (neighborTerrainId + blendFactor) / 10.0
 *  Shader decodes: neighborId = int(floor(G*10)), blend = fract(G*10) */
function getTopFaceColor(terrainIdx: number, tierH: number, neighborTerrainId: number, blendFactor: number): [number, number, number] {
	const r = terrainIdx / 9.0;
	const b = (tierH + 0.030) / 0.110;
	const nId = neighborTerrainId >= 0 ? neighborTerrainId : terrainIdx;
	const g = (nId + Math.min(blendFactor, 0.99)) / 10.0;
	return [r, g, b];
}
function getLevelHeight(level: number): number { return LEVEL_HEIGHTS[Math.min(level, LEVEL_HEIGHTS.length - 1)] ?? 0; }

/** Recursively subdivide a triangle on the unit sphere */
function subdivTriangle(
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
function smoothNormalsPass(
	positions: Float32Array, normals: Float32Array, colors: Float32Array, vertexCount: number
): void {
	const step = 1.0; // quantization step in km — groups vertices within 1km
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
function smoothWaterCornerPositions(
	positions: Float32Array, colors: Float32Array, vertexCount: number
): void {
	const step = 0.5; // angular quantization in km on unit sphere * radius
	const map = new Map<string, number[]>();

	for (let i = 0; i < vertexCount; i++) {
		if (colors[i * 4 + 3] < 0.05) continue; // skip walls
		// Detect water by blue-dominant vertex color
		const r = colors[i * 4], b = colors[i * 4 + 2];
		if (b <= r + 0.05) continue; // skip land

		// Key by angular direction (normalize position to unit sphere)
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
		// Average the radii — keep direction the same
		let avgR = 0;
		const i0 = indices[0];
		const dx = positions[i0 * 3];
		const dy = positions[i0 * 3 + 1];
		const dz = positions[i0 * 3 + 2];
		const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
		const ux = dx / dirLen, uy = dy / dirLen, uz = dz / dirLen;

		for (const i of indices) {
			const px = positions[i * 3];
			const py = positions[i * 3 + 1];
			const pz = positions[i * 3 + 2];
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

// ── Coastline Edge Detection (Sota's exclude_border_set) ────

/** Distance from point P to line segment AB (Euclidean approximation on unit sphere) */
function distToSegment(
	px: number, py: number, pz: number,
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number
): number {
	return distToSegmentWithT(px, py, pz, ax, ay, az, bx, by, bz).dist;
}

function distToSegmentWithT(
	px: number, py: number, pz: number,
	ax: number, ay: number, az: number,
	bx: number, by: number, bz: number
): { dist: number; t: number } {
	const abx = bx - ax, aby = by - ay, abz = bz - az;
	const apx = px - ax, apy = py - ay, apz = pz - az;
	const ab2 = abx * abx + aby * aby + abz * abz;
	const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / ab2)) : 0;
	const dx = ax + t * abx - px;
	const dy = ay + t * aby - py;
	const dz = az + t * abz - pz;
	return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), t };
}

/** Border info for any hex — controls which edges get cosine ramps.
 *  Works for both water hexes (coastline + depth transitions) and
 *  land hexes (coastline smoothing toward water). */
interface HexBorderInfo {
	excludedEdges: boolean[];  // true = edge excluded from distance calc (no ramp)
	edgeTargets: number[];     // ramp target height per non-excluded edge
	allSameHeight: boolean;    // ALL neighbors at exact same height level (deep ocean fast path)
	hasBorder: boolean;        // has at least one non-excluded edge
	edgeNeighborTerrains: number[]; // terrain ID of neighbor across each edge (-1 if same terrain)
	hasTerrainBorder: boolean;      // any edge borders a different terrain type
	coastEdges: boolean[];     // true = edge borders water↔land transition
	hasCoast: boolean;         // any edge is a coastline
}

function cornerKey(x: number, y: number, z: number): string {
	return `${Math.round(x * CORNER_KEY_SCALE)},${Math.round(y * CORNER_KEY_SCALE)},${Math.round(z * CORNER_KEY_SCALE)}`;
}

/** Find the neighbor across a given hex edge (by edge midpoint direction). */
function findNeighborAcrossEdge(cell: HexCell, edgeIdx: number, cellById: Map<number, HexCell>): HexCell | null {
	const n = cell.corners.length;
	const midX = (cell.corners[edgeIdx].x + cell.corners[(edgeIdx + 1) % n].x) / 2;
	const midY = (cell.corners[edgeIdx].y + cell.corners[(edgeIdx + 1) % n].y) / 2;
	const midZ = (cell.corners[edgeIdx].z + cell.corners[(edgeIdx + 1) % n].z) / 2;
	const dirX = midX - cell.center.x;
	const dirY = midY - cell.center.y;
	const dirZ = midZ - cell.center.z;

	let closestNb: HexCell | null = null;
	let closestDot = -Infinity;
	for (const nId of cell.neighbors) {
		const nb = cellById.get(nId);
		if (!nb) continue;
		const dot = dirX * (nb.center.x - cell.center.x) +
		            dirY * (nb.center.y - cell.center.y) +
		            dirZ * (nb.center.z - cell.center.z);
		if (dot > closestDot) { closestDot = dot; closestNb = nb; }
	}
	return closestNb;
}

function countLandNeighbors(cell: HexCell, cellById: Map<number, HexCell>): number {
	let count = 0;
	for (const nId of cell.neighbors) {
		const nb = cellById.get(nId);
		if (nb && nb.heightLevel > 1) count++;
	}
	return count;
}

function getHexBorderInfo(cell: HexCell, cellById: Map<number, HexCell>): HexBorderInfo {
	const n = cell.corners.length;
	const excludedEdges: boolean[] = new Array(n).fill(false);
	const edgeTargets: number[] = new Array(n).fill(0);
	const edgeNeighborTerrains: number[] = new Array(n).fill(-1);
	const coastEdges: boolean[] = new Array(n).fill(false);
	let excludedCount = 0;
	let exactSameCount = 0;
	let hasTerrainBorder = false;
	let hasCoast = false;
	const isWater = cell.heightLevel <= 1;

	for (let i = 0; i < n; i++) {
		const nb = findNeighborAcrossEdge(cell, i, cellById);
		if (!nb) continue;

		// Track terrain type differences for color blending
		// Skip water neighbors — coastline ramps handle those transitions
		const nbIsWaterTerrain = nb.heightLevel <= 1;
		const cellIsWaterTerrain = cell.heightLevel <= 1;
		if (nb.terrain !== cell.terrain && !nbIsWaterTerrain && !cellIsWaterTerrain) {
			edgeNeighborTerrains[i] = nb.terrain;
			hasTerrainBorder = true;
		}

		if (nb.heightLevel === cell.heightLevel) exactSameCount++;
		const nbIsWater = nb.heightLevel <= 1;

		if (isWater) {
			// ── Water hex edge logic ──
			// Set targets for ALL water edges (cornerTargets reads them all
			// regardless of exclusion). Exclude same-depth edges from the
			// distance competition so the coastal ramp extends broadly,
			// but ONLY when BOTH hexes sharing the edge qualify (≤2 land
			// neighbors each). This ensures both sides always agree on
			// exclusion → no gap. Small lakes (≥3 land neighbors on
			// either side) keep edges active for angular hex shape.
			if (nbIsWater) {
				edgeTargets[i] = getLevelHeight(Math.min(cell.heightLevel, nb.heightLevel));
				if (cell.heightLevel === nb.heightLevel) {
					const cellLand = countLandNeighbors(cell, cellById);
					const nbLand = countLandNeighbors(nb, cellById);
					if (cellLand <= 2 && nbLand <= 2) {
						excludedEdges[i] = true;
						excludedCount++;
					}
				}
			} else {
				// Water → land: ramp up to sea level
				edgeTargets[i] = 0;
				coastEdges[i] = true;
				hasCoast = true;
			}
		} else {
			// ── Land hex edge logic ──
			// Only ramp at water borders (coastline). All land-land edges excluded (walls handle those).
			if (nbIsWater) {
				// Land → water: ramp down to sea level
				edgeTargets[i] = 0;
				coastEdges[i] = true;
				hasCoast = true;
				// NOT excluded — this edge gets a ramp
			} else {
				// Land → land: excluded (walls handle height transitions)
				excludedEdges[i] = true;
				excludedCount++;
			}
		}
	}

	return {
		excludedEdges,
		edgeTargets,
		allSameHeight: isWater && exactSameCount >= n,
		hasBorder: excludedCount < n,
		edgeNeighborTerrains,
		hasTerrainBorder,
		coastEdges,
		hasCoast,
	};
}

function buildCornerTargetMap(cells: HexCell[], borderInfoById: Map<number, HexBorderInfo>): Map<string, number> {
	const cornerTargets = new Map<string, number>();

	for (const cell of cells) {
		const borderInfo = borderInfoById.get(cell.id);
		if (!borderInfo) continue;
		const isWater = cell.heightLevel <= 1;
		const n = cell.corners.length;

		for (let i = 0; i < n; i++) {
			const prev = (i + n - 1) % n;
			let best = cornerTargets.get(cornerKey(cell.corners[i].x, cell.corners[i].y, cell.corners[i].z)) ?? -Infinity;

			if (isWater || !borderInfo.excludedEdges[prev]) {
				best = Math.max(best, borderInfo.edgeTargets[prev]);
			}
			if (isWater || !borderInfo.excludedEdges[i]) {
				best = Math.max(best, borderInfo.edgeTargets[i]);
			}

			if (best > -Infinity) {
				cornerTargets.set(cornerKey(cell.corners[i].x, cell.corners[i].y, cell.corners[i].z), best);
			}
		}
	}

	return cornerTargets;
}

function getLocalCornerActiveTarget(
	cell: HexCell,
	borderInfo: HexBorderInfo,
	cornerIdx: number
): number | undefined {
	const n = cell.corners.length;
	const prev = (cornerIdx + n - 1) % n;
	let best = -Infinity;

	if (!borderInfo.excludedEdges[prev]) best = Math.max(best, borderInfo.edgeTargets[prev]);
	if (!borderInfo.excludedEdges[cornerIdx]) best = Math.max(best, borderInfo.edgeTargets[cornerIdx]);

	return best > -Infinity ? best : undefined;
}

/** Compute minimum distance to ANY non-excluded edge, and return the ramp target.
 *  Exact-corner snaps are intentionally omitted for water cells; mismatch
 *  corners are filled by dedicated patch geometry instead of distorting the
 *  whole distance field around them. */
function distToBorderWithTarget(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): { dist: number; target: number; edgeIdx: number; edgeT: number } {
	const n = cell.corners.length;
	let minDist = Infinity;
	let target = -Infinity;
	let edgeIdx = -1;
	let edgeT = 0.5;
	const EPS = 1e-4;
	for (let i = 0; i < n; i++) {
		if (borderInfo.excludedEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const sample = distToSegmentWithT(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (sample.dist < minDist - EPS) {
			minDist = sample.dist;
			target = borderInfo.edgeTargets[i];
			edgeIdx = i;
			edgeT = sample.t;
		} else if (sample.dist < minDist + EPS) {
			// Multiple edges at similar distance (corner) — use highest target
			if (borderInfo.edgeTargets[i] > target) {
				target = borderInfo.edgeTargets[i];
				edgeIdx = i;
				edgeT = sample.t;
			}
			if (sample.dist < minDist) minDist = sample.dist;
		}
	}
	return { dist: minDist, target, edgeIdx, edgeT };
}

/** Find distance to the nearest edge that borders a different terrain type.
 *  Returns { dist, neighborTerrainId } or { dist: Infinity, neighborTerrainId: -1 } if none. */
function distToTerrainBorder(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): { dist: number; neighborTerrainId: number } {
	const n = cell.corners.length;
	let minDist = Infinity;
	let neighborTerrain = -1;
	for (let i = 0; i < n; i++) {
		if (borderInfo.edgeNeighborTerrains[i] < 0) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) {
			minDist = d;
			neighborTerrain = borderInfo.edgeNeighborTerrains[i];
		}
	}
	return { dist: minDist, neighborTerrainId: neighborTerrain };
}

/** Distance from a vertex to the nearest coast edge (water↔land boundary).
 *  Returns Infinity if no coast edges exist on this hex. */
function distToCoast(
	vx: number, vy: number, vz: number,
	cell: HexCell, borderInfo: HexBorderInfo
): number {
	const n = cell.corners.length;
	let minDist = Infinity;
	for (let i = 0; i < n; i++) {
		if (!borderInfo.coastEdges[i]) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		if (d < minDist) minDist = d;
	}
	return minDist;
}

function smoothMin(a: number, b: number, k: number): number {
	if (k <= 0) return Math.min(a, b);
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

function smoothDistanceToTargetEdges(
	vx: number, vy: number, vz: number,
	cell: HexCell,
	borderInfo: HexBorderInfo,
	targetHeight: number,
	hexRadius: number
): number {
	const n = cell.corners.length;
	const k = hexRadius * COAST_SMOOTHING;
	let result = Infinity;

	for (let i = 0; i < n; i++) {
		if (borderInfo.excludedEdges[i]) continue;
		if (Math.abs(borderInfo.edgeTargets[i] - targetHeight) > 1e-9) continue;
		const a = cell.corners[i];
		const b = cell.corners[(i + 1) % n];
		const d = distToSegment(vx, vy, vz, a.x, a.y, a.z, b.x, b.y, b.z);
		result = Number.isFinite(result) ? smoothMin(result, d, k) : d;
	}

	return result;
}

/** Compute the top-surface height at a point using the same logic as the subdivided top face. */
function computeSurfaceHeight(
	ux: number, uy: number, uz: number,
	cell: HexCell,
	borderInfo: HexBorderInfo,
	hexRadius: number,
	tierH: number,
	isWaterHex: boolean
): number {
	const rawNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
	// Interior noise: water uses abs(), land biases upward (+0.3)
	const interiorNoiseH = isWaterHex ? Math.abs(rawNoise) : rawNoise + 0.3;
	// Border noise: MUST match on both sides of shared edges.
	// At coastline (borderTarget=0), both water and land use the same formula.
	const borderNoiseH = Math.abs(rawNoise) + 0.15;

	if (isWaterHex && borderInfo.allSameHeight) {
		return tierH + interiorNoiseH * NOISE_AMP;
	}

	if (borderInfo.hasBorder) {
		const nearest = distToBorderWithTarget(ux, uy, uz, cell, borderInfo);
		let dist = nearest.dist;
		const borderTarget = nearest.target;
		const edgeIdx = nearest.edgeIdx;
		const edgeT = nearest.edgeT;

		// Round coastline corners by blending adjacent coast-edge distance fields
		// into a smooth union instead of using a hard nearest-edge switch.
		if (borderTarget === 0) {
			dist = Math.min(dist, smoothDistanceToTargetEdges(ux, uy, uz, cell, borderInfo, 0, hexRadius));
		}

		const t = Math.min(dist / hexRadius, 1.0);
		const mu = (1 - Math.cos(t * Math.PI)) / 2;

		// Noise coefficient must MATCH at shared borders:
		// - Water↔water: border noise = NOISE_AMP (flat neighbor uses full noise)
		// - Water↔land: border noise = NOISE_AMP * 0.3 (both sides use 0.3 at coast)
		const isWaterNeighborBorder = borderTarget < -0.001;
		const borderNoiseCoeff = isWaterNeighborBorder ? NOISE_AMP : NOISE_AMP * 0.3;
		const interiorNoiseCoeff = NOISE_AMP;
		const noiseCoeff = interiorNoiseCoeff * mu + borderNoiseCoeff * (1 - mu);
		// Blend between interior noise shape and border noise shape
		// so both sides of the shared edge use identical noise at dist=0
		const noiseH = interiorNoiseH * mu + borderNoiseH * (1 - mu);
		let h = tierH * mu + borderTarget * (1 - mu) + noiseH * noiseCoeff;

		// Keep coastline continuity exact at the shared edge, but hold the terrain
		// slightly lower around the middle of each coastal edge so the visible
		// shoreline contour reads rounder and less like a straight hex cut.
		if (borderTarget === 0 && edgeIdx >= 0) {
			const coastMid = 4 * edgeT * (1 - edgeT);      // 0 at corners, 1 at edge midpoint
			const coastBlend = mu * (1 - mu);              // 0 on the edge and in the far interior
			h -= COAST_ROUNDING * coastMid * coastBlend * 4;
		}

		return h;
	}

	return tierH + interiorNoiseH * NOISE_AMP;
}

function cornerPatchHeight(
	ux: number, uy: number, uz: number,
	borderTarget: number
): number {
	const rawNoise = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);
	const noiseH = Math.abs(rawNoise) + 0.15; // matches borderNoiseH in computeSurfaceHeight
	const borderNoise = borderTarget < -0.001 ? NOISE_AMP : NOISE_AMP * 0.3;
	return borderTarget + noiseH * borderNoise;
}

function lerpOnSphere(a: Vector3, b: Vector3, t: number): Vector3 {
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
function subdivideEdge(
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
					const h = computeSurfaceHeight(ux, uy, uz, cell, borderInfo, hexRadius, tierH, isWaterHex);

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

				for (let k = 0; k < 3; k++) {
					// Compute per-vertex terrain blend
					const vx = triVerts[j + k * 3];
					const vy = triVerts[j + k * 3 + 1];
					const vz = triVerts[j + k * 3 + 2];
					let neighborTerrainId = -1;
					let blendFactor = 0;
					if (borderInfo.hasTerrainBorder) {
						const tb = distToTerrainBorder(vx, vy, vz, cell, borderInfo);
						if (tb.neighborTerrainId >= 0) {
							blendFactor = Math.min(tb.dist / hexRadius, 0.999);
							neighborTerrainId = tb.neighborTerrainId;
						}
					}
					// Encode coast proximity in alpha:
					// 1.0 = not coastal, 0.5 = at water edge
					// Walls use 0.0, shader checks < 0.05 for walls
					let alpha = 1.0;
					if (borderInfo.hasCoast) {
						const cd = distToCoast(vx, vy, vz, cell, borderInfo);
						// 0 at coast edge → alpha=0.5, hexRadius away → alpha=1.0
						alpha = 0.5 + 0.5 * Math.min(cd / hexRadius, 1.0);
					}
					const topColor = getTopFaceColor(cell.terrain, tierH, neighborTerrainId, blendFactor);
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

			// Skip coastline edges — ramp handles the transition smoothly
			if (nb.heightLevel <= 1) continue;

			// Only emit wall from the HIGHER land hex.
			if (nb.heightLevel >= cell.heightLevel) continue;

			const edgePoints: number[] = [];
			subdivideEdge(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, SUBDIVISIONS, edgePoints);

			for (let p = 0; p < edgePoints.length - 3; p += 3) {
				const ux0 = edgePoints[p];
				const uy0 = edgePoints[p + 1];
				const uz0 = edgePoints[p + 2];
				const ux1 = edgePoints[p + 3];
				const uy1 = edgePoints[p + 4];
				const uz1 = edgePoints[p + 5];

				const h0 = computeSurfaceHeight(ux0, uy0, uz0, cell, borderInfo, hexRadius, tierH, isWaterHex);
				const h1 = computeSurfaceHeight(ux1, uy1, uz1, cell, borderInfo, hexRadius, tierH, isWaterHex);
				const topR0 = radius * (1 + h0);
				const topR1 = radius * (1 + h1);

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

				positions.push(ux0 * botR, uy0 * botR, uz0 * botR);
				normals.push(wnx, wny, wnz);
				colors.push(color[0], color[1], color[2], 0.0);

				positions.push(ux1 * botR, uy1 * botR, uz1 * botR);
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
	smoothNormalsPass(positionsF32, normalsF32, colorsF32, vOff);
	smoothWaterCornerPositions(positionsF32, colorsF32, vOff);

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
		const topColor = getTopFaceColor(cell.terrain, tierH, -1, 0);

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

		for (let i = 0; i < count; i++) {
			const vi = (start + i) * 4;
			const pi = (start + i) * 3;
			const isWall = colorsBuffer[vi + 3] < 0.05;

			if (isWall) {
				colorsBuffer[vi] = wallColor[0];
				colorsBuffer[vi + 1] = wallColor[1];
				colorsBuffer[vi + 2] = wallColor[2];
			} else {
				// Recover unit-sphere direction from world position
				const px = positionsBuffer[pi], py = positionsBuffer[pi + 1], pz = positionsBuffer[pi + 2];
				const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
				const ux = px / len, uy = py / len, uz = pz / len;

				let neighborTerrainId = -1;
				let blendFactor = 0;
				if (borderInfo.hasTerrainBorder) {
					const tb = distToTerrainBorder(ux, uy, uz, c, borderInfo);
					if (tb.neighborTerrainId >= 0) {
						blendFactor = Math.min(tb.dist / hexRadius, 0.999);
						neighborTerrainId = tb.neighborTerrainId;
					}
				}
				// Recompute coast proximity
				let alpha = 1.0;
				if (borderInfo.hasCoast) {
					const cd = distToCoast(ux, uy, uz, c, borderInfo);
					alpha = 0.5 + 0.5 * Math.min(cd / hexRadius, 1.0);
				}
				const topColor = getTopFaceColor(c.terrain, tierH, neighborTerrainId, blendFactor);
				colorsBuffer[vi] = topColor[0];
				colorsBuffer[vi + 1] = topColor[1];
				colorsBuffer[vi + 2] = topColor[2];
				colorsBuffer[vi + 3] = alpha;
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
