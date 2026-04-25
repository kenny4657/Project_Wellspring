/**
 * Phase 3 -- smooth icosphere base mesh for the new shader-driven renderer.
 *
 * Replaces the per-hex prism mesh from globe-mesh.ts with a uniform
 * subdivided icosphere. Geometry has no per-hex info; the fragment shader
 * derives that on the fly via Phase 2's worldPosToHexId + Phase 1's data
 * textures.
 *
 * Subdivision count is chosen to land in the plan's 200k-500k vertex range.
 * IMPORTANT: Babylon's CreateIcoSphere does NOT share vertices across
 * triangle edges, so vertex count = 3 * triangle count, not the textbook
 * "verts ~= triangles / 2." Concretely: subdivisions = N -> 20 * N^2
 * triangles -> 60 * N^2 verts.
 *
 *   N=80  -> 128,000 tri, 384,000 verts.  In the 200-500k band. <-- chosen
 *   N=128 -> 327,680 tri, 983,040 verts.  Over budget.
 *   N=160 -> 512,000 tri, 1,536,000 verts. Way over budget.
 *
 * Confirmed empirically via _phase3MeshStats(); see audit notes.
 *
 * Tessellation (per Phase 8 fallback): not now. Static dense mesh is
 * simpler and the perf headroom from Phase 2 (~65 fps median, 14 ms) leaves
 * plenty of room before we'd need adaptive subdivision.
 */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

export const SHADER_GLOBE_SUBDIVISIONS = 80;

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
