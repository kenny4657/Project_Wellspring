/**
 * Hex picking — ray-sphere intersection, then find nearest hex cell center.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { HexCell } from './icosphere';
import { EARTH_RADIUS_KM } from '$lib/geo/coords';

/**
 * Pick the hex cell under a screen coordinate.
 *
 * @returns Cell index or -1 if missed
 */
export function pickHexAtScreen(
	scene: Scene,
	camera: Camera,
	screenX: number,
	screenY: number,
	cells: HexCell[],
	radius: number
): number {
	const ray = scene.createPickingRay(screenX, screenY, undefined, camera);

	// Intersect with sphere
	const origin = ray.origin;
	const dir = ray.direction;
	const a = Vector3.Dot(dir, dir);
	const b = 2.0 * Vector3.Dot(origin, dir);
	const c = Vector3.Dot(origin, origin) - radius * radius;
	const discriminant = b * b - 4.0 * a * c;

	if (discriminant < 0) return -1;

	const t = (-b - Math.sqrt(discriminant)) / (2.0 * a);
	if (t < 0) return -1;

	const hitPoint = origin.add(dir.scale(t)).normalize();

	// Find nearest cell center
	let bestIdx = -1;
	let bestDist = Infinity;
	for (let i = 0; i < cells.length; i++) {
		const dist = Vector3.DistanceSquared(hitPoint, cells[i].center);
		if (dist < bestDist) {
			bestDist = dist;
			bestIdx = i;
		}
	}

	return bestIdx;
}
