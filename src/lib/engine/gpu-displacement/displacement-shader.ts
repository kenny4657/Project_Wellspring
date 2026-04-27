/**
 * GPU displacement shader (Phase 2 final).
 *
 * Vertex shader fully ports `computeHeightWithCliffErosion`:
 *   - sample baked noise cubemap (raw + cliff channels)
 *   - read hex tier from hexDataTex; 6 corners + neighbor IDs
 *     packed into hexCornersTex (xyz=corner, a=neighborId)
 *   - classify edges (excluded / coast / cliff / steepCliff) using
 *     the same rules as hex-borders.ts
 *   - find nearest non-excluded edge for border smoothing, with
 *     coast smooth-min across coast edges and COAST_ROUNDING dip
 *   - apply self cliff erosion for cliff edges
 *   - apply 1-hop neighbor cliff erosion: for every non-cliff edge
 *     of self, walk that neighbor's cliff edges using its own data
 *     (closes seams between same-tier neighbors of a common cliff)
 *
 * Fragment shader: per-fragment dFdx/dFdy face normals + Lambert
 * + tier-based debug palette. Real terrain colors land in Phase 3.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { HexDataTextures } from './hex-data-tex';
import type { HexCornersTexture } from './hex-corners-tex';
import { LEVEL_HEIGHTS } from '../hex-borders';
import { NOISE_AMP, NOISE_SCALE, BASE_HEIGHT, COAST_ROUNDING } from '../hex-heights';

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform mat4 world;
uniform mat4 viewProjection;

uniform float planetRadius;
uniform float noiseAmp;
uniform float noiseScale;
uniform float baseHeight;
uniform float coastRounding;
uniform vec4 levelHeights;
uniform float levelHeight4;

uniform samplerCube noiseCubemap;
uniform sampler2D hexDataTex;
uniform sampler2D hexNeighborsTex;
uniform sampler2D hexCornersTex;
uniform int hexTexWidth;
uniform int hexCornersTexWidth;

in vec3 position;
in float hexId;
in vec2 localUV;
in float wallFlag;
in float neighborSlot;

out vec3 vWorldPos;
out vec2 vLocalUV;
out float vHeight;
out float vTierH;
out float vCliffMu;

float levelHeight(int level) {
    if (level <= 0) return levelHeights.x;
    if (level == 1) return levelHeights.y;
    if (level == 2) return levelHeights.z;
    if (level == 3) return levelHeights.w;
    return levelHeight4;
}

ivec2 hexCoord(int id) {
    return ivec2(id % hexTexWidth, id / hexTexWidth);
}

vec4 readCornerPixel(int id, int k) {
    int W = hexCornersTexWidth;
    int xCol = id % W;
    int yRow = (id / W) * 12 + k;
    return texelFetch(hexCornersTex, ivec2(xCol, yRow), 0);
}

float distToSegment(vec3 p, vec3 a, vec3 b) {
    vec3 ab = b - a;
    float ab2 = dot(ab, ab);
    float t = ab2 > 1e-12 ? clamp(dot(p - a, ab) / ab2, 0.0, 1.0) : 0.0;
    vec3 proj = a + ab * t;
    return length(p - proj);
}

// Distance + edge parameter t (0..1 along segment)
void distAndT(vec3 p, vec3 a, vec3 b, out float dist, out float t) {
    vec3 ab = b - a;
    float ab2 = dot(ab, ab);
    t = ab2 > 1e-12 ? clamp(dot(p - a, ab) / ab2, 0.0, 1.0) : 0.0;
    vec3 proj = a + ab * t;
    dist = length(p - proj);
}

// ── Edge classification (matches hex-borders.ts) ─────────────
// CPU rule: coast if water<->lowland (low-side tier ≤ 2).
//           cliff if any height gap > 0 between two land hexes
//           OR water-against-tall-land (land tier > 2).
//           steepCliff if gap ≥ 2 between land hexes
//           OR water-against-tall-land.
//           excluded from border-distance walk if: both land,
//           OR cliff (water+tall-land), so border smoothing
//           doesn't pull the surface toward sea level there.
bool isCliffEdge(int selfH, int nbH) {
    // Any tier transition runs through cliff erosion's smooth-ramp logic.
    // Includes land-shallow-water (coast) and shallow-deep-water (water step)
    // — replaces the old coast and water-step special-case passes.
    return selfH != nbH;
}
// "Rock" cliffs that should render with the brown cliff-face shader.
// Smooth coast/water-step transitions use the same h-blend math but
// don't qualify as rocky → fragment stays normal tier color.
bool isRockCliff(int selfH, int nbH) {
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    if (selfWater && nbWater) return false;
    int gap = int(abs(float(selfH - nbH)));
    if (gap == 0) return false;
    if (selfWater && nbH <= 2) return false;
    if (nbWater && selfH <= 2) return false;
    return true;
}
bool isSteepCliffEdge(int selfH, int nbH) {
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    if (selfWater && nbWater) return false;
    if (!selfWater && !nbWater) return abs(selfH - nbH) >= 2;
    if (nbWater) return selfH > 2;
    if (selfWater) return nbH > 2;
    return false;
}
bool isCoastEdge(int selfH, int nbH) {
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    if (selfWater == nbWater) return false; // both same → not coast
    if (selfWater) return nbH <= 2;         // water against shallow land
    return selfH <= 2;                      // shallow land against water
}
bool isExcludedEdge(int selfH, int nbH) {
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    // Land-land: excluded (per classifyLandToLand)
    if (!selfWater && !nbWater) return true;
    // Cliff-water from LAND side only (per classifyCliffToWater).
    // From the water side (classifyWaterToCliff), edge is NOT excluded
    // and uses target=0 — water surface ramps up to sea level at cliff foot.
    if (!selfWater && nbWater && selfH > 2) return true;
    return false;
}
float computeBorderTarget(int selfH, int nbH) {
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    // Water-water: target is the shallower of the two (per CPU classifyWaterToWater)
    if (selfWater && nbWater) {
        int lo = min(selfH, nbH);
        return levelHeight(lo);
    }
    // Coast (water<->shallow land): sea level
    return 0.0;
}

void readNeighbors(int id, out int nb[12]) {
    // 12 nibbles spread across 2 RGBA8 pixels (rows). Pixel 0: slots 0..7.
    // Pixel 1: slots 8..11 in R+G; B+A unused.
    int W = hexTexWidth;
    int xCol = id % W;
    int yRowBase = (id / W) * 2;
    vec4 p0 = texelFetch(hexNeighborsTex, ivec2(xCol, yRowBase), 0);
    vec4 p1 = texelFetch(hexNeighborsTex, ivec2(xCol, yRowBase + 1), 0);
    int n0 = int(p0.r * 255.0 + 0.5);
    int n1 = int(p0.g * 255.0 + 0.5);
    int n2 = int(p0.b * 255.0 + 0.5);
    int n3 = int(p0.a * 255.0 + 0.5);
    int n4 = int(p1.r * 255.0 + 0.5);
    int n5 = int(p1.g * 255.0 + 0.5);
    nb[0] = n0 & 0xf;
    nb[1] = (n0 >> 4) & 0xf;
    nb[2] = n1 & 0xf;
    nb[3] = (n1 >> 4) & 0xf;
    nb[4] = n2 & 0xf;
    nb[5] = (n2 >> 4) & 0xf;
    nb[6] = n3 & 0xf;
    nb[7] = (n3 >> 4) & 0xf;
    nb[8] = n4 & 0xf;
    nb[9] = (n4 >> 4) & 0xf;
    nb[10] = n5 & 0xf;
    nb[11] = (n5 >> 4) & 0xf;
}

void readHexData(int id, out int heightLevel, out int edgeCount) {
    vec4 d = texelFetch(hexDataTex, hexCoord(id), 0);
    heightLevel = int(d.r * 255.0 + 0.5);
    int packed = int(d.b * 255.0 + 0.5);
    edgeCount = (packed >> 4) & 0xf;
    if (edgeCount < 5) edgeCount = 6;
}

void readCornersAndNeighborIds(int id, out vec3 corners[12], out int nbIds[12]) {
    for (int i = 0; i < 12; i++) {
        vec4 v = readCornerPixel(id, i);
        corners[i] = v.rgb;
        nbIds[i] = int(v.a + 0.5);
    }
}

float meanHexRadius(vec3 corners[12], int edgeCount) {
    vec3 c = vec3(0.0);
    for (int i = 0; i < 12; i++) { if (i >= edgeCount) break; c += corners[i]; }
    c = normalize(c / float(edgeCount));
    float r = 0.0;
    for (int i = 0; i < 12; i++) { if (i >= edgeCount) break; r += length(corners[i] - c); }
    return r / float(edgeCount);
}

// Walk a hex's edges (up to 12) and apply cliff erosion for every cliff
// edge. Each cliff contributes (midH, weight=exp(-mu/k)) to a running
// weighted sum, plus updates min mu. Used both for self and 1-hop
// neighbors. Symmetric accumulation closes 3-cell-corner gaps where
// the old "pick the lowest-mu cliff" rule produced a different winner
// per cell. midWeightSum/midWeightedH must be reduced to bestMidH after
// all walks complete.
void walkCliffEdges(
    vec3 unitDir,
    int selfH,
    int edgeCount,
    int neighborH[12],
    vec3 corners[12],
    float ownerHexRadius,
    float cliffNoise,
    float midNoise,
    float selfTierH,
    inout float bestMu,
    inout float rockMu,
    inout float midWeightSum,
    inout float midWeightedH
) {
    float kernelK = 0.05;
    for (int i = 0; i < 12; i++) {
        if (i >= edgeCount) break;
        int nbH = neighborH[i];
        if (!isCliffEdge(selfH, nbH)) continue;
        vec3 a = corners[i];
        int nextIdx = (i + 1) == edgeCount ? 0 : (i + 1);
        vec3 b = corners[nextIdx];
        float dist = distToSegment(unitDir, a, b);
        bool steep = isSteepCliffEdge(selfH, nbH);
        bool rock = isRockCliff(selfH, nbH);
        float mu;
        if (steep) {
            float rampWidth = ownerHexRadius * 0.2;
            float safeBand = ownerHexRadius * 0.05;
            float perturbed = dist < safeBand
                ? dist
                : max(0.0, dist + cliffNoise * ownerHexRadius * 0.25);
            float t = min(perturbed / rampWidth, 1.0);
            mu = t * (2.0 - t);
        } else {
            float rampWidth = ownerHexRadius * 0.7;
            float t = min(dist / rampWidth, 1.0);
            mu = (1.0 - cos(t * 3.14159265)) / 2.0;
        }
        // Noise scaled smaller for non-rock transitions — underwater
        // and coastal smooth ramps shouldn't have rocky bumps.
        float midNoiseScale = rock ? 0.3 : 0.1;
        float midTier = (selfTierH + levelHeight(nbH)) * 0.5;
        float midH = midTier + (abs(midNoise) + 0.15) * noiseAmp * midNoiseScale;
        float w = exp(-mu / kernelK);
        midWeightSum += w;
        midWeightedH += w * midH;
        if (mu < bestMu) bestMu = mu;
        if (rock && mu < rockMu) rockMu = mu;
    }
}

void main() {
    int id = int(hexId + 0.5);
    vec3 unitDir = normalize(position);

    // Self data
    int selfH, edgeCount;
    readHexData(id, selfH, edgeCount);
    int neighborH[12];
    readNeighbors(id, neighborH);
    vec3 corners[12];
    int nbIds[12];
    readCornersAndNeighborIds(id, corners, nbIds);

    // Noise
    vec4 noiseRGBA = textureLod(noiseCubemap, unitDir, 0.0);
    float rawNoise = noiseRGBA.r;
    float cliffNoise = noiseRGBA.g;
    float midNoise = rawNoise; // identical to CPU: midNoise === rawNoise

    bool isWaterHex = selfH <= 1;
    float selfTierH = levelHeight(selfH);
    float interiorNoiseH = isWaterHex ? abs(rawNoise) : (rawNoise + 0.3);
    float hexRadius = meanHexRadius(corners, edgeCount);

    // h_base: pure interior height. The unified cliff/transition erosion
    // below blends toward midH at every cross-tier boundary. No separate
    // border walk, coast pass, water-step pass, or rounding dip — every
    // tier transition (land→shallow water, shallow→deep, land cliff)
    // goes through the same symmetric smooth-ramp logic.
    float h = selfTierH + interiorNoiseH * noiseAmp;

    // ── Tier-transition erosion (self + 1-hop) ─────────────
    float bestMu = 1.0;
    float rockMu = 1.0;  // gates fragment-shader cliff coloring
    float midWeightSum = 0.0;
    float midWeightedH = 0.0;
    walkCliffEdges(unitDir, selfH, edgeCount, neighborH, corners,
                   hexRadius, cliffNoise, midNoise, selfTierH,
                   bestMu, rockMu, midWeightSum, midWeightedH);
    for (int i = 0; i < 12; i++) {
        if (i >= edgeCount) break;
        int nbId = nbIds[i];
        if (nbId < 0) continue;

        int nbHL, nbEdgeCount;
        readHexData(nbId, nbHL, nbEdgeCount);
        int nbNeighborH[12];
        readNeighbors(nbId, nbNeighborH);
        vec3 nbCorners[12];
        int nbNbIds[12];
        readCornersAndNeighborIds(nbId, nbCorners, nbNbIds);
        float nbHexRadius = meanHexRadius(nbCorners, nbEdgeCount);
        float nbTierH = levelHeight(nbHL);

        walkCliffEdges(unitDir, nbHL, nbEdgeCount, nbNeighborH, nbCorners,
                       nbHexRadius, cliffNoise, midNoise, nbTierH,
                       bestMu, rockMu, midWeightSum, midWeightedH);
    }

    if (bestMu < 1.0 && midWeightSum > 0.0) {
        float bestMidH = midWeightedH / midWeightSum;
        float clamped = max(0.0, (bestMu - 0.05) / 0.95);
        h = bestMidH * (1.0 - clamped) + h * clamped;
    }

    vec3 worldPos = unitDir * (planetRadius * (1.0 + h));
    vec4 wp = world * vec4(worldPos, 1.0);
    vWorldPos = wp.xyz;
    vLocalUV = localUV;
    vHeight = h;
    vTierH = selfTierH;
    vCliffMu = 1.0 - rockMu;
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec2 vLocalUV;
in float vHeight;
in float vTierH;
in float vCliffMu;

uniform vec3 sunDir;
uniform vec3 cameraPos;

out vec4 fragColor;

void main() {
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 N = normalize(cross(dy, dx));

    vec3 base;
    if (vCliffMu > 0.5)               base = vec3(0.45, 0.40, 0.35); // cliff face only where erosion is strong
    else if (vTierH < -0.01)          base = vec3(0.10, 0.18, 0.32);
    else if (vTierH < -0.001)         base = vec3(0.16, 0.30, 0.45);
    else if (vTierH < 0.001)          base = vec3(0.62, 0.78, 0.42);
    else if (vTierH < 0.008)          base = vec3(0.45, 0.55, 0.30);
    else                              base = vec3(0.55, 0.50, 0.45);

    float light = 0.4 + 0.6 * max(0.0, dot(N, sunDir));
    fragColor = vec4(base * light, 1.0);
}
`;

export function createDisplacementMaterial(
	scene: Scene,
	resources: {
		noiseCubemap: RawCubeTexture;
		hexTextures: HexDataTextures;
		hexCorners: HexCornersTexture;
	},
	planetRadius: number,
): ShaderMaterial {
	ShaderStore.ShadersStore['gpuDisplVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['gpuDisplFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('gpuDisplMat', scene, {
		vertex: 'gpuDispl',
		fragment: 'gpuDispl',
	}, {
		attributes: ['position', 'hexId', 'localUV', 'wallFlag', 'neighborSlot'],
		uniforms: [
			'world', 'viewProjection',
			'planetRadius', 'noiseAmp', 'noiseScale',
			'baseHeight', 'coastRounding',
			'levelHeights', 'levelHeight4',
			'hexTexWidth', 'hexCornersTexWidth',
			'sunDir', 'cameraPos',
		],
		samplers: ['noiseCubemap', 'hexDataTex', 'hexNeighborsTex', 'hexCornersTex'],
	});

	mat.setFloat('planetRadius', planetRadius);
	mat.setFloat('noiseAmp', NOISE_AMP);
	mat.setFloat('noiseScale', NOISE_SCALE);
	mat.setFloat('baseHeight', BASE_HEIGHT);
	mat.setFloat('coastRounding', COAST_ROUNDING);
	mat.setVector4('levelHeights', new Vector4(
		LEVEL_HEIGHTS[0], LEVEL_HEIGHTS[1],
		LEVEL_HEIGHTS[2], LEVEL_HEIGHTS[3],
	));
	mat.setFloat('levelHeight4', LEVEL_HEIGHTS[4]);
	mat.setInt('hexTexWidth', resources.hexTextures.width);
	mat.setInt('hexCornersTexWidth', resources.hexCorners.width);
	mat.setTexture('noiseCubemap', resources.noiseCubemap);
	mat.setTexture('hexDataTex', resources.hexTextures.hexDataTex);
	mat.setTexture('hexNeighborsTex', resources.hexTextures.hexNeighborsTex);
	mat.setTexture('hexCornersTex', resources.hexCorners.tex);
	mat.backFaceCulling = true;

	return mat;
}
