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
import { loadTerrainSettings, packCustomPalettes, packCliffPalettes, type RGB, type TerrainSettings } from '$lib/world/terrain-types';

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

// ── Fragment shader chunks ──────────────────────────────────
// The fragment shader is split into named chunks concatenated at the bottom
// into FRAGMENT. Each chunk is a self-contained block of GLSL that compiles
// in sequence; the preamble (precision, uniforms, varyings) lives at the top
// of GLSL_NOISE so order matters.

const GLSL_NOISE = /* glsl */ `
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
uniform vec3 terrainPalette[40]; // 10 types × 4 bands [shore, grass, hill, snow]
uniform float terrainBlend[10]; // per-terrain shore→grass transition width (fraction of amplitude)
uniform float terrainBlendPos[10]; // per-terrain blend position offset (shifts shore/grass boundary)
uniform vec3 cliffPalette[30]; // 10 types × 3 bands [light, dark, pale]

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

// ── Hash functions for procedural rock textures ────────────────
float hash1(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

// Slab map: warped rectangular grid with per-cell height and edge distance.
// Returns vec3(edge_distance, cell_value, cell_value_2)
vec3 slabMap(vec2 uv, float warp) {
    // Warp the UV to break up the rectangular grid
    uv += vec2(snoise(vec3(uv * 0.7, 0.0)), snoise(vec3(uv * 0.7, 5.0))) * warp;
    vec2 cellId = floor(uv);
    vec2 cellUV = fract(uv);
    // Edge distance: how close to any cell boundary
    float edgeDist = min(min(cellUV.x, 1.0 - cellUV.x), min(cellUV.y, 1.0 - cellUV.y));
    // Per-cell random values for color/height variation
    float cv1 = hash1(cellId);
    float cv2 = hash1(cellId + 100.0);
    return vec3(edgeDist, cv1, cv2);
}
`;

const GLSL_SCRATCHY = /* glsl */ `
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
`;

const GLSL_PALETTE = /* glsl */ `
// ── Per-terrain palette lookup ──────────────────────────────
// terrainPalette[id*4+0] = shore, [id*4+1] = grass, [id*4+2] = hill, [id*4+3] = snow

vec3 palShore(int id, float s) { return terrainPalette[id * 4]     * (1.0 + s * 0.10); }
vec3 palGrass(int id, float s) { return terrainPalette[id * 4 + 1] * (1.0 + s * 0.14); }
vec3 palHill(int id, float s)  { return terrainPalette[id * 4 + 2] * (1.0 + s * 0.14); }
vec3 palSnow(int id, float s)  { return terrainPalette[id * 4 + 3] * (1.0 + s * 0.08); }

// Compute the full 4-band terrain color for a given terrain ID at the current vertex.
vec3 computeTerrainColor(int id, float heightAboveR, float tierH, float scratchy) {
    float amplitude = abs(topOffset) + abs(bottomOffset);
    float noiseAmp = 0.008 * planetRadius;
    float noiseBias = 0.3 * noiseAmp;
    float sw = terrainBlend[id] * amplitude;

    float tierBase = (id <= 3) ? seaLevel : (tierH + noiseBias);
    float refLevel = tierBase + terrainBlendPos[id] * amplitude;
    float boundary1 = refLevel;
    float boundary2 = tierBase + noiseAmp * 0.6;
    float boundary3 = tierBase + noiseAmp * 0.85;

    if (heightAboveR < boundary1 - sw) {
        return palShore(id, scratchy);
    } else if (heightAboveR < boundary1 + sw) {
        float t = (heightAboveR - (boundary1 - sw)) / (2.0 * sw);
        return mix(palShore(id, scratchy), palGrass(id, scratchy), clamp(t, 0.0, 1.0));
    } else if (heightAboveR < boundary2 - sw) {
        return palGrass(id, scratchy);
    } else if (heightAboveR < boundary2 + sw) {
        float t = (heightAboveR - (boundary2 - sw)) / (2.0 * sw);
        return mix(palGrass(id, scratchy), palHill(id, scratchy), clamp(t, 0.0, 1.0));
    } else if (heightAboveR < boundary3 - sw) {
        return palHill(id, scratchy);
    } else if (heightAboveR < boundary3 + sw) {
        float t = (heightAboveR - (boundary3 - sw)) / (2.0 * sw);
        return mix(palHill(id, scratchy), palSnow(id, scratchy), clamp(t, 0.0, 1.0));
    } else {
        return palSnow(id, scratchy);
    }
}
`;

const GLSL_WALL_TEXTURE = /* glsl */ `
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
`;

const GLSL_MAIN_SETUP = /* glsl */ `
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
        // ── Per-terrain height blending + cross-terrain border blend ────
        int terrainId = int(vColor.r * 9.0 + 0.5);
        // B channel packs heightLevel (0-4) and cliff proximity (0-1):
        //   B = heightLevel * 0.1 + cliffProximity * 0.09
        float rawB = vColor.b * 10.0;
        int heightLevel = int(floor(rawB + 0.001));
        float cliffProximity = fract(rawB + 0.001) / 0.9;
        cliffProximity = clamp(cliffProximity, 0.0, 1.0);
        // Reconstruct tierH from height level
        float tierH;
        if (heightLevel == 0) tierH = -0.020 * planetRadius;
        else if (heightLevel == 1) tierH = -0.008 * planetRadius;
        else if (heightLevel == 2) tierH = 0.0;
        else if (heightLevel == 3) tierH = 0.005 * planetRadius;
        else tierH = 0.010 * planetRadius;
        float scratchy = triplanarScratchy(vWorldPos, N, 0.004);

        // Decode cross-terrain blend from G channel
        float rawG = vColor.g * 10.0;
        int neighborId = min(int(floor(rawG + 0.001)), 9);
        float distToBorder = fract(rawG + 0.001);
        bool hasCrossBlend = (neighborId != terrainId);

        // Coast proximity from alpha: 0.5 = at water edge, 1.0 = not coastal
        float coastProximity = clamp((1.0 - vColor.a) * 2.0, 0.0, 1.0); // 1.0 at coast, 0.0 inland

        // Compute terrain color at inland height (above shore band)
        float noiseAmp = 0.008 * planetRadius;
        float noiseBias = 0.3 * noiseAmp;
        float inlandH = tierH + noiseBias;
        vec3 inlandColor = computeTerrainColor(terrainId, inlandH, tierH, scratchy);

        // Own terrain color — always clamp height above shore band.
        // Shore color only appears via the beach overlay (coast proximity),
        // never from raw height dropping into the shore palette range.
        float colorH = max(heightAboveR, inlandH);
        vec3 ownColor = computeTerrainColor(terrainId, colorH, tierH, scratchy);

        // Beach color — warm sand
        vec3 beachColor = vec3(0.68, 0.60, 0.42) * (1.0 + scratchy * 0.10);

        // First: compute base terrain color (with land-land blend if applicable)
        if (hasCrossBlend) {
            float n1 = snoise(vWorldPos * 0.004) * 0.22;
            float n2 = snoise(vWorldPos * 0.012) * 0.10;
            float noiseOffset = n1 + n2;
            float threshold = max(0.35 + noiseOffset, 0.08);
            float blend = (1.0 - smoothstep(0.0, threshold, distToBorder)) * 0.45;
            vec3 neighborColor = computeTerrainColor(neighborId, colorH, tierH, scratchy);
            procColor = mix(ownColor, neighborColor, blend);
            // Also blend inlandColor for coastal use
            vec3 neighborInland = computeTerrainColor(neighborId, inlandH, tierH, scratchy);
            inlandColor = mix(inlandColor, neighborInland, blend);
        } else {
            procColor = ownColor;
        }
`;

const GLSL_CLIFF_RENDERING = /* glsl */ `
        // Cliff texture — per-terrain rock with continuous proximity blending
        float steepness = 1.0 - dot(N, normalize(vWorldPos));

        // Water hex cliff: continuous blend toward cliff rock color based
        // on proximity. Done OUTSIDE the cliff block to avoid gate/branch
        // issues that cause hairlines. Uses a simple dark rock tone that
        // blends with the sandy coast color underneath.
        float waterCliffBlend = 0.0;
        if (cliffProximity > 0.3) {
            int wCliffPalId = hasCrossBlend ? neighborId : terrainId;
            vec3 wRock = mix(cliffPalette[wCliffPalId * 3], cliffPalette[wCliffPalId * 3 + 1], 0.5);
            waterCliffBlend = smoothstep(0.3, 0.8, cliffProximity);
            procColor = mix(procColor, wRock, waterCliffBlend);
        }

        if (cliffProximity > 0.01 && steepness > 0.003) {
            // Per-terrain cliff palette from uniform
            vec3 cliffLight = cliffPalette[terrainId * 3];
            vec3 cliffDark  = cliffPalette[terrainId * 3 + 1];
            vec3 cliffPale  = cliffPalette[terrainId * 3 + 2];

            // ── Triplanar UV for the slab map ──
            vec3 triW = abs(N);
            triW /= (triW.x + triW.y + triW.z + 0.001);
            vec2 uvX = vec2(vWorldPos.y * 0.4, vWorldPos.z) * 0.008;
            vec2 uvY = vec2(vWorldPos.x, vWorldPos.z) * 0.008;
            vec2 uvZ = vec2(vWorldPos.x, vWorldPos.y * 0.4) * 0.008;

            // ── Large rectangular slabs ──
            vec3 slab1X = slabMap(uvX * 1.0, 0.4);
            vec3 slab1Y = slabMap(uvY * 1.0, 0.4);
            vec3 slab1Z = slabMap(uvZ * 1.0, 0.4);
            float slabCell1 = slab1X.y * triW.x + slab1Y.y * triW.y + slab1Z.y * triW.z;

            // ── Medium slabs ──
            vec3 slab2X = slabMap(uvX * 2.8 + 10.0, 0.5);
            vec3 slab2Y = slabMap(uvY * 2.8 + 10.0, 0.5);
            vec3 slab2Z = slabMap(uvZ * 2.8 + 10.0, 0.5);
            float slabCell2 = slab2X.y * triW.x + slab2Y.y * triW.y + slab2Z.y * triW.z;

            // ── Per-slab color from terrain cliff palette ──
            vec3 rockColor = mix(cliffLight, cliffDark, slabCell1);
            rockColor = mix(rockColor, cliffPale, step(0.65, slabCell1) * 0.45);
            rockColor = mix(rockColor, rockColor * 0.80, step(0.55, slabCell2) * 0.35);
            rockColor = mix(rockColor, rockColor * 1.15, (1.0 - step(0.45, slabCell2)) * 0.20);
            float roughness = snoise(vWorldPos * 0.04) * 0.025;
            rockColor += roughness;

            // At the midpoint (high proximity), blend toward a shared neutral
            // dark rock so both sides converge to the same color at the seam
            vec3 midRock = vec3(0.32, 0.26, 0.19);
            float midBlend = smoothstep(0.5, 1.0, cliffProximity);
            rockColor = mix(rockColor, midRock, midBlend * 0.75);

            // Blend: steepness only — no proximity in the blend = no hairline
            float erosionNoise = snoise(vWorldPos * 0.006) * 0.02;
            float erosionBlend = smoothstep(0.003 + erosionNoise, 0.06, steepness);
            float proxFade = smoothstep(0.0, 0.3, cliffProximity);
            erosionBlend *= proxFade;
            procColor = mix(procColor, rockColor, erosionBlend);
            // Track for beach suppression
            waterCliffBlend = max(waterCliffBlend, erosionBlend);
        }
`;

const GLSL_BEACH_OVERLAY = /* glsl */ `
        // Then: if coastal, blend the result toward beach
        // Suppress beach across the ENTIRE cliff zone (using cliffProximity
        // directly) so the cliff face and water-hex cliff blend form a
        // continuous surface — no muddy beach band at the join.
        if (coastProximity > 0.01) {
            float coastNoise = snoise(vWorldPos * 0.005) * 0.12
                             + snoise(vWorldPos * 0.015) * 0.06;
            float beachStart = 0.35 + coastNoise;
            float beachBlend = smoothstep(beachStart, 1.0, coastProximity);
            beachBlend *= (1.0 - cliffProximity);
            procColor = mix(procColor, beachColor, beachBlend);
        }
    }
`;

const GLSL_LIGHTING = /* glsl */ `
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
        vec3 halfVec = normalize(sunDir + toCamera);
        float spec = pow(max(0.0, dot(N, halfVec)), 64.0);
        litColor += vec3(1.0, 0.98, 0.92) * spec * 0.10;
    }

    gl_FragColor = vec4(litColor, 1.0);
}
`;

const FRAGMENT =
	GLSL_NOISE +
	GLSL_SCRATCHY +
	GLSL_PALETTE +
	GLSL_WALL_TEXTURE +
	GLSL_MAIN_SETUP +
	GLSL_CLIFF_RENDERING +
	GLSL_BEACH_OVERLAY +
	GLSL_LIGHTING;

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
			'planetRadius', 'seaLevel', 'bottomOffset', 'topOffset', 'hillRatio', 'time',
			'terrainPalette', 'terrainBlend', 'terrainBlendPos', 'cliffPalette'
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

	// Load and upload per-terrain color palettes + blend values
	const settings = loadTerrainSettings();
	applyTerrainSettings(mat, settings);

	mat.backFaceCulling = true;

	return mat;
}

/** Update terrain palette + blend uniforms at runtime (for color editor). */
export function applyTerrainSettings(mat: ShaderMaterial, settings: TerrainSettings): void {
	mat.setArray3('terrainPalette', packCustomPalettes(settings.palettes));
	mat.setFloats('terrainBlend', settings.blends);
	mat.setFloats('terrainBlendPos', settings.blendPositions);
	if (settings.cliffPalettes) {
		mat.setArray3('cliffPalette', packCliffPalettes(settings.cliffPalettes));
	}
}
