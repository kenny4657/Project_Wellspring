/**
 * Globe engine — Babylon.js 9.0 scene with geospatial camera, atmosphere, and earth sphere.
 *
 * This is the rendering backbone. The UI layer (Svelte) communicates with it
 * via the GlobeEngine interface — it never touches Babylon objects directly.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { GeospatialCamera } from '@babylonjs/core/Cameras/geospatialCamera';
import { Atmosphere } from '@babylonjs/addons/atmosphere/atmosphere';
import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';

// Side-effect import: enables thin instance API on Mesh
import '@babylonjs/core/Meshes/thinInstanceMesh';

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
}

/**
 * Create and return a fully initialized globe engine bound to the given canvas.
 */
export async function createGlobeEngine(canvas: HTMLCanvasElement): Promise<GlobeEngine> {
	// ── Engine & Scene ──────────────────────────────────────
	const engine = new Engine(canvas, true, {
		preserveDrawingBuffer: false,
		stencil: true,
		antialias: true
	});

	const scene = new Scene(engine);
	scene.clearColor = new Color4(0, 0, 0, 1); // black space background

	// ── Lighting ────────────────────────────────────────────
	// Hemisphere light for ambient fill
	const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
	hemiLight.intensity = 0.4;
	hemiLight.groundColor = new Color3(0.1, 0.1, 0.15);

	// Directional light as the sun — drives the atmosphere day/night cycle
	const sunDirection = new Vector3(-1, 0.5, 0.3).normalize();
	const sunLight = new DirectionalLight('sun', sunDirection.negate(), scene);
	sunLight.intensity = 2.0;
	sunLight.diffuse = new Color3(1, 0.98, 0.92);

	// ── Globe Sphere ────────────────────────────────────────
	const globe = MeshBuilder.CreateSphere('globe', {
		diameter: EARTH_RADIUS_KM * 2,
		segments: 64
	}, scene);

	const globeMat = new StandardMaterial('globeMat', scene);
	// Ocean blue-grey base color
	globeMat.diffuseColor = new Color3(0.34, 0.45, 0.56); // ~#576F8F
	globeMat.specularColor = new Color3(0.15, 0.15, 0.15);
	globe.material = globeMat;

	// ── Geospatial Camera ───────────────────────────────────
	const camera = new GeospatialCamera('geoCam', scene, {
		planetRadius: EARTH_RADIUS_KM,
		pickPredicate: (mesh) => mesh === globe
	});

	// Start looking at roughly Europe/Atlantic, zoomed out
	const startCenter = latLngToWorld(35, -20, EARTH_RADIUS_KM);
	camera.center = startCenter;
	camera.radius = EARTH_RADIUS_KM * 3; // far orbit
	camera.pitch = 0; // looking straight at globe
	camera.yaw = 0;

	// Zoom limits
	camera.limits.radiusMin = EARTH_RADIUS_KM * 1.01; // just above surface
	camera.limits.radiusMax = EARTH_RADIUS_KM * 5;    // far orbit
	camera.limits.pitchMax = Math.PI / 2.5;            // limit tilt

	camera.attachControl(canvas, true);

	// ── Atmosphere ──────────────────────────────────────────
	let atmosphere: Atmosphere | null = null;
	if (Atmosphere.IsSupported(engine)) {
		atmosphere = new Atmosphere('atmosphere', scene, [sunLight], {
			exposure: 1.0,
			isLinearSpaceLight: false,
			isLinearSpaceComposition: false,
			isSkyViewLutEnabled: true,
			isAerialPerspectiveLutEnabled: true,
			originHeight: 0
		});
	} else {
		console.warn('[Globe] Atmosphere not supported on this device');
	}

	// ── Render Loop ─────────────────────────────────────────
	engine.runRenderLoop(() => {
		scene.render();
	});

	// Handle window resize
	const onResize = () => engine.resize();
	window.addEventListener('resize', onResize);

	// ── Public API ──────────────────────────────────────────
	return {
		dispose() {
			window.removeEventListener('resize', onResize);
			atmosphere?.dispose();
			scene.dispose();
			engine.dispose();
		},

		flyTo(lat: number, lng: number, altitude: number = EARTH_RADIUS_KM * 0.5) {
			const targetCenter = latLngToWorld(lat, lng, EARTH_RADIUS_KM);
			const targetRadius = EARTH_RADIUS_KM + altitude;
			camera.flyToAsync(
				undefined, // keep current yaw
				undefined, // keep current pitch
				targetRadius,
				targetCenter,
				2000 // 2 second flight
			);
		}
	};
}
