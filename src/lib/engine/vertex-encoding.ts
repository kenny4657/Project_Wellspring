/**
 * Vertex color channel packing for the globe mesh.
 *
 * The terrain shader (`terrain-material.ts`) decodes a packed COLOR vertex
 * attribute to look up biome / height / cliff parameters. This module owns
 * the encoding side; the shader owns the decoding side. Any change to the
 * packing here MUST be mirrored in `terrain-material.ts` (and vice versa).
 *
 * Channel layout for top-face vertices (alpha > 0.5):
 *   R — terrain index, encoded as `terrainIdx / 9.0`.
 *       Shader: `int(round(R * 9.0))`.
 *   G — neighbor terrain id + blend factor, encoded as
 *       `(neighborTerrainId + blendFactor) / 10.0` (blendFactor < 1).
 *       Shader: `neighborId = int(floor(G * 10))`,
 *               `blend     = fract(G * 10)`.
 *   B — height level (0-4) AND cliff proximity (0-1) packed together as
 *       `B = heightLevel * 0.1 + cliffProximity * 0.09`.
 *       Cliff proximity max contribution is 0.09 so the integer step at
 *       0.1 is preserved for `floor()` decoding.
 *       Shader (terrain-material.ts lines 245-250):
 *           int   heightLevel    = int(floor(rawB + 0.001));
 *           float cliffProximity = fract(rawB + 0.001) / 0.9;
 *   A — coast proximity for top faces, or 0.0 for wall vertices.
 *       Walls: alpha == 0 (used as a wall/top discriminator everywhere
 *       in this codebase — see the alpha < 0.05 checks in mesh-smoothing).
 *
 * Wall vertices use the raw terrain RGB color from `TERRAIN_PROFILES`
 * (returned by `getTerrainColor`) with alpha 0.0.
 *
 * !!! CONTRACT WARNING !!!
 * If you change the B-channel formula here, also update the decode at
 * `src/lib/engine/terrain-material.ts` lines 245-250. Both ends must agree
 * or every cliff and water hex will render at the wrong height tier.
 */
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';
import type { HexCell } from './icosphere';
import type { HexBorderInfo } from './hex-borders';
import { findNeighborAcrossEdge } from './hex-borders';
import { distToSegment, distToCoast, distToGentleLandEdge } from './hex-distance-fields';

// ── Shared B-channel packing constants ──────────────────────
// These three constants are the single source of truth for the B-channel
// pack/unpack formula. They are imported by `terrain-material.ts` and
// interpolated into the GLSL string at shader-build time so the encode and
// decode literally share the same numeric values. Change one, both update.

/** Per-tier multiplier on the B channel. B = heightLevel * HEIGHT_LEVEL_SCALE + cliffProx * CLIFF_PROX_SCALE.
 *  Used by both TS encoder and GLSL decoder — change one, both update. */
export const HEIGHT_LEVEL_SCALE = 0.1;

/** Cliff proximity contribution to B. Must stay strictly < HEIGHT_LEVEL_SCALE
 *  so the integer step at 0.1 survives floor() decoding.
 *  Used by both TS encoder and GLSL decoder — change one, both update. */
export const CLIFF_PROX_SCALE = 0.09;

/** Decode multiplier: shader does `rawB = vColor.b * B_CHANNEL_DECODE_MUL`.
 *  Must equal 1 / HEIGHT_LEVEL_SCALE.
 *  Used by both TS encoder and GLSL decoder — change one, both update. */
export const B_CHANNEL_DECODE_MUL = 10.0;

/** Wall vertex color: terrain profile RGB (used by textureWall for blue-detection). */
export function getTerrainColor(idx: number): [number, number, number] {
	return TERRAIN_PROFILES[idx]?.color ?? [0.5, 0.5, 0.5];
}

/** Top-face vertex color: R = terrainId/9, G = packed blend data, B = encoded tier height.
 *  G encodes: (neighborTerrainId + blendFactor) / 10.0
 *  Shader decodes: neighborId = int(floor(G*10)), blend = fract(G*10) */
/**
 * B channel packs heightLevel (0-4) and cliff proximity (0-1):
 *   B = heightLevel * 0.1 + cliffProximity * 0.09
 * Shader decodes: level = floor(B * 10), proximity = fract(B * 10) / 0.9
 */
export function getTopFaceColor(terrainIdx: number, heightLevel: number, neighborTerrainId: number, blendFactor: number, cliffProximity: number = 0): [number, number, number] {
	const r = terrainIdx / 9.0;
	const level = Math.min(heightLevel, 4);
	const prox = Math.max(0, Math.min(cliffProximity, 1.0));
	const b = level * HEIGHT_LEVEL_SCALE + prox * CLIFF_PROX_SCALE;
	const nId = neighborTerrainId >= 0 ? neighborTerrainId : terrainIdx;
	const g = (nId + Math.min(blendFactor, 0.99)) / 10.0;
	return [r, g, b];
}

/**
 * Compute the full RGBA top-face vertex color for a single vertex.
 *
 * Encapsulates the per-vertex logic shared between `buildGlobeMesh` (initial
 * mesh build) and `updateCellTerrain` (paint-time recolor):
 *   - cliffProximity from the nearest steep-cliff edge (with gentle-land fade)
 *   - cliff-neighbor terrain swap into the G channel for water hexes
 *   - alpha from coast proximity
 *   - RGB packing via `getTopFaceColor`
 *
 * Caller computes `chosenNeighborTerrainId` and `crossBlendFactor` per-triangle
 * (so all 3 verts of a triangle agree on the neighborId — see comments in
 * `buildGlobeMesh` about GPU interpolation artifacts).
 */
export function encodeTopVertexColor(
	cell: HexCell,
	vx: number,
	vy: number,
	vz: number,
	borderInfo: HexBorderInfo,
	cellById: Map<number, HexCell>,
	hexRadius: number,
	chosenNeighborTerrainId: number,
	crossBlendFactor: number,
): [number, number, number, number] {
	const n = cell.corners.length;
	const isWaterHex = cell.heightLevel <= 1;

	// Per-vertex cliff proximity + cliff neighbor terrain for water hexes
	let cliffProx = 0;
	let cliffNbTerrain = -1;
	if (borderInfo.hasSteepCliff) {
		let minCliffDist = Infinity;
		for (let ei = 0; ei < n; ei++) {
			if (!borderInfo.steepCliffEdges[ei]) continue;
			const ea = cell.corners[ei];
			const eb = cell.corners[(ei + 1) % n];
			const d = distToSegment(vx, vy, vz, ea.x, ea.y, ea.z, eb.x, eb.y, eb.z);
			if (d < minCliffDist) {
				minCliffDist = d;
				if (isWaterHex) {
					const cliffNb = findNeighborAcrossEdge(cell, ei, cellById);
					if (cliffNb) cliffNbTerrain = cliffNb.terrain;
				}
			}
		}
		if (Number.isFinite(minCliffDist)) {
			cliffProx = Math.max(0, 1.0 - minCliffDist / (hexRadius * 0.3));
		}
		// In mixed hexes (both steep + gentle edges), suppress
		// cliff proximity near gentle edges so the shader doesn't
		// draw cliff texture on the gentle-slope faces. Clamped to
		// a minimum of 0.5 so flat hexes adjacent to cliffs (e.g. a
		// beach hex bordering a cliff hex) keep enough cliffProx for
		// the beach overlay to blend toward rock at the shared edge.
		// Cliff TEXTURE rendering is gated separately by steepness >
		// 0.003 in the shader, so flat slopes still won't get rock
		// texture even with elevated cliffProx.
		if (cliffProx > 0 && borderInfo.hasGentleLandEdge) {
			const gd = distToGentleLandEdge(vx, vy, vz, cell, borderInfo);
			const gt = Math.min(gd / (hexRadius * 0.35), 1.0);
			const gentleFade = gt * gt * (3 - 2 * gt);
			cliffProx *= Math.max(0.5, gentleFade);
		}
	}

	// Coast proximity in alpha
	let alpha = 1.0;
	if (borderInfo.hasCoast) {
		const cd = distToCoast(vx, vy, vz, cell, borderInfo);
		alpha = 0.5 + 0.5 * Math.min(cd / hexRadius, 1.0);
	}

	// For water hexes with cliff proximity, encode cliff neighbor's terrain
	// in G channel so shader uses correct cliff palette
	const effectiveNId = (isWaterHex && cliffProx > 0 && cliffNbTerrain >= 0) ? cliffNbTerrain : chosenNeighborTerrainId;
	const effectiveBF = (isWaterHex && cliffProx > 0 && cliffNbTerrain >= 0) ? 0.01 : crossBlendFactor;
	const topColor = getTopFaceColor(cell.terrain, cell.heightLevel, effectiveNId, effectiveBF, cliffProx);
	return [topColor[0], topColor[1], topColor[2], alpha];
}
