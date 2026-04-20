/**
 * Hex picking — use Babylon's scene.pick() against the actual globe mesh,
 * then find the nearest hex cell center to the hit point.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { HexCell } from './icosphere';

/**
 * Pick the hex cell under a screen coordinate.
 * Uses Babylon's built-in picking against the globe mesh for accurate results.
 *
 * @returns Cell index or -1 if missed
 */
export function pickHexAtScreen(
	scene: Scene,
	globeMesh: Mesh,
	screenX: number,
	screenY: number,
	cells: HexCell[]
): number {
	const pickResult = scene.pick(screenX, screenY, (mesh) => mesh === globeMesh);

	if (!pickResult?.hit || !pickResult.pickedPoint) return -1;

	// Normalize the hit point to unit sphere for comparison with cell centers
	const hitNorm = pickResult.pickedPoint.normalize();

	// Find nearest cell center
	let bestIdx = -1;
	let bestDist = Infinity;
	for (let i = 0; i < cells.length; i++) {
		const dist = Vector3.DistanceSquared(hitNorm, cells[i].center);
		if (dist < bestDist) {
			bestDist = dist;
			bestIdx = i;
		}
	}

	return bestIdx;
}
