/**
 * Phase 1 -- per-hex data textures.
 *
 * Three RGBA8 textures keyed by hexId. The fragment shader computes a hex
 * id via Phase 2's worldPosToHexId, then samples these textures to read
 * what's painted on that hex.
 *
 * Layout: pixelIndex = hexId, x = id % size, y = floor(id / size). The
 * texture side length is the next power of two above sqrt(cells.length),
 * so 1M hexes fit in a 1024x1024 texture. Each texture costs 4 bytes per
 * hex; the three together = 12 bytes per hex (12 MB at 1M -- trivial).
 *
 * Why three textures instead of one packed texture: terrain gets painted
 * one hex at a time, owner gets bulk-rewritten when borders shift, height
 * is mostly static. Separate textures means cheap partial updates without
 * re-uploading unrelated channels. We keep CPU-side mirrors of each
 * texture's bytes so single-hex edits don't require GPU readback.
 */

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { HexCell } from './icosphere';

export interface HexDataTextures {
	/** R = terrain id, GBA reserved for future expansion. */
	terrain: RawTexture;
	/** R = height level (0..4), G = cliff style (Phase 6 placeholder), BA reserved. */
	height: RawTexture;
	/** R = owner id (Phase X gameplay). */
	owner: RawTexture;
	/** Texture side length in pixels. */
	size: number;
	/** size * size. Maximum hexId we can address. */
	capacity: number;

	// CPU-side mirrors. Modified by updateHex/updateHeight/setOwner; the
	// modified mirror is re-uploaded to GPU. These let us avoid GPU readback
	// when toggling a single hex.
	_terrainData: Uint8Array;
	_heightData: Uint8Array;
	_ownerData: Uint8Array;
}

function nextPow2(n: number): number {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

/** Build the three textures, populated from current `cells[*].terrain` /
 *  `cells[*].heightLevel`. Owner is initialized to 0 (unowned). */
export function createHexDataTextures(cells: HexCell[], scene: Scene): HexDataTextures {
	const size = Math.max(64, nextPow2(Math.ceil(Math.sqrt(cells.length))));
	const capacity = size * size;

	// Sanity: every cell.id must be addressable. nextPow2(ceil(sqrt(N))) makes
	// capacity >= N for any N >= 1, but a future caller could pass cells with
	// non-contiguous IDs (id values >= N). Catch that at build time rather
	// than letting Uint8Array silently no-op the out-of-range write.
	for (let i = 0; i < cells.length; i++) {
		const id = cells[i].id;
		if (id < 0 || id >= capacity) {
			throw new Error(`hex-data-textures: cell.id ${id} exceeds texture capacity ${capacity}`);
		}
	}

	const terrainData = new Uint8Array(capacity * 4);
	const heightData = new Uint8Array(capacity * 4);
	const ownerData = new Uint8Array(capacity * 4);

	for (let i = 0; i < cells.length; i++) {
		const c = cells[i];
		const idx = c.id * 4;
		// All values are bytes; mask to 0..255 explicitly so a future overflow
		// (e.g., > 9 terrain types or > 4 height levels) corrupts visibly via
		// the wrong byte rather than via Uint8Array's silent truncation.
		if (c.terrain < 0 || c.terrain > 255 || c.heightLevel < 0 || c.heightLevel > 255) {
			throw new Error(`hex-data-textures: cell ${c.id} has out-of-range bytes terrain=${c.terrain} height=${c.heightLevel}`);
		}
		terrainData[idx] = c.terrain;
		heightData[idx] = c.heightLevel;
		// Cliff style: byte 0..255. Reserved for Phase 6 noise variation.
		// Default 0 means "use whatever the terrain default is."
		heightData[idx + 1] = 0;
		// Owner 0 = unowned.
		ownerData[idx] = 0;
	}

	const make = (data: Uint8Array, name: string) => {
		const tex = RawTexture.CreateRGBATexture(
			data, size, size, scene,
			false,                                    // no mipmaps -- IDs/levels must be exact
			false,                                    // no flipY
			Constants.TEXTURE_NEAREST_SAMPLINGMODE,   // nearest -- IDs aren't interpolatable
			Engine.TEXTURETYPE_UNSIGNED_BYTE,
		);
		tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
		tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
		tex.name = name;
		return tex;
	};

	return {
		terrain: make(terrainData, 'hexDataTerrain'),
		height: make(heightData, 'hexDataHeight'),
		owner: make(ownerData, 'hexDataOwner'),
		size,
		capacity,
		_terrainData: terrainData,
		_heightData: heightData,
		_ownerData: ownerData,
	};
}

/**
 * Update the per-hex terrain and height bytes for a single cell.
 *
 * Currently re-uploads the entire texture per call -- for 16k hexes that's
 * 64 KB per channel, fine for editor pace. Phase 7 should switch to
 * `engine.updateTextureData(box, ...)` for sub-rect updates if profiling
 * shows the upload is hot.
 */
export function updateHex(
	tex: HexDataTextures,
	hexId: number,
	terrain: number,
	height: number,
): void {
	if (hexId < 0 || hexId >= tex.capacity) return;
	if (terrain < 0 || terrain > 255 || height < 0 || height > 255) {
		throw new Error(`updateHex: out-of-range bytes terrain=${terrain} height=${height}`);
	}
	const idx = hexId * 4;
	tex._terrainData[idx] = terrain;
	tex._heightData[idx] = height;
	tex.terrain.update(tex._terrainData);
	tex.height.update(tex._heightData);
}

export function setOwner(tex: HexDataTextures, hexId: number, ownerId: number): void {
	if (hexId < 0 || hexId >= tex.capacity) return;
	tex._ownerData[hexId * 4] = ownerId;
	tex.owner.update(tex._ownerData);
}

/** Free GPU resources. */
export function disposeHexDataTextures(tex: HexDataTextures): void {
	tex.terrain.dispose();
	tex.height.dispose();
	tex.owner.dispose();
}
