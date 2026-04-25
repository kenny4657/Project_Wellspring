/**
 * Phase 3 -- shader-driven globe material.
 *
 * Per the transition plan: "Initial fragment shader = single flat color.
 * Initial vertex shader = no displacement." This is the foundation Phase 4
 * will build on (port terrain shading), Phase 5 (vertex displacement),
 * Phase 6 (cliff noise). Right now it does the bare minimum needed to
 * confirm the new mesh + render-mode plumbing works end-to-end.
 *
 * The material binds Phase 1's three data textures and the Phase 2 hex
 * lookup uniforms even though the fragment shader doesn't read them yet.
 * This avoids a re-wire when Phase 4 lands; the shader can start sampling
 * `terrainTex` without the material's binding list changing.
 */

import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import type { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { HexIdLookup } from './hex-id-lookup';
import type { HexDataTextures } from './hex-data-textures';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;
attribute vec3 normal;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vSpherePos;

void main() {
    vec4 wp = world * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
    // vSpherePos is the unit-sphere projection of the vertex -- ready for
    // Phase 4 to feed into worldPosToHexId.
    vSpherePos = normalize(wp.xyz);
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 flatColor;
uniform vec3 sunDir;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vSpherePos;

void main() {
    // Cheap directional shading just so the sphere reads as a sphere
    // (without it Phase 3 looks like a flat disk and we can't tell the
    // mesh is right). Pure flat color comes back once Phase 4 takes over.
    float ambient = 0.55;
    float diffuse = max(0.0, dot(normalize(vWorldNormal), sunDir)) * 0.45;
    gl_FragColor = vec4(flatColor * (ambient + diffuse), 1.0);
}
`;

export interface ShaderGlobeMaterialOptions {
	hexLookup: HexIdLookup;
	hexData: HexDataTextures;
	planetRadiusKm: number;
}

export function createShaderGlobeMaterial(scene: Scene, opts: ShaderGlobeMaterialOptions): ShaderMaterial {
	ShaderStore.ShadersStore['shaderGlobeVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['shaderGlobeFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('shaderGlobe', scene, {
		vertex: 'shaderGlobe',
		fragment: 'shaderGlobe',
	}, {
		// Attribute / uniform / sampler list is forward-compatible with Phase 4:
		// Phase 4 will start reading terrainTex / heightTex / faceVerts etc.
		// without the material's binding list changing.
		attributes: ['position', 'normal'],
		uniforms: [
			'world', 'viewProjection',
			'flatColor', 'sunDir',
			'planetRadius',
			'gridSize', 'resolution',
			'faceCentroid', 'faceVertA', 'faceVertB', 'faceVertC',
			'pentagonVert', 'pentagonId', 'pentagonThreshold',
		],
		samplers: ['hexLookup', 'terrainTex', 'heightTex', 'ownerTex'],
		needAlphaBlending: false,
	});

	// Phase 3 deliverable: "uniform-colored sphere at correct position and
	// size." Pick a tone that's clearly distinct from the legacy biomes so
	// it's obvious which mode is rendering.
	mat.setVector3('flatColor', new Vector3(0.45, 0.55, 0.70));
	mat.setVector3('sunDir', new Vector3(-1, 0.5, 0.3).normalize()); // overwritten per frame
	mat.setFloat('planetRadius', opts.planetRadiusKm);

	// Pre-bind Phase 1 / Phase 2 data so Phase 4 can start sampling without
	// editing globe.ts again.
	mat.setTexture('hexLookup', opts.hexLookup.texture);
	mat.setTexture('terrainTex', opts.hexData.terrain);
	mat.setTexture('heightTex', opts.hexData.height);
	mat.setTexture('ownerTex', opts.hexData.owner);
	mat.setFloat('gridSize', opts.hexLookup.gridSize);
	mat.setFloat('resolution', opts.hexLookup.gridSize - 2);
	mat.setArray3('faceCentroid', Array.from(opts.hexLookup.faceCentroids));

	const vA = new Float32Array(20 * 3), vB = new Float32Array(20 * 3), vC = new Float32Array(20 * 3);
	for (let f = 0; f < 20; f++) {
		vA[f * 3] = opts.hexLookup.faceVerts[f * 9 + 0]; vA[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 1]; vA[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 2];
		vB[f * 3] = opts.hexLookup.faceVerts[f * 9 + 3]; vB[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 4]; vB[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 5];
		vC[f * 3] = opts.hexLookup.faceVerts[f * 9 + 6]; vC[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 7]; vC[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 8];
	}
	mat.setArray3('faceVertA', Array.from(vA));
	mat.setArray3('faceVertB', Array.from(vB));
	mat.setArray3('faceVertC', Array.from(vC));
	mat.setArray3('pentagonVert', Array.from(opts.hexLookup.pentagonVerts));
	mat.setFloats('pentagonId', Array.from(opts.hexLookup.pentagonIds));
	mat.setFloat('pentagonThreshold', opts.hexLookup.pentagonThreshold);

	mat.backFaceCulling = true;
	return mat;
}
