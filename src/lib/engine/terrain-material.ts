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
// The original Sota shader blended between two biome colors using a
// continuous ratio derived from vertex height — within a single hex,
// low vertices got one color and high vertices got another, creating
// rich organic variation. We replicate this by using the scratchy
// pattern (s, remapped to 0-1) as the primary blend factor between
// two distinct colors per terrain. The scratchy varies beautifully
// within each hex via triplanar 4-octave noise. Height (h) adds a
// secondary tint shift so the same terrain looks different at
// different elevations.

vec3 terrainDeepOcean(float s, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.10, 0.15, 0.28);
    return base * (1.0 + s * 0.06);
}

vec3 terrainShallowOcean(float s, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.32, 0.30, 0.24);
    return base * (1.0 + s * 0.08);
}

vec3 terrainCoast(float s, float h, vec3 wp, vec3 N) {
    vec3 wet  = vec3(0.50, 0.44, 0.30);
    vec3 dry  = vec3(0.65, 0.58, 0.40);
    float t = s * 0.5 + 0.5;
    return mix(wet, dry, t);
}

vec3 terrainLake(float s, float h, vec3 wp, vec3 N) {
    vec3 base = vec3(0.12, 0.24, 0.35);
    return base * (1.0 + s * 0.05);
}

vec3 terrainPlains(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.38, 0.48, 0.22); // grassy
    vec3 colorB = vec3(0.48, 0.44, 0.30); // earthy
    float t = s * 0.5 + 0.5; // remap scratchy -1..1 to 0..1
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.02, -0.01, -0.02) * h; // warmer at height
    return col;
}

vec3 terrainGrassland(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.30, 0.46, 0.16); // lush green
    vec3 colorB = vec3(0.42, 0.44, 0.24); // dried grass
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.01, -0.02, -0.01) * h;
    return col;
}

vec3 terrainDesert(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.52, 0.42, 0.26); // shadow sand
    vec3 colorB = vec3(0.65, 0.56, 0.36); // bright sand
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.02, 0.01, -0.01) * h;
    return col;
}

vec3 terrainSwamp(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.14, 0.20, 0.12); // dark pool
    vec3 colorB = vec3(0.28, 0.32, 0.18); // muddy bank
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(-0.01, 0.01, -0.01) * h;
    return col;
}

vec3 terrainTundra(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.46, 0.44, 0.36); // bare rock
    vec3 colorB = vec3(0.58, 0.58, 0.54); // frost
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.02, 0.02, 0.02) * h; // lighter at height
    return col;
}

vec3 terrainHills(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.34, 0.42, 0.20); // grassy
    vec3 colorB = vec3(0.50, 0.46, 0.34); // exposed earth
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.02, -0.01, -0.02) * h;
    return col;
}

vec3 terrainHighland(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.44, 0.40, 0.30); // rocky earth
    vec3 colorB = vec3(0.62, 0.60, 0.56); // grey stone
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.03, 0.03, 0.03) * h; // lighter at height
    return col;
}

vec3 terrainMountain(float s, float h, vec3 wp, vec3 N) {
    vec3 colorA = vec3(0.42, 0.40, 0.34); // dark rock
    vec3 colorB = vec3(0.78, 0.80, 0.84); // snow/ice
    float t = s * 0.5 + 0.5;
    vec3 col = mix(colorA, colorB, t);
    col += vec3(0.04, 0.04, 0.05) * h; // snowier at height
    return col;
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
        float scratchy = triplanarScratchy(vWorldPos, N, 0.004);

        // Normalized height: 0 at deep water floor, 1 at mountain peaks.
        // Used within each terrain function for height-based variation.
        float hNorm = clamp((heightAboveR + 0.020 * planetRadius) / (0.10 * planetRadius), 0.0, 1.0);

        if      (terrainId == 0)  procColor = terrainDeepOcean(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 1)  procColor = terrainShallowOcean(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 2)  procColor = terrainCoast(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 3)  procColor = terrainLake(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 4)  procColor = terrainPlains(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 5)  procColor = terrainGrassland(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 6)  procColor = terrainDesert(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 7)  procColor = terrainSwamp(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 8)  procColor = terrainTundra(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 9)  procColor = terrainHills(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 10) procColor = terrainHighland(scratchy, hNorm, vWorldPos, N);
        else if (terrainId == 11) procColor = terrainMountain(scratchy, hNorm, vWorldPos, N);
        else                      procColor = vec3(1.0, 0.0, 1.0); // magenta = unknown
    }

    // ── Lighting ──
    float ambient = 0.55;
    float sun  = max(0.0, dot(N, sunDir))  * 0.45;
    float fill = max(0.0, dot(N, fillDir)) * 0.15;
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float cam  = max(0.0, dot(N, toCamera)) * 0.25;

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
