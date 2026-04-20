/**
 * Shared hex mesh template — subdivided hexagon with skirt ring.
 *
 * One instance of this mesh is created; all hexes use it as thin instances.
 * The vertex shader displaces vertices based on per-instance terrain data.
 *
 * Vertex layout:
 * - Top face: subdivided hexagon (concentric rings of vertices)
 * - Skirt ring: duplicate of outer edge vertices, extended downward by shader
 *
 * Each vertex stores a "localHexUV" (position within the hex, -1 to 1 range)
 * as UV coordinates, used by the shader to compute edge distance and neighbor blending.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';

/**
 * Create a subdivided hex mesh with a skirt ring.
 *
 * @param radius Hex radius in world units (km)
 * @param subdivisions Number of concentric rings (0=center only, 1=center+outer, 2+=more)
 * @param scene Babylon.js scene
 * @returns Mesh with UV encoding local hex position for the shader
 */
export function createHexMesh(radius: number, subdivisions: number, scene: Scene): Mesh {
	const positions: number[] = [];
	const indices: number[] = [];
	const uvs: number[] = [];     // encodes localHexUV for shader
	const uvs2: number[] = [];    // encodes: 0 = top face vertex, 1 = skirt vertex

	// ── Generate top face vertices in concentric hex rings ──
	// Ring 0: center vertex
	// Ring 1-N: hexagonal rings with 6*ring vertices each

	const ringCount = Math.max(subdivisions, 1);
	const vertexRings: Array<Array<[number, number]>> = [];

	// Center vertex
	vertexRings.push([[0, 0]]);

	// Outer rings
	for (let ring = 1; ring <= ringCount; ring++) {
		const ringVerts: Array<[number, number]> = [];
		const r = (ring / ringCount) * radius;

		for (let side = 0; side < 6; side++) {
			const vertsOnSide = ring; // number of vertices per hex side at this ring
			for (let v = 0; v < vertsOnSide; v++) {
				const angle0 = (Math.PI / 3) * side - Math.PI / 6;
				const angle1 = (Math.PI / 3) * (side + 1) - Math.PI / 6;
				const t = v / vertsOnSide;
				const x = r * (Math.cos(angle0) * (1 - t) + Math.cos(angle1) * t);
				const z = r * (Math.sin(angle0) * (1 - t) + Math.sin(angle1) * t);
				ringVerts.push([x, z]);
			}
		}
		vertexRings.push(ringVerts);
	}

	// Add all top face vertices
	const topVertexCount = vertexRings.reduce((sum, ring) => sum + ring.length, 0);
	for (const ring of vertexRings) {
		for (const [x, z] of ring) {
			positions.push(x, 0, z);
			uvs.push(x / radius, z / radius); // local hex UV: -1 to 1
			uvs2.push(0, 0); // top face marker
		}
	}

	// ── Triangulate top face ──
	// Center to first ring
	const firstRing = vertexRings[1];
	for (let i = 0; i < firstRing.length; i++) {
		const next = (i + 1) % firstRing.length;
		indices.push(0, 1 + i, 1 + next);
	}

	// Ring-to-ring triangulation
	let innerStart = 1;
	for (let ring = 1; ring < ringCount; ring++) {
		const innerRing = vertexRings[ring];
		const outerRing = vertexRings[ring + 1];
		const outerStart = innerStart + innerRing.length;

		let iIdx = 0;
		let oIdx = 0;
		const innerLen = innerRing.length;
		const outerLen = outerRing.length;

		// Walk both rings, creating triangles
		while (iIdx < innerLen || oIdx < outerLen) {
			const iCurr = innerStart + (iIdx % innerLen);
			const iNext = innerStart + ((iIdx + 1) % innerLen);
			const oCurr = outerStart + (oIdx % outerLen);
			const oNext = outerStart + ((oIdx + 1) % outerLen);

			if (iIdx >= innerLen) {
				// Only outer vertices left
				indices.push(iCurr, oCurr, oNext);
				oIdx++;
			} else if (oIdx >= outerLen) {
				// Only inner vertices left
				indices.push(iCurr, oCurr, iNext);
				iIdx++;
			} else {
				// Decide: advance outer or inner
				// Advance outer more frequently since outer ring has more vertices
				const outerRatio = oIdx / outerLen;
				const innerRatio = iIdx / innerLen;
				if (outerRatio <= innerRatio) {
					indices.push(iCurr, oCurr, oNext);
					oIdx++;
				} else {
					indices.push(iCurr, oCurr, iNext);
					iIdx++;
				}
			}
		}
		innerStart += innerRing.length;
	}

	// Skirts removed — not needed until terrain elevation varies between hexes.
	// Will be re-added when terrain painting creates elevation differences.

	// ── Build mesh ──
	const mesh = new Mesh('hexTemplate', scene);
	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(positions);
	vertexData.indices = new Uint32Array(indices);
	vertexData.uvs = new Float32Array(uvs);
	vertexData.uvs2 = new Float32Array(uvs2);

	// Compute normals
	VertexData.ComputeNormals(positions, indices, vertexData.normals = []);

	vertexData.applyToMesh(mesh);
	mesh.isPickable = false;

	return mesh;
}
