/**
 * Flat unit-sphere hex mesh builder for GPU displacement.
 *
 * Same tessellation algorithm as the CPU path (`subdivTriangle`),
 * but emits **only the unit-direction position** for each vertex.
 * No noise, no cliff erosion, no smoothing — those move to the
 * vertex shader.
 *
 * Per-vertex attributes:
 *   - `position` (vec3): unit direction on sphere, length 1.0
 *   - `hexId`    (float): cell.id, used by shader to look up
 *     per-hex data (heightLevel, terrain, neighbors)
 *   - `localUV`  (vec2): hex-local barycentric (corner 0 = (0,0),
 *     corner 1 = (1,0), center = (1/3, 1/3) approx). Used by
 *     fragment shader for terrain blending.
 *   - `wallFlag` (float): 0.0 = top vertex, 1.0 = wall vertex.
 *
 * Phase 1 emits **top faces only**. Walls land in Phase 2 alongside
 * the vertex shader that knows how to position them — wall geometry
 * needs neighbor heightLevel to set the bottom radius, and that's a
 * shader-side decision now.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import type { ChunkAssignment } from '../globe-chunks';
import { SUBDIVISIONS, subdivTriangle } from '../mesh-smoothing';

export interface FlatChunkMesh {
	mesh: Mesh;
	cellIds: number[];
	/** cellIdx → vertex offset within this chunk's buffer. */
	cellLocalStart: Map<number, number>;
	/** cellIdx → vertex count within this chunk's buffer. */
	cellVertexCount: Map<number, number>;
	totalVertices: number;
}

export function buildFlatChunkMeshes(
	cells: HexCell[],
	scene: Scene,
	chunkAssignment: ChunkAssignment,
): FlatChunkMesh[] {
	const chunks: FlatChunkMesh[] = [];

	for (let chunkIdx = 0; chunkIdx < chunkAssignment.cellsByChunk.length; chunkIdx++) {
		const cellIds = chunkAssignment.cellsByChunk[chunkIdx];
		const positions: number[] = [];
		const hexIds: number[] = [];
		const localUVs: number[] = [];
		const wallFlags: number[] = [];
		const indices: number[] = [];
		const cellLocalStart = new Map<number, number>();
		const cellVertexCount = new Map<number, number>();
		let vOff = 0;

		for (const ci of cellIds) {
			const cell = cells[ci];
			const n = cell.corners.length;
			if (n < 3) {
				cellLocalStart.set(ci, vOff);
				cellVertexCount.set(ci, 0);
				continue;
			}
			cellLocalStart.set(ci, vOff);
			const startVOff = vOff;
			const hexIdF = cell.id;

			// Tessellate each fan triangle (center, c[i+1], c[i]) into
			// SUBDIVISIONS-many small triangles. Same call signature as
			// the CPU path so the geometry matches vertex-for-vertex.
			for (let i = 0; i < n; i++) {
				const c0 = cell.corners[(i + 1) % n];
				const c1 = cell.corners[i];
				const triVerts: number[] = [];
				subdivTriangle(
					cell.center.x, cell.center.y, cell.center.z,
					c0.x, c0.y, c0.z,
					c1.x, c1.y, c1.z,
					SUBDIVISIONS, triVerts,
				);

				// Each tri is 3 contiguous vec3s (9 floats). The 3 verts
				// are in fan-triangle order: center, c0, c1, where center
				// for the *outer* sub-tris is the result of subdivision —
				// not literally the hex center. We emit them with
				// per-vertex attributes; the shader handles positioning.
				for (let j = 0; j < triVerts.length; j += 9) {
					for (let k = 0; k < 3; k++) {
						const ux = triVerts[j + k * 3];
						const uy = triVerts[j + k * 3 + 1];
						const uz = triVerts[j + k * 3 + 2];
						positions.push(ux, uy, uz);
						hexIds.push(hexIdF);
						// localUV = (k==1 ? 1 : 0, k==2 ? 1 : 0). Identifies
						// which corner of the sub-tri this vertex is. The
						// fragment shader can use this for terrain blending
						// across the hex once Phase 2 wires it up.
						localUVs.push(k === 1 ? 1 : 0, k === 2 ? 1 : 0);
						wallFlags.push(0);
						indices.push(vOff++);
					}
				}
			}
			cellVertexCount.set(ci, vOff - startVOff);
		}

		const positionsF32 = new Float32Array(positions);
		const hexIdsF32 = new Float32Array(hexIds);
		const localUVsF32 = new Float32Array(localUVs);
		const wallFlagsF32 = new Float32Array(wallFlags);

		const mesh = new Mesh(`gpuFlatChunk_${chunkIdx}`, scene);
		const vd = new VertexData();
		vd.positions = positionsF32;
		vd.indices = new Uint32Array(indices);
		vd.applyToMesh(mesh, true);
		mesh.setVerticesData('hexId', hexIdsF32, false, 1);
		mesh.setVerticesData('localUV', localUVsF32, false, 2);
		mesh.setVerticesData('wallFlag', wallFlagsF32, false, 1);
		// Disabled by default — Phase 1 doesn't render this mesh.
		mesh.setEnabled(false);

		chunks.push({
			mesh,
			cellIds: cellIds.slice(),
			cellLocalStart,
			cellVertexCount,
			totalVertices: vOff,
		});
	}

	return chunks;
}
