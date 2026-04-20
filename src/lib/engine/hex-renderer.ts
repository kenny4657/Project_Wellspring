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
	private terrainData0: Float32Array;
	private terrainData1: Float32Array;
	private hexTerrainIndex: Float32Array;
	private hexIndex: Map<string, number> = new Map();
	private neighborMap: Map<string, string[]> = new Map();
	private count: number = 0;

	constructor(mesh: Mesh, capacity: number) {
		this.mesh = mesh;
		this.matrices = new Float32Array(capacity * 16);
		this.colors = new Float32Array(capacity * 4);
		this.terrainData0 = new Float32Array(capacity * 4);
		this.terrainData1 = new Float32Array(capacity * 4);
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

			// Terrain data for custom shader
			this.terrainData0[i * 4 + 0] = terrainIdx;
			this.terrainData0[i * 4 + 1] = terrainIdx;
			this.terrainData0[i * 4 + 2] = terrainIdx;
			this.terrainData0[i * 4 + 3] = terrainIdx;
			this.terrainData1[i * 4 + 0] = terrainIdx;
			this.terrainData1[i * 4 + 1] = terrainIdx;
			this.terrainData1[i * 4 + 2] = terrainIdx;
			this.terrainData1[i * 4 + 3] = 0;
		}

		// Set neighbor terrain data
		for (let i = 0; i < cells.length; i++) {
			const h3 = cells[i];
			const neighbors = this.neighborMap.get(h3)!;
			for (let e = 0; e < 6; e++) {
				const ni = this.hexIndex.get(neighbors[e]);
				if (ni !== undefined) {
					const neighborType = this.terrainData0[ni * 4 + 0];
					if (e < 3) {
						this.terrainData0[i * 4 + 1 + e] = neighborType;
					} else {
						this.terrainData1[i * 4 + (e - 3)] = neighborType;
					}
				}
			}
		}

		this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, true);
		// Instance colors for StandardMaterial/CustomMaterial lighting
		this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false);
		// Custom terrain attributes for shader injection
		this.mesh.thinInstanceRegisterAttribute('terrainData0', 4);
		this.mesh.thinInstanceSetBuffer('terrainData0', this.terrainData0, 4, false);
		this.mesh.thinInstanceRegisterAttribute('terrainData1', 4);
		this.mesh.thinInstanceSetBuffer('terrainData1', this.terrainData1, 4, false);
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

		// Update terrain data for shader
		this.terrainData0[idx * 4 + 0] = terrainIdx;

		const neighbors = this.neighborMap.get(h3);
		if (neighbors) {
			for (let e = 0; e < 6; e++) {
				const neighborH3 = neighbors[e];
				const ni = this.hexIndex.get(neighborH3);
				if (ni === undefined) continue;
				const neighborNeighbors = this.neighborMap.get(neighborH3);
				if (!neighborNeighbors) continue;
				for (let ne = 0; ne < 6; ne++) {
					if (neighborNeighbors[ne] === h3) {
						if (ne < 3) this.terrainData0[ni * 4 + 1 + ne] = terrainIdx;
						else this.terrainData1[ni * 4 + (ne - 3)] = terrainIdx;
						break;
					}
				}
				const neighborType = this.terrainData0[ni * 4 + 0];
				if (e < 3) this.terrainData0[idx * 4 + 1 + e] = neighborType;
				else this.terrainData1[idx * 4 + (e - 3)] = neighborType;
			}
		}

		this.mesh.thinInstanceBufferUpdated('color');
		this.mesh.thinInstanceBufferUpdated('terrainData0');
		this.mesh.thinInstanceBufferUpdated('terrainData1');
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
