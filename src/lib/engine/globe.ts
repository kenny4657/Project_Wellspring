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
import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { createHexMesh } from '$lib/engine/hex-mesh';
import { HexRenderer } from '$lib/engine/hex-renderer';
import { createTerrainMaterial } from '$lib/engine/terrain-shader';
import { type TerrainTypeId, TERRAIN_PROFILES } from '$lib/world/terrain-types';
import { getRes0Cells, cellToChildren, isPentagon } from 'h3-js';

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
	hemiLight.intensity = 0.4;
	hemiLight.groundColor = new Color3(0.1, 0.1, 0.15);

	const sunDirection = new Vector3(-1, 0.5, 0.3).normalize();
	const sunLight = new DirectionalLight('sun', sunDirection.negate(), scene);
	sunLight.intensity = 2.0;
	sunLight.diffuse = new Color3(1, 0.98, 0.92);

	// ── Globe Sphere (ocean base) ───────────────────────────
	const globe = MeshBuilder.CreateSphere('globe', {
		diameter: EARTH_RADIUS_KM * 2,
		segments: 64
	}, scene);

	const globeMat = new StandardMaterial('globeMat', scene);
	globeMat.diffuseColor = new Color3(0.10, 0.15, 0.35); // deep ocean color
	globeMat.specularColor = new Color3(0.15, 0.15, 0.15);
	globe.material = globeMat;

	// ── Camera ──────────────────────────────────────────────
	// Use ArcRotateCamera for initial debugging — GeospatialCamera can be restored later
	const { ArcRotateCamera } = await import('@babylonjs/core/Cameras/arcRotateCamera');
	const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3, EARTH_RADIUS_KM * 1.5, Vector3.Zero(), scene);
	camera.lowerRadiusLimit = EARTH_RADIUS_KM * 1.05;
	camera.upperRadiusLimit = EARTH_RADIUS_KM * 5;
	camera.minZ = 1;       // near clip
	camera.maxZ = EARTH_RADIUS_KM * 20;  // far clip
	camera.attachControl(canvas, true);

	// ── Atmosphere (disabled for debugging) ─────────────────
	let atmosphere: Atmosphere | null = null;
	// TODO: re-enable once basic rendering works
	// if (Atmosphere.IsSupported(engine)) {
	// 	atmosphere = new Atmosphere('atmosphere', scene, [sunLight], {
	// 		exposure: 1.0,
	// 		isLinearSpaceLight: false,
	// 		isLinearSpaceComposition: false,
	// 		isSkyViewLutEnabled: true,
	// 		isAerialPerspectiveLutEnabled: true,
	// 		originHeight: 0
	// 	});
	// }

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

	// For now, use StandardMaterial to validate hex geometry + positioning
	const hexMat = new StandardMaterial('hexMat', scene);
	hexMat.diffuseColor = new Color3(0.55, 0.65, 0.30); // green
	hexMat.emissiveColor = new Color3(0.3, 0.4, 0.15); // self-lit for visibility
	hexMat.specularColor = new Color3(0.1, 0.1, 0.1);
	hexMat.backFaceCulling = false; // show both sides
	hexMesh.material = hexMat;

	// Keep terrain material reference for later
	// const terrainMat = createTerrainMaterial(scene);
	// hexMesh.material = terrainMat;

	// ── Hex Renderer ────────────────────────────────────────
	report('Building hex instances...');
	await tick();

	const hexRenderer = new HexRenderer(hexMesh, allCells.length);
	hexRenderer.initFromCells(allCells, 'deep_ocean');

	report(`Initialized ${allCells.length.toLocaleString()} hex instances`);

	// Debug: log mesh state
	console.log('[Globe] Hex mesh vertices:', hexMesh.getTotalVertices());
	console.log('[Globe] Hex mesh thin instance count:', hexMesh.thinInstanceCount);
	console.log('[Globe] Hex mesh material:', hexMesh.material?.name);
	console.log('[Globe] Hex mesh isVisible:', hexMesh.isVisible);
	console.log('[Globe] Hex mesh isEnabled:', hexMesh.isEnabled());

	// Debug: check rendering on first frame
	scene.onAfterRenderObservable.addOnce(() => {
		console.log('[Globe] Active meshes:', scene.getActiveMeshes().length);
		console.log('[Globe] Total meshes:', scene.meshes.length);
		for (const m of scene.meshes) {
			console.log(`[Globe] Mesh "${m.name}": vertices=${m.getTotalVertices()}, visible=${m.isVisible}, enabled=${m.isEnabled()}, instances=${m.thinInstanceCount}`);
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

		flyTo(_lat: number, _lng: number, _altitude: number = EARTH_RADIUS_KM * 0.5) {
			// TODO: restore flyTo when GeospatialCamera is re-enabled
			console.log('[Globe] flyTo not yet implemented with ArcRotateCamera');
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
		}
	};
}

/** Yield to the event loop so progress messages can render */
function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
