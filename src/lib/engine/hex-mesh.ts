/**
 * Hex mesh — a subdivided ground plane clipped to hex shape in fragment shader.
 *
 * Uses CreateGround for dense vertex grid (100+ vertices for proper terrain
 * displacement), then the fragment shader discards pixels outside the hex boundary.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';

/**
 * Create a hex mesh with enough vertices for terrain displacement.
 *
 * @param radius Hex circumradius in world units (km)
 * @param subdivisions Grid subdivisions (8-12 for good terrain detail)
 * @param scene Babylon.js scene
 */
export function createHexMesh(radius: number, subdivisions: number, scene: Scene): Mesh {
	// CreateGround makes a flat grid on XZ plane (Y-up) — matches our instance matrix
	const mesh = MeshBuilder.CreateGround('hexTemplate', {
		width: radius * 2,
		height: radius * 2,
		subdivisions: subdivisions,
		updatable: false
	}, scene);

	mesh.isPickable = false;
	return mesh;
}
