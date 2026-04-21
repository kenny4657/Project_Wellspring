/**
 * Ocean surface ShaderMaterial — semi-transparent animated water sphere.
 *
 * Lightweight stylized water inspired by the Babylon.js Ocean Node Material.
 * Applied to an icosphere at sea level radius. Features:
 *   - Animated wave vertex displacement (two scrolling noise octaves)
 *   - Fresnel transparency (see-through from above, opaque at edges)
 *   - Depth-like color (darker toward center, lighter at rim)
 *   - Specular sun highlight
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;
uniform float time;
uniform float waveAmp;
uniform float waveFreq;

attribute vec3 position;
attribute vec3 normal;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;

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

    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 sunDir;
uniform vec3 cameraPos;
uniform float time;
uniform vec3 deepColor;
uniform vec3 shallowColor;
uniform float opacity;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalPos;

void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPos - vWorldPos);

    // Fresnel — more transparent looking straight down, opaque at grazing angles
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    fresnel = pow(fresnel, 2.5);

    // Color blend: deeper at center, lighter at rim
    vec3 waterCol = mix(deepColor, shallowColor, fresnel * 0.6 + 0.2);

    // Subtle animated color variation
    vec3 nDir = normalize(vLocalPos);
    float shimmer = sin(nDir.x * 30.0 + time * 1.2) * sin(nDir.z * 30.0 + time * 0.8) * 0.03;
    waterCol += shimmer;

    // Lighting
    float ambient = 0.5;
    float diffuse = max(dot(N, sunDir), 0.0) * 0.3;
    float light = ambient + diffuse;
    waterCol *= light;

    // Specular sun reflection
    vec3 halfVec = normalize(sunDir + V);
    float spec = pow(max(dot(N, halfVec), 0.0), 96.0);
    waterCol += vec3(1.0, 0.98, 0.92) * spec * 0.5;

    // Secondary broader specular for softer highlight
    float spec2 = pow(max(dot(N, halfVec), 0.0), 16.0);
    waterCol += vec3(0.7, 0.85, 1.0) * spec2 * 0.08;

    gl_FragColor = vec4(waterCol, 1.0);
}
`;

export function createWaterMaterial(scene: Scene): ShaderMaterial {
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
			'deepColor', 'shallowColor', 'opacity',
			'waveAmp', 'waveFreq'
		],
		needAlphaBlending: false,
	});

	mat.setVector3('sunDir', new Vector3(1, -0.5, -0.3).normalize());
	mat.setVector3('cameraPos', Vector3.Zero());
	mat.setFloat('time', 0);

	// Ocean colors
	mat.setVector3('deepColor', new Vector3(0.08, 0.18, 0.35));
	mat.setVector3('shallowColor', new Vector3(0.15, 0.35, 0.55));

	// Transparency and waves
	mat.setFloat('opacity', 0.55);
	mat.setFloat('waveAmp', 1.5);    // km displacement
	mat.setFloat('waveFreq', 12.0);  // noise frequency on unit sphere

	mat.backFaceCulling = true;

	return mat;
}
