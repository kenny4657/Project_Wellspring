/**
 * Hex mesh — properly subdivided hexagon with correct UV mapping.
 * Ported from threejs-hex-map/hexagon.ts (MIT license).
 *
 * Creates a hex on the XZ plane (Y-up) with:
 * - Subdivided triangles for smooth terrain displacement
 * - UVs mapping to 0.02-0.98 within a square bounding box (for atlas sampling)
 * - Border attribute: 1.0 at hex edges, 0.0 at interior
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Scene } from '@babylonjs/core/scene';

interface Vec3 { x: number; y: number; z: number }

function vec3(x: number, y: number, z: number): Vec3 { return { x, y, z }; }
function sub(a: Vec3, b: Vec3): Vec3 { return vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
function add(a: Vec3, b: Vec3): Vec3 { return vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
function scale(a: Vec3, s: number): Vec3 { return vec3(a.x * s, a.y * s, a.z * s); }
function len(a: Vec3): number { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
function setLen(a: Vec3, l: number): Vec3 { const c = l / len(a); return vec3(a.x * c, a.y * c, a.z * c); }

function subdivideTriangle(a: Vec3, b: Vec3, c: Vec3, numSub: number): Vec3[] {
	if (numSub <= 0) return [a, b, c];

	const ba = sub(b, a);
	const ah = add(a, setLen(ba, len(ba) / 2));
	const cb = sub(c, b);
	const bh = add(b, setLen(cb, len(cb) / 2));
	const ac = sub(a, c);
	const ch = add(c, setLen(ac, len(ac) / 2));

	return [
		...subdivideTriangle(ah, bh, ch, numSub - 1),
		...subdivideTriangle(ch, bh, c, numSub - 1),
		...subdivideTriangle(ah, ch, a, numSub - 1),
		...subdivideTriangle(bh, ah, b, numSub - 1),
	];
}

/**
 * Create a subdivided hex mesh.
 *
 * @param radius Hex circumradius in world units
 * @param numSubdivisions 0=6 tris, 1=24, 2=96, 3=384
 * @param scene Babylon.js scene
 */
export function createHexMesh(radius: number, numSubdivisions: number, scene: Scene): Mesh {
	const numFaces = 6 * Math.pow(4, numSubdivisions);
	const positions: number[] = [];
	const uvs: number[] = [];
	const borders: number[] = [];
	const indices: number[] = [];

	// 6 hex corners + center, on XZ plane (Y=0, Y-up for Babylon)
	// Reference uses XY plane; we rotate to XZ for our instance matrix convention
	const corners: Vec3[] = [];
	for (let i = 0; i < 6; i++) {
		corners.push(vec3(
			radius * Math.sin(Math.PI * 2 * (i / 6.0)),
			0,
			radius * Math.cos(Math.PI * 2 * (i / 6.0))
		));
	}
	const center = vec3(0, 0, 0);

	// 6 triangles: corner[i], center, corner[i+1]
	const faceIndices = [
		0, 6, 1, 1, 6, 2, 2, 6, 3, 3, 6, 4, 4, 6, 5, 5, 6, 0
	];
	const points = [...corners, center]; // index 6 = center

	let vertices: Vec3[] = [];
	for (let i = 0; i < faceIndices.length; i += 3) {
		const a = points[faceIndices[i]];
		const b = points[faceIndices[i + 1]];
		const c = points[faceIndices[i + 2]];
		vertices = vertices.concat(subdivideTriangle(a, b, c, numSubdivisions));
	}

	// Inradius = distance from center to edge midpoint
	const inradius = (Math.sqrt(3) / 2) * radius;

	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		positions.push(v.x, v.y, v.z);

		// UVs: map hex bounding box (-radius..radius) to (0.02..0.98)
		// Use X and Z (hex is on XZ plane)
		uvs.push(
			0.02 + 0.96 * ((v.x + radius) / (radius * 2)),
			0.02 + 0.96 * ((v.z + radius) / (radius * 2))
		);

		// Border: 1.0 if vertex is near hex edge, 0.0 if interior
		const dist = Math.sqrt(v.x * v.x + v.z * v.z);
		borders.push(dist >= inradius - 0.1 * radius ? 1.0 : 0.0);

		indices.push(i);
	}

	// Build mesh
	const mesh = new Mesh('hexTemplate', scene);
	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(positions);
	vertexData.indices = new Uint32Array(indices);
	vertexData.uvs = new Float32Array(uvs);

	// Compute normals (all face Y-up for a flat hex)
	const normals: number[] = [];
	for (let i = 0; i < positions.length / 3; i++) {
		normals.push(0, 1, 0);
	}
	vertexData.normals = new Float32Array(normals);

	vertexData.applyToMesh(mesh);

	// Add border as custom vertex attribute
	mesh.setVerticesData('border', new Float32Array(borders), false, 1);

	mesh.isPickable = false;
	return mesh;
}
