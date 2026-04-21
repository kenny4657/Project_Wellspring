/**
 * Terrain ShaderMaterial — Sota-style height-based texture blending.
 *
 * The shader determines biome entirely by vertex height (distance from
 * sphere center), blending between water → grass → hill → snow textures.
 * Textures are procedural with a scratchy organic pattern applied via
 * triplanar mapping. Walls use rock/dirt cross-section texturing.
 *
 * This replicates the exact approach from Sota's polyhedron_biome.gdshader:
 *   h = (distance_from_center - bottom_offset) / amplitude
 *   ALBEDO = mix(texture_A, texture_B, h_ratio)
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vColor;

void main() {
    vec4 wp = world * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
    vColor = color;
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 sunDir;
uniform vec3 fillDir;
uniform vec3 cameraPos;
uniform float planetRadius;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vColor;

// ── Simplex 3D Noise ────────────────────────────────────────
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x)  { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1.0 - g;
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
    vec3 ns  = n_ * D.wyz - D.xzx;
    vec4 j   = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_  = floor(j * ns.z);
    vec4 y_  = floor(j - 7.0 * x_);
    vec4 x   = x_ * ns.x + ns.yyyy;
    vec4 y   = y_ * ns.x + ns.yyyy;
    vec4 h   = 1.0 - abs(x) - abs(y);
    vec4 b0  = vec4(x.xy, y.xy);
    vec4 b1  = vec4(x.zw, y.zw);
    vec4 s0  = floor(b0) * 2.0 + 1.0;
    vec4 s1  = floor(b1) * 2.0 + 1.0;
    vec4 sh  = -step(h, vec4(0.0));
    vec4 a0  = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1  = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// ── Scratchy organic texture (matches Sota's tileable textures) ──

float scratchyPattern(vec2 uv) {
    float n1 = snoise(vec3(uv * 18.0, 0.0)) * 0.4;
    float n2 = snoise(vec3(uv * 35.0, 1.5)) * 0.3;
    float n3 = snoise(vec3(uv * 70.0, 3.0)) * 0.2;
    float n4 = snoise(vec3(uv * 140.0, 5.0)) * 0.1;
    return n1 + n2 + n3 + n4;
}

// Triplanar mapping — seamless texturing on a sphere
float triplanarScratchy(vec3 worldPos, vec3 normal, float scale) {
    vec3 blend = abs(normal);
    blend = blend / (blend.x + blend.y + blend.z + 0.001);

    float tx = scratchyPattern(worldPos.yz * scale);
    float ty = scratchyPattern(worldPos.xz * scale);
    float tz = scratchyPattern(worldPos.xy * scale);

    return tx * blend.x + ty * blend.y + tz * blend.z;
}

// ── Extra noise helpers ─────────────────────────────────────

float ridgedNoise(vec3 p) {
    return 1.0 - abs(snoise(p));
}

float triplanarScratchy2(vec3 worldPos, vec3 normal, float scale, float seed) {
    vec3 blend = abs(normal);
    blend = blend / (blend.x + blend.y + blend.z + 0.001);
    float tx = scratchyPattern(worldPos.yz * scale + seed);
    float ty = scratchyPattern(worldPos.xz * scale + seed);
    float tz = scratchyPattern(worldPos.xy * scale + seed);
    return tx * blend.x + ty * blend.y + tz * blend.z;
}

// ── Per-terrain procedural textures ─────────────────────────
// Each terrain uses multiple noise layers at different scales for
// rich internal variation: base color, broad patches, fine detail,
// color shifts. s = triplanar scratchy, s2 = second scratchy at
// different scale/seed for independent variation.

vec3 terrainDeepOcean(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.10, 0.15, 0.28);
    return base * (1.0 + s * 0.06);
}

vec3 terrainShallowOcean(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.32, 0.30, 0.24);
    base += vec3(0.04, 0.03, 0.01) * s;
    base += vec3(0.02, 0.02, 0.01) * s2;
    return base;
}

vec3 terrainCoast(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.58, 0.52, 0.36);
    // Broad wet/dry patches
    base += vec3(-0.06, -0.05, -0.03) * s;
    // Fine sand grain
    base += vec3(0.03, 0.02, 0.01) * s2;
    return base;
}

vec3 terrainLake(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.12, 0.24, 0.35);
    return base * (1.0 + s * 0.05);
}

vec3 terrainPlains(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.38, 0.42, 0.24);
    base *= (1.0 + s * 0.18);
    base += vec3(0.04, -0.02, -0.03) * s2;
    base += vec3(0.03, -0.02, -0.02) * h;
    return base;
}

vec3 terrainGrassland(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.30, 0.42, 0.18);
    base *= (1.0 + s * 0.20);
    base += vec3(-0.02, 0.03, -0.01) * s2;
    base += vec3(0.03, -0.02, -0.02) * h;
    return base;
}

vec3 terrainDesert(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.52, 0.44, 0.30);
    base *= (1.0 + s * 0.16);
    base += vec3(-0.04, -0.03, -0.01) * s2;
    base += vec3(0.03, 0.02, 0.01) * h;
    return base;
}

vec3 terrainSwamp(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.20, 0.26, 0.15);
    base *= (1.0 + s * 0.22);
    base += vec3(-0.02, 0.03, -0.01) * s2;
    base += vec3(0.02, 0.01, -0.02) * h;
    return base;
}

vec3 terrainTundra(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.48, 0.48, 0.44);
    base *= (1.0 + s * 0.14);
    base += vec3(0.03, 0.03, 0.04) * s2;
    base += vec3(0.03, 0.03, 0.04) * h;
    return base;
}

vec3 terrainHills(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.38, 0.40, 0.26);
    base *= (1.0 + s * 0.20);
    base += vec3(0.03, 0.02, -0.03) * s2;
    base += vec3(0.04, -0.02, -0.03) * h;
    return base;
}

vec3 terrainHighland(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.44, 0.40, 0.32);
    base *= (1.0 + s * 0.18);
    base += vec3(-0.03, -0.02, -0.01) * s2;
    base += vec3(0.04, 0.04, 0.05) * h;
    return base;
}

vec3 terrainMountain(float s, float s2, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.46, 0.44, 0.38);
    base *= (1.0 + s * 0.16);
    base += vec3(-0.02, -0.02, 0.01) * s2;
    base += vec3(0.12, 0.14, 0.18) * h;
    return base;
}

// ── Wall cross-section ──────────────────────────────────────

vec3 textureWall(int terrainId, vec3 wp) {
    vec3 np = wp * 0.003;
    bool isWater = terrainId <= 3;

    vec3 dirt = vec3(0.38, 0.28, 0.18);
    vec3 rock = vec3(0.50, 0.46, 0.40);
    vec3 darkRock = vec3(0.26, 0.23, 0.20);

    float h = length(wp);
    float strata = sin(h * 0.8) * 0.5 + 0.5;
    strata *= strata;
    float strata2 = sin(h * 2.5 + 1.0) * 0.5 + 0.5;

    float n1 = snoise(np * 7.0) * 0.14;
    float n2 = snoise(np * 18.0 + 150.0) * 0.06;
    float crevice = 1.0 - abs(snoise(np * 12.0 + 170.0));

    vec3 landWall = mix(dirt, rock, strata * 0.5 + strata2 * 0.15 + n1 * 0.4 + 0.2);
    landWall += n2;
    landWall = mix(landWall, darkRock, crevice * 0.30);

    vec3 deepSand = vec3(0.42, 0.36, 0.26);
    vec3 midSand  = vec3(0.52, 0.46, 0.34);
    vec3 waterWall = mix(deepSand, midSand, strata * 0.35 + n1 * 0.25);

    return isWater ? waterWall : landWall;
}

// ── Main ────────────────────────────────────────────────────

void main() {
    vec3 N = normalize(vWorldNormal);
    bool isWall = vColor.a < 0.05;
    int terrainId = int(floor(vColor.r * 11.0 + 0.5));
    bool isWater = terrainId <= 3;

    float distFromCenter = length(vWorldPos);
    float heightAboveR = distFromCenter - planetRadius;

    vec3 procColor;

    if (isWall) {
        procColor = textureWall(terrainId, vWorldPos);
    } else {
        // Two scratchy layers at different scales for independent variation
        float s1 = triplanarScratchy(vWorldPos, N, 0.004);  // broad patches
        float s2 = triplanarScratchy2(vWorldPos, N, 0.010, 42.0); // fine detail

        // Normalized height for secondary tint shifts
        float hNorm = clamp((heightAboveR + 0.020 * planetRadius) / (0.10 * planetRadius), 0.0, 1.0);

        if      (terrainId == 0)  procColor = terrainDeepOcean(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 1)  procColor = terrainShallowOcean(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 2)  procColor = terrainCoast(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 3)  procColor = terrainLake(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 4)  procColor = terrainPlains(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 5)  procColor = terrainGrassland(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 6)  procColor = terrainDesert(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 7)  procColor = terrainSwamp(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 8)  procColor = terrainTundra(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 9)  procColor = terrainHills(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 10) procColor = terrainHighland(s1, s2, hNorm, vWorldPos, N);
        else if (terrainId == 11) procColor = terrainMountain(s1, s2, hNorm, vWorldPos, N);
        else                      procColor = vec3(1.0, 0.0, 1.0); // magenta = unknown
    }

    // ── Lighting ──
    float ambient = 0.48;
    float sun  = max(0.0, dot(N, sunDir))  * 0.35;
    float fill = max(0.0, dot(N, fillDir)) * 0.12;
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float cam  = max(0.0, dot(N, toCamera)) * 0.20;

    float light = ambient + sun + fill + cam;
    vec3 litColor = procColor * light;

    // Specular on water
    if (!isWall && isWater) {
        vec3 halfVec = normalize(sunDir + toCamera);
        float spec = pow(max(0.0, dot(N, halfVec)), 64.0);
        litColor += vec3(1.0, 0.98, 0.92) * spec * 0.10;
    }

    gl_FragColor = vec4(litColor, 1.0);
}
`;

export function createTerrainMaterial(scene: Scene): ShaderMaterial {
	ShaderStore.ShadersStore['terrainVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['terrainFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('terrainMat', scene, {
		vertex: 'terrain',
		fragment: 'terrain',
	}, {
		attributes: ['position', 'normal', 'color'],
		uniforms: [
			'world', 'viewProjection',
			'sunDir', 'fillDir', 'cameraPos',
			'planetRadius'
		],
		needAlphaBlending: false,
	});

	mat.setVector3('sunDir', new Vector3(-1, 0.5, 0.3).normalize());
	mat.setVector3('fillDir', new Vector3(1, -0.3, -0.5).normalize());
	mat.setVector3('cameraPos', Vector3.Zero());

	const R = 6371; // EARTH_RADIUS_KM
	mat.setFloat('planetRadius', R);

	mat.backFaceCulling = true;

	return mat;
}
