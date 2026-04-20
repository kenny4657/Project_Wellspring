/**
 * Terrain material — CustomMaterial (extends StandardMaterial) with:
 * - Vertex displacement: noise-based terrain height per terrain type
 * - Fragment: terrain colors, edge blending, hex shape clipping
 * - All Babylon lights work automatically
 */
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { TERRAIN_PROFILES } from '$lib/world/terrain-types';

const N = TERRAIN_PROFILES.length;

function buildTerrainColorsGlsl(): string {
	const lines = TERRAIN_PROFILES.map((p, i) =>
		`  tc[${i}] = vec3(${p.color[0].toFixed(2)}, ${p.color[1].toFixed(2)}, ${p.color[2].toFixed(2)});`
	).join('\n');
	return `void initTC(out vec3 tc[${N}]) {\n${lines}\n}`;
}

function buildTerrainParamsGlsl(): string {
	const lines = TERRAIN_PROFILES.map((p, i) =>
		`  tp[${i}] = vec4(${p.height.toFixed(1)}, ${p.amplitude.toFixed(1)}, ${p.frequency.toFixed(1)}, ${p.ridged ? '1.0' : '0.0'});`
	).join('\n');
	return `void initTP(out vec4 tp[${N}]) {\n${lines}\n}`;
}

// Hex shape test: returns 0-1 where 0=center, 1=edge, >1=outside
const HEX_SHAPE_GLSL = `
float hexDist(vec2 p) {
    vec2 ap = abs(p);
    // Flat-top hex: test against 3 edge planes
    float d = max(ap.x * 0.866025 + ap.y * 0.5, ap.y);
    return d;
}
`;

// Compact simplex noise
const NOISE_GLSL = `
vec3 mr3(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mr4(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm4(vec4 x){return mr4(((x*34.)+1.)*x);}
vec4 tis4(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snz(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
  vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mr3(i);
  vec4 p=pm4(pm4(pm4(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;
  vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 nm=tis4(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=nm.x;p1*=nm.y;p2*=nm.z;p3*=nm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbmN(vec3 p,float f){float v=0.;float a=.5;vec3 pp=p*f;for(int i=0;i<4;i++){v+=a*snz(pp);pp*=2.;a*=.5;}return v;}
float ridN(vec3 p,float f){float v=0.;float a=.5;vec3 pp=p*f;for(int i=0;i<4;i++){float n=1.-abs(snz(pp));v+=a*n*n;pp*=2.;a*=.5;}return v;}
`;

export function createTerrainMaterial(scene: Scene, hexRadius: number): CustomMaterial {
	const mat = new CustomMaterial('terrainMat', scene);
	mat.diffuseColor = new Color3(1, 1, 1);
	mat.specularColor = new Color3(0.1, 0.1, 0.1);
	mat.backFaceCulling = false;

	mat.AddAttribute('terrainData0');
	mat.AddAttribute('terrainData1');

	// ── Vertex shader ──
	mat.Vertex_Definitions(`
		attribute vec4 terrainData0;
		attribute vec4 terrainData1;
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0,vN1,vN2,vN3,vN4,vN5;
		${buildTerrainParamsGlsl()}
		${NOISE_GLSL}
		${HEX_SHAPE_GLSL}
		float getNH(int e, vec4 tp[${N}]) {
			float nt;
			if(e==0)nt=terrainData0.y;else if(e==1)nt=terrainData0.z;else if(e==2)nt=terrainData0.w;
			else if(e==3)nt=terrainData1.x;else if(e==4)nt=terrainData1.y;else nt=terrainData1.z;
			return tp[int(nt)].x;
		}
	`);

	mat.Vertex_MainBegin(`
		vTerrainType = terrainData0.x;
		vN0=terrainData0.y;vN1=terrainData0.z;vN2=terrainData0.w;
		vN3=terrainData1.x;vN4=terrainData1.y;vN5=terrainData1.z;
	`);

	const R = hexRadius.toFixed(1);

	mat.Vertex_Before_PositionUpdated(`
		vec2 hexUV = positionUpdated.xz / ${R};
		vHexUV = hexUV;

		vec4 tp[${N}]; initTP(tp);
		int tIdx = int(terrainData0.x);
		vec4 prm = tp[tIdx];
		float tH = prm.x;
		float amp = prm.y;
		float frq = prm.z;
		float isR = prm.w;

		// Noise displacement using local position as seed
		float dfc = hexDist(hexUV);
		vec3 ns = positionUpdated * 0.02;

		float disp;
		if (isR > 0.5) { disp = ridN(ns, frq) * amp; }
		else { disp = fbmN(ns, frq) * amp; }

		// Fade displacement to edge meeting height
		float ef = smoothstep(0.6, 0.95, dfc);
		float ang = atan(hexUV.y, hexUV.x);
		float sec = mod(ang / (3.14159265 / 3.0) + 6.0, 6.0);
		int ne = int(floor(sec)); ne = clamp(ne, 0, 5);
		float nH = getNH(ne, tp);
		float mH = (tH + nH) * 0.5;
		float fH = mix(tH + disp * (1.0 - ef), mH, ef);

		positionUpdated.y = fH;
	`);

	// ── Fragment shader ──
	mat.Fragment_Definitions(`
		varying vec2 vHexUV;
		varying float vTerrainType;
		varying float vN0,vN1,vN2,vN3,vN4,vN5;
		${buildTerrainColorsGlsl()}
		${HEX_SHAPE_GLSL}
		float gNT(int e){
			if(e==0)return vN0;if(e==1)return vN1;if(e==2)return vN2;
			if(e==3)return vN3;if(e==4)return vN4;return vN5;
		}
	`);

	// Clip to hex shape — discard pixels outside hex boundary
	mat.Fragment_MainBegin(`
		float hd = hexDist(vHexUV);
		if (hd > 1.0) discard;
	`);

	// Override diffuse with terrain color + blending
	mat.Fragment_Custom_Diffuse(`
		vec3 tc[${N}]; initTC(tc);
		int tIdx = int(vTerrainType + 0.5);
		vec3 tCol = tc[tIdx];

		float dfc = hexDist(vHexUV);
		float eb = smoothstep(0.6, 0.95, dfc);
		float ang = atan(vHexUV.y, vHexUV.x);
		float sec = mod(ang / (3.14159265 / 3.0) + 6.0, 6.0);
		int ne = int(floor(sec)); ne = clamp(ne, 0, 5);
		float nType = gNT(ne);
		int nIdx = int(nType + 0.5);

		if (nIdx != tIdx && eb > 0.0) {
			vec3 nCol = tc[nIdx];
			bool mW = tIdx <= 4;
			bool nW = nIdx <= 4;
			if (mW != nW) {
				tCol = mix(tCol, vec3(0.85, 0.78, 0.55), eb * 0.6);
			} else {
				tCol = mix(tCol, nCol, eb * 0.4);
			}
		}

		// Hex edge darkening
		float eDk = smoothstep(0.88, 0.98, dfc) * 0.15;
		tCol *= (1.0 - eDk);

		diffuseColor = tCol;
	`);

	return mat;
}
