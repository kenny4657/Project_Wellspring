/**
 * Per-hex corner-position texture.
 *
 * Stores up to 6 corner unit-direction positions per hex. Layout:
 * texture has the same `width` as `hexDataTex` and `6 × hexDataHeight`
 * rows. Corner `k` of hex `id` lives at:
 *
 *   ivec2 coord = ivec2(id % W, (id / W) * 6 + k);
 *   vec3 corner = texelFetch(hexCornersTex, coord, 0).rgb;
 *
 * Pentagons (5 corners): the unused 6th slot is set to corner[0],
 * so a fixed-size shader loop with `edgeCount` early-out walks
 * exactly 5 unique edges without branching on a special case.
 */
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';

export interface HexCornersTexture {
	tex: RawTexture;
	width: number;
	height: number;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

export function buildHexCornersTexture(cells: HexCell[], scene: Scene): HexCornersTexture {
	const numHexes = cells.length;
	let maxId = 0;
	for (const c of cells) if (c.id > maxId) maxId = c.id;
	const idCount = maxId + 1;

	const W = nextPow2(Math.ceil(Math.sqrt(idCount)));
	const baseH = nextPow2(Math.ceil(idCount / W));
	const H = baseH * 6;

	const data = new Float32Array(W * H * 4);

	const cellByIdMap = new Map<number, HexCell>();
	for (const c of cells) cellByIdMap.set(c.id, c);

	for (let id = 0; id <= maxId; id++) {
		const c = cellByIdMap.get(id);
		if (!c) continue;
		const corners = c.corners;
		const xCol = id % W;
		const yRowBase = Math.floor(id / W) * 6;
		for (let k = 0; k < 6; k++) {
			const corner = corners[k] ?? corners[0]; // pad pentagons to 6 slots
			const px = (yRowBase + k) * W + xCol;
			data[px * 4 + 0] = corner.x;
			data[px * 4 + 1] = corner.y;
			data[px * 4 + 2] = corner.z;
			data[px * 4 + 3] = 0;
		}
	}

	const tex = new RawTexture(
		data, W, H,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_FLOAT,
	);
	tex.name = 'gpuHexCorners';

	return { tex, width: W, height: H };
}
