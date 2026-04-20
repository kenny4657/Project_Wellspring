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
	// CreateDisc makes a disc on XY plane (facing Z).
	// We need it on XZ plane (facing Y) to match the instance matrix tangent frame.
	const mesh = MeshBuilder.CreateDisc('hexTemplate', {
		radius,
		tessellation: 6,
		sideOrientation: Mesh.DOUBLESIDE
	}, scene);

	// Rotate vertices from XY plane to XZ plane (swap Y and Z)
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
	if (positions) {
		const rotated = new Float32Array(positions.length);
		const uvs: number[] = [];
		const uvs2: number[] = [];
		for (let i = 0; i < positions.length; i += 3) {
			rotated[i]     = positions[i];     // X stays
			rotated[i + 1] = 0;                // Y = 0 (flat on XZ plane)
			rotated[i + 2] = positions[i + 1]; // Z = old Y
			uvs.push(rotated[i] / radius, rotated[i + 2] / radius);
			uvs2.push(0, 0);
		}
		mesh.setVerticesData(VertexBuffer.PositionKind, rotated);
		mesh.setVerticesData(VertexBuffer.UVKind, new Float32Array(uvs));
		mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(uvs2));

		// Recompute normals for the rotated geometry
		const normals = new Float32Array(positions.length);
		for (let i = 0; i < positions.length; i += 3) {
			normals[i] = 0; normals[i + 1] = 1; normals[i + 2] = 0; // all face Y-up
		}
		mesh.setVerticesData(VertexBuffer.NormalKind, normals);
	}

	mesh.isPickable = false;
	return mesh;
}
