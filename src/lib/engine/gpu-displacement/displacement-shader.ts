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
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { HexDataTextures } from './hex-data-tex';
import type { HexCornersTexture } from './hex-corners-tex';
import { LEVEL_HEIGHTS } from '../hex-borders';
import { NOISE_AMP, NOISE_SCALE, BASE_HEIGHT, COAST_ROUNDING } from '../hex-heights';
import { loadTerrainSettings, packCustomPalettes, packCliffPalettes, type TerrainSettings } from '$lib/world/terrain-types';

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
flat out int vTerrainId;
flat out int vHeightLevel;

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

void readHexData(int id, out int heightLevel, out int edgeCount, out bool hasCliffNbr) {
    vec4 d = texelFetch(hexDataTex, hexCoord(id), 0);
    heightLevel = int(d.r * 255.0 + 0.5);
    int packed = int(d.b * 255.0 + 0.5);
    edgeCount = (packed >> 4) & 0xf;
    if (edgeCount < 5) edgeCount = 6;
    hasCliffNbr = (int(d.a * 255.0 + 0.5) & 1) != 0;
}

int readTerrainId(int id) {
    vec4 d = texelFetch(hexDataTex, hexCoord(id), 0);
    return int(d.g * 255.0 + 0.5);
}

void readCornersAndNeighborIds(int id, out vec3 corners[12], out int nbIds[12]) {
    // Reads all 12 slots — early-break by edgeCount caused visible gaps
    // (pre-existing issue, see prior session notes). Cells with fewer
    // corners pad slots with duplicates so loops stay safe.
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
        // Rocky cliff coloring only for STEEP cliffs (gap≥2 land or water
        // vs tall land). Gentle 1-tier land slopes still smooth-ramp via
        // the height-blend above but render with terrain color, not rock.
        if (steep && rock && mu < rockMu) rockMu = mu;
    }
}

void main() {
    int id = int(hexId + 0.5);
    vec3 unitDir = normalize(position);

    // Self data
    int selfH, edgeCount;
    bool selfHasCliffNbr;
    readHexData(id, selfH, edgeCount, selfHasCliffNbr);
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

        // Cheap probe: just one texelFetch for the neighbor's hexData.
        // If the neighbor has no cross-tier neighbors of its own, no
        // cliff edges can come from it — skip the rest of the reads
        // (saves ~14 texelFetches per skipped neighbor for the bulk
        // of the planet that's deep-interior single-tier).
        int nbHL, nbEdgeCount;
        bool nbHasCliffNbr;
        readHexData(nbId, nbHL, nbEdgeCount, nbHasCliffNbr);
        if (!nbHasCliffNbr) continue;

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
    vTerrainId = readTerrainId(id);
    vHeightLevel = selfH;
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
flat in int vTerrainId;
flat in int vHeightLevel;

uniform vec3 sunDir;
uniform vec3 fillDir;
uniform vec3 cameraPos;
uniform float planetRadius;
uniform float seaLevel;
uniform float bottomOffset;
uniform float topOffset;
uniform vec3 terrainPalette[40]; // 10 types × 4 bands [shore, grass, hill, snow]
uniform float terrainBlend[10];
uniform float terrainBlendPos[10];
uniform vec3 cliffPalette[30];   // 10 types × 3 bands [light, dark, pale]

out vec4 fragColor;

// ── Simplex 3D noise (matches terrain-material.ts) ───────────
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
    float nv = 1.0/7.0;
    vec3  ns = nv * D.wyz - D.xzx;
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
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// Full 4-octave triplanar scratchy on land — same as terrain-material.ts.
// Water fragments skip this entirely (gated at the call site).
float scratchyPattern(vec2 uv) {
    float n1 = snoise(vec3(uv * 18.0, 0.0)) * 0.4;
    float n2 = snoise(vec3(uv * 35.0, 1.5)) * 0.3;
    float n3 = snoise(vec3(uv * 70.0, 3.0)) * 0.2;
    float n4 = snoise(vec3(uv * 140.0, 5.0)) * 0.1;
    return n1 + n2 + n3 + n4;
}
float triplanarScratchy(vec3 worldPos, vec3 normal, float scale) {
    vec3 blend = abs(normal);
    blend = blend / (blend.x + blend.y + blend.z + 0.001);
    float tx = scratchyPattern(worldPos.yz * scale);
    float ty = scratchyPattern(worldPos.xz * scale);
    float tz = scratchyPattern(worldPos.xy * scale);
    return tx * blend.x + ty * blend.y + tz * blend.z;
}

// ── Per-terrain palette lookup + 4-band height blend ─────────
vec3 palShore(int id, float s) { return terrainPalette[id * 4]     * (1.0 + s * 0.10); }
vec3 palGrass(int id, float s) { return terrainPalette[id * 4 + 1] * (1.0 + s * 0.14); }
vec3 palHill (int id, float s) { return terrainPalette[id * 4 + 2] * (1.0 + s * 0.14); }
vec3 palSnow (int id, float s) { return terrainPalette[id * 4 + 3] * (1.0 + s * 0.08); }

vec3 computeTerrainColor(int id, float heightAboveR, float tierH, float scratchy) {
    float amplitude = abs(topOffset) + abs(bottomOffset);
    float noiseAmpW = 0.008 * planetRadius;
    float noiseBias = 0.3 * noiseAmpW;
    float sw = terrainBlend[id] * amplitude;
    float tierBase = (id <= 3) ? seaLevel : (tierH + noiseBias);
    float refLevel = tierBase + terrainBlendPos[id] * amplitude;
    float boundary1 = refLevel;
    float boundary2 = tierBase + noiseAmpW * 0.6;
    float boundary3 = tierBase + noiseAmpW * 0.85;
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

void main() {
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 N = normalize(cross(dy, dx));

    int terrainId = clamp(vTerrainId, 0, 9);
    float tierHKm = vTierH * planetRadius;     // unit-sphere → world km
    float heightAboveR = vHeight * planetRadius;
    // Skip surface scratchy on water hexes — water doesn't need rocky
    // grain and we already get specular highlights below. Halves the
    // fragment cost for the entire ocean.
    bool isWaterFrag = vHeightLevel <= 1;
    float scratchy = isWaterFrag ? 0.0 : triplanarScratchy(vWorldPos, N, 0.004);

    // Own terrain color, height-banded. Clamp height above the shore band
    // so shore color appears only on the actual shoreline (we don't have
    // a beach overlay yet — Phase 3 simplification).
    float noiseAmpW = 0.008 * planetRadius;
    float noiseBias = 0.3 * noiseAmpW;
    float inlandH = tierHKm + noiseBias;
    float colorH = max(heightAboveR, inlandH);
    vec3 procColor = computeTerrainColor(terrainId, colorH, tierHKm, scratchy);

    // Cliff face — only fires when vCliffMu (= 1 - rockMu) is high, i.e.
    // we're near a real rock cliff. Smooth coast / water-step transitions
    // do not set rockMu, so they stay terrain-colored.
    if (vCliffMu > 0.01) {
        vec3 cliffLight = cliffPalette[terrainId * 3];
        vec3 cliffDark  = cliffPalette[terrainId * 3 + 1];
        vec3 cliffPale  = cliffPalette[terrainId * 3 + 2];
        float t = clamp(scratchy * 0.5 + 0.5, 0.0, 1.0);
        vec3 rockColor = mix(cliffLight, cliffDark, t);
        rockColor = mix(rockColor, cliffPale, smoothstep(0.65, 0.85, t) * 0.45);
        // Surface steepness suppresses cliff coloring on flat tops.
        float steepness = 1.0 - dot(N, normalize(vWorldPos));
        float erosionBlend = smoothstep(0.003, 0.06, steepness)
                           * smoothstep(0.0, 0.5, vCliffMu);
        procColor = mix(procColor, rockColor, erosionBlend);
    }

    // Lighting (matches terrain-material.ts)
    float ambient = 0.55;
    float sunL  = max(0.0, dot(N, sunDir))  * 0.45;
    float fillL = max(0.0, dot(N, fillDir)) * 0.15;
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float camL  = max(0.0, dot(N, toCamera)) * 0.25;
    float light = ambient + sunL + fillL + camL;
    vec3 litColor = procColor * light;

    // Subtle specular on water surfaces.
    if (isWaterFrag) {
        vec3 halfVec = normalize(sunDir + toCamera);
        float spec = pow(max(0.0, dot(N, halfVec)), 64.0);
        litColor += vec3(1.0, 0.98, 0.92) * spec * 0.10;
    }

    fragColor = vec4(litColor, 1.0);
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
			'sunDir', 'fillDir', 'cameraPos',
			'seaLevel', 'bottomOffset', 'topOffset',
			'terrainPalette', 'terrainBlend', 'terrainBlendPos', 'cliffPalette',
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
	// Per-terrain palette + height bands. Same scheme as terrain-material.ts.
	mat.setVector3('fillDir', new Vector3(1, -0.3, -0.5).normalize());
	mat.setFloat('seaLevel', -0.002 * planetRadius);
	mat.setFloat('bottomOffset', -0.020 * planetRadius);
	mat.setFloat('topOffset', 0.080 * planetRadius);
	const settings = loadTerrainSettings();
	mat.setArray3('terrainPalette', packCustomPalettes(settings.palettes));
	mat.setFloats('terrainBlend', settings.blends);
	mat.setFloats('terrainBlendPos', settings.blendPositions);
	if (settings.cliffPalettes) {
		mat.setArray3('cliffPalette', packCliffPalettes(settings.cliffPalettes));
	}
	mat.backFaceCulling = true;

	return mat;
}

/** Update palette + blend uniforms at runtime (mirrors applyTerrainSettings
 *  in terrain-material.ts so the GPU path receives ColorsTab edits too). */
export function applyDisplacementSettings(mat: ShaderMaterial, settings: TerrainSettings): void {
	mat.setArray3('terrainPalette', packCustomPalettes(settings.palettes));
	mat.setFloats('terrainBlend', settings.blends);
	mat.setFloats('terrainBlendPos', settings.blendPositions);
	if (settings.cliffPalettes) {
		mat.setArray3('cliffPalette', packCliffPalettes(settings.cliffPalettes));
	}
}
