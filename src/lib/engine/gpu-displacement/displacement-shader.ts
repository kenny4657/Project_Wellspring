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
    int yRow = (id / W) * 6 + k;
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
    bool selfWater = selfH <= 1;
    bool nbWater = nbH <= 1;
    if (selfWater && nbWater) return false;
    int gap = int(abs(float(selfH - nbH)));
    if (selfWater && nbH <= 2) return false;
    if (nbWater && selfH <= 2) return false;
    return gap > 0;
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

void readNeighbors(int id, out int nb[6]) {
    vec4 nbPacked = texelFetch(hexNeighborsTex, hexCoord(id), 0);
    int n0 = int(nbPacked.r * 255.0 + 0.5);
    int n1 = int(nbPacked.g * 255.0 + 0.5);
    int n2 = int(nbPacked.b * 255.0 + 0.5);
    nb[0] = n0 & 0xf;
    nb[1] = (n0 >> 4) & 0xf;
    nb[2] = n1 & 0xf;
    nb[3] = (n1 >> 4) & 0xf;
    nb[4] = n2 & 0xf;
    nb[5] = (n2 >> 4) & 0xf;
}

void readHexData(int id, out int heightLevel, out int edgeCount) {
    vec4 d = texelFetch(hexDataTex, hexCoord(id), 0);
    heightLevel = int(d.r * 255.0 + 0.5);
    int packed = int(d.b * 255.0 + 0.5);
    edgeCount = (packed >> 4) & 0xf;
    if (edgeCount < 5) edgeCount = 6;
}

void readCornersAndNeighborIds(int id, out vec3 corners[6], out int nbIds[6]) {
    for (int i = 0; i < 6; i++) {
        vec4 v = readCornerPixel(id, i);
        corners[i] = v.rgb;
        nbIds[i] = int(v.a + 0.5);
    }
}

float meanHexRadius(vec3 corners[6], int edgeCount) {
    vec3 c = vec3(0.0);
    for (int i = 0; i < 6; i++) { if (i >= edgeCount) break; c += corners[i]; }
    c = normalize(c / float(edgeCount));
    float r = 0.0;
    for (int i = 0; i < 6; i++) { if (i >= edgeCount) break; r += length(corners[i] - c); }
    return r / float(edgeCount);
}

// Walk a hex's 6 edges and apply cliff erosion for every cliff
// edge to (bestMu, bestMidH). Used both for self and 1-hop neighbors.
void walkCliffEdges(
    vec3 unitDir,
    int selfH,
    int edgeCount,
    int neighborH[6],
    vec3 corners[6],
    float ownerHexRadius,
    float cliffNoise,
    float midNoise,
    float selfTierH,
    inout float bestMu,
    inout float bestMidH
) {
    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        if (!isCliffEdge(selfH, neighborH[i])) continue;
        vec3 a = corners[i];
        int nextIdx = (i + 1) == edgeCount ? 0 : (i + 1);
        vec3 b = corners[nextIdx];
        float dist = distToSegment(unitDir, a, b);
        bool steep = isSteepCliffEdge(selfH, neighborH[i]);
        float mu;
        if (steep) {
            float rampWidth = ownerHexRadius * 0.2;
            float perturbed = max(0.0, dist + cliffNoise * ownerHexRadius * 0.25);
            float t = min(perturbed / rampWidth, 1.0);
            mu = t * (2.0 - t);
        } else {
            float rampWidth = ownerHexRadius * 0.7;
            float t = min(dist / rampWidth, 1.0);
            mu = (1.0 - cos(t * 3.14159265)) / 2.0;
        }
        if (mu < bestMu) {
            float midTier = (selfTierH + levelHeight(neighborH[i])) * 0.5;
            bestMu = mu;
            bestMidH = midTier + (abs(midNoise) + 0.15) * noiseAmp * 0.3;
        }
    }
}

void main() {
    int id = int(hexId + 0.5);
    vec3 unitDir = normalize(position);

    // Self data
    int selfH, edgeCount;
    readHexData(id, selfH, edgeCount);
    int neighborH[6];
    readNeighbors(id, neighborH);
    vec3 corners[6];
    int nbIds[6];
    readCornersAndNeighborIds(id, corners, nbIds);

    // Noise
    vec4 noiseRGBA = textureLod(noiseCubemap, unitDir, 0.0);
    float rawNoise = noiseRGBA.r;
    float cliffNoise = noiseRGBA.g;
    float midNoise = rawNoise; // identical to CPU: midNoise === rawNoise

    bool isWaterHex = selfH <= 1;
    float selfTierH = levelHeight(selfH);
    float interiorNoiseH = isWaterHex ? abs(rawNoise) : (rawNoise + 0.3);
    float borderNoiseH = abs(rawNoise) + 0.15;
    float hexRadius = meanHexRadius(corners, edgeCount);

    // ── Walk non-excluded edges to find nearest border ─────
    float minDist = 1e9;
    float borderTarget = 0.0;
    int nearestEdgeIdx = -1;
    float nearestEdgeT = 0.0;
    float nearestBorderTarget = 0.0;
    bool hasBorder = false;

    // For coast smooth-min: accumulate exp(-d/k) for coast edges only
    float coastSmoothK = 0.22;
    float coastWeightSum = 0.0;
    bool hasCoastEdge = false;

    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        int nbH = neighborH[i];
        if (isExcludedEdge(selfH, nbH)) continue;

        vec3 a = corners[i];
        int nextIdx = (i + 1) == edgeCount ? 0 : (i + 1);
        vec3 b = corners[nextIdx];

        float dist; float tEdge;
        distAndT(unitDir, a, b, dist, tEdge);

        float target = computeBorderTarget(selfH, nbH);
        bool coast = isCoastEdge(selfH, nbH);

        if (dist < minDist) {
            minDist = dist;
            nearestEdgeIdx = i;
            nearestEdgeT = tEdge;
            nearestBorderTarget = target;
        }
        if (coast) {
            coastWeightSum += exp(-dist / coastSmoothK);
            hasCoastEdge = true;
        }
        hasBorder = true;
    }

    float h;
    if (!hasBorder) {
        // All edges excluded (typical for an inland land hex with only
        // land neighbors). Pure interior height — cliff erosion below
        // will pull it toward midTier near any cliff edge.
        h = selfTierH + interiorNoiseH * noiseAmp;
    } else {
        borderTarget = nearestBorderTarget;
        // Coast smooth-min: rounds the corner where two coast edges meet
        float dist = minDist;
        if (hasCoastEdge && nearestBorderTarget == 0.0 && coastWeightSum > 0.0) {
            float smoothD = -log(coastWeightSum) * coastSmoothK;
            dist = min(dist, smoothD);
        }
        float t01 = clamp(dist / hexRadius, 0.0, 1.0);
        float mu = (1.0 - cos(t01 * 3.14159265)) / 2.0;

        bool isWaterNeighborBorder = borderTarget < -0.001;
        float borderNoiseCoeff = isWaterNeighborBorder ? noiseAmp : noiseAmp * 0.3;
        float noiseCoeff = noiseAmp * mu + borderNoiseCoeff * (1.0 - mu);
        float noiseH = interiorNoiseH * mu + borderNoiseH * (1.0 - mu);
        h = selfTierH * mu + borderTarget * (1.0 - mu) + noiseH * noiseCoeff;

        // COAST_ROUNDING dip at coastal edge midpoint
        if (borderTarget == 0.0 && nearestEdgeIdx >= 0) {
            float coastMid = 4.0 * nearestEdgeT * (1.0 - nearestEdgeT);
            float coastBlend = mu * (1.0 - mu);
            h -= coastRounding * coastMid * coastBlend * 4.0;
        }
    }

    // ── Cliff erosion: self ─────────────────────────────────
    float bestMu = 1.0;
    float bestMidH = h;
    walkCliffEdges(unitDir, selfH, edgeCount, neighborH, corners,
                   hexRadius, cliffNoise, midNoise, selfTierH, bestMu, bestMidH);

    // ── Cliff erosion: 1-hop neighbors ──────────────────────
    // For EVERY edge of self, walk that neighbor's cliff edges using
    // the neighbor's own data. Walking all 6 neighbors (not just
    // non-cliff edges) ensures both sides of any shared edge see the
    // same set of nearby cliffs, so they compute identical bestMu.
    // Without this, a cliff hex C adjacent to both A and B would only
    // be 1-hop visited from the side where A-B is non-cliff, making
    // the seam mismatch.
    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        int nbId = nbIds[i];
        if (nbId < 0) continue;

        int nbHL, nbEdgeCount;
        readHexData(nbId, nbHL, nbEdgeCount);
        int nbNeighborH[6];
        readNeighbors(nbId, nbNeighborH);
        vec3 nbCorners[6];
        int nbNbIds[6];
        readCornersAndNeighborIds(nbId, nbCorners, nbNbIds);
        float nbHexRadius = meanHexRadius(nbCorners, nbEdgeCount);
        float nbTierH = levelHeight(nbHL);

        walkCliffEdges(unitDir, nbHL, nbEdgeCount, nbNeighborH, nbCorners,
                       nbHexRadius, cliffNoise, midNoise, nbTierH, bestMu, bestMidH);
    }

    if (bestMu < 1.0) {
        h = bestMidH * (1.0 - bestMu) + h * bestMu;
    }

    vec3 worldPos = unitDir * (planetRadius * (1.0 + h));
    vec4 wp = world * vec4(worldPos, 1.0);
    vWorldPos = wp.xyz;
    vLocalUV = localUV;
    vHeight = h;
    vTierH = selfTierH;
    vCliffMu = 1.0 - bestMu;
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
