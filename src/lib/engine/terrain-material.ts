/**
 * Terrain material — CustomMaterial with texture atlas, blend masks,
 * normal maps, and coast overlays. Adapted from threejs-hex-map (MIT).
 *
 * Babylon's full lighting pipeline works automatically via CustomMaterial.
 */
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_PROFILES, buildAtlasCellMap, buildHillMap } from '$lib/world/terrain-types';

const N = TERRAIN_PROFILES.length;

// Atlas layout: 4 columns x 3 rows, 256px cells in 1024x1024
const ATLAS_COLS = 4.0;
const ATLAS_ROWS = 3.0;

const HEX_SHAPE_GLSL = `
float hexDist(vec2 p) {
    vec2 ap = abs(p);
    return max(ap.x * 0.866025 + ap.y * 0.5, ap.y);
}
`;

export function createTerrainMaterial(scene: Scene, hexRadius: number): CustomMaterial {
	const mat = new CustomMaterial('terrainMat', scene);
	mat.diffuseColor = new Color3(1, 1, 1);
	mat.specularColor = new Color3(0.1, 0.1, 0.1);
	mat.backFaceCulling = false;

	// Load textures
	const terrainAtlas = new Texture('/assets/hex-terrain/terrain.png', scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
	const transitionTex = new Texture('/assets/hex-terrain/transitions.png', scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
	const hillsNormal = new Texture('/assets/hex-terrain/hills-normal.png', scene, false, true, Texture.BILINEAR_SAMPLINGMODE);
	const coastAtlas = new Texture('/assets/hex-terrain/coast-diffuse.png', scene, false, true, Texture.BILINEAR_SAMPLINGMODE);

	// Prevent texture wrapping artifacts
	terrainAtlas.wrapU = Texture.CLAMP_ADDRESSMODE;
	terrainAtlas.wrapV = Texture.CLAMP_ADDRESSMODE;

	// Add textures as uniforms
	mat.AddUniform('terrainAtlas', 'sampler2D', terrainAtlas);
	mat.AddUniform('transitionTex', 'sampler2D', transitionTex);
	mat.AddUniform('hillsNormal', 'sampler2D', hillsNormal);
	mat.AddUniform('coastAtlas', 'sampler2D', coastAtlas);

	mat.AddAttribute('terrainData0');
	mat.AddAttribute('terrainData1');

	const R = hexRadius.toFixed(1);

	// ── Vertex shader ──
	mat.Vertex_Definitions(`
		attribute vec4 terrainData0;
		attribute vec4 terrainData1;
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0, vN1, vN2, vN3, vN4, vN5;
		varying float vBorder;
		${HEX_SHAPE_GLSL}
	`);

	mat.Vertex_MainBegin(`
		vTerrainType = terrainData0.x;
		vN0 = terrainData0.y; vN1 = terrainData0.z; vN2 = terrainData0.w;
		vN3 = terrainData1.x; vN4 = terrainData1.y; vN5 = terrainData1.z;
	`);

	mat.Vertex_Before_PositionUpdated(`
		vHexUV = positionUpdated.xz / ${R};
		vBorder = hexDist(vHexUV);
	`);

	// ── Fragment shader ──
	mat.Fragment_Definitions(`
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0, vN1, vN2, vN3, vN4, vN5;
		varying float vBorder;
		${HEX_SHAPE_GLSL}
		${buildAtlasCellMap()}
		${buildHillMap()}

		// Convert atlas cell index to UV coordinates
		vec2 cellToUV(float cell, vec2 hexUv) {
			float col = mod(cell, ${ATLAS_COLS.toFixed(1)});
			float row = floor(cell / ${ATLAS_COLS.toFixed(1)});
			vec2 localUV = clamp(hexUv * 0.5 + 0.5, 0.02, 0.98);
			return vec2(
				(col + localUV.x) / ${ATLAS_COLS.toFixed(1)},
				1.0 - (row + 1.0 - localUV.y) / ${ATLAS_ROWS.toFixed(1)}
			);
		}

		float getNeighborType(int e) {
			if (e == 0) return vN0; if (e == 1) return vN1; if (e == 2) return vN2;
			if (e == 3) return vN3; if (e == 4) return vN4; return vN5;
		}

		// Blend with neighbor terrain using transition mask
		vec4 terrainTransition(vec4 inputColor, float neighborType, float sector, float myCell) {
			float neighborCell = getAtlasCell(int(neighborType + 0.5));
			if (neighborCell == myCell) return inputColor; // same texture, no blend needed

			vec2 neighborUV = cellToUV(neighborCell, vHexUV);
			vec4 neighborColor = texture2D(terrainAtlas, neighborUV);

			// Sample blend mask for this sector direction
			vec2 blendUV = vec2(sector / 6.0 + (vHexUV.x * 0.5 + 0.5) / 6.0,
			                    1.0 - (vHexUV.y * 0.5 + 0.5));
			vec4 blendMask = texture2D(transitionTex, blendUV);

			float alpha = blendMask.r * smoothstep(0.3, 0.7, length(vHexUV));
			return mix(inputColor, neighborColor, alpha);
		}
	`);

	// Clip to hex shape
	mat.Fragment_MainBegin(`
		float hd = hexDist(vHexUV);
		if (hd > 1.0) discard;
	`);

	// Override diffuse with textured terrain + transitions
	mat.Fragment_Custom_Diffuse(`
		int tIdx = int(vTerrainType + 0.5);
		float myCell = getAtlasCell(tIdx);
		vec2 atlasUV = cellToUV(myCell, vHexUV);
		vec4 texColor = texture2D(terrainAtlas, atlasUV);

		// Blend with all 6 neighbors
		texColor = terrainTransition(texColor, vN0, 0.0, myCell);
		texColor = terrainTransition(texColor, vN1, 1.0, myCell);
		texColor = terrainTransition(texColor, vN2, 2.0, myCell);
		texColor = terrainTransition(texColor, vN3, 3.0, myCell);
		texColor = terrainTransition(texColor, vN4, 4.0, myCell);
		texColor = terrainTransition(texColor, vN5, 5.0, myCell);

		// Hills normal map
		float isHill = getIsHill(tIdx);
		if (isHill > 0.5) {
			vec3 hillNorm = normalize(texture2D(hillsNormal, vHexUV * 0.5 + 0.5).xyz * 2.0 - 1.0);
			// Fade normal map at edges
			float fade = vBorder * vBorder * vBorder;
			hillNorm = mix(hillNorm, vec3(0.0, 0.0, 1.0), fade);
			// Modulate lighting via normal
			float hillShade = max(dot(hillNorm, vec3(0.3, 0.3, 0.7)), 0.0);
			texColor.rgb *= 0.7 + 0.3 * hillShade;
		}

		// Subtle hex edge line
		float edgeDark = smoothstep(0.90, 0.98, hd) * 0.15;
		texColor.rgb *= (1.0 - edgeDark);

		diffuseColor = texColor.rgb;
	`);

	return mat;
}
