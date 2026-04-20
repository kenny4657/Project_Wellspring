/**
 * Terrain material — StandardMaterial with vertex colors.
 *
 * Vertex colors are set per-cell in the mesh builder based on terrain type.
 * StandardMaterial automatically uses vertex colors when mesh.useVertexColors = true.
 * All Babylon scene lights work automatically.
 *
 * Future: upgrade to CustomMaterial for biome texture blending by height.
 */
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

export function createTerrainMaterial(scene: Scene): StandardMaterial {
	const mat = new StandardMaterial('terrainMat', scene);
	mat.diffuseColor = new Color3(1, 1, 1); // white — vertex colors provide the actual color
	mat.specularColor = new Color3(0.15, 0.15, 0.15);
	mat.backFaceCulling = true;
	return mat;
}
