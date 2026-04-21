/**
 * Ocean surface ShaderMaterial — depth-tested water sphere.
 *
 * Renders a water sphere at sea level. Samples the scene depth texture
 * to discard fragments where terrain is closer to the camera, so land
 * naturally occludes water with zero z-fighting.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
uniform float waveAmp;
uniform float waveFreq;
uniform float cameraNear;
uniform float cameraFar;

attribute vec3 position;
attribute vec3 normal;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;
varying vec4 vScreenPos;
varying float vLinearDepth;

// Simple noise for wave displacement
vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 perm(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }

float noise3d(vec3 p) {
    vec3 a = floor(p);
    vec3 d = p - a;
    d = d * d * (3.0 - 2.0 * d);
    vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
    vec4 k1 = perm(b.xyxy);
    vec4 k2 = perm(k1.xyxy + b.zzww);
    vec4 c = k2 + a.zzzz;
    vec4 k3 = perm(c);
    vec4 k4 = perm(c + 1.0);
    vec4 o1 = fract(k3 * (1.0 / 41.0));
    vec4 o2 = fract(k4 * (1.0 / 41.0));
    vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
    vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
    return o4.y * d.y + o4.x * (1.0 - d.y);
}

void main() {
    vec3 pos = position;
    vec3 n = normalize(position);

    // Two scrolling noise octaves for wave displacement
    float wave1 = noise3d(n * waveFreq + time * 0.4) - 0.5;
    float wave2 = noise3d(n * waveFreq * 2.1 + time * 0.7 + 50.0) - 0.5;
    float wave = (wave1 * 0.7 + wave2 * 0.3) * waveAmp;

    // Only push waves downward — never above base sphere to avoid clipping land
    wave = min(wave, 0.0);
    pos += n * wave;

    vec4 wp = world * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
    vLocalPos = pos;

    vec4 clip = viewProjection * wp;
    vScreenPos = clip;
    // Match Babylon depth renderer linear formula:
    // depthValues = (minZ, minZ + maxZ)
    // vDepthMetric = (gl_Position.z + depthValues.x) / depthValues.y
    vLinearDepth = (clip.z + cameraNear) / (cameraNear + cameraFar);
    gl_Position = clip;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 sunDir;
uniform vec3 cameraPos;
uniform float time;
uniform vec3 deepColor;
uniform vec3 shallowColor;
uniform float cameraNear;
uniform float cameraFar;
uniform sampler2D depthSampler;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;
varying vec4 vScreenPos;
varying float vLinearDepth;

void main() {
    // Sample scene depth texture at this fragment's screen position
    vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
    float sceneDepth = texture2D(depthSampler, screenUV).r;

    // If terrain is at or near water depth, terrain wins.
    // Small bias handles floating point precision at boundaries.
    if (sceneDepth < vLinearDepth + 0.00015) {
        discard;
    }

    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPos - vWorldPos);

    // Depth difference for shore foam
    float depthDiff = max(sceneDepth - vLinearDepth, 0.0);

    // Fresnel — more transparent looking straight down, opaque at grazing angles
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    fresnel = pow(fresnel, 2.5);

    // Color blend: deeper at center, lighter at rim
    vec3 waterCol = mix(deepColor, shallowColor, fresnel * 0.6 + 0.2);

    // Subtle animated color variation
    vec3 nDir = normalize(vLocalPos);
    float shimmer = sin(nDir.x * 30.0 + time * 1.2) * sin(nDir.z * 30.0 + time * 0.8) * 0.03;
    waterCol += shimmer;

    // Shore foam where water meets terrain
    float foamEdge = smoothstep(0.0, 0.003, depthDiff);
    waterCol = mix(vec3(0.75, 0.82, 0.85), waterCol, foamEdge);

    // Lighting
    float ambient = 0.55;
    float diffuse = max(dot(N, sunDir), 0.0) * 0.4;
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float cam = max(0.0, dot(N, toCamera)) * 0.15;
    float light = ambient + diffuse + cam;
    waterCol *= light;

    // Specular sun reflection
    vec3 halfVec = normalize(sunDir + V);
    float spec = pow(max(dot(N, halfVec), 0.0), 96.0);
    waterCol += vec3(1.0, 0.98, 0.92) * spec * 0.5;

    // Secondary broader specular for softer highlight
    float spec2 = pow(max(dot(N, halfVec), 0.0), 16.0);
    waterCol += vec3(0.7, 0.85, 1.0) * spec2 * 0.08;

    float alpha = 0.85 + fresnel * 0.15;

    gl_FragColor = vec4(waterCol, alpha);
}
`;

export function createWaterMaterial(scene: Scene, depthTexture: BaseTexture): ShaderMaterial {
	ShaderStore.ShadersStore['waterSurfaceVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['waterSurfaceFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('waterMat', scene, {
		vertex: 'waterSurface',
		fragment: 'waterSurface',
	}, {
		attributes: ['position', 'normal'],
		uniforms: [
			'world', 'viewProjection',
			'sunDir', 'cameraPos', 'time',
			'deepColor', 'shallowColor',
			'cameraNear', 'cameraFar',
			'waveAmp', 'waveFreq'
		],
		samplers: ['depthSampler'],
		needAlphaBlending: true,
	});

	mat.setVector3('sunDir', new Vector3(1, -0.5, -0.3).normalize());
	mat.setVector3('cameraPos', Vector3.Zero());
	mat.setFloat('time', 0);

	// Ocean colors
	mat.setVector3('deepColor', new Vector3(0.08, 0.18, 0.35));
	mat.setVector3('shallowColor', new Vector3(0.15, 0.35, 0.55));

	// Waves
	mat.setFloat('waveAmp', 1.5);
	mat.setFloat('waveFreq', 12.0);

	// Camera
	mat.setFloat('cameraNear', 1);
	mat.setFloat('cameraFar', 1);

	// Depth texture from scene depth renderer
	mat.setTexture('depthSampler', depthTexture);

	mat.backFaceCulling = true;

	return mat;
}
