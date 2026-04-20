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

import '@babylonjs/core/Meshes/Builders/linesBuilder';

// ── Configuration ───────────────────────────────────────────

/** Height offsets per discrete height level (fraction of globe radius).
 *  Height level is independent of terrain type. */
const LEVEL_HEIGHTS = [
	-0.020,  // level 0: deep water
	-0.008,  // level 1: shallow water
	 0.000,  // level 2: lowland
	 0.020,  // level 3: midland
	 0.045,  // level 4: highland
	 0.080,  // level 5: peak
];

/** Walls extend down to this floor */
const BASE_HEIGHT = -0.030;

/** Global noise amplitude (fraction of radius). Continuous across all hexes. */
const NOISE_AMP = 0.008;

/** Noise scale (unit sphere coords). ~35 gives terrain features within hexes */
const NOISE_SCALE = 35.0;

/** Subdivision levels for hex face tessellation (3 ≈ Sota's divisions=7) */
const SUBDIVISIONS = 3;

// ── Noise ───────────────────────────────────────────────────

function hash3(ix: number, iy: number, iz: number): number {
	let h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) | 0;
	h = ((h ^ (h >>> 13)) * 1274126177) | 0;
	return ((h ^ (h >>> 16)) & 0x7fffffff) / 0x7fffffff;
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

function noise3d(x: number, y: number, z: number): number {
	const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
	const fx = smoothstep(x - ix), fy = smoothstep(y - iy), fz = smoothstep(z - iz);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	return lerp(
		lerp(lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx),
			lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
		lerp(lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx),
			lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
		fz
	);
}

function fbmNoise(x: number, y: number, z: number): number {
	let v = 0, a = 0.5, max = 0;
	for (let i = 0; i < 4; i++) {
		v += noise3d(x, y, z) * a; max += a;
		x *= 2.1; y *= 2.1; z *= 2.1; a *= 0.45;
	}
	return v / max - 0.5; // center around 0
}

// ── Helpers ─────────────────────────────────────────────────

function getTerrainColor(idx: number): [number, number, number] { return TERRAIN_PROFILES[idx]?.color ?? [0.5, 0.5, 0.5]; }
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
		if (colors[i * 4 + 3] < 0.5) continue; // skip wall vertices
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

	for (let ci = 0; ci < cells.length; ci++) {
		const cell = cells[ci];
		const n = cell.corners.length;
		if (n < 3) { vertexStarts.push(vOff); totalVerticesPerCell.push(0); continue; }

		vertexStarts.push(vOff);
		const startVOff = vOff;

		const color = getTerrainColor(cell.terrain);
		const tierH = getLevelHeight(cell.heightLevel);
		const isWaterHex = cell.heightLevel <= 1;

		// Compute hex radius for water bowl shape
		let hexRadius = 0;
		if (isWaterHex) {
			for (let i = 0; i < n; i++) {
				const dx = cell.corners[i].x - cell.center.x;
				const dy = cell.corners[i].y - cell.center.y;
				const dz = cell.corners[i].z - cell.center.z;
				hexRadius += Math.sqrt(dx * dx + dy * dy + dz * dz);
			}
			hexRadius /= n;
		}

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

					const noiseH = fbmNoise(ux * NOISE_SCALE, uy * NOISE_SCALE, uz * NOISE_SCALE);

					let h: number;
					if (isWaterHex) {
						// Sota-style: water hexes use cosine interpolation to create
						// concave bowl shapes. Edge stays near sea level (0), center
						// dips to full water depth. This creates natural shorelines.
						const dx = ux - cell.center.x;
						const dy = uy - cell.center.y;
						const dz = uz - cell.center.z;
						const distToCenter = Math.sqrt(dx * dx + dy * dy + dz * dz);
						const t = Math.min(distToCenter / hexRadius, 1.0);
						// cosrp: cosine interpolation from full depth (center) to 0 (edge)
						const mu = (1 - Math.cos(t * Math.PI)) / 2; // 0 at center, 1 at edge
						h = tierH * (1 - mu) + noiseH * NOISE_AMP;
					} else {
						// Land hexes: flat tier height + global noise
						h = tierH + noiseH * NOISE_AMP;
					}

					const r = radius * (1 + h);
					displaced.push(ux * r, uy * r, uz * r);
				}

				// Face normal from displaced positions
				const e1x = displaced[3] - displaced[0];
				const e1y = displaced[4] - displaced[1];
				const e1z = displaced[5] - displaced[2];
				const e2x = displaced[6] - displaced[0];
				const e2y = displaced[7] - displaced[1];
				const e2z = displaced[8] - displaced[2];
				let nx = e1y * e2z - e1z * e2y;
				let ny = e1z * e2x - e1x * e2z;
				let nz = e1x * e2y - e1y * e2x;
				const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
				nx /= nl; ny /= nl; nz /= nl;

				for (let k = 0; k < 3; k++) {
					positions.push(displaced[k * 3], displaced[k * 3 + 1], displaced[k * 3 + 2]);
					normals.push(nx, ny, nz);
					colors.push(color[0], color[1], color[2], 1.0); // alpha=1 = top face
					indices.push(vOff++);
				}
			}
		}

		// ── Side walls ──────────────────────────────────────
		for (let i = 0; i < n; i++) {
			const c0 = cell.corners[i];
			const c1 = cell.corners[(i + 1) % n];

			// Wall top = tier height + noise at each corner (matches terrain surface)
			const wn0 = fbmNoise(c0.x * NOISE_SCALE, c0.y * NOISE_SCALE, c0.z * NOISE_SCALE);
			const wn1 = fbmNoise(c1.x * NOISE_SCALE, c1.y * NOISE_SCALE, c1.z * NOISE_SCALE);
			const topR0 = radius * (1 + tierH + wn0 * NOISE_AMP);
			const topR1 = radius * (1 + tierH + wn1 * NOISE_AMP);

			// Wall normal: outward from hex center
			const midX = (c0.x + c1.x) * 0.5;
			const midY = (c0.y + c1.y) * 0.5;
			const midZ = (c0.z + c1.z) * 0.5;
			let wnx = midX - cell.center.x;
			let wny = midY - cell.center.y;
			let wnz = midZ - cell.center.z;
			const wnLen = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
			wnx /= wnLen; wny /= wnLen; wnz /= wnLen;

			const wallOff = vOff;

			// 4 wall vertices — top matches terrain surface, bottom at floor
			positions.push(c0.x * topR0, c0.y * topR0, c0.z * topR0);
			normals.push(wnx, wny, wnz);
			colors.push(color[0], color[1], color[2], 0.0);

			positions.push(c1.x * topR1, c1.y * topR1, c1.z * topR1);
			normals.push(wnx, wny, wnz);
			colors.push(color[0], color[1], color[2], 0.0);

			positions.push(c0.x * botR, c0.y * botR, c0.z * botR);
			normals.push(wnx, wny, wnz);
			colors.push(color[0], color[1], color[2], 0.0);

			positions.push(c1.x * botR, c1.y * botR, c1.z * botR);
			normals.push(wnx, wny, wnz);
			colors.push(color[0], color[1], color[2], 0.0);

			indices.push(wallOff + 0, wallOff + 1, wallOff + 2);
			indices.push(wallOff + 1, wallOff + 3, wallOff + 2);
			vOff += 4;
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

	const mesh = new Mesh('globeHex', scene);
	const vertexData = new VertexData();
	vertexData.positions = positionsF32;
	vertexData.indices = new Uint32Array(indices);
	vertexData.normals = normalsF32;
	vertexData.colors = colorsF32;
	vertexData.applyToMesh(mesh, true);

	return { mesh, vertexStarts, totalVerticesPerCell, colorsBuffer: colorsF32, positionsBuffer: positionsF32 };
}

/** Update a single cell when painted — simplified (rebuilds just colors) */
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
	const cell = cells[cellIndex];
	const color = getTerrainColor(cell.terrain);
	const start = vertexStarts[cellIndex];
	const count = totalVerticesPerCell[cellIndex];
	if (count === 0) return;

	// Update all vertex colors for this cell
	for (let i = 0; i < count; i++) {
		const ci = (start + i) * 4;
		colorsBuffer[ci] = color[0];
		colorsBuffer[ci + 1] = color[1];
		colorsBuffer[ci + 2] = color[2];
		// Preserve alpha (wall vs top face flag)
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
