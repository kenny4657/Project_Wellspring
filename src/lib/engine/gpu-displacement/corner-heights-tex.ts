/**
 * Per-canonical-corner displaced-height texture.
 *
 * After canonicalizeCells merges shared corners to a single Vector3 ref
 * across cells, build a global cornerId index (Vector3 → cornerId) and
 * bake one h value per corner: the average of `simulateShaderHeight`
 * (the shader mirror) across every cell that references that corner.
 *
 * The vertex shader samples this texture for any vertex marked with
 * cornerId >= 0 and short-circuits the full border-walk path. Because
 * every cell at a canonical corner gets the SAME h, the mesh closes at
 * corners by construction.
 *
 * Why simulate-shader (not CPU's computeHeightWithCliffErosion):
 * the GPU shader's per-corner natural value is what we'd see WITHOUT
 * snap; snapping to a CPU-derived value would create a visible
 * CPU/GPU-bias bump at every corner. The shader mirror produces values
 * the actual shader would also produce (same algorithm), so snap is
 * smooth into the surrounding non-corner geometry.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import { computeShaderCornerCanonicalHeights } from './debug';

export interface CornerHeightsTexture {
	tex: RawTexture;
	width: number;
	height: number;
	idByRef: Map<Vector3, number>;
}

export function buildCornerHeightsTexture(
	cells: HexCell[],
	scene: Scene,
): CornerHeightsTexture {
	const idByRef = new Map<Vector3, number>();
	const refs: Vector3[] = [];
	for (const c of cells) {
		for (const corner of c.corners) {
			if (!idByRef.has(corner)) {
				idByRef.set(corner, refs.length);
				refs.push(corner);
			}
		}
	}

	const heightByRef = computeShaderCornerCanonicalHeights(cells);

	const N = refs.length;
	const W = 256;
	const H = Math.max(1, Math.ceil(N / W));
	const data = new Float32Array(W * H * 4);
	for (let i = 0; i < N; i++) {
		const h = heightByRef.get(refs[i]) ?? 0;
		data[i * 4 + 0] = h;
	}

	const tex = new RawTexture(
		data, W, H,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false, false,
		Constants.TEXTURE_NEAREST_NEAREST,
		Constants.TEXTURETYPE_FLOAT,
	);
	tex.name = 'gpuCornerHeights';

	return { tex, width: W, height: H, idByRef };
}
