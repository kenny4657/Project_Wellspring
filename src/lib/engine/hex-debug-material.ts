/**
 * Hex debug material — colors each vertex by a hash of its hexId attribute.
 *
 * Adjacent hexes get visibly distinct colors so we can see where one hex
 * ends and the next begins. Walls (vColor.a < 0.05) are rendered in
 * neutral gray so they don't drown out the hex top colors.
 *
 * Used by toggling `engine.setDebugMode(true)` from the dev console.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import type { Scene } from '@babylonjs/core/scene';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
attribute vec3 hexDebugColor;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vColor;
varying vec3 vDebugColor;

void main() {
    vec4 wp = world * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
    vColor = color;
    vDebugColor = hexDebugColor;
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vColor;
varying vec3 vDebugColor;

void main() {
    bool isWall = vColor.a < 0.05;
    vec3 baseColor = isWall ? vec3(0.4, 0.4, 0.4) : vDebugColor;

    // Simple Lambert shading so 3D form is still readable.
    vec3 sunDir = normalize(vec3(-1.0, 0.5, 0.3));
    float light = 0.5 + 0.5 * max(0.0, dot(normalize(vWorldNormal), sunDir));
    gl_FragColor = vec4(baseColor * light, 1.0);
}
`;

export function createHexDebugMaterial(scene: Scene): ShaderMaterial {
	ShaderStore.ShadersStore['hexDebugVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['hexDebugFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('hexDebugMat', scene, {
		vertex: 'hexDebug',
		fragment: 'hexDebug',
	}, {
		attributes: ['position', 'normal', 'color', 'hexDebugColor'],
		uniforms: ['world', 'viewProjection'],
		needAlphaBlending: false,
	});

	mat.backFaceCulling = true;
	return mat;
}
