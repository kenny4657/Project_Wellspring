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

// Interior surface noise. Legacy globe-mesh applies fbm noise to every
// vertex (hex-heights.ts: NOISE_AMP=0.008, NOISE_SCALE=35). Without it
// hex tops are perfectly flat -- visible as "no small variation in
// height" the user flagged. We replicate it on the smooth sphere so
// land and water hexes get the same continuous bumpiness as legacy.
uniform float interiorNoiseAmp;  // peak displacement on hex tops, fraction of planetRadius
uniform float interiorNoiseFreq; // matches legacy NOISE_SCALE (~35)
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

// Look up the cellId of the neighbor across the given edge. If the neighbor
// is in-grid on the same face, use the lookup texture directly. If the
// neighbor's (i, j) is OUT of this face's grid -- i.e., across an
// icosphere face seam -- compute the neighbor's world center via the
// face-local 2D -> sphere map (linear bary + normalize, gnomonic-style),
// find which face the world center lies on (max dot vs centroid), then
// re-project into that face's grid and sample. Without this fallback,
// every fragment within ~one hex of an icosphere face seam saw nbId = -1
// and Strategy 3 / Phase 6 noise both no-oped, producing flat patches
// along the 30 great-circle face seams.
float neighborIdAtEdge(int edge) {
    ivec2 off = neighborOffsetForEdge(g_i, edge);
    int nI = g_i + off.x;
    int nJ = g_j + off.y;
    float gs = gridSize;
    if (nI >= 0 && nJ >= 0 && float(nI) < gs && float(nJ) < gs) {
        return sampleLookupFace(g_face, nI, nJ);
    }
    // Out of grid: compute the neighbor's center in face-local 2D, then
    // project to world via linear bary on the current face's triangle.
    // The result is approximate (gnomonic projection, not slerp) but
    // matches what the forward map would produce within the precision
    // we need to find the right adjacent face.
    vec2 nb2D = selfCenter2D(nI, nJ);
    float l3 = nb2D.y * 2.0 / SQRT3_GH;
    float l2 = nb2D.x + 0.5 * (1.0 - l3);
    float l1 = 1.0 - l2 - l3;
    vec3 v0 = faceVertA[g_face];
    vec3 v1 = faceVertB[g_face];
    vec3 v2 = faceVertC[g_face];
    vec3 nbWorld = normalize(l1 * v0 + l2 * v1 + l3 * v2);

    // Find the actual face the neighbor center lies on.
    int newFace = findFace(nbWorld);
    vec3 nv0 = faceVertA[newFace];
    vec3 nv1 = faceVertB[newFace];
    vec3 nv2 = faceVertC[newFace];
    vec3 nbBary = baryGnomonic(nbWorld, nv0, nv1, nv2);
    float nbCz = nbBary.z * SQRT3_GH * 0.5;
    float nbCx = nbBary.y - 0.5 * (1.0 - nbBary.z);
    float r = 0.5 / (resolution + 1.0);
    float diameter = 2.0 * r * 2.0 / SQRT3_GH;
    float rowStep = diameter * 0.75;
    int newI = int(floor(nbCz / rowStep + 0.5));
    float oddOff2 = (mod(float(newI), 2.0) > 0.5) ? r : 0.0;
    int newJ = int(floor((nbCx + 0.5 - oddOff2) / (2.0 * r) + 0.5));
    return sampleLookupFace(newFace, newI, newJ);
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

    // Water hexes (heightLevel 0 or 1) collapse to a single uniform depth
    // just below sea level. Two reasons:
    //
    //   1. Without flattening, deep ocean (-0.020R) vs shallow (-0.008R)
    //      produce stair-step seams in the water surface (inline water
    //      paints the displaced seafloor, not a separate flat plane).
    //
    //   2. The flat depth must be slightly below tier 2 land (0.0R) so
    //      every coastline (including water -> tier 2 land) shows a
    //      geometric cliff. If both were 0, coastlines would be perfectly
    //      hex-aligned with no displacement to break the 60-degree edges.
    //
    // -0.001R = ~6 km. Subtle but enough for Phase 6 noise to wiggle the
    // boundary visibly. Deep vs shallow color difference is preserved
    // purely in the fragment-side fresnel mix (no geometry needed).
    const float WATER_FLAT_DEPTH = -0.001;
    bool ownIsWater = (ownLevel <= 1.5);
    float ownH = ownIsWater ? WATER_FLAT_DEPTH : tierHeight(ownLevel);

    if (g_isPentagon) {
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
    bool nbIsWater = (nbLevel <= 1.5);
    float nbH = nbIsWater ? WATER_FLAT_DEPTH : tierHeight(nbLevel);

    // For Phase 6 cliff-noise activation we want the *real* tier delta,
    // not the post-flatten delta. Water-flatten makes water and land tier-2
    // both sit at h=0 (delta=0), which would kill cliff noise at every
    // sea-level coastline. Compute the "true" delta from the tier tables.
    float ownTierH = tierHeight(ownLevel);
    float nbTierH  = tierHeight(nbLevel);
    float trueHeightDelta = abs(nbTierH - ownTierH);

    // Strategy 3: flat hex top + sharp transition near edge. The "0.15"
    // is the plan's edge-band fraction (last 15% of edge distance gets the
    // ramp).
    float t = smoothstep(0.0, 0.15, edgeDistNorm);
    float strategyH = mix(nbH, ownH, t);
    float h = strategyH;

    // Interior surface noise. Land hexes only -- water surface stays
    // perfectly flat at sea level. The legacy stack gets bumpy water
    // visuals from the water-sphere's wave shader, not from displacement.
    // Adding noise to water hexes here would re-introduce the visible
    // stair-step / wobble pattern we just fixed by flattening to sea level.
    if (!ownIsWater) {
        vec3 iP = P * interiorNoiseFreq;
        float iN = snoise(iP)         * 0.55
                 + snoise(iP * 2.07)   * 0.30
                 + snoise(iP * 4.13)   * 0.15;
        // Land bias: +0.3 so plains don't dip below sea level into water palette.
        h += (iN + 0.3) * interiorNoiseAmp;
    }

    // Phase 6: cliff-face noise. Active where edge is close AND height
    // delta between own and neighbor is non-trivial. heightDelta is in
    // fraction-of-planetRadius units; legacy LEVEL_HEIGHTS span 0.030R.
    // smoothstep(0, 0.008) gates: adjacent same-tier neighbors (delta=0)
    // get nothing, single-tier-step (delta=0.005) gets ~63% activity,
    // double-tier-step (delta=0.010) saturates. Audit-flagged: the prior
    // 0.012 underrepresented single-tier transitions.
    float cliffness = 1.0 - smoothstep(0.0, 0.15, edgeDistNorm);
    // Use the tier-table delta (not the post-flatten delta) so coastlines
    // (water tier 0/1 -> land tier 2/3/4) trigger cliff noise even though
    // both sides display at h=0.
    float cliffActivity = cliffness * smoothstep(0.0, 0.008, trueHeightDelta);
    if (cliffActivity > 0.0001) {
        // 3-octave simplex (snoise comes from GLSL_NOISE in fragment, from
        // GLSL_NOISE_VERTEX_SUBSET in vertex; same Ashima impl in both).
        vec3 nP = P * cliffNoiseFreq;
        float n =  snoise(nP)         * 0.55
                 + snoise(nP * 2.07)   * 0.30
                 + snoise(nP * 4.13)   * 0.15;
        h += cliffActivity * n * cliffNoiseAmp;

        // Stratification: horizontal rock layers banded at *constant
        // altitude*. The audit caught the prior code projecting onto cliff
        // direction in face-local 2D, which produces VERTICAL bands across
        // the cliff face. Real strata are horizontal (constant altitude)
        // so the input must be the vertex's altitude itself -- we use
        // strategyH (the smooth Strategy 3 altitude before cliff noise) so
        // bands are clean lines rather than tracking the bumpy noise.
        // cliffStrataAmp = 0 disables.
        if (cliffStrataAmp > 0.0001) {
            float strata = sin(strategyH * cliffStrataFreq * 6.2831853) * 0.5 + 0.5;
            // Modulate by a low-freq 3D noise so layers don't read as
            // perfect parallel circles around the planet.
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
// Helper: compute the displaced world position for a given unit-sphere
// point. Internally calls computeHexLookup + phase5AndPhase6Displacement.
// Used 3x in main() to derive smooth per-vertex normals via finite
// difference of the displacement function at tangent offsets.
//
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
    // Pass mesh-native radial-out normal. Babylon's CreateIcoSphere gives
    // us perfectly smooth per-vertex normals; interpolating these across
    // triangles produces smooth shading on hex tops with NO low-poly facet
    // appearance and NO NaN dots.
    //
    // Why not finite-difference smooth normals: the displacement function
    // is discontinuous at hex edges (Strategy 3 produces sharp height
    // step) and at face/pentagon seams. A 3-sample cross product near
    // those boundaries classifies the offsets into different regions,
    // generates extreme gradients, and the cross product collapses or
    // flips -> NaN normalize -> visible black dots scattered across the
    // terrain. Mesh-native normals are NaN-free.
    //
    // Cliff-rock texture firing: the legacy cliff branch gates on
    // steepness > 0.003. With a radial-out normal that gate never fires,
    // so we override steepness in the fragment via dFdx of heightAboveR
    // (a per-fragment scalar gradient that doesn't suffer cross-product
    // collapse). See GLSL_MAIN_SETUP_NEW.
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

    // Smooth per-vertex radial-out normal from the mesh, used for lighting.
    // Stays NaN-free (no finite-difference cross product) and gives smooth
    // shading across triangles within a hex face -- no low-poly facets,
    // no scattered black dots.
    vec3 N = normalize(vWorldNormal);

    bool isWall = false;  // smooth sphere -- no walls
    float distFromCenter = length(vWorldPos);
    float heightAboveR = distFromCenter - planetRadius;

    // Steepness override happens via GLSL_CLIFF_RENDERING_PATCHED, which
    // replaces the legacy 1 - dot(N, radial) (always ~0 with the radial
    // smooth normal) with cliffProximity from the 6-neighbor scan below
    // -- a clean geometric "near a real tier edge" signal that conforms
    // to hex transitions.

    vec3 procColor;

    if (isWall) {
        procColor = vec3(0.0);
    } else {
        // Perturb the hex lookup position with a small noise displacement
        // so coast and biome boundaries don't follow the perfect 60-degree
        // hex edges. The noise amplitude must stay below the hex apothem
        // in unit-sphere terms (~ 0.5/(res+1) = 0.012 at res=40) so most
        // fragments still land in their own hex; only fragments within
        // ~AMP of an edge see the noise potentially flip them to the
        // neighbor. Result: coastlines, biome borders, and cliff lines
        // are all wavy rather than hex-aligned.
        // Unperturbed lookup FIRST -- captures clean distance to the closest
        // CLIFF-TRANSITION edge specifically. Two reasons we have to do
        // this in unperturbed-P space and only consider cliff edges:
        //
        //   1. Boundary-noise amp (0.004) is wider than the rock band width
        //      (15% of apothem). Computing edge distance off the perturbed
        //      lookup makes the rock band wander with the noise field
        //      instead of following the real hex edge.
        //
        //   2. We can't just take "distance to closest hex edge of any kind"
        //      either. A fragment well inside a cliff hex but close to a
        //      same-tier neighbor edge would falsely register as a wall
        //      fragment. The gate must specifically measure "distance to
        //      the nearest edge that has a real height-tier transition".
        //
        // Same cliff-classifier rules as legacy hex-borders.ts:classifyEdge:
        //   water<->land where land tier > 2  OR  land<->land delta >= 2
        // Color/biome lookups still use the perturbed P below so coastlines
        // and biome edges stay wavy.
        computeHexLookup(P);
        float cleanCliffEdgeDistN = 1.0;
        if (g_hexId >= 0.0) {
            int cleanLvl = int(sampleHexData(g_hexId).y);
            bool cleanW = (cleanLvl <= 1);
            float rClean = 0.5 / (resolution + 1.0);
            float minCliffEd = 1e30;
            for (int k = 0; k < 6; k++) {
                float ang = float(k) * (3.14159265 / 3.0);
                vec2 nrm = vec2(cos(ang), sin(ang));
                float ed = rClean - dot(g_P2D - g_self_2d, nrm);
                float ndN = neighborIdAtEdge(k);
                if (ndN < 0.0) continue;
                int nH = int(sampleHexData(ndN).y);
                bool nIsW = (nH <= 1);
                bool isCliff = false;
                if (cleanW && !nIsW) isCliff = (nH > 2);
                else if (!cleanW && nIsW) isCliff = (cleanLvl > 2);
                else if (!cleanW && !nIsW) isCliff = (abs(nH - cleanLvl) >= 2);
                if (isCliff && ed < minCliffEd) minCliffEd = ed;
            }
            if (minCliffEd < 1e29) {
                cleanCliffEdgeDistN = clamp(minCliffEd / rClean, 0.0, 1.0);
            }
        }

        vec3 boundaryNoise = vec3(
            snoise(P * 80.0),
            snoise(P * 80.0 + vec3(100.0, 0.0, 0.0)),
            snoise(P * 80.0 + vec3(0.0, 100.0, 0.0))
        );
        vec3 P_lookup = normalize(P + boundaryNoise * 0.004);

        computeHexLookup(P_lookup);
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
            for (int k = 0; k < 6; k++) {
                float ang = float(k) * (3.14159265 / 3.0);
                vec2 nrm = vec2(cos(ang), sin(ang));
                float ed = r - dot(g_P2D - g_self_2d, nrm);
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

        // Water override is now in GLSL_WATER_OVERRIDE_LAST, injected at
        // the END of the else block so the legacy cliff + beach branches
        // can run for non-water hexes without overwriting water hex tops
        // with seafloor rock textures.
`;

// ── GLSL_WATER_OVERRIDE_LAST ────────────────────────────────
// Injected at the end of the else block (between BEACH_OVERLAY's body
// and its closing brace) so cliff and beach branches don't overwrite
// the water hex's surface with rock textures. Sharp coast boundary --
// water-water cross-blend only, no water-land blend.
const GLSL_WATER_OVERRIDE_LAST = /* glsl */ `
        if (selfIsWater) {
            vec3 viewDir = normalize(cameraPos - vWorldPos);
            float fresnel = pow(1.0 - max(0.0, dot(N, viewDir)), 2.0);
            vec3 selfWater;
            if (terrainId == 0) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
            else if (terrainId == 1) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
            else if (terrainId == 3) selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
            else selfWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.2);

            vec3 waterCol = selfWater;
            bool nbIsWater = (neighborId == 0 || neighborId == 1 || neighborId == 3);
            if (hasCrossBlend && nbIsWater) {
                vec3 nbWater;
                if (neighborId == 0) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.1);
                else if (neighborId == 1) nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.4);
                else nbWater = mix(deepColor, shallowColor, fresnel * 0.3 + 0.3) + vec3(-0.02, 0.02, 0.03);
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

// Strip the trailing `}` (closes the else) from GLSL_BEACH_OVERLAY so we
// can inject the water override before that close. The legacy chunk's
// last meaningful line is closing brace of its `if (coastProximity > ...)`
// block; the very last `}` is the else-block close.
const GLSL_BEACH_OVERLAY_NO_CLOSE = GLSL_BEACH_OVERLAY.replace(/\}\s*$/, '');

// New cliff chunk -- single fragment-side gate from cleanCliffEdgeDistN.
//
// wallness MUST be a step-like mask, NOT a smooth fade across the whole
// wall band. The wall band is [0, 0.15] of apothem (Strategy 3 ramp).
// We want full rock across that whole band -- and a quick falloff just
// at the boundary so it doesn't bleed onto the hex top. Earlier
// attempts used `1 - smoothstep(0, 0.22, edgeDistN)` which fades
// throughout the band -- mid-wall fragments only got 50-60% rock blend
// with grass, so the wall read as a thin brown line at the edge with
// grass-blended tint everywhere else. This formula keeps rock at full
// strength throughout the wall band:
//   ed = 0..0.18 -> wallness = 1 (full rock, the entire wall)
//   ed = 0.18..0.24 -> falloff
//   ed > 0.24 -> wallness = 0 (hex top, no rock)
//
// Cliff-foot sand: legacy uses a pure heightAboveR threshold which fires
// for ANY cliff at low elevation, including inland tier 2->3 cliffs
// where the whole wall is below the threshold. That dyes the entire
// inland wall sand-tan. Gate footAmt on coastProximity so the sand
// blend only fires for actually coastal cliffs.
const GLSL_CLIFF_RENDERING_NEW = /* glsl */ `
        float wallness = 1.0 - smoothstep(0.18, 0.24, cleanCliffEdgeDistN);
        float waterCliffBlend = 0.0;
        if (wallness > 0.005) {
            int cliffPalId = hasCrossBlend ? neighborId : terrainId;
            vec3 cliffLight = cliffPalette[cliffPalId * 3];
            vec3 cliffDark  = cliffPalette[cliffPalId * 3 + 1];
            vec3 cliffPale  = cliffPalette[cliffPalId * 3 + 2];

            // Procedural rock color from worldspace simplex noise.
            float rockN1 = snoise(vWorldPos * 0.012) * 0.5 + 0.5;
            float rockN2 = snoise(vWorldPos * 0.045) * 0.5 + 0.5;
            vec3 rockColor = mix(cliffLight, cliffDark, rockN1);
            rockColor = mix(rockColor, cliffPale, smoothstep(0.62, 0.92, rockN2) * 0.55);
            rockColor += snoise(vWorldPos * 0.006) * 0.025;

            // Cliff-foot sand: only fires when actually coastal. For
            // inland cliffs coastProximity is 0 so footGate is 0 and
            // the wall stays purely rocky.
            float footAmt = 1.0 - smoothstep(
                COAST_FOOT_FULL * planetRadius,
                COAST_FOOT_FADE * planetRadius,
                heightAboveR
            );
            float footNoise = snoise(vWorldPos * 0.010) * 0.30
                            + snoise(vWorldPos * 0.035) * 0.15;
            footAmt = clamp(footAmt + footNoise, 0.0, 1.0);
            float footGate = smoothstep(0.0, 0.4, coastProximity);
            rockColor = mix(rockColor, beachColor * 0.82, footAmt * COAST_FOOT_AMOUNT * footGate);

            procColor = mix(procColor, rockColor, wallness);
            waterCliffBlend = wallness;
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
	GLSL_CLIFF_RENDERING_NEW +
	GLSL_BEACH_OVERLAY_NO_CLOSE +
	GLSL_WATER_OVERRIDE_LAST +
	'\n}\n' +              // close the else block
	GLSL_LIGHTING;

// Phase 6 default tunables. Cliff noise amplitude is in fraction-of-planet-
// radius units; AMP=0.005 means peak displacement of ~0.5% of radius
// (~32 km on a 6371 km planet -- enough to break the polar silhouette
// from a perfect circle, which 0.0015 was too low to do).
//
// Stratification: bands at constant altitude; each band period is
// 1 / cliffStrataFreq fraction of planetRadius. freq=300 gives bands
// every ~21 km, so ~5-10 visible bands across a tier transition.
const PHASE6_DEFAULTS = {
	// Cliff noise: high frequency, low amplitude. The Phase 6 noise displaces
	// vertices in the cliff transition band (last 15% of edge distance);
	// large amp at low freq makes the *silhouette* of the cliff face swim
	// around in big curves (visible "swirly cliff" pattern). What we want
	// is a crisp wall (close to legacy prism cliff) with fine rocky detail
	// across the face -- so push freq up (period ~6-7 km) and drop amp
	// almost an order of magnitude. The cliff line stays at the hex tier
	// boundary; only the surface texture varies.
	cliffNoiseAmp: 0.0015,
	cliffNoiseFreq: 150.0,
	cliffStrataAmp: 0.0008,
	cliffStrataFreq: 300.0,
	// Interior noise stays gentle so dFdx/dFdy normals don't see every
	// per-triangle slope as a cliff. 0.0025R / freq 20 keeps the surface
	// readable as bumpy plains without lighting up the slab-rock branch.
	interiorNoiseAmp: 0.0025,
	interiorNoiseFreq: 20.0,
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
			'interiorNoiseAmp', 'interiorNoiseFreq',
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
	mat.setFloat('interiorNoiseAmp', PHASE6_DEFAULTS.interiorNoiseAmp);
	mat.setFloat('interiorNoiseFreq', PHASE6_DEFAULTS.interiorNoiseFreq);

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

/** Tune Phase 6 cliff-face noise + interior surface noise at runtime. */
export interface ShaderGlobeCliffNoiseSettings {
	cliffNoiseAmp?: number;
	cliffNoiseFreq?: number;
	cliffStrataAmp?: number;
	cliffStrataFreq?: number;
	interiorNoiseAmp?: number;
	interiorNoiseFreq?: number;
}
export function applyShaderGlobeCliffNoise(mat: ShaderMaterial, s: ShaderGlobeCliffNoiseSettings): void {
	if (s.cliffNoiseAmp !== undefined) mat.setFloat('cliffNoiseAmp', s.cliffNoiseAmp);
	if (s.cliffNoiseFreq !== undefined) mat.setFloat('cliffNoiseFreq', s.cliffNoiseFreq);
	if (s.cliffStrataAmp !== undefined) mat.setFloat('cliffStrataAmp', s.cliffStrataAmp);
	if (s.cliffStrataFreq !== undefined) mat.setFloat('cliffStrataFreq', s.cliffStrataFreq);
	if (s.interiorNoiseAmp !== undefined) mat.setFloat('interiorNoiseAmp', s.interiorNoiseAmp);
	if (s.interiorNoiseFreq !== undefined) mat.setFloat('interiorNoiseFreq', s.interiorNoiseFreq);
}
