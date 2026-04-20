/**
 * Globe engine — Babylon.js 9.0 scene with geospatial camera, atmosphere,
 * and shader-driven hex terrain.
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

// Side-effect imports: register atmosphere shaders in ShaderStore
// (Babylon uses dynamic import() for these, which Vite can't resolve from node_modules)
import '@babylonjs/addons/atmosphere/Shaders/fullscreenTriangle.vertex';
import '@babylonjs/addons/atmosphere/Shaders/transmittance.fragment';
import '@babylonjs/addons/atmosphere/Shaders/multiScattering.fragment';
import '@babylonjs/addons/atmosphere/Shaders/skyView.fragment';
import '@babylonjs/addons/atmosphere/Shaders/aerialPerspective.fragment';
import '@babylonjs/addons/atmosphere/Shaders/compositeSky.fragment';
import '@babylonjs/addons/atmosphere/Shaders/compositeGlobeAtmosphere.fragment';
import '@babylonjs/addons/atmosphere/Shaders/compositeAerialPerspective.fragment';
import '@babylonjs/addons/atmosphere/Shaders/diffuseSkyIrradiance.fragment';
import '@babylonjs/addons/atmosphere/Shaders/ShadersInclude/atmosphereFragmentDeclaration';
import '@babylonjs/addons/atmosphere/Shaders/ShadersInclude/atmosphereUboDeclaration';
import '@babylonjs/addons/atmosphere/Shaders/ShadersInclude/atmosphereFunctions';
import '@babylonjs/addons/atmosphere/Shaders/ShadersInclude/depthFunctions';

// Side-effect: register Babylon's default material shaders
import '@babylonjs/core/Shaders/default.vertex';
import '@babylonjs/core/Shaders/default.fragment';

import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { createHexMesh } from '$lib/engine/hex-mesh';
import { HexRenderer } from '$lib/engine/hex-renderer';
import { createTerrainMaterial } from '$lib/engine/terrain-shader';
import { pickHexAtScreen } from '$lib/engine/picking';
import { type TerrainTypeId, TERRAIN_PROFILES } from '$lib/world/terrain-types';
import { getRes0Cells, cellToChildren } from 'h3-js';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';

// Side-effect import: enables thin instance API on Mesh
import '@babylonjs/core/Meshes/thinInstanceMesh';

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(h3: string, terrain: TerrainTypeId): void;
	setHexColor(h3: string, r: number, g: number, b: number, a: number): void;
	clearHexColor(h3: string): void;
	getHexTerrain(h3: string): TerrainTypeId | null;
	hasHex(h3: string): boolean;
	readonly hexCount: number;
	readonly hexRenderer: HexRenderer;
	/** Set callback for hex clicks. Return the H3 index of the clicked hex. */
	onHexClick: ((h3: string) => void) | null;
}

/** H3 resolution for the hex grid */
const H3_RES = 3; // ~12K cells for prototyping (res 4 = ~80K, too slow for initial dev)

/**
 * Create and return a fully initialized globe engine bound to the given canvas.
 */
export async function createGlobeEngine(
	canvas: HTMLCanvasElement,
	onProgress?: (message: string) => void
): Promise<GlobeEngine> {
	const report = onProgress ?? (() => {});

	// ── Engine & Scene ──────────────────────────────────────
	report('Initializing Babylon.js...');
	const engine = new Engine(canvas, true, {
		preserveDrawingBuffer: false,
		stencil: true,
		antialias: true
	});

	const scene = new Scene(engine);
	scene.clearColor = new Color4(0, 0, 0, 1);

	// ── Lighting ────────────────────────────────────────────
	const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
	hemiLight.intensity = 0.6;
	hemiLight.groundColor = new Color3(0.15, 0.15, 0.2);

	const sunDirection = new Vector3(-1, 0.5, 0.3).normalize();
	const sunLight = new DirectionalLight('sun', sunDirection.negate(), scene);
	sunLight.intensity = 2.5;
	sunLight.diffuse = new Color3(1, 0.98, 0.92);

	// ── Globe Sphere (ocean base) ───────────────────────────
	const globe = MeshBuilder.CreateSphere('globe', {
		diameter: EARTH_RADIUS_KM * 2,
		segments: 64
	}, scene);

	const globeMat = new StandardMaterial('globeMat', scene);
	globeMat.diffuseColor = new Color3(0.12, 0.18, 0.40);
	globeMat.emissiveColor = new Color3(0.05, 0.08, 0.18); // self-lit so globe is visible without atmosphere
	globeMat.specularColor = new Color3(0.2, 0.2, 0.2);
	globe.material = globeMat;

	// ── Geospatial Camera ───────────────────────────────────
	const camera = new GeospatialCamera('geoCam', scene, {
		planetRadius: EARTH_RADIUS_KM,
		pickPredicate: (mesh) => mesh === globe
	});

	const startCenter = latLngToWorld(35, -20, EARTH_RADIUS_KM);
	camera.center = startCenter;
	camera.radius = EARTH_RADIUS_KM * 2;
	camera.pitch = 0;
	camera.yaw = 0;

	camera.limits.radiusMin = EARTH_RADIUS_KM * 1.05;
	camera.limits.radiusMax = EARTH_RADIUS_KM * 5;
	camera.limits.pitchMax = Math.PI / 2.5;

	// Clip planes for km-scale rendering
	camera.minZ = 10;
	camera.maxZ = EARTH_RADIUS_KM * 20;

	camera.attachControl(canvas, true);

	// ── Atmosphere ──────────────────────────────────────────
	let atmosphere: Atmosphere | null = null;
	const atmosphereSupported = Atmosphere.IsSupported(engine);
	console.log('[Globe] Atmosphere supported:', atmosphereSupported);
	if (atmosphereSupported) {
		try {
			atmosphere = new Atmosphere('atmosphere', scene, [sunLight], {
				exposure: 1.5,
				isLinearSpaceLight: false,
				isLinearSpaceComposition: false,
				isSkyViewLutEnabled: true,
				isAerialPerspectiveLutEnabled: true,
				originHeight: 0
			});
			console.log('[Globe] Atmosphere created successfully');
		} catch (e) {
			console.error('[Globe] Atmosphere creation failed:', e);
		}
	} else {
		console.warn('[Globe] Atmosphere not supported on this device');
	}

	// Log scene state after first render
	scene.onAfterRenderObservable.addOnce(() => {
		console.log('[Globe] First render - active meshes:', scene.getActiveMeshes().length);
		console.log('[Globe] Lights:', scene.lights.map(l => `${l.name} intensity=${l.intensity}`));
	});

	// ── Hex Grid ────────────────────────────────────────────
	report('Generating hex grid...');
	await tick();

	// Generate all H3 cells at target resolution
	const baseCells = getRes0Cells();
	const allCells: string[] = [];
	for (const base of baseCells) {
		const children = cellToChildren(base, H3_RES);
		for (const child of children) {
			allCells.push(child);
		}
	}
	report(`Generated ${allCells.length.toLocaleString()} hex cells`);
	await tick();

	// ── Hex Mesh + Material ─────────────────────────────────
	report('Building hex mesh and shader...');
	await tick();

	// Hex radius in km: approximate from H3 cell area
	// Res 3: ~12,393 km² per hex → radius ≈ sqrt(area / (2.598 * sqrt(3))) ≈ 59 km
	// Res 4: ~1,770 km² per hex → radius ≈ 22 km
	const hexRadiusKm = H3_RES === 3 ? 59 : H3_RES === 4 ? 22 : 10;

	const hexMesh = createHexMesh(hexRadiusKm, 3, scene); // 3 subdivisions

	const terrainMat = createTerrainMaterial(scene);
	hexMesh.material = terrainMat;

	// ── Hex Renderer ────────────────────────────────────────
	report('Building hex instances...');
	await tick();

	const hexRenderer = new HexRenderer(hexMesh, allCells.length);
	hexRenderer.initFromCells(allCells, 'deep_ocean');

	report(`Initialized ${allCells.length.toLocaleString()} hex instances`);

	// ── Picking / Painting ──────────────────────────────────
	// Use native canvas events instead of Babylon's pointer observable
	// to avoid interfering with GeospatialCamera's own input handling.
	// Camera orbits on left-drag by default; painting only on single clicks.
	let onHexClickCallback: ((h3: string) => void) | null = null;
	let pointerDownPos: { x: number; y: number } | null = null;

	canvas.addEventListener('pointerdown', (e) => {
		if (e.button === 0) {
			pointerDownPos = { x: e.clientX, y: e.clientY };
		}
	});

	canvas.addEventListener('pointerup', (e) => {
		if (e.button === 0 && pointerDownPos) {
			const dx = e.clientX - pointerDownPos.x;
			const dy = e.clientY - pointerDownPos.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist < 5) {
				const rect = canvas.getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;
				console.log(`[Globe] Click at screen (${x.toFixed(0)}, ${y.toFixed(0)})`);
				const h3 = pickHexAtScreen(scene, camera, x, y, H3_RES);
				console.log(`[Globe] Picked hex: ${h3}, hasHex: ${h3 ? hexRenderer.hasHex(h3) : 'N/A'}`);
				if (h3 && hexRenderer.hasHex(h3)) {
					console.log(`[Globe] Painting hex ${h3}`);
					onHexClickCallback?.(h3);
				}
			}
			pointerDownPos = null;
		}
	});

	// ── Render Loop ─────────────────────────────────────────
	engine.runRenderLoop(() => {
		scene.render();
	});

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
			camera.flyToAsync(undefined, undefined, targetRadius, targetCenter, 2000);
		},

		setHexTerrain(h3: string, terrain: TerrainTypeId) {
			hexRenderer.setHexTerrain(h3, terrain);
		},

		setHexColor(h3: string, r: number, g: number, b: number, a: number) {
			hexRenderer.setHexColor(h3, r, g, b, a);
		},

		clearHexColor(h3: string) {
			hexRenderer.clearHexColor(h3);
		},

		getHexTerrain(h3: string) {
			return hexRenderer.getHexTerrain(h3);
		},

		hasHex(h3: string) {
			return hexRenderer.hasHex(h3);
		},

		get hexCount() {
			return hexRenderer.hexCount;
		},

		get hexRenderer() {
			return hexRenderer;
		},

		set onHexClick(cb: ((h3: string) => void) | null) {
			onHexClickCallback = cb;
		},
		get onHexClick() {
			return onHexClickCallback;
		}
	};
}

/** Yield to the event loop so progress messages can render */
function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
