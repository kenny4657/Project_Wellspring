/**
 * GPU displacement shader (Phase 2a).
 *
 * Vertex shader displaces unit-sphere hex meshes by:
 *   - sampling baked noise cubemap (raw + cliff channels)
 *   - reading hex tier from hexDataTex
 *   - walking the hex's 6 edges to find the nearest border, blending
 *     the interior tier+noise with the symmetric `min(self, nb)`
 *     border target so seams between adjacent hexes match exactly
 *
 * Fragment shader does Lambert lighting with face normals from
 * dFdx/dFdy. No terrain colors yet — just a base color so the
 * geometry is visible. Cliff erosion + terrain blending land in
 * Phase 2b/2c.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { HexDataTextures } from './hex-data-tex';
import type { HexCornersTexture } from './hex-corners-tex';
import { LEVEL_HEIGHTS } from '../hex-borders';
import { NOISE_AMP, NOISE_SCALE } from '../hex-heights';

const VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform mat4 world;
uniform mat4 viewProjection;

uniform float planetRadius;
uniform float noiseAmp;
uniform float noiseScale;
uniform vec4 levelHeights; // L0..L3
uniform float levelHeight4;

uniform samplerCube noiseCubemap;
uniform sampler2D hexDataTex;
uniform sampler2D hexNeighborsTex;
uniform sampler2D hexCornersTex;
uniform int hexTexWidth;
uniform int hexCornersTexWidth;

in vec3 position;     // unit direction on sphere
in float hexId;
in vec2 localUV;
in float wallFlag;

out vec3 vWorldPos;
out vec2 vLocalUV;
out float vWallFlag;
out float vHeight;
out float vTierH;

float levelHeight(int level) {
    if (level <= 0) return levelHeights.x;
    if (level == 1) return levelHeights.y;
    if (level == 2) return levelHeights.z;
    if (level == 3) return levelHeights.w;
    return levelHeight4;
}

vec3 readCorner(int id, int k) {
    int W = hexCornersTexWidth;
    int xCol = id % W;
    int yRow = (id / W) * 6 + k;
    return texelFetch(hexCornersTex, ivec2(xCol, yRow), 0).rgb;
}

ivec2 hexCoord(int id) {
    return ivec2(id % hexTexWidth, id / hexTexWidth);
}

// Distance from point P (on unit sphere) to great-circle segment AB.
// Linear approximation in 3D — same metric as CPU distToSegment.
float distToSegment(vec3 p, vec3 a, vec3 b) {
    vec3 ab = b - a;
    float ab2 = dot(ab, ab);
    float t = ab2 > 1e-12 ? clamp(dot(p - a, ab) / ab2, 0.0, 1.0) : 0.0;
    vec3 proj = a + ab * t;
    return length(p - proj);
}

void main() {
    vec3 unitDir = normalize(position);
    int id = int(hexId + 0.5);

    // Read this hex's data
    vec4 d = texelFetch(hexDataTex, hexCoord(id), 0);
    int heightLevel = int(d.r * 255.0 + 0.5);
    int packed = int(d.b * 255.0 + 0.5);
    int edgeCount = (packed >> 4) & 0xf;
    if (edgeCount < 5) edgeCount = 6; // safety: zero packed = full hex

    // Read neighbor heightLevels (4 bits each, packed in 3 bytes)
    vec4 nbPacked = texelFetch(hexNeighborsTex, hexCoord(id), 0);
    int n0 = int(nbPacked.r * 255.0 + 0.5);
    int n1 = int(nbPacked.g * 255.0 + 0.5);
    int n2 = int(nbPacked.b * 255.0 + 0.5);
    int neighbors[6];
    neighbors[0] = n0 & 0xf;
    neighbors[1] = (n0 >> 4) & 0xf;
    neighbors[2] = n1 & 0xf;
    neighbors[3] = (n1 >> 4) & 0xf;
    neighbors[4] = n2 & 0xf;
    neighbors[5] = (n2 >> 4) & 0xf;

    // Sample noise
    vec4 noiseRGBA = textureLod(noiseCubemap, unitDir, 0.0);
    float rawNoise = noiseRGBA.r;

    bool isWaterHex = heightLevel <= 1;
    float tierH = levelHeight(heightLevel);
    float interiorNoiseH = isWaterHex ? abs(rawNoise) : (rawNoise + 0.3);
    float borderNoiseH = abs(rawNoise) + 0.15;

    // Walk edges: find the nearest one to determine border distance.
    // Each edge i is between corner i and corner (i+1) % edgeCount.
    // Use a fixed loop of 6 with edgeCount early-out.
    vec3 corners[6];
    for (int i = 0; i < 6; i++) corners[i] = readCorner(id, i);

    float minDist = 1e9;
    float borderTarget = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        vec3 a = corners[i];
        vec3 b = corners[(i + 1) % 6];
        if (i + 1 == edgeCount) b = corners[0]; // wrap pentagon
        float dist = distToSegment(unitDir, a, b);
        if (dist < minDist) {
            minDist = dist;
            int nbH = neighbors[i];
            // Symmetric target so both sides of the edge agree:
            // target = levelHeight(min(self, nb)).
            int sharedLevel = min(heightLevel, nbH);
            borderTarget = levelHeight(sharedLevel);
        }
    }

    // Compute hexRadius from corner 0 distance to hex center.
    // Approximate hex center as the mean of corners on the unit sphere.
    vec3 cellCenter = vec3(0.0);
    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        cellCenter += corners[i];
    }
    cellCenter = normalize(cellCenter / float(edgeCount));
    float hexRadius = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= edgeCount) break;
        hexRadius += length(corners[i] - cellCenter);
    }
    hexRadius /= float(edgeCount);

    float t = clamp(minDist / hexRadius, 0.0, 1.0);
    float mu = (1.0 - cos(t * 3.14159265)) / 2.0;

    // Border vs interior noise coefficient (matches CPU):
    // - water-water border: full NOISE_AMP
    // - water-land or land-land: NOISE_AMP * 0.3
    bool isWaterNeighbor = borderTarget < -0.001;
    float borderNoiseCoeff = isWaterNeighbor ? noiseAmp : noiseAmp * 0.3;
    float noiseCoeff = noiseAmp * mu + borderNoiseCoeff * (1.0 - mu);
    float noiseH = interiorNoiseH * mu + borderNoiseH * (1.0 - mu);

    float h = tierH * mu + borderTarget * (1.0 - mu) + noiseH * noiseCoeff;

    vec3 worldPos = unitDir * (planetRadius * (1.0 + h));
    vec4 wp = world * vec4(worldPos, 1.0);
    vWorldPos = wp.xyz;
    vLocalUV = localUV;
    vWallFlag = wallFlag;
    vHeight = h;
    vTierH = tierH;
    gl_Position = viewProjection * wp;
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec2 vLocalUV;
in float vWallFlag;
in float vHeight;
in float vTierH;

uniform vec3 sunDir;
uniform vec3 cameraPos;

out vec4 fragColor;

void main() {
    // Face normal via screen-space derivatives — gives flat per-tri shading.
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 N = normalize(cross(dy, dx));

    // Base color tinted by tier so different heightLevels look distinct.
    vec3 base;
    if (vTierH < -0.01)        base = vec3(0.10, 0.18, 0.32); // deep water
    else if (vTierH < -0.001)  base = vec3(0.16, 0.30, 0.45); // shallow
    else if (vTierH < 0.001)   base = vec3(0.62, 0.78, 0.42); // lowland
    else if (vTierH < 0.008)   base = vec3(0.45, 0.55, 0.30); // midland
    else                       base = vec3(0.55, 0.50, 0.45); // highland

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
		attributes: ['position', 'hexId', 'localUV', 'wallFlag'],
		uniforms: [
			'world', 'viewProjection',
			'planetRadius', 'noiseAmp', 'noiseScale',
			'levelHeights', 'levelHeight4',
			'hexTexWidth', 'hexCornersTexWidth',
			'sunDir', 'cameraPos',
		],
		samplers: ['noiseCubemap', 'hexDataTex', 'hexNeighborsTex', 'hexCornersTex'],
	});

	mat.setFloat('planetRadius', planetRadius);
	mat.setFloat('noiseAmp', NOISE_AMP);
	mat.setFloat('noiseScale', NOISE_SCALE);
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
