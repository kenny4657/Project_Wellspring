/**
 * Terrain shader — custom ShaderMaterial for hex terrain rendering.
 *
 * Terrain params and colors are HARDCODED as GLSL constants (not uniforms)
 * to avoid WebGL uniform array issues. Regenerate this file if terrain
 * profiles change.
 */
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';

// Generate GLSL constant arrays from terrain profiles
function buildGlslConstants(): { paramsGlsl: string; colorsGlsl: string } {
	const N = TERRAIN_PROFILES.length;
	const paramLines = TERRAIN_PROFILES.map((p, i) =>
		`  tp[${i}] = vec4(${p.height.toFixed(1)}, ${p.amplitude.toFixed(1)}, ${p.frequency.toFixed(1)}, ${p.ridged ? '1.0' : '0.0'});`
	).join('\n');
	const colorLines = TERRAIN_PROFILES.map((p, i) =>
		`  tc[${i}] = vec3(${p.color[0].toFixed(2)}, ${p.color[1].toFixed(2)}, ${p.color[2].toFixed(2)});`
	).join('\n');

	return {
		paramsGlsl: `void initTerrainParams(out vec4 tp[${N}]) {\n${paramLines}\n}`,
		colorsGlsl: `void initTerrainColors(out vec3 tc[${N}]) {\n${colorLines}\n}`
	};
}

function buildShaders() {
	const N = TERRAIN_PROFILES.length;
	const { paramsGlsl, colorsGlsl } = buildGlslConstants();

	const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2;

#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif

attribute vec4 terrainData0;
attribute vec4 terrainData1;
attribute vec4 color;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vN0, vN1, vN2, vN3, vN4, vN5;
varying vec4 vColor;

// Terrain params as constants
${paramsGlsl}

// Simplex noise
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

float getNeighborHeight(int edge, vec4 tp[${N}]) {
    float nt;
    if (edge == 0) nt = terrainData0.y;
    else if (edge == 1) nt = terrainData0.z;
    else if (edge == 2) nt = terrainData0.w;
    else if (edge == 3) nt = terrainData1.x;
    else if (edge == 4) nt = terrainData1.y;
    else nt = terrainData1.z;
    return tp[int(nt)].x;
}

void main() {
    vTerrainType = terrainData0.x;
    vN0 = terrainData0.y; vN1 = terrainData0.z; vN2 = terrainData0.w;
    vN3 = terrainData1.x; vN4 = terrainData1.y; vN5 = terrainData1.z;
    vColor = color;
    vHexUV = uv;

    vec4 tp[${N}];
    initTerrainParams(tp);

    #ifdef INSTANCES
    mat4 finalWorld = world * mat4(world0, world1, world2, world3);
    #else
    mat4 finalWorld = world;
    #endif

    int typeIdx = int(terrainData0.x);
    vec4 params = tp[typeIdx];
    float tierHeight = params.x;
    float amplitude = params.y;
    float frequency = params.z;
    float isRidged = params.w;

    float distFromCenter = length(uv);

    vec4 worldOrigin = finalWorld * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 noiseSeed = worldOrigin.xyz * 0.01;

    float displacement;
    if (isRidged > 0.5) {
        displacement = ridged(noiseSeed + position * 0.1, frequency) * amplitude;
    } else {
        displacement = fbm(noiseSeed + position * 0.1, frequency) * amplitude;
    }

    float edgeFade = smoothstep(0.5, 0.95, distFromCenter);

    float angle = atan(uv.y, uv.x);
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);
    float neighborHeight = getNeighborHeight(nearestEdge, tp);

    float meetingHeight = (tierHeight + neighborHeight) * 0.5;
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

	const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 sunDirection;
uniform vec3 cameraPos;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vHexUV;
varying float vTerrainType;
varying float vN0, vN1, vN2, vN3, vN4, vN5;
varying vec4 vColor;

// Terrain colors as constants
${colorsGlsl}

float getNeighborType(int edge) {
    if (edge == 0) return vN0;
    if (edge == 1) return vN1;
    if (edge == 2) return vN2;
    if (edge == 3) return vN3;
    if (edge == 4) return vN4;
    return vN5;
}

void main() {
    vec3 tc[${N}];
    initTerrainColors(tc);

    int typeIdx = int(vTerrainType + 0.5);
    vec3 baseColor = tc[typeIdx];

    float distFromCenter = length(vHexUV);

    // Edge blending
    float edgeBlend = smoothstep(0.5, 0.95, distFromCenter);
    float angle = atan(vHexUV.y, vHexUV.x);
    float sector = mod(angle / (3.14159265 / 3.0) + 6.0, 6.0);
    int nearestEdge = int(floor(sector));
    nearestEdge = clamp(nearestEdge, 0, 5);

    float neighborType = getNeighborType(nearestEdge);
    int neighborIdx = int(neighborType + 0.5);

    if (neighborIdx != typeIdx && edgeBlend > 0.0) {
        vec3 neighborColor = tc[neighborIdx];
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
    vec3 toCamera = normalize(cameraPos - vWorldPos);
    float camDiffuse = max(dot(N, toCamera), 0.0);

    float light = 0.55 + 0.20 * sunDiffuse + 0.25 * camDiffuse;
    vec3 litColor = baseColor * light;

    // Hex edge line
    float edgeDarken = smoothstep(0.85, 0.95, distFromCenter) * 0.12;
    litColor *= (1.0 - edgeDarken);

    // Province/country tint
    if (vColor.a > 0.0) {
        litColor = mix(litColor, vColor.rgb, vColor.a * 0.5);
    }

    gl_FragColor = vec4(litColor, 1.0);
}
`;

	return { VERTEX, FRAGMENT };
}

export function createTerrainMaterial(scene: Scene): ShaderMaterial {
	const { VERTEX, FRAGMENT } = buildShaders();

	ShaderStore.ShadersStore['terrainVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['terrainFragmentShader'] = FRAGMENT;

	const material = new ShaderMaterial('terrainMat', scene, {
		vertex: 'terrain',
		fragment: 'terrain',
	}, {
		attributes: [
			'position', 'normal', 'uv', 'uv2',
			'terrainData0', 'terrainData1',
			'color'
		],
		uniforms: [
			'world', 'viewProjection',
			'sunDirection', 'cameraPos'
		],
		needAlphaBlending: false,
	});

	// Only 2 uniforms needed now — no more array hassles
	material.setVector3('sunDirection', new Vector3(-1, 0.5, 0.3).normalize());
	material.setVector3('cameraPos', Vector3.Zero());
	material.backFaceCulling = false;

	return material;
}
