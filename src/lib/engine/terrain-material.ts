/**
 * Terrain material — CustomMaterial with texture atlas, blend masks,
 * normal maps, and coast overlays. Adapted from threejs-hex-map (MIT).
 */
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_PROFILES, buildAtlasCellMap, buildHillMap } from '$lib/world/terrain-types';

const N = TERRAIN_PROFILES.length;

// Atlas: 4 cols x 3 rows of 256px cells in 1024x1024
const COLS = '4.0';
const ROWS = '3.0';

export function createTerrainMaterial(scene: Scene, _hexRadius: number): CustomMaterial {
	const mat = new CustomMaterial('terrainMat', scene);
	mat.diffuseColor = new Color3(1, 1, 1);
	mat.specularColor = new Color3(0.15, 0.15, 0.15);
	mat.backFaceCulling = false;

	// Textures
	const terrainAtlas = new Texture('/assets/hex-terrain/terrain.png', scene);
	const transitionTex = new Texture('/assets/hex-terrain/transitions.png', scene);
	const hillsNormal = new Texture('/assets/hex-terrain/hills-normal.png', scene);
	const coastAtlas = new Texture('/assets/hex-terrain/coast-diffuse.png', scene);

	terrainAtlas.wrapU = terrainAtlas.wrapV = Texture.CLAMP_ADDRESSMODE;
	transitionTex.wrapU = transitionTex.wrapV = Texture.CLAMP_ADDRESSMODE;

	mat.AddUniform('terrainAtlas', 'sampler2D', terrainAtlas);
	mat.AddUniform('transitionTex', 'sampler2D', transitionTex);
	mat.AddUniform('hillsNormal', 'sampler2D', hillsNormal);
	mat.AddUniform('coastAtlas', 'sampler2D', coastAtlas);

	mat.AddAttribute('terrainData0');
	mat.AddAttribute('terrainData1');
	mat.AddAttribute('border');

	// ── Vertex ──
	mat.Vertex_Definitions(`
		attribute vec4 terrainData0;
		attribute vec4 terrainData1;
		attribute float border;
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0, vN1, vN2, vN3, vN4, vN5;
		varying float vBorder;
	`);

	mat.Vertex_MainBegin(`
		vTerrainType = terrainData0.x;
		vN0 = terrainData0.y; vN1 = terrainData0.z; vN2 = terrainData0.w;
		vN3 = terrainData1.x; vN4 = terrainData1.y; vN5 = terrainData1.z;
	`);

	// Compute hex UVs from position — the hex mesh is on XZ plane, radius maps to 0-1
	mat.Vertex_Before_PositionUpdated(`
		float hexR = ${_hexRadius.toFixed(1)};
		vHexUV = vec2(
			0.02 + 0.96 * ((positionUpdated.x + hexR) / (hexR * 2.0)),
			0.02 + 0.96 * ((positionUpdated.z + hexR) / (hexR * 2.0))
		);
		vBorder = border;
	`);

	// ── Fragment ──
	mat.Fragment_Definitions(`
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0, vN1, vN2, vN3, vN4, vN5;
		varying float vBorder;
		${buildAtlasCellMap()}
		${buildHillMap()}

		// Convert atlas cell index to UV within the atlas texture
		vec2 cellToUV(float cell) {
			float col = mod(cell, ${COLS});
			float row = floor(cell / ${COLS});
			return vec2(
				col / ${COLS} + vHexUV.x / ${COLS},
				1.0 - (row / ${ROWS} + (1.0 - vHexUV.y) / ${ROWS})
			);
		}

		float getNeighborType(int e) {
			if (e == 0) return vN0; if (e == 1) return vN1; if (e == 2) return vN2;
			if (e == 3) return vN3; if (e == 4) return vN4; return vN5;
		}

		// Blend with neighbor terrain using transition mask
		vec4 terrainTransition(vec4 inputColor, float neighborType, float sector, float myTerrain) {
			float neighborCell = getAtlasCell(int(neighborType + 0.5));
			float myCell = getAtlasCell(int(myTerrain + 0.5));

			// Skip if same texture cell
			if (abs(neighborCell - myCell) < 0.5) return inputColor;

			vec2 otherUV = cellToUV(neighborCell);
			vec4 otherColor = texture2D(terrainAtlas, otherUV);

			// Blend mask for this sector direction
			// The transition texture has 6 directional masks side by side
			vec2 blendUV = vec2(
				sector / 6.0 + vHexUV.x / 6.0,
				vHexUV.y
			);
			vec4 blend = texture2D(transitionTex, blendUV);

			float alpha = blend.r * 0.6;
			return mix(inputColor, otherColor, alpha);
		}
	`);

	// Override diffuse with textured terrain
	mat.Fragment_Custom_Diffuse(`
		int tIdx = int(vTerrainType + 0.5);
		float myCell = getAtlasCell(tIdx);
		vec2 atlasUV = cellToUV(myCell);
		vec4 texColor = texture2D(terrainAtlas, atlasUV);

		// Blend with 6 neighbors using transition masks
		texColor = terrainTransition(texColor, vN0, 0.0, vTerrainType);
		texColor = terrainTransition(texColor, vN1, 1.0, vTerrainType);
		texColor = terrainTransition(texColor, vN2, 2.0, vTerrainType);
		texColor = terrainTransition(texColor, vN3, 3.0, vTerrainType);
		texColor = terrainTransition(texColor, vN4, 4.0, vTerrainType);
		texColor = terrainTransition(texColor, vN5, 5.0, vTerrainType);

		// Hills: apply normal map for surface bumps
		float isHill = getIsHill(tIdx);
		if (isHill > 0.5 && vBorder < 0.75) {
			vec3 hillNorm = normalize(texture2D(hillsNormal, vHexUV).xyz * 2.0 - 1.0);
			// Fade normal at hex edges
			hillNorm = mix(hillNorm, vec3(0.0, 0.0, 1.0), vBorder * vBorder * vBorder);
			float hillShade = max(dot(hillNorm, vec3(0.3, 0.3, 0.7)), 0.0);
			texColor.rgb *= 0.7 + 0.3 * hillShade;
		}

		// Coast overlay
		// TODO: compute coast bitmask from neighbor water status

		// Grid line at hex border
		if (vBorder > 0.5) {
			texColor.rgb *= 0.85;
		}

		diffuseColor = texColor.rgb;
	`);

	return mat;
}
