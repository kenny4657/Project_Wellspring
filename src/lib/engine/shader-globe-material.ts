/**
 * Phase 4 + 5 + 6 -- shader-driven globe material.
 *
 * Phase 4: full biome shading driven by texture lookups (palette, blend
 *          curves, beach overlay, cliff color, lighting). Inputs come from
 *          terrainTex / heightTex / hexLookup -- all texture-driven, no
 *          per-vertex attributes.
 *
 * Phase 5: vertex displacement. Each vertex computes its hex via
 *          worldPosToHexId, samples its heightLevel, samples the closest-
 *          edge neighbor's heightLevel, and applies "Strategy 3" from the
 *          plan: flat hex top with a sharp transition near the edge:
 *
 *            t = smoothstep(0, 0.15, distanceToHexEdge_normalized);
 *            h = mix(neighborHeight, ownHeight, t);
 *            displaced = normalize(position) * (planetRadius + h);
 *
 * Phase 6: noise-driven cliff face detail. Where two adjacent hexes have
 *          a height delta, the inter-hex transition gets noise displacement
 *          so the cliff face looks like rock instead of a smooth ramp:
 *
 *            cliffness = 1 - smoothstep(0, 0.15, distanceToHexEdge_norm);
 *            heightDelta = abs(neighborH - ownH);
 *            h += cliffness * smoothstep(0, AMP_DELTA, heightDelta)
 *                           * snoise(pos * NOISE_FREQ) * NOISE_AMP;
 *          Plus an optional "stratification" noise term that bands the
 *          cliff face vertically -- gives visible rock layers.
 *
 * The hex lookup machinery (worldPosToHexId, distanceToHexEdge) is shared
 * between vertex and fragment via GLSL_HEX_HELPERS. Only fragment runs the
 * full 6-neighbor scan (for coast/cliff/cross-blend overlay decisions);
 * vertex shader only needs the closest-edge neighbor.
 *
 * Brace structure (mirrors legacy terrain-material.ts main()):
 *   void main() {
 *       ... shared setup ...
 *       if (isWall) { /<unused on smooth sphere/> }
 *       else {
 *           ... GLSL_MAIN_SETUP_NEW (ends OPEN) ...
 *           ... GLSL_CLIFF_RENDERING (ends OPEN) ...
 *           ... GLSL_BEACH_OVERLAY (closes the else with `}`) ...
 *       }
 *       ... GLSL_LIGHTING (closes main with `}`) ...
 *   }
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

// ── GLSL_PHASE4_UNIFORMS ────────────────────────────────────
// Phase 1 / 2 / 4 / 5 / 6 uniforms and the vSpherePos varying. Used by both
// vertex and fragment so they share the same uniform names. precision and
// the legacy lighting/palette uniforms come from GLSL_NOISE which is
// included after this chunk in the fragment (and a slimmer copy in the
// vertex via GLSL_VERTEX_NOISE_SUBSET below).
const GLSL_PHASE4_UNIFORMS = /* glsl */ `
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

// Phase 2 hex lookup uniforms.
uniform sampler2D hexLookup;
uniform float gridSize;       // = res + 2
uniform float resolution;
uniform vec3 faceCentroid[20];
uniform vec3 faceVertA[20];
uniform vec3 faceVertB[20];
uniform vec3 faceVertC[20];
uniform vec3 pentagonVert[12];
uniform float pentagonId[12];
uniform float pentagonThreshold;

// Phase 6 cliff-noise tunables. Defaults set in createShaderGlobeMaterial.
// Exposed as uniforms so the Cliffs tab can drive them at runtime if a UI
// is wired in later (the plan calls for it but it's not blocking).
uniform float cliffNoiseAmp;     // peak displacement at cliff edge, fraction of planetRadius
uniform float cliffNoiseFreq;    // 3D noise frequency (1/units in normalized sphere space)
uniform float cliffStrataAmp;    // stratification ridge amplitude
uniform float cliffStrataFreq;   // stratification frequency along altitude
`;

// ── GLSL_HEX_HELPERS ────────────────────────────────────────
// computeHexLookup, sampleHexData, neighborIdAtEdge, edge-direction tables.
// Pure functions over the uniforms declared in GLSL_PHASE4_UNIFORMS. Used
// by both vertex and fragment shaders. Sets globals g_hexId/g_face/g_i/g_j/
// g_isPentagon/g_P2D/g_self_2d that callers read after computeHexLookup(P).
const GLSL_HEX_HELPERS = /* glsl */ `
const float SQRT3_GH = 1.7320508075688772;
const float NO_HEX_GH = 65535.0;

float g_hexId;
int g_face;
int g_i;
int g_j;
bool g_isPentagon;
vec2 g_P2D;
vec2 g_self_2d;

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
    if (id >= NO_HEX_GH) return -1.0;
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
    float diameter = 2.0 * r * 2.0 / SQRT3_GH;
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
    int face = findFace(P);
    vec3 v0 = faceVertA[face];
    vec3 v1 = faceVertB[face];
    vec3 v2 = faceVertC[face];
    vec3 bary = baryGnomonic(P, v0, v1, v2);
    float l3 = bary.z;
    float l2 = bary.y;
    float cz = l3 * SQRT3_GH * 0.5;
    float cx = l2 - 0.5 * (1.0 - l3);
    float r = 0.5 / (resolution + 1.0);
    float diameter = 2.0 * r * 2.0 / SQRT3_GH;
    float rowStep = diameter * 0.75;
    float iF = cz / rowStep;
    int i = int(floor(iF + 0.5));
    float oddOffset = (mod(float(i), 2.0) > 0.5) ? r : 0.0;
    float jF = (cx + 0.5 - oddOffset) / (2.0 * r);
    int j = int(floor(jF + 0.5));
    g_face = face; g_i = i; g_j = j;
    g_P2D = vec2(cx, cz);
    g_self_2d = selfCenter2D(i, j);
    g_hexId = g_isPentagon ? pent : sampleLookupFace(face, i, j);
}

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

vec2 sampleHexData(float hexId) {
    if (hexId < 0.0) return vec2(-1.0);
    float fx = (mod(hexId, dataTexSize) + 0.5) / dataTexSize;
    float fy = (floor(hexId / dataTexSize) + 0.5) / dataTexSize;
    float t = floor(texture2D(terrainTex, vec2(fx, fy)).r * 255.0 + 0.5);
    float h = floor(texture2D(heightTex, vec2(fx, fy)).r * 255.0 + 0.5);
    return vec2(t, h);
}

// Phase 5: heightLevel -> world-space tier elevation. Mirrors LEVEL_HEIGHTS
// in hex-borders.ts: { -0.020, -0.008, 0, 0.005, 0.010 } * planetRadius.
float tierHeight(float level) {
    if (level < 0.5) return -0.020;
    if (level < 1.5) return -0.008;
    if (level < 2.5) return  0.000;
    if (level < 3.5) return  0.005;
    return                    0.010;
}

// Phase 5 + 6: combined displacement amount for a fragment/vertex at point
// P (unit-sphere position). Returns the displacement in *fractions of
// planetRadius*; caller multiplies by planetRadius and adds it to the
// sphere position. Reads g_face/g_i/g_j/g_P2D/g_self_2d set by a prior
// computeHexLookup(P) call. Walks the 6 hex edges to find the closest
// neighbor; uses that neighbor's height + the edge distance to drive
// Strategy 3 displacement and Phase 6's cliff noise.
//
// Returns vec2(h, edgeDistNorm) where:
//   h = displacement in fraction-of-planetRadius units
//   edgeDistNorm = distance to closest edge / apothem (in [0, 1] inside hex)
// Pentagons skip the edge math and just sit at their tier height with no
// noise -- they're the 12 pole hexes and 0% of fragments in practice.
vec2 phase5AndPhase6Displacement(vec3 P, float ownLevel) {
    if (g_hexId < 0.0) return vec2(0.0, 1.0); // safe fallback

    float ownH = tierHeight(ownLevel);

    if (g_isPentagon) {
        // Pentagons: flat top, no noise (they don't have a clean (i, j) for
        // the row-parity-dependent neighbor offsets).
        return vec2(ownH, 1.0);
    }

    float r = 0.5 / (resolution + 1.0);
    // Closest edge + its neighbor's height.
    float minEdgeDist = 1e30;
    int closestEdge = 0;
    for (int k = 0; k < 6; k++) {
        float ang = float(k) * (3.14159265 / 3.0);
        vec2 nrm = vec2(cos(ang), sin(ang));
        float ed = r - dot(g_P2D - g_self_2d, nrm);
        if (ed < minEdgeDist) { minEdgeDist = ed; closestEdge = k; }
    }
    float edgeDistNorm = clamp(minEdgeDist / r, 0.0, 1.0);

    float nbHexId = neighborIdAtEdge(closestEdge);
    float nbLevel = (nbHexId >= 0.0) ? sampleHexData(nbHexId).y : ownLevel;
    float nbH = tierHeight(nbLevel);

    // Strategy 3: flat hex top + sharp transition near edge. The "0.15"
    // is the plan's edge-band fraction (last 15% of edge distance gets the
    // ramp).
    float t = smoothstep(0.0, 0.15, edgeDistNorm);
    float h = mix(nbH, ownH, t);

    // Phase 6: cliff-face noise. Active where edge is close AND height
    // delta between own and neighbor is non-trivial. heightDelta is in
    // fraction-of-planetRadius units; legacy LEVEL_HEIGHTS span 0.030R, so
    // a "significant" delta is around 0.005R+. Use smoothstep(0, 0.012)
    // so adjacent same-tier neighbors don't get noise but cliffs do.
    float cliffness = 1.0 - smoothstep(0.0, 0.15, edgeDistNorm);
    float heightDelta = abs(nbH - ownH);
    float cliffActivity = cliffness * smoothstep(0.0, 0.012, heightDelta);
    if (cliffActivity > 0.0001) {
        // 3-octave simplex (snoise comes from GLSL_NOISE).
        vec3 nP = P * cliffNoiseFreq;
        float n =  snoise(nP)         * 0.55
                 + snoise(nP * 2.07)   * 0.30
                 + snoise(nP * 4.13)   * 0.15;
        h += cliffActivity * n * cliffNoiseAmp;

        // Stratification: a second term banded along the cliff direction.
        // Legacy cliff art shows visible horizontal rock layers; project a
        // sinusoid on (P projected to face-local 2D, dotted with cliff
        // direction) and modulate by a low-freq noise so layers don't read
        // as perfect parallel lines. cliffStrataAmp = 0 disables.
        if (cliffStrataAmp > 0.0001) {
            float angS = float(closestEdge) * (3.14159265 / 3.0);
            vec2 cliffDir = vec2(cos(angS), sin(angS));
            float along = dot(g_P2D - g_self_2d, cliffDir) * cliffStrataFreq;
            float strata = sin(along * 6.2831853) * 0.5 + 0.5;
            strata *= snoise(P * cliffNoiseFreq * 0.45) * 0.5 + 0.7;
            h += cliffActivity * (strata - 0.5) * cliffStrataAmp;
        }
    }

    return vec2(h, edgeDistNorm);
}
`;

// ── VERTEX shader ───────────────────────────────────────────
// Per-vertex hex lookup + Phase 5 displacement + Phase 6 noise. The mesh
// from shader-globe-mesh is built at radius=planetRadius (Babylon's
// CreateIcoSphere); we normalize and re-extrude to (planetRadius + h).
const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;
uniform float planetRadius;

attribute vec3 position;
attribute vec3 normal;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
// vSpherePos is declared in GLSL_PHASE4_UNIFORMS; vColor is declared in
// GLSL_NOISE_VERTEX_SUBSET via the legacy varying alias. Both must be
// matched in vertex and fragment for the WebGL2 link to succeed.
varying vec4 vColor;
` +
GLSL_PHASE4_UNIFORMS +
GLSL_NOISE_VERTEX_SUBSET() +
GLSL_HEX_HELPERS +
/* glsl */ `
void main() {
    // Mesh vertex sits at radius planetRadius (CreateIcoSphere). Normalize
    // to unit sphere for the hex lookup, then re-extrude after computing
    // displacement.
    vec3 normPos = normalize(position);
    computeHexLookup(normPos);
    float ownLevel = (g_hexId >= 0.0) ? sampleHexData(g_hexId).y : 2.0;
    vec2 disp = phase5AndPhase6Displacement(normPos, ownLevel);
    float h = disp.x;

    vec3 displaced = normPos * (planetRadius * (1.0 + h));
    vec4 wp = world * vec4(displaced, 1.0);
    vWorldPos = wp.xyz;
    // Surface normal: with displacement the radial-out normal is no longer
    // exact at hex-edge transitions, but it's close enough for shading
    // (each hex top is flat -- only the narrow edge band has curvature).
    // Phase 8 could compute analytic normals from neighbour heights if it
    // becomes a visible artifact.
    vWorldNormal = normalize((world * vec4(normalize(displaced), 0.0)).xyz);
    vSpherePos = normPos;
    vColor = vec4(0.0);
    gl_Position = viewProjection * wp;
}
`;

// Vertex shader needs only snoise (for Phase 6 noise) + the precision dec.
// The full GLSL_NOISE chunk also declares lighting/palette uniforms and
// varyings the vertex doesn't need; this subset trims to what the vertex
// actually uses, avoiding stale uniform decls.
//
// (Implemented as a function so the inline string is built once at
// import time; this is just a small optimization clarity helper.)
function GLSL_NOISE_VERTEX_SUBSET(): string {
	return /* glsl */ `
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
`;
}

// ── GLSL_MAIN_SETUP_NEW ─────────────────────────────────────
// Texture-driven analog of legacy GLSL_MAIN_SETUP. Same set of locals the
// imported GLSL_CLIFF_RENDERING / GLSL_BEACH_OVERLAY chunks expect.
const GLSL_MAIN_SETUP_NEW = /* glsl */ `
void main() {
    vec3 P = normalize(vSpherePos);
    vec3 N = normalize(vWorldNormal);
    bool isWall = false;  // smooth sphere -- no walls
    float distFromCenter = length(vWorldPos);
    float heightAboveR = distFromCenter - planetRadius;
    vec3 procColor;

    if (isWall) {
        procColor = vec3(0.0);
    } else {
        computeHexLookup(P);
        float hexIdF = g_hexId;
        if (hexIdF < 0.0) {
            gl_FragColor = vec4(0.4, 0.4, 0.4, 1.0);
            return;
        }
        vec2 selfData = sampleHexData(hexIdF);
        int terrainId = int(selfData.x);
        int heightLevel = int(selfData.y);

        // tierH from heightLevel.
        float tierH;
        if (heightLevel == 0) tierH = -0.020 * planetRadius;
        else if (heightLevel == 1) tierH = -0.008 * planetRadius;
        else if (heightLevel == 2) tierH = 0.0;
        else if (heightLevel == 3) tierH = 0.005 * planetRadius;
        else tierH = 0.010 * planetRadius;

        float scratchy = triplanarScratchy(vWorldPos, N, 0.004);

        // ── 6-neighbor scan for cross-blend / coast / cliff ─────
        float distToBorder = 1.0;
        int blendNeighborId = terrainId;
        bool selfIsWater = (heightLevel <= 1);
        bool anyWaterLandTransition = false;
        bool anyHeightTransition = false;
        float minWaterLandDist = 1.0;
        float minHeightDist = 1.0;
        float minDiffTerrainDist = 1.0;

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

                if (nT != terrainId && edN < minDiffTerrainDist) {
                    minDiffTerrainDist = edN;
                    blendNeighborId = nT;
                }
                if (nIsWater != selfIsWater) {
                    anyWaterLandTransition = true;
                    minWaterLandDist = min(minWaterLandDist, edN);
                }
                bool steepCliff = false;
                if (selfIsWater && !nIsWater) steepCliff = (nH > 2);
                else if (!selfIsWater && nIsWater) steepCliff = (heightLevel > 2);
                else if (!selfIsWater && !nIsWater) steepCliff = (abs(nH - heightLevel) >= 2);
                if (steepCliff) {
                    anyHeightTransition = true;
                    minHeightDist = min(minHeightDist, edN);
                }
            }
            distToBorder = minDiffTerrainDist;
        }

        int neighborId = blendNeighborId;
        bool hasCrossBlend = (neighborId != terrainId);

        float coastProximity = anyWaterLandTransition
            ? clamp(1.0 - minWaterLandDist * 0.866, 0.0, 1.0)
            : 0.0;
        float cliffProximity = anyHeightTransition
            ? clamp(1.0 - minHeightDist / 0.35, 0.0, 1.0)
            : 0.0;

        // ── Per-cell colors (palettes), legacy math ────
        // Phase 5+ restores legacy formula: heightAboveR can be > inlandH
        // when Phase 6 noise pushes a vertex above its tier's nominal
        // inland height. max() picks the higher; computeTerrainColor then
        // returns the appropriate band (grass -> hill -> snow as height
        // increases).
        float noiseAmp = 0.008 * planetRadius;
        float noiseBias = 0.3 * noiseAmp;
        float inlandH = tierH + noiseBias;
        vec3 inlandColor = computeTerrainColor(terrainId, inlandH, tierH, scratchy);

        float colorH = max(heightAboveR, inlandH);
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

        // Phase 4 inline water (see comments on the original Phase 4
        // commit). Phase 5/6 displacement makes water hexes geometrically
        // lower than land, but we keep the inline color since the legacy
        // water-sphere isn't wired into shader-preview yet.
        if (selfIsWater) {
            vec3 viewDir = normalize(cameraPos - vWorldPos);
            float fresnel = pow(1.0 - max(0.0, dot(N, viewDir)), 2.0);
            vec3 selfWater;
            if (terrainId == 0) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
            else if (terrainId == 1) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
            else if (terrainId == 3) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
            else selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.2);

            vec3 waterCol = selfWater;
            if (hasCrossBlend) {
                vec3 nbWater;
                if (neighborId == 0) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
                else if (neighborId == 1) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
                else if (neighborId == 3) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
                else nbWater = procColor;
                float n1 = snoise(vWorldPos * 0.004) * 0.22;
                float n2 = snoise(vWorldPos * 0.012) * 0.10;
                float threshold = max(0.35 + n1 + n2, 0.08);
                float blend = (1.0 - smoothstep(0.0, threshold, distToBorder)) * 0.45;
                waterCol = mix(selfWater, nbWater, blend);
            }
            float wave = snoise(vWorldPos * 0.012 + vec3(time * 0.3, 0.0, 0.0)) * 0.012
                       + snoise(vWorldPos * 0.04  + vec3(0.0, time * 0.2, 0.0)) * 0.006;
            waterCol += vec3(wave);
            procColor = waterCol;
        }
`;

const FRAGMENT =
	GLSL_NOISE +
	GLSL_PHASE4_UNIFORMS +
	GLSL_COASTAL_CONSTANTS +
	GLSL_SCRATCHY +
	GLSL_PALETTE +
	GLSL_HEX_HELPERS +
	GLSL_MAIN_SETUP_NEW +
	GLSL_CLIFF_RENDERING +
	GLSL_BEACH_OVERLAY +
	GLSL_LIGHTING;

// Phase 6 default tunables. Cliff noise amplitude is in fraction-of-planet-
// radius units; AMP=0.0015 means peak displacement of ~0.15% of radius
// (for our 6371 km planet that's ~9.5 km cliff variation -- comparable to
// real-world mountain ranges and matching legacy's noise feel).
const PHASE6_DEFAULTS = {
	cliffNoiseAmp: 0.0015,
	cliffNoiseFreq: 6.0,    // 1/(unit-sphere distance); ~6 means feature size of ~1/6 of a sphere quadrant
	cliffStrataAmp: 0.0008,
	cliffStrataFreq: 30.0,  // bands per unit hex-radius along cliff direction
};

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
			'sunDir', 'fillDir', 'cameraPos',
			'planetRadius', 'seaLevel', 'bottomOffset', 'topOffset', 'hillRatio', 'time',
			'terrainPalette', 'terrainBlend', 'terrainBlendPos', 'cliffPalette',
			'dataTexSize',
			'deepColor', 'shallowColor',
			'gridSize', 'resolution',
			'faceCentroid', 'faceVertA', 'faceVertB', 'faceVertC',
			'pentagonVert', 'pentagonId', 'pentagonThreshold',
			'cliffNoiseAmp', 'cliffNoiseFreq', 'cliffStrataAmp', 'cliffStrataFreq',
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

	// Phase 6 cliff-noise tunables.
	mat.setFloat('cliffNoiseAmp', PHASE6_DEFAULTS.cliffNoiseAmp);
	mat.setFloat('cliffNoiseFreq', PHASE6_DEFAULTS.cliffNoiseFreq);
	mat.setFloat('cliffStrataAmp', PHASE6_DEFAULTS.cliffStrataAmp);
	mat.setFloat('cliffStrataFreq', PHASE6_DEFAULTS.cliffStrataFreq);

	mat.backFaceCulling = true;
	return mat;
}

/** Push terrain palette settings into the shader-globe material. */
export function applyShaderGlobeSettings(mat: ShaderMaterial, settings: TerrainSettings): void {
	mat.setArray3('terrainPalette', packCustomPalettes(settings.palettes));
	mat.setFloats('terrainBlend', settings.blends);
	mat.setFloats('terrainBlendPos', settings.blendPositions);
	if (settings.cliffPalettes) {
		mat.setArray3('cliffPalette', packCliffPalettes(settings.cliffPalettes));
	}
}

/** Tune Phase 6 cliff-face noise amplitudes/frequencies at runtime. */
export interface ShaderGlobeCliffNoiseSettings {
	cliffNoiseAmp?: number;
	cliffNoiseFreq?: number;
	cliffStrataAmp?: number;
	cliffStrataFreq?: number;
}
export function applyShaderGlobeCliffNoise(mat: ShaderMaterial, s: ShaderGlobeCliffNoiseSettings): void {
	if (s.cliffNoiseAmp !== undefined) mat.setFloat('cliffNoiseAmp', s.cliffNoiseAmp);
	if (s.cliffNoiseFreq !== undefined) mat.setFloat('cliffNoiseFreq', s.cliffNoiseFreq);
	if (s.cliffStrataAmp !== undefined) mat.setFloat('cliffStrataAmp', s.cliffStrataAmp);
	if (s.cliffStrataFreq !== undefined) mat.setFloat('cliffStrataFreq', s.cliffStrataFreq);
}
