/**
 * Hex renderer — manages thin instances for all hex tiles on the globe.
 *
 * All hexes share one mesh template. Terrain shape, material, and transitions
 * are driven by per-instance attributes read by the terrain shader:
 *   - matrix (16 floats): position + rotation on globe
 *   - terrainData (8 floats): terrain type + 6 neighbor types + padding
 *   - color (4 floats): province/country tint RGBA
 */
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { type Mesh } from '@babylonjs/core/Meshes/mesh';
import { cellToLatLng, gridDisk } from 'h3-js';
import { latLngToWorld, EARTH_RADIUS_KM } from '$lib/geo/coords';
import { TERRAIN_TYPES, type TerrainTypeId } from '$lib/world/terrain-types';

// Reusable temp vectors to avoid allocation in hot loops
const _pos = Vector3.Zero();
const _up = Vector3.Zero();
const _fwd = Vector3.Zero();
const _right = Vector3.Zero();

export class HexRenderer {
	private mesh: Mesh;
	private matrices: Float32Array;
	private terrainData: Float32Array;
	private colors: Float32Array;
	private hexIndex: Map<string, number> = new Map();
	private neighborMap: Map<string, string[]> = new Map(); // h3 → 6 neighbor h3s
	private count: number = 0;

	constructor(mesh: Mesh, capacity: number) {
		this.mesh = mesh;
		this.matrices = new Float32Array(capacity * 16);
		this.terrainData = new Float32Array(capacity * 8);
		this.colors = new Float32Array(capacity * 4);
	}

	/**
	 * Initialize all hexes from H3 cell list.
	 * Computes globe positions, builds neighbor map, sets default terrain.
	 */
	initFromCells(cells: string[], defaultTerrain: TerrainTypeId = 'deep_ocean'): void {
		this.count = cells.length;
		const cellSet = new Set(cells);
		const terrainIndex = TERRAIN_TYPES[defaultTerrain];

		for (let i = 0; i < cells.length; i++) {
			const h3 = cells[i];
			this.hexIndex.set(h3, i);

			// Compute neighbors (filter to cells in our grid)
			const disk = gridDisk(h3, 1);
			const neighbors = disk.filter(n => n !== h3);
			// Pad to exactly 6 neighbors (pentagons have 5)
			while (neighbors.length < 6) neighbors.push(neighbors[0] || h3);
			this.neighborMap.set(h3, neighbors);

			// Compute instance matrix (position + rotation on globe)
			const [lat, lng] = cellToLatLng(h3);
			this.computeMatrix(lat, lng, i);

			// Set default terrain data
			this.terrainData[i * 8 + 0] = terrainIndex;
			for (let e = 0; e < 6; e++) {
				this.terrainData[i * 8 + 1 + e] = terrainIndex;
			}
			this.terrainData[i * 8 + 7] = 0; // padding

			// Default color: fully transparent (no tint)
			this.colors[i * 4 + 0] = 0;
			this.colors[i * 4 + 1] = 0;
			this.colors[i * 4 + 2] = 0;
			this.colors[i * 4 + 3] = 0;
		}

		// Second pass: set neighbor terrain data (now that all hexes are indexed)
		for (let i = 0; i < cells.length; i++) {
			const h3 = cells[i];
			const neighbors = this.neighborMap.get(h3)!;
			for (let e = 0; e < 6; e++) {
				const ni = this.hexIndex.get(neighbors[e]);
				if (ni !== undefined) {
					this.terrainData[i * 8 + 1 + e] = this.terrainData[ni * 8 + 0];
				}
			}
		}

		// Upload buffers
		// Babylon splits instance attributes into vec4 chunks in the shader.
		// 'matrix' (16 floats) → mat4 'world' (automatically handled)
		// 'terrainData' (8 floats) → two vec4 attributes: 'terrainData0' + 'terrainData1'
		// 'color' (4 floats) → vec4 'color'
		this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, true);
		this.mesh.thinInstanceRegisterAttribute('terrainData', 8);
		this.mesh.thinInstanceSetBuffer('terrainData', this.terrainData, 8, false);
		this.mesh.thinInstanceRegisterAttribute('color', 4);
		this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false);
	}

	/**
	 * Change a hex's terrain type. Updates this hex + 6 neighbors' buffers.
	 */
	setHexTerrain(h3: string, terrain: TerrainTypeId): void {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return;

		const terrainIndex = TERRAIN_TYPES[terrain];

		// Update this hex's terrain type
		this.terrainData[idx * 8 + 0] = terrainIndex;

		// Update all neighbors' data pointing back to this hex
		const neighbors = this.neighborMap.get(h3);
		if (neighbors) {
			for (let e = 0; e < 6; e++) {
				const neighborH3 = neighbors[e];
				const ni = this.hexIndex.get(neighborH3);
				if (ni === undefined) continue;

				// Find which edge of the neighbor points back to this hex
				const neighborNeighbors = this.neighborMap.get(neighborH3);
				if (!neighborNeighbors) continue;
				for (let ne = 0; ne < 6; ne++) {
					if (neighborNeighbors[ne] === h3) {
						this.terrainData[ni * 8 + 1 + ne] = terrainIndex;
						break;
					}
				}

				// Also update this hex's neighbor data
				this.terrainData[idx * 8 + 1 + e] = this.terrainData[ni * 8 + 0];
			}
		}

		this.mesh.thinInstanceBufferUpdated('terrainData');
	}

	/**
	 * Set a hex's province/country color tint.
	 */
	setHexColor(h3: string, r: number, g: number, b: number, a: number): void {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return;

		this.colors[idx * 4 + 0] = r;
		this.colors[idx * 4 + 1] = g;
		this.colors[idx * 4 + 2] = b;
		this.colors[idx * 4 + 3] = a;
		this.mesh.thinInstanceBufferUpdated('color');
	}

	/**
	 * Clear a hex's color tint (make fully transparent).
	 */
	clearHexColor(h3: string): void {
		this.setHexColor(h3, 0, 0, 0, 0);
	}

	/**
	 * Get the terrain type of a hex.
	 */
	getHexTerrain(h3: string): TerrainTypeId | null {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return null;
		const typeIndex = this.terrainData[idx * 8 + 0];
		const entries = Object.entries(TERRAIN_TYPES);
		const entry = entries.find(([, v]) => v === typeIndex);
		return entry ? entry[0] as TerrainTypeId : null;
	}

	/** Total hex count */
	get hexCount(): number { return this.count; }

	/** Check if an H3 cell is in the grid */
	hasHex(h3: string): boolean { return this.hexIndex.has(h3); }

	// ── Private helpers ──

	private computeMatrix(lat: number, lng: number, index: number): void {
		// Position on globe surface
		const r = EARTH_RADIUS_KM;
		_pos.copyFrom(latLngToWorld(lat, lng, r));

		// Surface normal = normalized position (for a sphere centered at origin)
		_pos.normalizeToRef(_up);

		// Compute tangent frame: right = cross(worldUp, normal), fwd = cross(normal, right)
		const worldUp = Math.abs(_up.y) < 0.999
			? Vector3.UpReadOnly
			: Vector3.RightReadOnly;

		Vector3.CrossToRef(worldUp, _up, _right);
		_right.normalize();
		Vector3.CrossToRef(_up, _right, _fwd);
		_fwd.normalize();

		// Build rotation matrix from tangent frame
		const mat = Matrix.Identity();
		Matrix.FromValuesToRef(
			_right.x, _right.y, _right.z, 0,
			_up.x,    _up.y,    _up.z,    0,
			_fwd.x,   _fwd.y,   _fwd.z,   0,
			_pos.x,   _pos.y,   _pos.z,   1,
			mat
		);

		mat.copyToArray(this.matrices, index * 16);
	}
}
