/**
 * Globe engine — Babylon.js 9.0 scene with icosahedral hex grid.
 *
 * Uses Sota-style icosahedral projection: hex vertices are projected
 * directly onto the sphere surface — zero gaps, zero z-fighting.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { GeospatialCamera } from '@babylonjs/core/Cameras/geospatialCamera';

import '@babylonjs/core/Shaders/default.vertex';
import '@babylonjs/core/Shaders/default.fragment';
import '@babylonjs/core/Animations/animatable';

import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { generateIcoHexGrid, type HexCell } from '$lib/engine/icosphere';
import { buildGlobeMesh, updateCellTerrain } from '$lib/engine/globe-mesh';
import { pickHexAtScreen } from '$lib/engine/picking';
import { TERRAIN_TYPES, type TerrainTypeId } from '$lib/world/terrain-types';

/** Icosphere resolution — controls hex count. Total ≈ 10 * res² + 2 */
const ICO_RESOLUTION = 20; // ~4000 hexes

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	readonly hexCount: number;
	readonly cells: HexCell[];
	onHexClick: ((cellIndex: number) => void) | null;
}

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
	scene.clearColor = new Color4(0.02, 0.03, 0.08, 1);

	// ── Lighting ────────────────────────────────────────────
	const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
	hemiLight.intensity = 1.2;
	hemiLight.groundColor = new Color3(0.4, 0.4, 0.5);

	const sunLight = new DirectionalLight('sun', new Vector3(1, -0.5, -0.3).normalize(), scene);
	sunLight.intensity = 1.5;
	sunLight.diffuse = new Color3(1, 0.98, 0.92);

	const fillLight = new DirectionalLight('fill', new Vector3(-1, 0.3, 0.5).normalize(), scene);
	fillLight.intensity = 0.8;
	fillLight.diffuse = new Color3(0.7, 0.75, 0.9);

	// ── Camera ──────────────────────────────────────────────
	const pickSphere = MeshBuilder.CreateSphere('pickSphere', {
		diameter: EARTH_RADIUS_KM * 2,
		segments: 32
	}, scene);
	pickSphere.visibility = 0;
	pickSphere.isPickable = true;

	const camera = new GeospatialCamera('geoCam', scene, {
		planetRadius: EARTH_RADIUS_KM,
		pickPredicate: (mesh) => mesh === pickSphere
	});

	const cameraLight = new PointLight('cameraLight', camera.position.clone(), scene);
	cameraLight.intensity = 0.8;
	cameraLight.diffuse = new Color3(1, 1, 1);
	cameraLight.range = EARTH_RADIUS_KM * 10;

	const startCenter = latLngToWorld(35, -20, EARTH_RADIUS_KM);
	camera.center = startCenter;
	camera.radius = 15000;
	camera.pitch = 0;
	camera.yaw = 0;

	camera.limits.radiusMin = 100;
	camera.limits.radiusMax = 40000;
	camera.limits.pitchMax = Math.PI / 2.5;
	camera.minZ = 1;
	camera.maxZ = EARTH_RADIUS_KM * 20;

	camera.attachControl(canvas, true);

	// ── Generate Icosahedral Hex Grid ────────────────────────
	report('Generating icosahedral hex grid...');
	await tick();

	const cells = generateIcoHexGrid(ICO_RESOLUTION);
	report(`Generated ${cells.length} hex cells`);
	await tick();

	// ── Build Globe Mesh ────────────────────────────────────
	report('Building globe mesh...');
	await tick();

	const { mesh: globeMesh, vertexStarts, totalVerticesPerCell } = buildGlobeMesh(cells, EARTH_RADIUS_KM, scene);

	const mat = new StandardMaterial('globeMat', scene);
	mat.diffuseColor = new Color3(1, 1, 1);
	mat.specularColor = new Color3(0.15, 0.15, 0.15);
	mat.backFaceCulling = true;
	globeMesh.material = mat;

	report(`Globe mesh: ${globeMesh.getTotalVertices().toLocaleString()} vertices, ${cells.length} cells`);

	// ── Picking / Painting ──────────────────────────────────
	let onHexClickCallback: ((cellIndex: number) => void) | null = null;
	let pointerDownPos: { x: number; y: number } | null = null;

	canvas.addEventListener('pointerdown', (e) => {
		if (e.button === 0) pointerDownPos = { x: e.clientX, y: e.clientY };
	});

	canvas.addEventListener('pointerup', (e) => {
		if (e.button === 0 && pointerDownPos) {
			const dx = e.clientX - pointerDownPos.x;
			const dy = e.clientY - pointerDownPos.y;
			if (Math.sqrt(dx * dx + dy * dy) < 5) {
				const rect = canvas.getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;
				const idx = pickHexAtScreen(scene, camera, x, y, cells, EARTH_RADIUS_KM);
				if (idx >= 0) onHexClickCallback?.(idx);
			}
			pointerDownPos = null;
		}
	});

	// ── Render Loop ─────────────────────────────────────────
	engine.runRenderLoop(() => {
		cameraLight.position.copyFrom(camera.position);
		scene.render();
	});

	const onResize = () => engine.resize();
	window.addEventListener('resize', onResize);

	// ── Public API ──────────────────────────────────────────
	return {
		dispose() {
			window.removeEventListener('resize', onResize);
			scene.dispose();
			engine.dispose();
		},

		flyTo(lat: number, lng: number, altitude: number = EARTH_RADIUS_KM * 0.5) {
			const targetCenter = latLngToWorld(lat, lng, EARTH_RADIUS_KM);
			camera.flyToAsync(undefined, undefined, EARTH_RADIUS_KM + altitude, targetCenter, 2000);
		},

		setHexTerrain(cellIndex: number, terrain: TerrainTypeId) {
			cells[cellIndex].terrain = TERRAIN_TYPES[terrain];
			updateCellTerrain(globeMesh, cells, cellIndex, vertexStarts, totalVerticesPerCell, EARTH_RADIUS_KM);
		},

		get hexCount() { return cells.length; },
		get cells() { return cells; },

		set onHexClick(cb: ((cellIndex: number) => void) | null) { onHexClickCallback = cb; },
		get onHexClick() { return onHexClickCallback; }
	};
}

function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
