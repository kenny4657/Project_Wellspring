/**
 * Hex renderer — manages thin instances for all hex tiles on the globe.
 *
 * Uses Babylon's native instance color system with StandardMaterial.
 * Terrain type → color lookup from TERRAIN_PROFILES.
 */
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { type Mesh } from '@babylonjs/core/Meshes/mesh';
import { cellToLatLng, gridDisk } from 'h3-js';
import { latLngToWorld, EARTH_RADIUS_KM } from '$lib/geo/coords';
import { TERRAIN_TYPES, TERRAIN_PROFILES, type TerrainTypeId } from '$lib/world/terrain-types';

const _pos = Vector3.Zero();
const _up = Vector3.Zero();
const _fwd = Vector3.Zero();
const _right = Vector3.Zero();

export class HexRenderer {
	private mesh: Mesh;
	private matrices: Float32Array;
	private colors: Float32Array;
	private hexTerrainIndex: Float32Array;
	private hexIndex: Map<string, number> = new Map();
	private neighborMap: Map<string, string[]> = new Map();
	private count: number = 0;

	constructor(mesh: Mesh, capacity: number) {
		this.mesh = mesh;
		this.matrices = new Float32Array(capacity * 16);
		this.colors = new Float32Array(capacity * 4);
		this.hexTerrainIndex = new Float32Array(capacity);
	}

	initFromCells(cells: string[], defaultTerrain: TerrainTypeId = 'deep_ocean'): void {
		this.count = cells.length;
		const terrainIdx = TERRAIN_TYPES[defaultTerrain];
		const profile = TERRAIN_PROFILES[terrainIdx];

		for (let i = 0; i < cells.length; i++) {
			const h3 = cells[i];
			this.hexIndex.set(h3, i);

			const disk = gridDisk(h3, 1);
			const neighbors = disk.filter(n => n !== h3);
			while (neighbors.length < 6) neighbors.push(neighbors[0] || h3);
			this.neighborMap.set(h3, neighbors);

			const [lat, lng] = cellToLatLng(h3);
			this.computeMatrix(lat, lng, i);

			this.hexTerrainIndex[i] = terrainIdx;
			this.colors[i * 4 + 0] = profile.color[0];
			this.colors[i * 4 + 1] = profile.color[1];
			this.colors[i * 4 + 2] = profile.color[2];
			this.colors[i * 4 + 3] = 1.0;
		}

		this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, true);
		this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false);
	}

	setHexTerrain(h3: string, terrain: TerrainTypeId): void {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return;

		const terrainIdx = TERRAIN_TYPES[terrain];
		const profile = TERRAIN_PROFILES[terrainIdx];

		this.hexTerrainIndex[idx] = terrainIdx;
		this.colors[idx * 4 + 0] = profile.color[0];
		this.colors[idx * 4 + 1] = profile.color[1];
		this.colors[idx * 4 + 2] = profile.color[2];
		this.colors[idx * 4 + 3] = 1.0;

		this.mesh.thinInstanceBufferUpdated('color');
	}

	setHexColor(h3: string, r: number, g: number, b: number, a: number): void {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return;
		this.colors[idx * 4 + 0] = r;
		this.colors[idx * 4 + 1] = g;
		this.colors[idx * 4 + 2] = b;
		this.colors[idx * 4 + 3] = a;
		this.mesh.thinInstanceBufferUpdated('color');
	}

	clearHexColor(h3: string): void {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return;
		const terrainIdx = this.hexTerrainIndex[idx];
		const profile = TERRAIN_PROFILES[terrainIdx];
		this.colors[idx * 4 + 0] = profile.color[0];
		this.colors[idx * 4 + 1] = profile.color[1];
		this.colors[idx * 4 + 2] = profile.color[2];
		this.colors[idx * 4 + 3] = 1.0;
		this.mesh.thinInstanceBufferUpdated('color');
	}

	getHexTerrain(h3: string): TerrainTypeId | null {
		const idx = this.hexIndex.get(h3);
		if (idx === undefined) return null;
		const typeIndex = this.hexTerrainIndex[idx];
		const entries = Object.entries(TERRAIN_TYPES);
		const entry = entries.find(([, v]) => v === typeIndex);
		return entry ? entry[0] as TerrainTypeId : null;
	}

	get hexCount(): number { return this.count; }
	hasHex(h3: string): boolean { return this.hexIndex.has(h3); }

	private computeMatrix(lat: number, lng: number, index: number): void {
		const r = EARTH_RADIUS_KM + 15;
		_pos.copyFrom(latLngToWorld(lat, lng, r));
		_pos.normalizeToRef(_up);

		const worldUp = Math.abs(_up.y) < 0.999
			? Vector3.UpReadOnly : Vector3.RightReadOnly;

		Vector3.CrossToRef(worldUp, _up, _right);
		_right.normalize();
		Vector3.CrossToRef(_up, _right, _fwd);
		_fwd.normalize();

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
