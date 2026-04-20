/**
 * Coordinate conversion between geographic (lat/lng) and 3D world positions.
 *
 * The globe is a sphere centered at the origin. The coordinate system matches
 * Babylon.js defaults (Y-up, left-handed). Planet radius is in kilometers
 * to match Babylon's geospatial camera and atmosphere (which use km).
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Earth's mean radius in kilometers */
export const EARTH_RADIUS_KM = 6371;

/**
 * Convert geographic coordinates to a 3D position on a sphere.
 * Y-up, left-handed coordinate system.
 *
 * @param lat Latitude in degrees (-90 to 90)
 * @param lng Longitude in degrees (-180 to 180)
 * @param radius Distance from center (planet radius + altitude)
 * @returns Position vector in world space
 */
export function latLngToWorld(lat: number, lng: number, radius: number = EARTH_RADIUS_KM): Vector3 {
	const phi = (90 - lat) * DEG2RAD;   // polar angle from Y axis
	const theta = (lng + 180) * DEG2RAD; // azimuthal angle

	return new Vector3(
		-radius * Math.sin(phi) * Math.cos(theta),
		 radius * Math.cos(phi),
		 radius * Math.sin(phi) * Math.sin(theta)
	);
}

/**
 * Convert a 3D world position back to geographic coordinates.
 *
 * @param position World-space position vector
 * @returns { lat, lng, altitude } where altitude is distance above the surface
 */
export function worldToLatLng(position: Vector3): { lat: number; lng: number; altitude: number } {
	const r = position.length();
	const lat = 90 - Math.acos(position.y / r) * RAD2DEG;
	const lng = Math.atan2(position.z, -position.x) * RAD2DEG - 180;

	return {
		lat,
		lng: lng < -180 ? lng + 360 : lng > 180 ? lng - 360 : lng,
		altitude: r - EARTH_RADIUS_KM
	};
}

/**
 * Compute the surface normal at a given lat/lng on a sphere.
 * This is simply the normalized position vector for a sphere centered at origin.
 */
export function surfaceNormal(lat: number, lng: number): Vector3 {
	return latLngToWorld(lat, lng, 1).normalize();
}
