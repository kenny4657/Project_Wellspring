/**
 * Phase 2 spike -- debug ShaderMaterial that calls `worldPosToHexId(P)` per
 * fragment and outputs a per-hex heat-map color. Applied to a smooth sphere
 * (not the per-hex prism mesh), this lets us visually verify the GLSL hex
 * lookup matches the CPU `pickHex` algorithm before committing to Phase 1+.
 *
 * Pipeline:
 *
 *   1. Vertex shader projects each vertex onto the unit sphere; the
 *      fragment shader receives the unit-sphere world position via varying.
 *
 *   2. Fragment shader runs `worldPosToHexId`:
 *        a. Find icosahedron face: max dot(P, faceCentroid[f]) over 20 faces.
 *        b. Compute planar barycentric (l1, l2, l3) of P w.r.t. the face's
 *           triangle (v0, v1, v2). Cross-product method -- implicitly projects
 *           onto plane.
 *        c. Invert icosphere.ts forward map: l3 -> cz, l2 -> cx, then
 *           (cz, cx) -> (i, j).
 *        d. Sample hex lookup texture at pixel (face*gridSize + j, i),
 *           decode 16-bit ID from RG channels.
 *
 *   3. Render the ID as a hashed RGB color. -1 sentinel renders magenta.
 *
 * Hex IDs assigned by icosphere.ts depend on triangle iteration order, so
 * the lookup texture (built CPU-side from the same `cells[]`) is the
 * authoritative ground truth. Match success <-> shader pixel color matches
 * the color we'd compute from `cells[pickHex(...)].id` at the same point.
 */

import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import type { Scene } from '@babylonjs/core/scene';
import type { HexIdLookup } from './hex-id-lookup';

const VERTEX = /* glsl */ `
precision highp float;

uniform mat4 world;
uniform mat4 viewProjection;

attribute vec3 position;

varying vec3 vSpherePos;

void main() {
    vec4 wp = world * vec4(position, 1.0);
    // Normalize by world position length -- vertex sits on a sphere centered
    // at world origin (pickSphere / smooth icosphere). Normalizing makes the
    // fragment shader independent of the actual sphere radius.
    vSpherePos = normalize(wp.xyz);
    gl_Position = viewProjection * wp;
}
`;

// -- Fragment shader --
//
// Mirrors `faceGridParams()` in icosphere.ts. If you change those constants,
// change them here too -- keep encoder and decoder in sync.
const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 faceCentroid[20];
uniform vec3 faceVertA[20];
uniform vec3 faceVertB[20];
uniform vec3 faceVertC[20];

uniform sampler2D hexLookup;
uniform float gridSize;
uniform float resolution;
uniform float outputMode;

varying vec3 vSpherePos;

const float SQRT3 = 1.7320508075688772;
const float NO_HEX = 65535.0;

// Cheap deterministic RGB hash for an integer ID.
vec3 idColor(float fid) {
    return vec3(
        fract(sin(fid * 12.9898) * 43758.5453),
        fract(sin(fid * 78.233 + 1.7) * 43758.5453),
        fract(sin(fid * 37.719 + 4.3) * 43758.5453)
    );
}

// Find the icosahedron face whose centroid has the largest dot with P.
// Loop over all 20 faces -- branchless, ~20 multiply-adds. Fast.
int findFace(vec3 P) {
    int best = 0;
    float bestDot = -2.0;
    for (int f = 0; f < 20; f++) {
        float d = dot(P, faceCentroid[f]);
        if (d > bestDot) { bestDot = d; best = f; }
    }
    return best;
}

// Planar barycentric coords (l1, l2, l3) of P projected onto triangle plane,
// such that P_proj ~= l1*v0 + l2*v1 + l3*v2 and l1+l2+l3 = 1.
// Cross-product method: numerically stable, no divide-by-near-zero unless
// the triangle is degenerate (icosahedron faces never are).
vec3 baryCoords(vec3 P, vec3 v0, vec3 v1, vec3 v2) {
    vec3 e1 = v1 - v0;
    vec3 e2 = v2 - v0;
    vec3 n = cross(e1, e2);
    float invDen = 1.0 / dot(n, n);
    vec3 d = P - v0;
    float l2 = dot(cross(d, e2), n) * invDen;
    float l3 = dot(cross(e1, d), n) * invDen;
    float l1 = 1.0 - l2 - l3;
    return vec3(l1, l2, l3);
}

// Decode (face, i, j) -> cellId via the lookup texture.
// Returns -1.0 if outside grid or no hex mapped. Uses nearest-neighbor
// sampling -- interpolation across hex IDs would be meaningless.
float sampleLookup(int face, int i, int j) {
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
    if (id >= NO_HEX) return -1.0;
    return id;
}

// Phase 2 deliverable: world position -> hex ID.
// vSpherePos is unit-length (vertex shader normalized).
//
// Forward map (icosphere.ts) was:
//   cx = -0.5 + 2r*j (+r if i odd), cz = (3*diameter/4)*i
//   l3 = cz * 2/sqrt(3); l2 = cx + 0.5*(1 - l3); l1 = 1 - l2 - l3
//   p = slerp(slerp(v0, v1, l2/(l1+l2)), v2, l3); normalize
//
// Inverse approximation: replace spherical slerp with planar barycentric.
// Error is bounded by face curvature; at icosahedron scale (12.4deg per edge),
// the planar bary of a unit-sphere point is within ~1% of the sphere bary --
// well below one hex cell at any practical resolution.
float worldPosToHexId(vec3 P) {
    int face = findFace(P);

    vec3 v0 = faceVertA[face];
    vec3 v1 = faceVertB[face];
    vec3 v2 = faceVertC[face];

    vec3 bary = baryCoords(P, v0, v1, v2);
    float l1 = bary.x, l2 = bary.y, l3 = bary.z;

    // Inverse of icosphere.ts barycentric() -- recover face-local 2D (cx, cz):
    //   forward: l3 = z * 2/sqrt(3); l2 = x + 0.5*(1 - l3); l1 = 1 - l2 - l3
    //   inverse: cz = l3 * sqrt(3)/2; cx = l2 - 0.5*(1 - l3)
    float cz = l3 * SQRT3 * 0.5;
    float cx = l2 - 0.5 * (1.0 - l3);

    // (cx, cz) -> (i, j) -- invert the row-step + column-step formulas.
    // r and diameter mirror faceGridParams() in icosphere.ts.
    float r = 0.5 / (resolution + 1.0);
    float diameter = 2.0 * r * 2.0 / SQRT3;
    float rowStep = diameter * 0.75;

    float iF = cz / rowStep;
    int i = int(floor(iF + 0.5));
    float oddOffset = (mod(float(i), 2.0) > 0.5) ? r : 0.0;
    float jF = (cx - (-0.5) - oddOffset) / (2.0 * r);
    int j = int(floor(jF + 0.5));

    return sampleLookup(face, i, j);
}

void main() {
    vec3 P = normalize(vSpherePos);
    float id = worldPosToHexId(P);

    if (outputMode > 0.5 && outputMode < 1.5) {
        // Face index visualization -- 20 distinct hues.
        int face = findFace(P);
        gl_FragColor = vec4(idColor(float(face) * 17.0 + 3.0), 1.0);
        return;
    }
    if (outputMode > 1.5 && outputMode < 2.5) {
        // (i, j) heat map -- ignores face, useful for verifying inverse map.
        // Re-run inverse to extract (i, j); reuse logic.
        int face = findFace(P);
        vec3 v0 = faceVertA[face], v1 = faceVertB[face], v2 = faceVertC[face];
        vec3 b = baryCoords(P, v0, v1, v2);
        float cz = b.z * SQRT3 * 0.5;
        float cx = b.y - 0.5 * (1.0 - b.z);
        float r = 0.5 / (resolution + 1.0);
        float diameter = 2.0 * r * 2.0 / SQRT3;
        float iF = cz / (diameter * 0.75);
        int ii = int(floor(iF + 0.5));
        float oddOff = (mod(float(ii), 2.0) > 0.5) ? r : 0.0;
        float jF = (cx + 0.5 - oddOff) / (2.0 * r);
        int jj = int(floor(jF + 0.5));
        gl_FragColor = vec4(float(ii) / gridSize, float(jj) / gridSize, 0.5, 1.0);
        return;
    }

    if (outputMode > 2.5) {
        // Mode 3: raw ID bits in RGB. Used by phase2-verify.mjs to compare
        // GLSL output with CPU pickHex *exactly*, bypassing hash precision.
        if (id < 0.0) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
        float low = mod(id, 256.0);
        float mid = mod(floor(id / 256.0), 256.0);
        float high = floor(id / 65536.0);
        gl_FragColor = vec4(low / 255.0, mid / 255.0, high / 255.0, 1.0);
        return;
    }

    if (id < 0.0) {
        // Lookup miss -- magenta marks "GLSL produced (face, i, j) that has
        // no mapped cell." Should be near-zero pixels in practice.
        gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
        return;
    }

    gl_FragColor = vec4(idColor(id), 1.0);
}
`;

export interface ShaderGlobeDebugOptions {
	lookup: HexIdLookup;
	resolution: number;
}

export function createShaderGlobeDebugMaterial(scene: Scene, opts: ShaderGlobeDebugOptions): ShaderMaterial {
	ShaderStore.ShadersStore['shaderGlobeDebugVertexShader'] = VERTEX;
	ShaderStore.ShadersStore['shaderGlobeDebugFragmentShader'] = FRAGMENT;

	const mat = new ShaderMaterial('shaderGlobeDebug', scene, {
		vertex: 'shaderGlobeDebug',
		fragment: 'shaderGlobeDebug',
	}, {
		attributes: ['position'],
		uniforms: [
			'world', 'viewProjection',
			'gridSize', 'resolution',
			'outputMode',
			'faceCentroid', 'faceVertA', 'faceVertB', 'faceVertC',
		],
		samplers: ['hexLookup'],
		needAlphaBlending: false,
	});

	const { lookup, resolution } = opts;

	// Split faceVerts (20 x 9 floats) into three vec3[20] arrays -- one per
	// triangle vertex slot. setArray3 expects flat float arrays.
	const vA = new Float32Array(20 * 3);
	const vB = new Float32Array(20 * 3);
	const vC = new Float32Array(20 * 3);
	for (let f = 0; f < 20; f++) {
		vA[f * 3] = lookup.faceVerts[f * 9 + 0]; vA[f * 3 + 1] = lookup.faceVerts[f * 9 + 1]; vA[f * 3 + 2] = lookup.faceVerts[f * 9 + 2];
		vB[f * 3] = lookup.faceVerts[f * 9 + 3]; vB[f * 3 + 1] = lookup.faceVerts[f * 9 + 4]; vB[f * 3 + 2] = lookup.faceVerts[f * 9 + 5];
		vC[f * 3] = lookup.faceVerts[f * 9 + 6]; vC[f * 3 + 1] = lookup.faceVerts[f * 9 + 7]; vC[f * 3 + 2] = lookup.faceVerts[f * 9 + 8];
	}

	mat.setArray3('faceCentroid', Array.from(lookup.faceCentroids));
	mat.setArray3('faceVertA', Array.from(vA));
	mat.setArray3('faceVertB', Array.from(vB));
	mat.setArray3('faceVertC', Array.from(vC));
	mat.setTexture('hexLookup', lookup.texture);
	mat.setFloat('gridSize', lookup.gridSize);
	mat.setFloat('resolution', resolution);
	mat.setFloat('outputMode', 0);

	mat.backFaceCulling = true;
	return mat;
}

/** Switch the heat-map mode at runtime.
 *  0 = id-color hash, 1 = face index, 2 = (i,j) heatmap, 3 = raw ID bits (verifier). */
export function setShaderGlobeDebugMode(mat: ShaderMaterial, mode: 0 | 1 | 2 | 3): void {
	mat.setFloat('outputMode', mode);
}
