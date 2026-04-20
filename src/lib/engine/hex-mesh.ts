/**
 * Shared hex mesh template.
 *
 * Uses Babylon's built-in CreateDisc with tessellation=6 for a perfect hexagon.
 * UV coordinates encode local hex position (-1 to 1) for the terrain shader.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';

/**
 * Create a hex mesh using Babylon's CreateDisc.
 *
 * @param radius Hex radius in world units (km)
 * @param scene Babylon.js scene
 * @returns Mesh with UV encoding local hex position for the shader
 */
export function createHexMesh(radius: number, _subdivisions: number, scene: Scene): Mesh {
	// CreateDisc with tessellation=6 makes a perfect flat hexagon
	const mesh = MeshBuilder.CreateDisc('hexTemplate', {
		radius,
		tessellation: 6,
		sideOrientation: Mesh.DOUBLESIDE
	}, scene);

	// Rewrite UVs to encode local hex position (-1 to 1 range)
	// so the terrain shader can compute distance from center and edge direction
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
	if (positions) {
		const uvs: number[] = [];
		const uvs2: number[] = [];
		for (let i = 0; i < positions.length; i += 3) {
			uvs.push(positions[i] / radius, positions[i + 2] / radius);
			uvs2.push(0, 0); // all top face (no skirt)
		}
		mesh.setVerticesData(VertexBuffer.UVKind, new Float32Array(uvs));
		mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(uvs2));
	}

	mesh.isPickable = false;
	return mesh;
}
