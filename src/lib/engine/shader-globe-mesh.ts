/**
 * Phase 3 -- smooth icosphere base mesh for the new shader-driven renderer.
 *
 * Replaces the per-hex prism mesh from globe-mesh.ts with a uniform
 * subdivided icosphere. Geometry has no per-hex info; the fragment shader
 * derives that on the fly via Phase 2's worldPosToHexId + Phase 1's data
 * textures.
 *
 * Subdivision count is chosen to land in the plan's 200k-500k vertex range:
 *   subdivisions = N produces 20 * N^2 triangles, ~10 * N^2 verts.
 *   N=128 -> 327,680 tri, ~163k verts. Squarely inside the band.
 *
 * Tessellation (per Phase 8 fallback): not now. Static dense mesh is
 * simpler and the perf headroom from Phase 2 (~65 fps median, 14 ms) leaves
 * plenty of room before we'd need adaptive subdivision.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

export const SHADER_GLOBE_SUBDIVISIONS = 128;

export interface ShaderGlobeMesh {
	mesh: Mesh;
	vertexCount: number;
	triangleCount: number;
}

/**
 * Build the smooth icosphere. Radius is set slightly below the legacy
 * planet radius so the mesh sits *inside* legacy hex prism elevation in
 * case both meshes are visible at once during the transition. The legacy
 * mesh extrudes outward from EARTH_RADIUS_KM; this one stays at radius.
 *
 * The mesh has no material attached -- callers attach shader-globe-material
 * (Phase 3) or shader-globe-debug-material (Phase 2) depending on the
 * render mode.
 */
export function createShaderGlobeMesh(planetRadiusKm: number, scene: Scene): ShaderGlobeMesh {
	const mesh = MeshBuilder.CreateIcoSphere('shaderGlobe', {
		radius: planetRadiusKm,
		subdivisions: SHADER_GLOBE_SUBDIVISIONS,
		flat: false, // smooth-shaded -- one normal per shared vertex
	}, scene);

	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true; // sphere always covers the screen; skip frustum check
	mesh.setEnabled(false); // off by default; render mode toggles it on

	return {
		mesh,
		vertexCount: mesh.getTotalVertices(),
		triangleCount: mesh.getTotalIndices() / 3,
	};
}
