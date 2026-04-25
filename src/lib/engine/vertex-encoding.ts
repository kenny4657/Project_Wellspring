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
	const b = level * 0.1 + prox * 0.09;
	const nId = neighborTerrainId >= 0 ? neighborTerrainId : terrainIdx;
	const g = (nId + Math.min(blendFactor, 0.99)) / 10.0;
	return [r, g, b];
}
