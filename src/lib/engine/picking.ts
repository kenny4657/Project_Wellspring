/**
 * Hex picking — ray-sphere intersection to identify which H3 hex
 * the user clicked on.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { latLngToCell } from 'h3-js';
import { worldToLatLng, EARTH_RADIUS_KM } from '$lib/geo/coords';

/**
 * Pick the H3 cell under a screen coordinate by ray-sphere intersection.
 *
 * @returns H3 cell index or null if the click missed the globe
 */
export function pickHexAtScreen(
	scene: Scene,
	camera: Camera,
	screenX: number,
	screenY: number,
	h3Resolution: number
): string | null {
	// Create picking ray from screen coordinates
	const ray = scene.createPickingRay(screenX, screenY, undefined, camera);

	// Intersect with sphere of radius EARTH_RADIUS_KM centered at origin
	const r = EARTH_RADIUS_KM + 10; // slightly above surface to match hex offset
	const origin = ray.origin;
	const dir = ray.direction;

	const oc = origin; // sphere center is at origin
	const a = Vector3.Dot(dir, dir);
	const b = 2.0 * Vector3.Dot(oc, dir);
	const c = Vector3.Dot(oc, oc) - r * r;
	const discriminant = b * b - 4.0 * a * c;

	if (discriminant < 0) return null; // miss

	const t = (-b - Math.sqrt(discriminant)) / (2.0 * a);
	if (t < 0) return null; // behind camera

	const hitPoint = origin.add(dir.scale(t));
	const { lat, lng } = worldToLatLng(hitPoint);

	return latLngToCell(lat, lng, h3Resolution);
}
