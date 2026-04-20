/**
 * Terrain shader — custom ShaderMaterial for hex terrain rendering.
 *
 * Vertex shader: displaces hex mesh vertices based on per-instance terrain type.
 * Fragment shader: selects material color, blends at edges, applies province tint.
 *
 * Babylon.js automatically adds #define INSTANCES, #define THIN_INSTANCES,
 * and world0-world3 attributes for thin instances. Our shader must handle
 * both the instanced and non-instanced paths via #ifdef.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_COUNT, packTerrainParams } from '$lib/world/terrain-types';

// ── GLSL Shader Sources ──

const VERTEX_SHADER = /* glsl */ `
precision highp float;

// Babylon.js standard uniforms
uniform mat4 world;
uniform mat4 viewProjection;

// Terrain parameter table
uniform vec4 terrainParams[${TERRAIN_COUNT}];

// Vertex attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;    // local hex UV: position within hex, -1 to 1
attribute vec2 uv2;   // x: 0 = top face, 1 = skirt vertex

// Instance attributes (Babylon auto-adds world0-world3 via #define INSTANCES)
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif

// Custom instance attributes
attribute vec4 terrainData0;   // [terrainType, neighbor0, neighbor1, neighbor2]
attribute vec4 terrainData1;   // [neighbor3, neighbor4, neighbor5, padding]
attribute vec4 color;          // province/country tint RGBA

// Varyings (no arrays — GLSL ES doesn't support varying arrays)
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vN0, vN1, vN2, vN3, vN4, vN5; // 6 neighbor types
varying vec4 vColor;
varying float vIsSkirt;

// ── Simplex noise (3D) — Ashima/webgl-noise (MIT) ──
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
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
    i = mod289v3(i);
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

float fbm(vec3 p, float freq) {
    float val = 0.0; float amp = 0.5; vec3 pp = p * freq;
    for (int i = 0; i < 4; i++) { val += amp * snoise(pp); pp *= 2.0; amp *= 0.5; }
    return val;
}

float ridged(vec3 p, float freq) {
    float val = 0.0; float amp = 0.5; vec3 pp = p * freq;
    for (int i = 0; i < 4; i++) { float n = 1.0 - abs(snoise(pp)); val += amp * n * n; pp *= 2.0; amp *= 0.5; }
    return val;
}

// Get neighbor height by index (GLSL ES can't index varyings dynamically)
float getNeighborHeight(int edge) {
    float nt;
    if (edge == 0) nt = terrainData0.y;
    else if (edge == 1) nt = terrainData0.z;
    else if (edge == 2) nt = terrainData0.w;
    else if (edge == 3) nt = terrainData1.x;
    else if (edge == 4) nt = terrainData1.y;
    else nt = terrainData1.z;
    return terrainParams[int(nt)].x;
}

void main() {
    // Pass terrain data to fragment shader
    vTerrainType = terrainData0.x;
    vN0 = terrainData0.y; vN1 = terrainData0.z; vN2 = terrainData0.w;
    vN3 = terrainData1.x; vN4 = terrainData1.y; vN5 = terrainData1.z;
    vColor = color;
    vHexUV = uv;
    vIsSkirt = uv2.x;

    // Build final world matrix
    #ifdef INSTANCES
    mat4 finalWorld = world * mat4(world0, world1, world2, world3);
    #else
    mat4 finalWorld = world;
    #endif

    // Terrain params
    int typeIdx = int(terrainData0.x);
    vec4 params = terrainParams[typeIdx];
    float tierHeight = params.x;
    float amplitude = params.y;
    float frequency = params.z;
    float isRidged = params.w;

    // Distance from hex center
    float distFromCenter = length(uv);

    // Noise seed from world position
    vec4 worldOrigin = finalWorld * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 noiseSeed = worldOrigin.xyz * 0.01;

    // Terrain noise displacement
    float displacement;
    if (isRidged > 0.5) {
        displacement = ridged(noiseSeed + position * 0.1, frequency) * amplitude;
    } else {
        displacement = fbm(noiseSeed + position * 0.1, frequency) * amplitude;
    }

    // Edge fade toward meeting height
    float edgeFade = smoothstep(0.5, 0.95, distFromCenter);

    // Nearest edge neighbor
    float angle = atan(uv.y, uv.x);
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);
    float neighborHeight = getNeighborHeight(nearestEdge);

    // Meeting height
    float meetingHeight = (tierHeight + neighborHeight) * 0.5;

    // Final Y displacement
    float th = tierHeight + displacement * (1.0 - edgeFade);
    float finalHeight = mix(th, meetingHeight, edgeFade);

    vec3 displacedPos = position;
    displacedPos.y = finalHeight;

    vec4 worldPos = finalWorld * vec4(displacedPos, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize((finalWorld * vec4(normal, 0.0)).xyz);

    gl_Position = viewProjection * worldPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec4 terrainColors[${TERRAIN_COUNT}];
uniform vec3 sunDirection;
uniform vec3 cameraPos;  // updated each frame from camera position

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vN0, vN1, vN2, vN3, vN4, vN5;
varying vec4 vColor;
varying float vIsSkirt;

float getNeighborType(int edge) {
    if (edge == 0) return vN0;
    if (edge == 1) return vN1;
    if (edge == 2) return vN2;
    if (edge == 3) return vN3;
    if (edge == 4) return vN4;
    return vN5;
}

void main() {
    int typeIdx = int(vTerrainType + 0.5);
    vec3 baseColor = terrainColors[typeIdx].rgb;

    float distFromCenter = length(vHexUV);

    // Edge blending with neighbor terrain
    float edgeBlend = smoothstep(0.5, 0.95, distFromCenter);

    float angle = atan(vHexUV.y, vHexUV.x);
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);

    float neighborType = getNeighborType(nearestEdge);
    int neighborIdx = int(neighborType + 0.5);

    if (neighborIdx != typeIdx && edgeBlend > 0.0) {
        vec3 neighborColor = terrainColors[neighborIdx].rgb;
        bool myWater = typeIdx <= 4;
        bool neighborWater = neighborIdx <= 4;

        if (myWater != neighborWater) {
            vec3 shoreColor = vec3(0.85, 0.78, 0.55);
            baseColor = mix(baseColor, shoreColor, edgeBlend * 0.6);
        } else {
            baseColor = mix(baseColor, neighborColor, edgeBlend * 0.4);
        }
    }

    // Lighting: sun + camera headlight
    vec3 N = normalize(vWorldNormal);
    float sunDiffuse = max(dot(N, sunDirection), 0.0);

    // Camera headlight: always illuminates what the camera sees
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float camDiffuse = max(dot(N, toCamera), 0.0);

    // Combine: high ambient + sun + camera light
    float light = 0.45 + 0.25 * sunDiffuse + 0.30 * camDiffuse;
    vec3 litColor = baseColor * light;

    // Subtle hex edge line
    float edgeDarken = smoothstep(0.85, 0.95, distFromCenter) * 0.12;
    litColor *= (1.0 - edgeDarken);

    // Province/country tint
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
	ShaderStore.ShadersStore['terrainVertexShader'] = VERTEX_SHADER;
	ShaderStore.ShadersStore['terrainFragmentShader'] = FRAGMENT_SHADER;

	const material = new ShaderMaterial('terrainMat', scene, {
		vertex: 'terrain',
		fragment: 'terrain',
	}, {
		attributes: [
			'position', 'normal', 'uv', 'uv2',
			// DO NOT include world0-world3 — Babylon adds them automatically for instances
			'terrainData0', 'terrainData1',
			'color'
		],
		uniforms: [
			'world', 'viewProjection',
			'terrainParams', 'terrainColors', 'sunDirection', 'cameraPos'
		],
		// DO NOT include INSTANCES/THIN_INSTANCES defines — Babylon adds them automatically
		needAlphaBlending: false,
	});

	// Upload terrain parameters as individual vec4 uniforms
	// setFloats uses glUniform1fv which doesn't match vec4 arrays —
	// must set each element individually via setVector4
	const { params, colors } = packTerrainParams();
	for (let i = 0; i < TERRAIN_COUNT; i++) {
		material.setVector4(`terrainParams[${i}]`, new Vector4(
			params[i * 4 + 0], params[i * 4 + 1], params[i * 4 + 2], params[i * 4 + 3]
		));
		material.setVector4(`terrainColors[${i}]`, new Vector4(
			colors[i * 4 + 0], colors[i * 4 + 1], colors[i * 4 + 2], colors[i * 4 + 3]
		));
	}

	material.setVector3('sunDirection', new Vector3(-1, 0.5, 0.3).normalize());
	material.backFaceCulling = false; // show both sides during dev

	return material;
}
