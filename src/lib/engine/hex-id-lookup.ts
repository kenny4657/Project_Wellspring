/**
 * Phase 2 — GLSL hex ID lookup support.
 *
 * Builds the GPU-side data needed by `worldPosToHexId` in
 * shader-globe-debug-material.ts:
 *
 *   - Face vertex uniforms (60 vec3's): per-face triangle vertices on the
 *     unit sphere. The shader uses these for face selection (max dot vs.
 *     centroid) and for planar barycentric → face-local 2D recovery.
 *
 *   - Hex lookup texture (RGBA8): 2D image keyed by (face, i, j) returning
 *     the canonical cell ID assigned by icosphere.ts. ID is packed into RG
 *     as little-endian uint16; -1 (no hex at this slot, outside triangle)
 *     is encoded as 0xFFFF.
 *
 * The plan calls this a "throwaway spike" deliverable — keep it isolated
 * from the legacy renderer so it can be deleted cleanly if Phase 2's
 * conclusion is "shader hex lookup isn't viable, fall back to cube map."
 */

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { IcoGridWithFaces } from './icosphere';

export const NO_HEX_SENTINEL = 0xFFFF;

export interface HexIdLookup {
	/** RGBA8 texture: (face*gridSize + j, i) → packed cellId in (R, G). */
	texture: RawTexture;
	/** 60 floats: 20 faces × (v0xyz, v1xyz, v2xyz) flattened. Upload as vec3 array. */
	faceVerts: Float32Array;
	/** 60 floats: 20 face centroids (normalized v0+v1+v2). vec3 array. */
	faceCentroids: Float32Array;
	/** Width of the lookup texture in pixels. */
	width: number;
	/** Height of the lookup texture in pixels. */
	height: number;
	/** gridSize = resolution + 2. */
	gridSize: number;

	// ── Pentagon early-exit data ──
	// The 12 pentagons sit at the 12 icosahedron vertices, where 5 faces meet.
	// At those points the planar barycentric inverse breaks down (the point
	// belongs equally to 5 face-grids), so the GLSL detects "near vertex" up
	// front and returns the pentagon's hex ID directly.
	/** 36 floats: 12 unit-sphere vertex positions (vec3 array). */
	pentagonVerts: Float32Array;
	/** 12 floats: cell ID of the pentagon hex sitting at vertex v (matched by nearest center). */
	pentagonIds: Float32Array;
	/** cos(angular pentagon-region radius). dot(P, vert) > this  →  inside pentagon. */
	pentagonThreshold: number;
}

/**
 * CPU mirror of the GLSL `worldPosToHexId` algorithm. Same face-pick + planar
 * barycentric + (i, j) grid-snap math. Used by phase2-verify.mjs as the
 * "ground truth" the shader is supposed to faithfully reproduce — and as a
 * reference for any future Phase 4 work that needs CPU-side parity.
 *
 * NOTE: this is *not* the same as `pickHex` in globe.ts. pickHex is a
 * nearest-cell-center search (Voronoi-style); this is a face-grid snap.
 * They agree at hex centers, disagree near boundaries by 1 cell.
 */
export function pickHexByFaceGrid(
	p: { x: number; y: number; z: number },
	lookup: HexIdLookup,
	resolution: number,
	grid: IcoGridWithFaces
): number {
	// Normalize input
	const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
	const px = p.x / len, py = p.y / len, pz = p.z / len;

	// Pentagon early-exit. Mirrors the GLSL — if P is within angular
	// threshold of any of the 12 icosahedron vertices, return that
	// pentagon's hex id directly. Skips face-lookup ambiguity at the
	// 5-face seam.
	for (let v = 0; v < 12; v++) {
		const vx = lookup.pentagonVerts[v * 3];
		const vy = lookup.pentagonVerts[v * 3 + 1];
		const vz = lookup.pentagonVerts[v * 3 + 2];
		if (px * vx + py * vy + pz * vz > lookup.pentagonThreshold) {
			return lookup.pentagonIds[v];
		}
	}

	// Find face (max dot vs centroid)
	let bestFace = 0, bestDot = -2;
	for (let f = 0; f < 20; f++) {
		const cx = lookup.faceCentroids[f * 3];
		const cy = lookup.faceCentroids[f * 3 + 1];
		const cz = lookup.faceCentroids[f * 3 + 2];
		const d = px * cx + py * cy + pz * cz;
		if (d > bestDot) { bestDot = d; bestFace = f; }
	}

	const v0 = grid.faces[bestFace].v0;
	const v1 = grid.faces[bestFace].v1;
	const v2 = grid.faces[bestFace].v2;

	// Gnomonic-projected barycentric — see GLSL baryCoords for rationale.
	const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
	const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
	const nx = e1y * e2z - e1z * e2y;
	const ny = e1z * e2x - e1x * e2z;
	const nz = e1x * e2y - e1y * e2x;
	// Plane offset = dot(n, v0). t = plane_offset / dot(n, P).
	const planeD = nx * v0.x + ny * v0.y + nz * v0.z;
	const nDotP = nx * px + ny * py + nz * pz;
	const tParam = planeD / nDotP;
	const qx = px * tParam, qy = py * tParam, qz = pz * tParam;
	const invDen = 1 / (nx * nx + ny * ny + nz * nz);
	const dx = qx - v0.x, dy = qy - v0.y, dz = qz - v0.z;
	const cdex = dy * e2z - dz * e2y;
	const cdey = dz * e2x - dx * e2z;
	const cdez = dx * e2y - dy * e2x;
	const ce1dx = e1y * dz - e1z * dy;
	const ce1dy = e1z * dx - e1x * dz;
	const ce1dz = e1x * dy - e1y * dx;
	const l2 = (cdex * nx + cdey * ny + cdez * nz) * invDen;
	const l3 = (ce1dx * nx + ce1dy * ny + ce1dz * nz) * invDen;

	// Inverse of icosphere.ts barycentric → face-local 2D
	const SQRT3 = Math.sqrt(3);
	const cz2 = l3 * SQRT3 * 0.5;
	const cx2 = l2 - 0.5 * (1 - l3);

	// (cx, cz) → (i, j)
	const r = 0.5 / (resolution + 1);
	const diameter = 2 * r * 2 / SQRT3;
	const rowStep = diameter * 0.75;
	const i = Math.floor(cz2 / rowStep + 0.5);
	const oddOffset = (i & 1) ? r : 0;
	const j = Math.floor((cx2 - (-0.5) - oddOffset) / (2 * r) + 0.5);

	const gs = lookup.gridSize;
	if (i < 0 || j < 0 || i >= gs || j >= gs) return -1;
	return grid.faceGrid[bestFace * gs * gs + i * gs + j];
}

export function createHexIdLookup(grid: IcoGridWithFaces, scene: Scene): HexIdLookup {
	const gridSize = grid.resolution + 2;
	const width = 20 * gridSize;
	const height = gridSize;

	// Pack faceGrid (Int32, value in [-1, cellCount)) into RGBA8.
	// Layout: (faceIdx, i, j) → pixel (faceIdx*gridSize + j, i).
	// Channels: R = id & 0xFF, G = (id >> 8) & 0xFF, B = 0, A = 255.
	const data = new Uint8Array(width * height * 4);
	for (let f = 0; f < 20; f++) {
		for (let i = 0; i < gridSize; i++) {
			for (let j = 0; j < gridSize; j++) {
				const id = grid.faceGrid[f * gridSize * gridSize + i * gridSize + j];
				const px = (f * gridSize + j);
				const py = i;
				const idx = (py * width + px) * 4;
				const packed = id < 0 ? NO_HEX_SENTINEL : id;
				data[idx + 0] = packed & 0xFF;
				data[idx + 1] = (packed >> 8) & 0xFF;
				data[idx + 2] = 0;
				data[idx + 3] = 255;
			}
		}
	}

	const texture = RawTexture.CreateRGBATexture(
		data,
		width,
		height,
		scene,
		false,                                   // no mipmaps — IDs must be exact, no bilinear
		false,                                   // no flipY
		Constants.TEXTURE_NEAREST_SAMPLINGMODE,  // nearest-neighbor; IDs aren't interpolatable
		Engine.TEXTURETYPE_UNSIGNED_BYTE
	);
	texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
	texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
	texture.name = 'hexIdLookup';

	// ── Pentagon table ──
	// For each icosahedron vertex, find the pentagon cell whose center is
	// nearest. Pentagons are flagged with isPentagon=true in icosphere.ts.
	// Generally there are exactly 12 of them; if any are missing we fall back
	// to nearest-center over all cells (defensive — shouldn't trigger).
	const pentagonCells = grid.cells.filter(c => c.isPentagon);
	const pentagonVerts = new Float32Array(12 * 3);
	const pentagonIds = new Float32Array(12);
	for (let v = 0; v < 12; v++) {
		const iv = grid.icoVerts[v];
		pentagonVerts[v * 3] = iv.x;
		pentagonVerts[v * 3 + 1] = iv.y;
		pentagonVerts[v * 3 + 2] = iv.z;
		const pool = pentagonCells.length === 12 ? pentagonCells : grid.cells;
		let bestId = -1, bestD = Infinity;
		for (const c of pool) {
			const dx = c.center.x - iv.x;
			const dy = c.center.y - iv.y;
			const dz = c.center.z - iv.z;
			const d = dx * dx + dy * dy + dz * dz;
			if (d < bestD) { bestD = d; bestId = c.id; }
		}
		pentagonIds[v] = bestId;
	}

	// Pentagon angular radius ≈ half the hex spacing on the sphere.
	// Hex spacing = (icosahedron edge angle) / (resolution + 1). Edge angle for
	// the regular icosahedron = arccos(1/√5) ≈ 1.10715 rad.
	// Use 0.55 × half-spacing as the threshold so the early-exit fires only
	// well inside the pentagon — we'd rather fall through to the face lookup
	// at the boundary than misclassify a neighbor hex as the pentagon.
	const ICO_EDGE_ANGLE = Math.acos(1 / Math.sqrt(5));
	const hexSpacing = ICO_EDGE_ANGLE / (grid.resolution + 1);
	const pentagonThreshold = Math.cos(hexSpacing * 0.55);

	const faceVerts = new Float32Array(20 * 9);
	const faceCentroids = new Float32Array(20 * 3);
	for (let f = 0; f < 20; f++) {
		const fd = grid.faces[f];
		faceVerts[f * 9 + 0] = fd.v0.x; faceVerts[f * 9 + 1] = fd.v0.y; faceVerts[f * 9 + 2] = fd.v0.z;
		faceVerts[f * 9 + 3] = fd.v1.x; faceVerts[f * 9 + 4] = fd.v1.y; faceVerts[f * 9 + 5] = fd.v1.z;
		faceVerts[f * 9 + 6] = fd.v2.x; faceVerts[f * 9 + 7] = fd.v2.y; faceVerts[f * 9 + 8] = fd.v2.z;

		const cx = (fd.v0.x + fd.v1.x + fd.v2.x);
		const cy = (fd.v0.y + fd.v1.y + fd.v2.y);
		const cz = (fd.v0.z + fd.v1.z + fd.v2.z);
		const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		faceCentroids[f * 3 + 0] = cx / cl;
		faceCentroids[f * 3 + 1] = cy / cl;
		faceCentroids[f * 3 + 2] = cz / cl;
	}

	return {
		texture, faceVerts, faceCentroids, width, height, gridSize,
		pentagonVerts, pentagonIds, pentagonThreshold,
	};
}
