/**
 * Per-corner consensus height texture.
 *
 * For every canonical corner (Vector3 ref shared after canonicalize),
 * average the shader-sim's h across all cells touching that corner.
 * Pack into an R32F texture with the same layout as hexCornersTex —
 * 6 rows per cell, indexed by `(id % W, (id / W) * 6 + k)`.
 *
 * The shader fetches this at any vertex sitting exactly on one of its
 * cell's 6 corners and snaps h to the consensus value, eliminating
 * 3+-cell corner mismatches where each cell's per-cell tie-break picks
 * a different borderTarget.
 *
 * NaN slot = no consensus available (e.g., pad slot on a pentagon).
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from '../icosphere';
import { simulateShaderHeight } from './debug';

export interface CornerHeightsTexture {
	tex: RawTexture;
	width: number;
	height: number;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

export function buildCornerHeightsTexture(cells: HexCell[], scene: Scene): CornerHeightsTexture {
	const cellById = new Map<number, HexCell>();
	for (const c of cells) cellById.set(c.id, c);

	// Compute consensus h per canonical corner: for each corner ref,
	// sum of simulated h across all cells whose corners[] contains it,
	// divided by count.
	const sums = new Map<Vector3, { sum: number; count: number }>();
	for (const c of cells) {
		for (const corner of c.corners) {
			const sim = simulateShaderHeight(corner, c, cellById);
			let s = sums.get(corner);
			if (!s) { s = { sum: 0, count: 0 }; sums.set(corner, s); }
			s.sum += sim.h;
			s.count += 1;
		}
	}
	const consensus = new Map<Vector3, number>();
	for (const [corner, s] of sums) consensus.set(corner, s.sum / s.count);

	let maxId = 0;
	for (const c of cells) if (c.id > maxId) maxId = c.id;
	const idCount = maxId + 1;
	const W = nextPow2(Math.ceil(Math.sqrt(idCount)));
	const baseH = nextPow2(Math.ceil(idCount / W));
	const H = baseH * 6;

	// Use a 4-channel float texture to avoid driver issues with R32F on
	// some platforms; only the R channel carries data.
	const data = new Float32Array(W * H * 4);
	// Fill with NaN sentinel so the shader can detect "no consensus".
	for (let i = 0; i < data.length; i += 4) data[i] = Number.NaN;

	for (let id = 0; id <= maxId; id++) {
		const c = cellById.get(id);
		if (!c) continue;
		const xCol = id % W;
		const yRowBase = Math.floor(id / W) * 6;
		const edgeCount = c.corners.length;
		for (let k = 0; k < 6; k++) {
			const corner = c.corners[k] ?? c.corners[0];
			const h = consensus.get(corner);
			const px = (yRowBase + k) * W + xCol;
			data[px * 4 + 0] = (h !== undefined && k < edgeCount) ? h : Number.NaN;
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
	tex.name = 'gpuCornerHeights';
	return { tex, width: W, height: H };
}
