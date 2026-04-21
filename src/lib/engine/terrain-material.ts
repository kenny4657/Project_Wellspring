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
uniform float seaLevel;      // height threshold: below = water, above = land
uniform float bottomOffset;  // lowest height (water floor)
uniform float hillRatio;     // 0-1 ratio where grass→hill transition occurs
uniform float topOffset;     // highest height (mountain peak)
uniform float time;          // elapsed seconds for water animation

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

// ── Biome colors (muted natural tones like Sota) ────────────

vec3 waterColor(float scratchy) {
    vec3 base = vec3(0.58, 0.52, 0.38);
    return base * (1.0 + scratchy * 0.10);
}

vec3 grassColor(float scratchy) {
    vec3 base = vec3(0.38, 0.60, 0.22);
    vec3 variation = vec3(0.02, 0.05, 0.01) * scratchy;
    return (base + variation) * (1.0 + scratchy * 0.14);
}

vec3 hillColor(float scratchy) {
    vec3 base = vec3(0.48, 0.44, 0.32);
    return base * (1.0 + scratchy * 0.14);
}

vec3 snowColor(float scratchy) {
    vec3 base = vec3(0.82, 0.84, 0.88);
    return base * (1.0 + scratchy * 0.08);
}

// ── Wall cross-section ──────────────────────────────────────

vec3 textureWall(vec3 terrainBase, vec3 wp) {
    vec3 np = wp * 0.003;
    float bDom = step(terrainBase.r + terrainBase.g, terrainBase.b * 2.0 - 0.1);

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

    return mix(landWall, waterWall, bDom);
}

// ── Main ────────────────────────────────────────────────────

void main() {
    vec3 N = normalize(vWorldNormal);
    bool isWall = vColor.a < 0.05;

    float distFromCenter = length(vWorldPos);
    float heightAboveR = distFromCenter - planetRadius;

    vec3 procColor;

    if (isWall) {
        procColor = textureWall(vColor.rgb, vWorldPos);
    } else {
        // ── Sota-style height-based texture blending ────

        float amplitude = abs(topOffset) + abs(bottomOffset);
        float firstCoef = 1.0 / hillRatio;
        float secondCoef = 1.0 / (1.0 - hillRatio);

        float h = (heightAboveR - bottomOffset) / amplitude;

        float scratchy = triplanarScratchy(vWorldPos, N, 0.004);

        // Shore transition zone: narrow sand/beach blend at water/land boundary
        float shoreWidth = 0.06; // width of shore zone in normalized height
        float shoreCenter = 0.0; // at bottom_offset (sea level)

        if (heightAboveR < seaLevel) {
            // ── Ocean surface effect ──
            // Animated water color computed per-pixel on the terrain mesh.
            // No separate sphere needed → zero z-fighting.
            vec3 nDir = normalize(vWorldPos);
            float depth = (seaLevel - heightAboveR) / abs(seaLevel);

            // Two scrolling noise octaves for color variation
            vec3 waveCoord1 = nDir * 18.0 + vec3(time * 0.3, time * 0.2, time * -0.1);
            vec3 waveCoord2 = nDir * 35.0 + vec3(-time * 0.2, time * 0.15, time * 0.25);
            float wave1 = snoise(waveCoord1) * 0.5 + 0.5;
            float wave2 = snoise(waveCoord2) * 0.5 + 0.5;
            float waveMix = wave1 * 0.6 + wave2 * 0.4;

            // Depth-based color: shallow turquoise → deep blue
            vec3 shallowCol = vec3(0.18, 0.45, 0.62);
            vec3 deepCol    = vec3(0.08, 0.20, 0.42);
            float depthT = clamp(depth * 0.3, 0.0, 1.0);
            vec3 baseWater = mix(shallowCol, deepCol, depthT);

            // Animated shimmer
            baseWater += vec3(0.03, 0.05, 0.06) * (waveMix - 0.5);

            // Fresnel: lighter at grazing angles
            vec3 V = normalize(cameraPos - vWorldPos);
            float fresnel = 1.0 - max(dot(N, V), 0.0);
            fresnel = pow(fresnel, 3.0);
            baseWater += vec3(0.06, 0.10, 0.14) * fresnel;

            // ── Animated normal perturbation (fake wave bumps) ──
            // Offset sample positions to compute gradient, then perturb
            // the normal so specular highlights ripple across the surface.
            float eps = 0.002;
            vec3 tx = nDir + vec3(eps, 0.0, 0.0);
            vec3 tz = nDir + vec3(0.0, 0.0, eps);
            float wx = snoise(tx * 18.0 + vec3(time * 0.3, time * 0.2, time * -0.1));
            float wz = snoise(tz * 18.0 + vec3(time * 0.3, time * 0.2, time * -0.1));
            float dWdx = (wx - (wave1 * 2.0 - 1.0)) / eps;
            float dWdz = (wz - (wave1 * 2.0 - 1.0)) / eps;
            // Build tangent-space perturbation and rotate into world space
            vec3 waveNormal = normalize(N + (dWdx * 0.012 + dWdz * 0.012) * cross(N, vec3(0.0, 1.0, 0.0))
                                           + (dWdz * 0.012 - dWdx * 0.012) * cross(N, cross(N, vec3(0.0, 1.0, 0.0))));
            N = waveNormal; // replace normal for lighting pass

            // ── Shore foam ──
            // White fringe where terrain is just below sea level
            float foamWidth = abs(seaLevel) * 1.5;
            float foamT = 1.0 - clamp((seaLevel - heightAboveR) / foamWidth, 0.0, 1.0);
            // Animated foam pattern — breaks up the line with noise
            float foamNoise = snoise(nDir * 60.0 + vec3(time * 0.5, -time * 0.3, time * 0.2));
            float foamMask = foamT * foamT * smoothstep(0.0, 0.5, foamNoise * 0.5 + 0.5);
            baseWater = mix(baseWater, vec3(0.75, 0.80, 0.82), foamMask * 0.7);

            procColor = baseWater;
        } else if (heightAboveR < seaLevel + shoreWidth * amplitude) {
            // Shore/beach transition zone — sand blending into grass
            vec3 shore = vec3(0.65, 0.58, 0.40) * (1.0 + scratchy * 0.10);
            float shoreT = (heightAboveR - seaLevel) / (shoreWidth * amplitude);
            procColor = mix(shore, grassColor(scratchy), clamp(shoreT, 0.0, 1.0));
        } else if (h <= hillRatio) {
            // Plain → Hill blend (Sota's first_coef)
            float t = clamp(h * firstCoef, 0.0, 1.0);
            procColor = mix(grassColor(scratchy), hillColor(scratchy), t);
        } else {
            // Hill → Snow blend (Sota's second_coef)
            float t = clamp((h - hillRatio) * secondCoef, 0.0, 1.0);
            procColor = mix(hillColor(scratchy), snowColor(scratchy), t);
        }
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
    if (!isWall && heightAboveR < seaLevel) {
        vec3 toCamera2 = normalize(cameraPos - vWorldPos);
        vec3 halfVec = normalize(sunDir + toCamera2);
        float spec = pow(max(0.0, dot(N, halfVec)), 96.0);
        litColor += vec3(1.0, 0.98, 0.92) * spec * 0.35;
        // Broader secondary highlight
        float spec2 = pow(max(0.0, dot(N, halfVec)), 16.0);
        litColor += vec3(0.5, 0.7, 0.9) * spec2 * 0.06;
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
			'planetRadius', 'seaLevel', 'bottomOffset', 'topOffset', 'hillRatio', 'time'
		],
		needAlphaBlending: false,
	});

	// Direction TO the light (not from) — shader uses dot(N, sunDir)
	mat.setVector3('sunDir', new Vector3(-1, 0.5, 0.3).normalize());
	mat.setVector3('fillDir', new Vector3(1, -0.3, -0.5).normalize());
	mat.setVector3('cameraPos', Vector3.Zero());

	// Height parameters matching NOISE_AMP in globe-mesh.ts
	const R = 6371; // EARTH_RADIUS_KM
	mat.setFloat('planetRadius', R);
	mat.setFloat('seaLevel', -0.002 * R);        // sea level (slightly below level 2 at 0.000)
	mat.setFloat('bottomOffset', -0.020 * R);    // deep water floor
	mat.setFloat('topOffset', 0.080 * R);         // mountain peak
	mat.setFloat('hillRatio', 0.40);               // grass→hill transition
	mat.setFloat('time', 0);

	mat.backFaceCulling = true;

	return mat;
}
