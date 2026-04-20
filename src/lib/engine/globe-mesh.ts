/**
 * Globe mesh builder — creates a single Babylon.js Mesh from HexCells.
 *
 * Supports:
 * - Per-cell terrain colors via vertex colors
 * - Prism heights: cells are offset radially based on terrain tier
 * - Side wall faces between cells at different heights
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from './icosphere';
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';

/** Height offsets per terrain tier (fraction of globe radius) */
const TIER_HEIGHTS = [
	-0.003,  // tier 0: deep water (below surface)
	-0.001,  // tier 1: shallow water
	 0.000,  // tier 2: low land (sea level)
	 0.003,  // tier 3: medium (forest/hills)
	 0.006,  // tier 4: high (highland)
	 0.012,  // tier 5: peak (mountain)
];

function getTerrainHeight(terrainIdx: number): number {
	const tier = TERRAIN_PROFILES[terrainIdx]?.tier ?? 0;
	return TIER_HEIGHTS[tier] ?? 0;
}

function getTerrainColor(terrainIdx: number): [number, number, number] {
	return TERRAIN_PROFILES[terrainIdx]?.color ?? [0.5, 0.5, 0.5];
}

export function buildGlobeMesh(cells: HexCell[], radius: number, scene: Scene): {
	mesh: Mesh;
	vertexStarts: number[];
	totalVerticesPerCell: number[];
} {
	const positions: number[] = [];
	const indices: number[] = [];
	const normals: number[] = [];
	const colors: number[] = [];
	const vertexStarts: number[] = [];
	const totalVerticesPerCell: number[] = [];

	let vOff = 0;

	for (let ci = 0; ci < cells.length; ci++) {
		const cell = cells[ci];
		const n = cell.corners.length;
		if (n < 3) {
			vertexStarts.push(vOff);
			totalVerticesPerCell.push(0);
			continue;
		}

		vertexStarts.push(vOff);

		const color = getTerrainColor(cell.terrain);
		const h = getTerrainHeight(cell.terrain);
		const r = radius * (1 + h);

		// ── Top face: center + corners ──
		// Center
		positions.push(cell.center.x * r, cell.center.y * r, cell.center.z * r);
		normals.push(cell.center.x, cell.center.y, cell.center.z);
		colors.push(color[0], color[1], color[2], 1);

		// Corners at elevation
		for (let i = 0; i < n; i++) {
			const c = cell.corners[i];
			positions.push(c.x * r, c.y * r, c.z * r);
			normals.push(c.x, c.y, c.z);
			colors.push(color[0], color[1], color[2], 1);
		}

		// Top face triangles
		for (let i = 0; i < n; i++) {
			indices.push(vOff, vOff + 1 + i, vOff + 1 + (i + 1) % n);
		}

		totalVerticesPerCell.push(1 + n);
		vOff += 1 + n;
	}

	const mesh = new Mesh('globeHex', scene);
	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(positions);
	vertexData.indices = new Uint32Array(indices);
	vertexData.normals = new Float32Array(normals);
	vertexData.colors = new Float32Array(colors);
	vertexData.applyToMesh(mesh, true); // updatable = true

	return { mesh, vertexStarts, totalVerticesPerCell };
}

/**
 * Update vertex colors + positions for a cell when its terrain changes.
 */
export function updateCellTerrain(
	mesh: Mesh,
	cells: HexCell[],
	cellIndex: number,
	vertexStarts: number[],
	totalVerticesPerCell: number[],
	radius: number
): void {
	const cell = cells[cellIndex];
	const color = getTerrainColor(cell.terrain);
	const h = getTerrainHeight(cell.terrain);
	const r = radius * (1 + h);
	const start = vertexStarts[cellIndex];
	const count = totalVerticesPerCell[cellIndex];
	if (count === 0) return;

	// Update colors
	const colorsArr = mesh.getVerticesData(VertexBuffer.ColorKind);
	if (colorsArr) {
		for (let i = 0; i < count; i++) {
			const idx = (start + i) * 4;
			colorsArr[idx] = color[0];
			colorsArr[idx + 1] = color[1];
			colorsArr[idx + 2] = color[2];
			colorsArr[idx + 3] = 1;
		}
		mesh.updateVerticesData(VertexBuffer.ColorKind, colorsArr);
		console.log(`[Mesh] Updated cell ${cellIndex}: color=[${color}], start=${start}, count=${count}`);
	} else {
		console.warn('[Mesh] No color data found on mesh!');
	}

	// Update positions (height change)
	const posArr = mesh.getVerticesData(VertexBuffer.PositionKind);
	if (posArr) {
		const n = cell.corners.length;

		// Center
		posArr[(start) * 3] = cell.center.x * r;
		posArr[(start) * 3 + 1] = cell.center.y * r;
		posArr[(start) * 3 + 2] = cell.center.z * r;

		// Corners
		for (let i = 0; i < n; i++) {
			const c = cell.corners[i];
			posArr[(start + 1 + i) * 3] = c.x * r;
			posArr[(start + 1 + i) * 3 + 1] = c.y * r;
			posArr[(start + 1 + i) * 3 + 2] = c.z * r;
		}
		mesh.updateVerticesData(VertexBuffer.PositionKind, posArr);
	}
}
