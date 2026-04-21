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

    // No vertex displacement — wave visuals handled by normal
    // perturbation in fragment shader. Keeps sphere smooth.
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

// ── Simplex 3D Noise ──
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x)  { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0,0.5,1.0,2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289_3(i);
    vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

void main() {
    vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
    float sceneDepth = texture2D(depthSampler, screenUV).r;

    if (sceneDepth < vLinearDepth + 0.00015) {
        discard;
    }

    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPos - vWorldPos);
    vec3 nDir = normalize(vLocalPos);

    // Depth difference for shore effects
    float depthDiff = max(sceneDepth - vLinearDepth, 0.0);

    // ── Animated wave color ──
    vec3 wc1 = nDir * 18.0 + vec3(time * 0.3, time * 0.2, -time * 0.1);
    vec3 wc2 = nDir * 35.0 + vec3(-time * 0.2, time * 0.15, time * 0.25);
    float wave1 = snoise(wc1) * 0.5 + 0.5;
    float wave2 = snoise(wc2) * 0.5 + 0.5;

    // Color: fresnel-based blend (not depth texture — that shows bumpy terrain)
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 waterCol = mix(deepColor, shallowColor, fresnel * 0.5 + 0.15);
    waterCol += vec3(0.03, 0.05, 0.06) * (wave1 * 0.6 + wave2 * 0.4 - 0.5);
    waterCol += vec3(0.04, 0.07, 0.10) * fresnel;

    // ── Wave normal perturbation ──
    // Two low-frequency octaves for broad rolling waves
    vec3 waveCoord = nDir * 6.0 + vec3(time * 0.2, time * 0.15, -time * 0.1);
    float eps = 0.01;
    float wBase = snoise(waveCoord);
    float wDx = snoise(waveCoord + vec3(eps, 0.0, 0.0));
    float wDz = snoise(waveCoord + vec3(0.0, 0.0, eps));
    float dWdx = (wDx - wBase) / eps;
    float dWdz = (wDz - wBase) / eps;
    float strength = 0.006;
    vec3 tangent = normalize(cross(N, vec3(0.0, 1.0, 0.0)));
    vec3 bitangent = cross(N, tangent);
    vec3 waveN = normalize(N + tangent * dWdx * strength + bitangent * dWdz * strength);

    // ── Shore foam ──
    float foamT = 1.0 - clamp(depthDiff * 120.0, 0.0, 1.0);
    float foamNoise = snoise(nDir * 60.0 + vec3(time * 0.5, -time * 0.3, time * 0.2));
    float foamMask = foamT * foamT * smoothstep(0.0, 0.4, foamNoise * 0.5 + 0.5);
    waterCol = mix(waterCol, vec3(0.82, 0.88, 0.90), foamMask * 0.8);

    // ── Lighting (using perturbed wave normal) ──
    float ambient = 0.50;
    float sun = max(dot(waveN, sunDir), 0.0) * 0.35;
    float cam = max(dot(waveN, V), 0.0) * 0.12;
    waterCol *= (ambient + sun + cam);

    // Specular (tighter, less intense)
    vec3 halfVec = normalize(sunDir + V);
    float spec = pow(max(dot(waveN, halfVec), 0.0), 128.0);
    waterCol += vec3(1.0, 0.98, 0.92) * spec * 0.25;

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
