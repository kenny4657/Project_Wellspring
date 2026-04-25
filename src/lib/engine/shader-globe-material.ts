/**
 * Phase 4 -- shader-driven globe material with full biome shading.
 *
 * The plan's "biggest piece": port the legacy terrain-material.ts GLSL onto
 * the new texture-driven inputs. Same palette logic, blend curves, beach
 * overlay math, cliff math, and lighting; only the data sources change:
 *
 *   - terrainId       : terrainTex sampled at hexCoord(worldPosToHexId(P))
 *   - heightLevel     : heightTex same way
 *   - neighbor + dist : `distanceToHexEdge` (this file)
 *   - cliff proximity : edge distance against neighbors with different heightLevel
 *   - coast proximity : edge distance against water/land neighbors
 *
 * Phase 4 leaves elevation flat (no vertex displacement). Phase 5 will add
 * displacement; this material's heightAboveR will then start tracking real
 * elevation without any code change. Phase 4 deliverable per plan: "the new
 * sphere looks identical to the legacy globe at 60 fps with no elevation."
 *
 * Brace structure (mirrors legacy terrain-material.ts main()):
 *   void main() {
 *       ... shared setup ...
 *       if (isWall) { /<unused on smooth sphere/> }
 *       else {
 *           ... GLSL_MAIN_SETUP_NEW (ends OPEN, no closing `}`) ...
 *           ... GLSL_CLIFF_RENDERING (ends OPEN) ...
 *           ... GLSL_BEACH_OVERLAY (closes the else with `}`) ...
 *       }
 *       ... GLSL_LIGHTING (closes main with `}`) ...
 *   }
 *
 * GLSL_BEACH_OVERLAY's trailing `}` closes the else; GLSL_LIGHTING's `}`
 * closes main. That match is load-bearing: the imported chunks rely on
 * GLSL_MAIN_SETUP_NEW opening exactly one extra block before them.
 */

import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import type { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
	GLSL_NOISE,
	GLSL_SCRATCHY,
	GLSL_PALETTE,
	GLSL_COASTAL_CONSTANTS,
	GLSL_CLIFF_RENDERING,
	GLSL_BEACH_OVERLAY,
	GLSL_LIGHTING,
} from './terrain-material';
import { loadTerrainSettings, packCustomPalettes, packCliffPalettes, type TerrainSettings } from '$lib/world/terrain-types';
import type { HexIdLookup } from './hex-id-lookup';
import type { HexDataTextures } from './hex-data-textures';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;
attribute vec3 normal;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vSpherePos;
// Legacy GLSL_NOISE chunk declares varying vec4 vColor; the fragment
// imports that chunk. Babylon's WebGL2 path turns varyings into in/out,
// so the link requires an out vec4 vColor here even though we never use it.
// Write a dummy; unused varyings get optimized out at link time.
varying vec4 vColor;

void main() {
    vec4 wp = world * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize((world * vec4(normal, 0.0)).xyz);
    vSpherePos = normalize(wp.xyz);
    vColor = vec4(0.0);
    gl_Position = viewProjection * wp;
}
`;

// ── GLSL_HEADER_PHASE4 ──────────────────────────────────────
// Adds Phase 1 / 2 / 4 uniforms and the vSpherePos varying. Does NOT
// re-declare precision or the lighting/palette uniforms -- GLSL_NOISE
// (imported below) brings those.
const GLSL_HEADER_PHASE4 = /* glsl */ `
varying vec3 vSpherePos;

// Phase 1 data textures, keyed by hexId (x = id % size, y = floor(id / size)).
uniform sampler2D terrainTex;
uniform sampler2D heightTex;
uniform float dataTexSize;

// Phase 4 water rendering. Same names as water-material.ts so a future
// shared "water-color settings" surface (Colors tab extension) can drive
// both renderers from one source.
uniform vec3 deepColor;
uniform vec3 shallowColor;

// Phase 2 hex lookup uniforms (same names the debug material uses).
uniform sampler2D hexLookup;
uniform float gridSize;       // = res + 2
uniform float resolution;     // legacy alias kept for clarity
uniform vec3 faceCentroid[20];
uniform vec3 faceVertA[20];
uniform vec3 faceVertB[20];
uniform vec3 faceVertC[20];
uniform vec3 pentagonVert[12];
uniform float pentagonId[12];
uniform float pentagonThreshold;
`;

// ── GLSL_HEX_LOOKUP ─────────────────────────────────────────
// Sets globals g_hexId, g_face, g_i, g_j, g_isPentagon. Same algorithm as
// shader-globe-debug-material's worldPosToHexId. Surfaces face/i/j as
// shared globals so Phase 4's distanceToHexEdge can reuse them.
const GLSL_HEX_LOOKUP = /* glsl */ `
const float SQRT3_P4 = 1.7320508075688772;
const float NO_HEX_P4 = 65535.0;

float g_hexId;
int g_face;
int g_i;
int g_j;
bool g_isPentagon;
vec2 g_P2D;       // P projected onto face triangle plane, in face-local 2D
vec2 g_self_2d;   // self center in face-local 2D

int findFace(vec3 P) {
    int best = 0;
    float bestDot = -2.0;
    for (int f = 0; f < 20; f++) {
        float d = dot(P, faceCentroid[f]);
        if (d > bestDot) { bestDot = d; best = f; }
    }
    return best;
}

vec3 baryGnomonic(vec3 P, vec3 v0, vec3 v1, vec3 v2) {
    vec3 e1 = v1 - v0;
    vec3 e2 = v2 - v0;
    vec3 n = cross(e1, e2);
    float t = dot(n, v0) / dot(n, P);
    vec3 Q = P * t;
    vec3 d = Q - v0;
    float invDen = 1.0 / dot(n, n);
    float l2 = dot(cross(d, e2), n) * invDen;
    float l3 = dot(cross(e1, d), n) * invDen;
    float l1 = 1.0 - l2 - l3;
    return vec3(l1, l2, l3);
}

float sampleLookupFace(int face, int i, int j) {
    if (i < 0 || j < 0) return -1.0;
    float gs = gridSize;
    if (float(i) >= gs || float(j) >= gs) return -1.0;
    float texW = 20.0 * gs;
    float texH = gs;
    float fx = (float(face) * gs + float(j) + 0.5) / texW;
    float fy = (float(i) + 0.5) / texH;
    vec4 t = texture2D(hexLookup, vec2(fx, fy));
    float low = floor(t.r * 255.0 + 0.5);
    float high = floor(t.g * 255.0 + 0.5);
    float id = low + high * 256.0;
    if (id >= NO_HEX_P4) return -1.0;
    return id;
}

float pentagonHit(vec3 P) {
    for (int v = 0; v < 12; v++) {
        if (dot(P, pentagonVert[v]) > pentagonThreshold) {
            return pentagonId[v];
        }
    }
    return -1.0;
}

vec2 selfCenter2D(int i, int j) {
    float r = 0.5 / (resolution + 1.0);
    float diameter = 2.0 * r * 2.0 / SQRT3_P4;
    float rowStep = diameter * 0.75;
    float cx = -0.5 + 2.0 * r * float(j) + ((mod(float(i), 2.0) > 0.5) ? r : 0.0);
    float cz = rowStep * float(i);
    return vec2(cx, cz);
}

void computeHexLookup(vec3 P) {
    g_isPentagon = false;
    g_face = -1; g_i = -1; g_j = -1;
    g_P2D = vec2(0.0);
    g_self_2d = vec2(0.0);

    float pent = pentagonHit(P);
    g_isPentagon = (pent >= 0.0);
    // Don't early-return for pentagons. We still want g_face/g_i/g_j filled
    // so downstream can run the 6-neighbor scan and pick up coast / cliff /
    // cross-blend overlays at pentagon hexes. The face-grid lookup at the
    // pentagon's position returns the same cellId pent would, but in many
    // faces (the pentagon shares 5 face triangles); pick whichever face the
    // dot product picks. The scan's row-parity offset table will produce
    // 5 valid neighbors and 1 out-of-grid (-1) -- matching the pentagon's
    // 5-neighbor topology naturally.
    int face = findFace(P);
    vec3 v0 = faceVertA[face];
    vec3 v1 = faceVertB[face];
    vec3 v2 = faceVertC[face];
    vec3 bary = baryGnomonic(P, v0, v1, v2);
    float l3 = bary.z;
    float l2 = bary.y;
    float cz = l3 * SQRT3_P4 * 0.5;
    float cx = l2 - 0.5 * (1.0 - l3);
    float r = 0.5 / (resolution + 1.0);
    float diameter = 2.0 * r * 2.0 / SQRT3_P4;
    float rowStep = diameter * 0.75;
    float iF = cz / rowStep;
    int i = int(floor(iF + 0.5));
    float oddOffset = (mod(float(i), 2.0) > 0.5) ? r : 0.0;
    float jF = (cx + 0.5 - oddOffset) / (2.0 * r);
    int j = int(floor(jF + 0.5));
    g_face = face; g_i = i; g_j = j;
    g_P2D = vec2(cx, cz);
    g_self_2d = selfCenter2D(i, j);
    // For pentagons, prefer the pentagon-table id (it's authoritative; the
    // face-grid may return any of the 5 face entries). Otherwise use the
    // standard face-grid lookup.
    g_hexId = g_isPentagon ? pent : sampleLookupFace(face, i, j);
}
`;

// ── GLSL_HEX_EDGE ───────────────────────────────────────────
// Phase 4's `distanceToHexEdge` and 6-neighbor scan.
//
// Edge geometry: pointy-top hexes (corners at -30deg + k*60deg). Edges
// between consecutive corners; edge midpoint angle = k*60deg; edge normal
// = same direction. Distance from P to edge k (when P is inside the hex)
// = apothem - dot(P - center, normal_k).
//
// Neighbor offsets (from icosphere.ts -- depend on row parity because odd
// rows are shifted by +r in x):
//   k=0..5 -> direction (cos, sin) at k*60deg. Offsets:
//     even row: (0,+1), (+1, 0), (+1,-1), (0,-1), (-1,-1), (-1, 0)
//     odd  row: (0,+1), (+1,+1), (+1, 0), (0,-1), (-1, 0), (-1,+1)
//
// Out-of-grid neighbors return -1; the legacy renderer didn't have a
// concept of cross-face neighbors either, so blending simply doesn't
// trigger across icosphere face seams. Phase 7 may revisit if needed.
const GLSL_HEX_EDGE = /* glsl */ `
ivec2 neighborOffsetForEdge(int i, int edge) {
    bool oddRow = (mod(float(i), 2.0) > 0.5);
    if (edge == 0) return ivec2(0,  1);
    if (edge == 3) return ivec2(0, -1);
    if (oddRow) {
        if (edge == 1) return ivec2( 1,  1);
        if (edge == 2) return ivec2( 1,  0);
        if (edge == 4) return ivec2(-1,  0);
        if (edge == 5) return ivec2(-1,  1);
    } else {
        if (edge == 1) return ivec2( 1,  0);
        if (edge == 2) return ivec2( 1, -1);
        if (edge == 4) return ivec2(-1, -1);
        if (edge == 5) return ivec2(-1,  0);
    }
    return ivec2(0, 0);
}

float neighborIdAtEdge(int edge) {
    ivec2 off = neighborOffsetForEdge(g_i, edge);
    return sampleLookupFace(g_face, g_i + off.x, g_j + off.y);
}

// Sample (terrain, height) at a hex id. Returns vec2(-1, -1) if invalid.
vec2 sampleHexData(float hexId) {
    if (hexId < 0.0) return vec2(-1.0);
    float fx = (mod(hexId, dataTexSize) + 0.5) / dataTexSize;
    float fy = (floor(hexId / dataTexSize) + 0.5) / dataTexSize;
    float t = floor(texture2D(terrainTex, vec2(fx, fy)).r * 255.0 + 0.5);
    float h = floor(texture2D(heightTex, vec2(fx, fy)).r * 255.0 + 0.5);
    return vec2(t, h);
}
`;

// ── GLSL_MAIN_SETUP_NEW ─────────────────────────────────────
// Texture-driven analog of legacy GLSL_MAIN_SETUP. Defines the same set of
// local variables (terrainId, heightLevel, scratchy, distToBorder,
// cliffProximity, coastProximity, neighborId, hasCrossBlend, inlandColor,
// beachColor, ownColor, procColor, tierH) that GLSL_CLIFF_RENDERING and
// GLSL_BEACH_OVERLAY expect. Opens main() and the `else` branch but does
// NOT close them -- GLSL_BEACH_OVERLAY closes the else, GLSL_LIGHTING
// closes main.
const GLSL_MAIN_SETUP_NEW = /* glsl */ `
void main() {
    vec3 P = normalize(vSpherePos);
    vec3 N = normalize(vWorldNormal);
    bool isWall = false;  // smooth sphere -- no walls
    float distFromCenter = length(vWorldPos);
    float heightAboveR = distFromCenter - planetRadius;
    vec3 procColor;

    if (isWall) {
        // Unreachable on the smooth sphere -- kept so the brace structure
        // mirrors the legacy main() and the imported chunks fit unmodified.
        procColor = vec3(0.0);
    } else {
        computeHexLookup(P);
        float hexIdF = g_hexId;
        if (hexIdF < 0.0) {
            // Lookup miss (should be rare with gnomonic + pentagon early-exit).
            // Emit neutral grey rather than crashing the frame.
            gl_FragColor = vec4(0.4, 0.4, 0.4, 1.0);
            return;
        }
        vec2 selfData = sampleHexData(hexIdF);
        int terrainId = int(selfData.x);
        int heightLevel = int(selfData.y);

        // Reconstruct tierH from heightLevel (same constants as legacy).
        float tierH;
        if (heightLevel == 0) tierH = -0.020 * planetRadius;
        else if (heightLevel == 1) tierH = -0.008 * planetRadius;
        else if (heightLevel == 2) tierH = 0.0;
        else if (heightLevel == 3) tierH = 0.005 * planetRadius;
        else tierH = 0.010 * planetRadius;

        float scratchy = triplanarScratchy(vWorldPos, N, 0.004);

        // ── Edge / 6-neighbor scan ─────────────────────────
        // For pentagons we have no face/i/j, so we skip the 6-neighbor
        // scan entirely (the pentagon will render with no cross-blend or
        // coast/cliff overlays -- a small visual concession for the 12
        // pole hexes).
        float distToBorder = 1.0;
        int blendNeighborId = terrainId;
        // Match legacy hex-borders.ts: water = heightLevel <= 1.
        bool selfIsWater = (heightLevel <= 1);
        bool anyWaterLandTransition = false;
        bool anyHeightTransition = false;
        float minWaterLandDist = 1.0;
        float minHeightDist = 1.0;
        // Cross-blend selection: track the closest neighbor that has a
        // DIFFERENT terrain id (not just the closest neighbor regardless of
        // terrain). A same-terrain closest neighbor would otherwise mask
        // a different-terrain farther one, leaving the cross-blend never
        // triggering -- which was Phase 4's audit-flagged bug.
        float minDiffTerrainDist = 1.0;

        // The scan runs for all hexes including pentagons. For pentagons,
        // computeHexLookup sets g_face/g_i/g_j via the standard face find
        // (the pentagon table provides the authoritative cellId; the scan
        // just walks the face-grid neighbors as if it were a regular hex).
        // 5 neighbors come back valid, the 6th returns -1 and is skipped,
        // matching the pentagon's 5-neighbor topology.
        {
            float r = 0.5 / (resolution + 1.0);
            float minEdgeDist = 1e30;
            for (int k = 0; k < 6; k++) {
                float ang = float(k) * (3.14159265 / 3.0);
                vec2 nrm = vec2(cos(ang), sin(ang));
                float ed = r - dot(g_P2D - g_self_2d, nrm);
                if (ed < minEdgeDist) {
                    minEdgeDist = ed;
                }
                float ndN = neighborIdAtEdge(k);
                if (ndN < 0.0) continue;
                vec2 ndata = sampleHexData(ndN);
                int nT = int(ndata.x);
                int nH = int(ndata.y);
                bool nIsWater = (nH <= 1);
                float edN = clamp(ed / r, 0.0, 1.0);

                // Cross-blend: pick the closest different-terrain neighbor.
                if (nT != terrainId && edN < minDiffTerrainDist) {
                    minDiffTerrainDist = edN;
                    blendNeighborId = nT;
                }

                // Coast: water/land transition by heightLevel.
                if (nIsWater != selfIsWater) {
                    anyWaterLandTransition = true;
                    minWaterLandDist = min(minWaterLandDist, edN);
                }

                // Steep cliff (legacy criteria from hex-borders.ts):
                //   land-land gap >= 2 height levels, OR
                //   water (<=1) <-> land where the land tier > 2
                bool steepCliff = false;
                if (selfIsWater && !nIsWater) steepCliff = (nH > 2);
                else if (!selfIsWater && nIsWater) steepCliff = (heightLevel > 2);
                else if (!selfIsWater && !nIsWater) steepCliff = (abs(nH - heightLevel) >= 2);
                if (steepCliff) {
                    anyHeightTransition = true;
                    minHeightDist = min(minHeightDist, edN);
                }
            }
            // distToBorder: distance to the closest different-terrain
            // neighbor's edge (used by the cross-blend smoothstep). If no
            // different-terrain neighbor was found, distToBorder stays at
            // 1.0 (= deep inland) and the blend doesn't trigger.
            distToBorder = minDiffTerrainDist;
        }

        int neighborId = blendNeighborId;
        bool hasCrossBlend = (neighborId != terrainId);

        // Coast proximity: 1.0 at a water/land border, 0.0 deep inland.
        // Legacy decoded vColor.a as 1 - cd/hexRadius where hexRadius is
        // the corner radius R = r * 2/sqrt(3). We use the apothem r, so
        // multiply the normalized distance by r/R = sqrt(3)/2 ~= 0.866 to
        // get the same falloff width.
        float coastProximity = anyWaterLandTransition
            ? clamp(1.0 - minWaterLandDist * 0.866, 0.0, 1.0)
            : 0.0;

        // Cliff proximity: 1.0 at a height-tier border, 0.0 inland. Legacy
        // (vertex-encoding.ts:131) uses 1 - dist/(hexRadius * 0.3); the
        // band reaches 0 at 30% of the corner radius. Apothem-normalized
        // that's about 0.35 * r. So divide by 0.35 (instead of 1.0).
        // Without this fix the cliff color band was ~3x too wide and dark
        // outlines bled across every hex with a different heightLevel
        // neighbor.
        float cliffProximity = anyHeightTransition
            ? clamp(1.0 - minHeightDist / 0.35, 0.0, 1.0)
            : 0.0;

        // ── Per-cell colors (palettes), same math as legacy ────
        // Phase 4: the smooth sphere has no displacement, so heightAboveR
        // is always ~0 -- which would make max(heightAboveR, inlandH) clamp
        // water tiers (inlandH < 0) up to grass colors. Use inlandH directly;
        // it equals what max(heightAboveR, inlandH) produces on the legacy
        // mesh in the normal case (where the mesh sits at tierH and
        // inlandH > tierH). Phase 5 will displace vertices, after which
        // heightAboveR ~= tierH and max(...) becomes equivalent again.
        float noiseAmp = 0.008 * planetRadius;
        float noiseBias = 0.3 * noiseAmp;
        float inlandH = tierH + noiseBias;
        vec3 inlandColor = computeTerrainColor(terrainId, inlandH, tierH, scratchy);

        float colorH = inlandH;
        vec3 ownColor = computeTerrainColor(terrainId, colorH, tierH, scratchy);

        vec3 beachColor = vec3(0.68, 0.60, 0.42) * (1.0 + scratchy * 0.10);

        if (hasCrossBlend) {
            float n1 = snoise(vWorldPos * 0.004) * 0.22;
            float n2 = snoise(vWorldPos * 0.012) * 0.10;
            float noiseOffset = n1 + n2;
            float threshold = max(0.35 + noiseOffset, 0.08);
            float blend = (1.0 - smoothstep(0.0, threshold, distToBorder)) * 0.45;
            vec3 neighborColor = computeTerrainColor(neighborId, colorH, tierH, scratchy);
            procColor = mix(ownColor, neighborColor, blend);
            vec3 neighborInland = computeTerrainColor(neighborId, inlandH, tierH, scratchy);
            inlandColor = mix(inlandColor, neighborInland, blend);
        } else {
            procColor = ownColor;
        }

        // Phase 4 water rendering. The legacy stack uses a separate animated
        // water-sphere positioned BELOW the land mesh's elevation. Phase 4
        // has no displacement (Phase 5's job), so the water-sphere can't
        // composite correctly -- shader-globe sits at planetRadius and the
        // water-sphere at 0.9995R is fully occluded.
        //
        // Approach: render water inline using deepColor/shallowColor (same
        // values as water-material.ts) plus a fresnel mix between them,
        // a tiny time-driven wave perturbation (low amplitude so the hex
        // pattern doesn't get noisy), and the same cross-blend smoothing
        // we use on land so deep/shallow water hex boundaries fade rather
        // than show as hard seams.
        if (selfIsWater) {
            vec3 viewDir = normalize(cameraPos - vWorldPos);
            float fresnel = pow(1.0 - max(0.0, dot(N, viewDir)), 2.0);

            // Per-terrain water colors. Legacy water-material.ts has a single
            // pair (deepColor, shallowColor); we map terrain ids onto that
            // pair plus a small lake variant. This honors the legacy palette
            // (water is global, not per-cell) so the Colors-tab water-color
            // editor is the right place for any future user customization.
            vec3 selfWater;
            if (terrainId == 0) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
            else if (terrainId == 1) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
            else if (terrainId == 3) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
            else selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.2);

            // Cross-blend across water/water hex boundaries (e.g., deep <->
            // shallow). Reuses the land cross-blend's distance + threshold
            // logic so the two paths produce visually consistent transitions.
            vec3 waterCol = selfWater;
            if (hasCrossBlend) {
                vec3 nbWater;
                if (neighborId == 0) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
                else if (neighborId == 1) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
                else if (neighborId == 3) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
                else nbWater = procColor; // neighbor is land -- use land color so coast fade reads correctly
                float n1 = snoise(vWorldPos * 0.004) * 0.22;
                float n2 = snoise(vWorldPos * 0.012) * 0.10;
                float threshold = max(0.35 + n1 + n2, 0.08);
                float blend = (1.0 - smoothstep(0.0, threshold, distToBorder)) * 0.45;
                waterCol = mix(selfWater, nbWater, blend);
            }

            // Tiny time-driven wave perturbation. Amplitude is intentionally
            // low so it doesn't make the hex tessellation look noisy.
            float wave = snoise(vWorldPos * 0.012 + vec3(time * 0.3, 0.0, 0.0)) * 0.012
                       + snoise(vWorldPos * 0.04  + vec3(0.0, time * 0.2, 0.0)) * 0.006;
            waterCol += vec3(wave);

            procColor = waterCol;
        }
`;

const FRAGMENT =
	GLSL_NOISE +
	GLSL_HEADER_PHASE4 +
	GLSL_COASTAL_CONSTANTS +
	GLSL_SCRATCHY +
	GLSL_PALETTE +
	GLSL_HEX_LOOKUP +
	GLSL_HEX_EDGE +
	GLSL_MAIN_SETUP_NEW +
	GLSL_CLIFF_RENDERING +
	GLSL_BEACH_OVERLAY +
	GLSL_LIGHTING;

export interface ShaderGlobeMaterialOptions {
	hexLookup: HexIdLookup;
	hexData: HexDataTextures;
	planetRadiusKm: number;
}

export function createShaderGlobeMaterial(scene: Scene, opts: ShaderGlobeMaterialOptions): ShaderMaterial {
	ShaderStore.ShadersStore['shaderGlobeVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['shaderGlobeFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('shaderGlobe', scene, {
		vertex: 'shaderGlobe',
		fragment: 'shaderGlobe',
	}, {
		attributes: ['position', 'normal'],
		uniforms: [
			'world', 'viewProjection',
			// Imported legacy chunks expect these exact names.
			'sunDir', 'fillDir', 'cameraPos',
			'planetRadius', 'seaLevel', 'bottomOffset', 'topOffset', 'hillRatio', 'time',
			'terrainPalette', 'terrainBlend', 'terrainBlendPos', 'cliffPalette',
			// Phase 1 / 2 / 4 additions
			'dataTexSize',
			'deepColor', 'shallowColor',
			'gridSize', 'resolution',
			'faceCentroid', 'faceVertA', 'faceVertB', 'faceVertC',
			'pentagonVert', 'pentagonId', 'pentagonThreshold',
		],
		samplers: ['hexLookup', 'terrainTex', 'heightTex'],
		needAlphaBlending: false,
	});

	const R = opts.planetRadiusKm;
	mat.setVector3('sunDir', new Vector3(-1, 0.5, 0.3).normalize());
	mat.setVector3('fillDir', new Vector3(1, -0.3, -0.5).normalize());
	mat.setVector3('cameraPos', Vector3.Zero());
	mat.setFloat('planetRadius', R);
	mat.setFloat('seaLevel', -0.002 * R);
	mat.setFloat('bottomOffset', -0.020 * R);
	mat.setFloat('topOffset', 0.080 * R);
	mat.setFloat('hillRatio', 0.40);
	mat.setFloat('time', 0);
	// Match water-material.ts defaults (line 220-221).
	mat.setVector3('deepColor', new Vector3(0.08, 0.18, 0.35));
	mat.setVector3('shallowColor', new Vector3(0.15, 0.35, 0.55));

	const settings = loadTerrainSettings();
	applyShaderGlobeSettings(mat, settings);

	mat.setTexture('hexLookup', opts.hexLookup.texture);
	mat.setTexture('terrainTex', opts.hexData.terrain);
	mat.setTexture('heightTex', opts.hexData.height);
	mat.setFloat('dataTexSize', opts.hexData.size);
	mat.setFloat('gridSize', opts.hexLookup.gridSize);
	mat.setFloat('resolution', opts.hexLookup.gridSize - 2);
	mat.setArray3('faceCentroid', Array.from(opts.hexLookup.faceCentroids));

	const vA = new Float32Array(20 * 3), vB = new Float32Array(20 * 3), vC = new Float32Array(20 * 3);
	for (let f = 0; f < 20; f++) {
		vA[f * 3] = opts.hexLookup.faceVerts[f * 9 + 0]; vA[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 1]; vA[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 2];
		vB[f * 3] = opts.hexLookup.faceVerts[f * 9 + 3]; vB[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 4]; vB[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 5];
		vC[f * 3] = opts.hexLookup.faceVerts[f * 9 + 6]; vC[f * 3 + 1] = opts.hexLookup.faceVerts[f * 9 + 7]; vC[f * 3 + 2] = opts.hexLookup.faceVerts[f * 9 + 8];
	}
	mat.setArray3('faceVertA', Array.from(vA));
	mat.setArray3('faceVertB', Array.from(vB));
	mat.setArray3('faceVertC', Array.from(vC));
	mat.setArray3('pentagonVert', Array.from(opts.hexLookup.pentagonVerts));
	mat.setFloats('pentagonId', Array.from(opts.hexLookup.pentagonIds));
	mat.setFloat('pentagonThreshold', opts.hexLookup.pentagonThreshold);

	mat.backFaceCulling = true;
	return mat;
}

/** Push terrain palette settings into the shader-globe material (mirrors
 *  applyTerrainSettings in terrain-material.ts but for this material). */
export function applyShaderGlobeSettings(mat: ShaderMaterial, settings: TerrainSettings): void {
	mat.setArray3('terrainPalette', packCustomPalettes(settings.palettes));
	mat.setFloats('terrainBlend', settings.blends);
	mat.setFloats('terrainBlendPos', settings.blendPositions);
	if (settings.cliffPalettes) {
		mat.setArray3('cliffPalette', packCliffPalettes(settings.cliffPalettes));
	}
}
