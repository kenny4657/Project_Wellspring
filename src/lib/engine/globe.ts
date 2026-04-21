/**
 * Globe engine — Babylon.js 9.0 scene with icosahedral hex grid.
 *
 * Uses Sota-style icosahedral projection: hex vertices are projected
 * directly onto the sphere surface — zero gaps, zero z-fighting.
 * Procedural ShaderMaterial for per-biome textures and rock/dirt walls.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { GeospatialCamera } from '@babylonjs/core/Cameras/geospatialCamera';

import '@babylonjs/core/Shaders/default.vertex';
import '@babylonjs/core/Shaders/default.fragment';
import '@babylonjs/core/Animations/animatable';
// Side-effect imports needed for camera pointer input system
import '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';

import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { generateIcoHexGrid, type HexCell } from '$lib/engine/icosphere';
import { buildGlobeMesh, buildHexEdgeLines, updateCellTerrain } from '$lib/engine/globe-mesh';
import { createTerrainMaterial } from '$lib/engine/terrain-material';
import { createWaterMaterial } from '$lib/engine/water-material';
// picking is inlined below using the lightweight pickSphere
import { assignTerrain } from '$lib/engine/terrain-gen';
import { TERRAIN_TYPES, type TerrainTypeId } from '$lib/world/terrain-types';

/** Icosphere resolution — controls hex count. Total ~ 10 * res² + 2 */
const ICO_RESOLUTION = 20;

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	setGridVisible(visible: boolean): void;
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
	// Keep depth buffer so terrain (group 1) depth-tests correctly
	scene.setRenderingAutoClearDepthStencil(1, false);

	// ── Lighting (scene lights for any non-shader meshes) ───
	const hemiLight = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
	hemiLight.intensity = 0.6;

	const sunLight = new DirectionalLight('sun', new Vector3(1, -0.5, -0.3).normalize(), scene);
	sunLight.intensity = 0.8;
	sunLight.diffuse = new Color3(1, 0.98, 0.92);

	// ── Camera ──────────────────────────────────────────────
	const pickSphere = MeshBuilder.CreateSphere('pickSphere', {
		diameter: EARTH_RADIUS_KM * 2 * 0.997,
		segments: 32
	}, scene);
	// isVisible must be true for scene.pick() to work (separate from visibility)
	// visibility=0 makes it visually invisible, isVisible=true keeps it pickable
	pickSphere.visibility = 0;
	pickSphere.isVisible = true;
	pickSphere.isPickable = true;

	const camera = new GeospatialCamera('geoCam', scene, {
		planetRadius: EARTH_RADIUS_KM,
		pickPredicate: (mesh) => mesh === pickSphere
	});

	const startCenter = latLngToWorld(35, -20, EARTH_RADIUS_KM);
	camera.center = startCenter;
	camera.radius = 12000;
	camera.pitch = 0;
	camera.yaw = 0;

	camera.limits.radiusMin = 100;
	camera.limits.radiusMax = 40000;
	camera.limits.pitchMax = Math.PI / 2.5;
	camera.minZ = 1;
	camera.maxZ = EARTH_RADIUS_KM * 20;

	camera.attachControl();

	// ── Generate Icosahedral Hex Grid ────────────────────────
	report('Generating icosahedral hex grid...');
	await tick();

	const cells = generateIcoHexGrid(ICO_RESOLUTION);
	report(`Generated ${cells.length} hex cells`);
	await tick();

	// ── Assign Procedural Terrain ───────────────────────────
	report('Generating terrain...');
	await tick();
	assignTerrain(cells);

	// ── Build Globe Mesh ────────────────────────────────────
	report('Building globe mesh...');
	await tick();

	const { mesh: globeMesh, vertexStarts, totalVerticesPerCell, colorsBuffer, positionsBuffer } =
		buildGlobeMesh(cells, EARTH_RADIUS_KM, scene);

	// Procedural terrain ShaderMaterial
	const terrainMat = createTerrainMaterial(scene);
	globeMesh.material = terrainMat;
	globeMesh.hasVertexAlpha = false;
	globeMesh.isPickable = false; // picking uses the lightweight pickSphere instead
	globeMesh.renderingGroupId = 1;

	// ── Water Surface ──────────────────────────────────────
	// Water renders FIRST (group 0), terrain renders SECOND (group 1).
	// Terrain overwrites water wherever it has geometry.
	const waterSphere = MeshBuilder.CreateSphere('waterSurface', {
		diameter: EARTH_RADIUS_KM * 2,
		segments: 64
	}, scene);
	const waterMat = createWaterMaterial(scene);
	waterSphere.material = waterMat;
	waterSphere.isPickable = false;
	waterSphere.renderingGroupId = 0;

	// ── Hex Edge Wireframe ──────────────────────────────────
	report('Building hex grid overlay...');
	await tick();
	const edgeLines = buildHexEdgeLines(cells, EARTH_RADIUS_KM, scene);
	edgeLines.setEnabled(false); // off by default — Sota style uses geometry, not grid lines

	report(`Globe ready: ${cells.length} cells, ${globeMesh.getTotalVertices().toLocaleString()} vertices`);

	// ── Picking / Painting ──────────────────────────────────
	// Pick against the lightweight pickSphere instead of the 5M-vertex globe mesh.
	// Only fire on click (not drag) so left-click-drag camera orbit still works.
	let onHexClickCallback: ((cellIndex: number) => void) | null = null;
	let pointerDownPos: { x: number; y: number } | null = null;

	function pickHex(sx: number, sy: number): number {
		const result = scene.pick(sx, sy, (m) => m === pickSphere);
		if (!result?.hit || !result.pickedPoint) return -1;
		const hitNorm = result.pickedPoint.normalize();
		let bestIdx = -1, bestDist = Infinity;
		for (let i = 0; i < cells.length; i++) {
			const d = Vector3.DistanceSquared(hitNorm, cells[i].center);
			if (d < bestDist) { bestDist = d; bestIdx = i; }
		}
		return bestIdx;
	}

	canvas.addEventListener('pointerdown', (e) => {
		if (e.button === 0) pointerDownPos = { x: e.clientX, y: e.clientY };
	});

	canvas.addEventListener('pointerup', (e) => {
		if (e.button === 0 && pointerDownPos) {
			const dx = e.clientX - pointerDownPos.x;
			const dy = e.clientY - pointerDownPos.y;
			if (Math.sqrt(dx * dx + dy * dy) < 5) {
				const idx = pickHex(scene.pointerX, scene.pointerY);
				if (idx >= 0) onHexClickCallback?.(idx);
			}
			pointerDownPos = null;
		}
	});

	// ── Render Loop ─────────────────────────────────────────
	let waterTime = 0;
	engine.runRenderLoop(() => {
		const camPos = camera.position;
		terrainMat.setVector3('cameraPos', camPos);
		// Sun follows camera: direction from origin toward camera, offset slightly upward
		const cx = camPos.x, cy = camPos.y, cz = camPos.z;
		const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const sx = cx / cl + 0.3, sy = cy / cl + 0.5, sz = cz / cl;
		const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
		const sunDirVec = new Vector3(sx / sl, sy / sl, sz / sl);
		terrainMat.setVector3('sunDir', sunDirVec);
		waterTime += engine.getDeltaTime() * 0.001;
		terrainMat.setFloat('time', waterTime);
		waterMat.setFloat('time', waterTime);
		waterMat.setVector3('cameraPos', camPos);
		waterMat.setVector3('sunDir', sunDirVec);
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
			updateCellTerrain(globeMesh, cells, cellIndex, vertexStarts, totalVerticesPerCell, EARTH_RADIUS_KM, colorsBuffer, positionsBuffer);
		},

		setGridVisible(visible: boolean) {
			edgeLines.setEnabled(visible);
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
