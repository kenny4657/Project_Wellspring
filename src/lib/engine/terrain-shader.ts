/**
 * Terrain shader — custom ShaderMaterial for hex terrain rendering.
 *
 * Vertex shader: displaces hex mesh vertices based on per-instance terrain type.
 * Fragment shader: selects material color, blends at edges, applies province tint.
 *
 * Uses Babylon's ShaderMaterial with custom instance attributes.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_COUNT, packTerrainParams } from '$lib/world/terrain-types';

// ── GLSL Shader Sources ──

const VERTEX_SHADER = /* glsl */ `
precision highp float;

// Babylon.js standard uniforms
uniform mat4 viewProjection;

// Terrain parameter table
uniform vec4 terrainParams[${TERRAIN_COUNT}];   // [height, amplitude, frequency, ridged]
uniform vec4 terrainColors[${TERRAIN_COUNT}];   // [r, g, b, 1]

// Vertex attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;    // local hex UV: position within hex, -1 to 1
attribute vec2 uv2;   // x: 0 = top face, 1 = skirt vertex

// Instance attributes
attribute mat4 world;          // instance transform (position + rotation on globe)
attribute vec4 terrainData0;   // [terrainType, neighbor0, neighbor1, neighbor2]
attribute vec4 terrainData1;   // [neighbor3, neighbor4, neighbor5, padding]
attribute vec4 color;          // province/country tint RGBA

// Varyings
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vNeighborTypes[6];
varying vec4 vColor;
varying float vIsSkirt;

// ── Simplex noise (3D) ──
// Adapted from Ashima/webgl-noise (MIT license)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
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
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// fBm with 4 octaves
float fbm(vec3 p, float freq) {
    float value = 0.0;
    float amp = 0.5;
    vec3 pp = p * freq;
    for (int i = 0; i < 4; i++) {
        value += amp * snoise(pp);
        pp *= 2.0;
        amp *= 0.5;
    }
    return value;
}

// Ridged noise
float ridged(vec3 p, float freq) {
    float value = 0.0;
    float amp = 0.5;
    vec3 pp = p * freq;
    for (int i = 0; i < 4; i++) {
        float n = 1.0 - abs(snoise(pp));
        value += amp * n * n;
        pp *= 2.0;
        amp *= 0.5;
    }
    return value;
}

void main() {
    float terrainType = terrainData0.x;
    vTerrainType = terrainType;
    vNeighborTypes[0] = terrainData0.y;
    vNeighborTypes[1] = terrainData0.z;
    vNeighborTypes[2] = terrainData0.w;
    vNeighborTypes[3] = terrainData1.x;
    vNeighborTypes[4] = terrainData1.y;
    vNeighborTypes[5] = terrainData1.z;
    vColor = color;
    vHexUV = uv;
    vIsSkirt = uv2.x;

    int typeIdx = int(terrainType);
    vec4 params = terrainParams[typeIdx];
    float tierHeight = params.x;
    float amplitude = params.y;
    float frequency = params.z;
    float isRidged = params.w;

    // Distance from hex center (0 at center, 1 at edge)
    float distFromCenter = length(uv);

    // Compute world position for noise seed (use instance transform)
    vec4 worldOrigin = world * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 noiseSeed = worldOrigin.xyz * 0.01; // scale down for good noise frequency

    // Terrain displacement
    float displacement;
    if (isRidged > 0.5) {
        displacement = ridged(noiseSeed + position * 0.1, frequency) * amplitude;
    } else {
        displacement = fbm(noiseSeed + position * 0.1, frequency) * amplitude;
    }

    // Edge fade: blend displacement toward meeting height at hex boundary
    float edgeFade = smoothstep(0.5, 0.95, distFromCenter);

    // Compute nearest neighbor and its terrain height for edge blending
    float angle = atan(uv.y, uv.x); // -PI to PI
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);

    float neighborTypeIdx = vNeighborTypes[nearestEdge];
    float neighborHeight = terrainParams[int(neighborTypeIdx)].x;

    // Meeting height at edge = average of both terrain heights
    float meetingHeight = (tierHeight + neighborHeight) * 0.5;

    // Final Y displacement
    float finalHeight;
    if (uv2.x > 0.5) {
        // Skirt vertex: extend downward
        float skirtDepth = 30.0; // km below meeting height
        finalHeight = min(tierHeight, neighborHeight) - skirtDepth;
    } else {
        // Top face vertex: blend between terrain displacement and meeting height
        float terrainHeight = tierHeight + displacement * (1.0 - edgeFade);
        finalHeight = mix(terrainHeight, meetingHeight, edgeFade);
    }

    // Apply displacement along the surface normal (Y in local space = radial direction)
    vec3 displacedPos = position;
    displacedPos.y = finalHeight;

    // Transform to world space
    vec4 worldPos = world * vec4(displacedPos, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);

    gl_Position = viewProjection * worldPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec4 terrainColors[${TERRAIN_COUNT}];

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vNeighborTypes[6];
varying vec4 vColor;
varying float vIsSkirt;

// Simple directional light
uniform vec3 sunDirection;

void main() {
    int typeIdx = int(vTerrainType + 0.5);
    vec3 baseColor = terrainColors[typeIdx].rgb;

    // Distance from hex center
    float distFromCenter = length(vHexUV);

    // Edge blending with neighbor terrain
    float edgeBlend = smoothstep(0.5, 0.95, distFromCenter);

    // Determine nearest edge neighbor
    float angle = atan(vHexUV.y, vHexUV.x);
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);

    float neighborType = vNeighborTypes[nearestEdge];
    int neighborIdx = int(neighborType + 0.5);

    if (neighborIdx != typeIdx && edgeBlend > 0.0) {
        // Different terrain type at this edge — blend colors
        vec3 neighborColor = terrainColors[neighborIdx].rgb;

        // Check if this is a water↔land transition
        bool myWater = typeIdx <= 4;  // deep_ocean through lake
        bool neighborWater = neighborIdx <= 4;

        if (myWater != neighborWater) {
            // Water-land transition: add shore sand color
            vec3 shoreColor = vec3(0.76, 0.70, 0.50);
            baseColor = mix(baseColor, shoreColor, edgeBlend * 0.6);
        } else {
            // Same category: smooth material blend
            baseColor = mix(baseColor, neighborColor, edgeBlend * 0.4);
        }
    }

    // Basic lighting
    float NdotL = max(dot(vWorldNormal, sunDirection), 0.0);
    float ambient = 0.3;
    float diffuse = 0.7 * NdotL;
    vec3 litColor = baseColor * (ambient + diffuse);

    // Hex edge darkening (subtle grid lines)
    float edgeDarken = smoothstep(0.85, 0.95, distFromCenter) * 0.15;

    // Apply skirt darkening
    if (vIsSkirt > 0.5) {
        litColor *= 0.6; // darker sides
    }

    litColor *= (1.0 - edgeDarken);

    // Apply province/country color tint
    if (vColor.a > 0.0) {
        litColor = mix(litColor, vColor.rgb, vColor.a * 0.5);
    }

    gl_FragColor = vec4(litColor, 1.0);
}
`;

/**
 * Create the terrain ShaderMaterial with terrain parameter uniforms.
 */
export function createTerrainMaterial(scene: Scene): ShaderMaterial {
	// Register shader code with Babylon's effect system
	Effect.ShadersStore['terrainVertexShader'] = VERTEX_SHADER;
	Effect.ShadersStore['terrainFragmentShader'] = FRAGMENT_SHADER;

	const material = new ShaderMaterial('terrainMat', scene, {
		vertex: 'terrain',
		fragment: 'terrain',
	}, {
		attributes: ['position', 'normal', 'uv', 'uv2', 'world', 'terrainData0', 'terrainData1', 'color'],
		uniforms: ['viewProjection', 'terrainParams', 'terrainColors', 'sunDirection'],
		needAlphaBlending: false,
	});

	// Upload terrain parameters
	const { params, colors } = packTerrainParams();

	// Set uniform arrays (4 floats per terrain type)
	for (let i = 0; i < TERRAIN_COUNT; i++) {
		material.setFloat4(
			`terrainParams[${i}]`,
			params[i * 4 + 0], params[i * 4 + 1], params[i * 4 + 2], params[i * 4 + 3]
		);
		material.setFloat4(
			`terrainColors[${i}]`,
			colors[i * 4 + 0], colors[i * 4 + 1], colors[i * 4 + 2], colors[i * 4 + 3]
		);
	}

	// Sun direction (matches globe.ts directional light)
	material.setVector3('sunDirection', new (Vector3 as any)(-1, 0.5, 0.3).normalize());

	material.backFaceCulling = true;

	return material;
}

// Re-export Vector3 for the material setup
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
