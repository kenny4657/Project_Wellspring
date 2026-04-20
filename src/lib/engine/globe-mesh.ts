/**
 * Globe mesh builder — creates a single merged Babylon.js Mesh from
 * an array of HexCells. All hex faces are baked into one mesh for
 * zero tiling artifacts and 1 draw call.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from './icosphere';
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';

/**
 * Build a single Babylon mesh from hex cells.
 *
 * @param cells Array of HexCells from generateIcoHexGrid
 * @param radius Globe radius in km
 * @param scene Babylon.js scene
 */
export function buildGlobeMesh(cells: HexCell[], radius: number, scene: Scene): Mesh {
	const positions: number[] = [];
	const indices: number[] = [];
	const normals: number[] = [];
	const colors: number[] = [];

	let vertexOffset = 0;

	for (const cell of cells) {
		const n = cell.corners.length;
		if (n < 3) continue; // skip degenerate cells

		const terrainColor = TERRAIN_PROFILES[cell.terrain]?.color ?? [0.5, 0.5, 0.5];

		// Center vertex
		const cx = cell.center.x * radius;
		const cy = cell.center.y * radius;
		const cz = cell.center.z * radius;
		positions.push(cx, cy, cz);
		normals.push(cell.center.x, cell.center.y, cell.center.z);
		colors.push(terrainColor[0], terrainColor[1], terrainColor[2], 1.0);

		// Corner vertices
		for (let i = 0; i < n; i++) {
			const corner = cell.corners[i];
			positions.push(corner.x * radius, corner.y * radius, corner.z * radius);
			normals.push(corner.x, corner.y, corner.z);
			colors.push(terrainColor[0], terrainColor[1], terrainColor[2], 1.0);
		}

		// Triangles: center → corner[i] → corner[i+1]
		for (let i = 0; i < n; i++) {
			indices.push(
				vertexOffset,                          // center
				vertexOffset + 1 + i,                  // corner i
				vertexOffset + 1 + (i + 1) % n         // corner i+1
			);
		}

		vertexOffset += 1 + n; // center + corners
	}

	const mesh = new Mesh('globeHexMesh', scene);
	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(positions);
	vertexData.indices = new Uint32Array(indices);
	vertexData.normals = new Float32Array(normals);
	vertexData.applyToMesh(mesh);

	// Set vertex colors
	mesh.setVerticesData(VertexBuffer.ColorKind, new Float32Array(colors), true);

	return mesh;
}

/**
 * Update vertex colors for a specific cell when terrain changes.
 *
 * @param mesh The globe mesh
 * @param cells All hex cells
 * @param cellIndex Index of the cell to update
 * @param vertexStarts Pre-computed: vertex start index for each cell
 */
export function updateCellColor(
	mesh: Mesh,
	cells: HexCell[],
	cellIndex: number,
	vertexStarts: number[]
): void {
	const cell = cells[cellIndex];
	const color = TERRAIN_PROFILES[cell.terrain]?.color ?? [0.5, 0.5, 0.5];
	const start = vertexStarts[cellIndex];
	const n = cell.corners.length + 1; // center + corners

	const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
	if (!colors) return;

	for (let i = 0; i < n; i++) {
		const idx = (start + i) * 4;
		colors[idx + 0] = color[0];
		colors[idx + 1] = color[1];
		colors[idx + 2] = color[2];
		colors[idx + 3] = 1.0;
	}

	mesh.setVerticesData(VertexBuffer.ColorKind, colors, true);
}

/**
 * Compute the vertex start index for each cell (for partial color updates).
 */
export function computeVertexStarts(cells: HexCell[]): number[] {
	const starts: number[] = [];
	let offset = 0;
	for (const cell of cells) {
		starts.push(offset);
		offset += 1 + cell.corners.length; // center + corners
	}
	return starts;
}
