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
// StandardMaterial import is a required side-effect — pickSphere needs
// a default material to be pickable via scene.pick()
import '@babylonjs/core/Materials/standardMaterial';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { GeospatialCamera } from '@babylonjs/core/Cameras/geospatialCamera';

import '@babylonjs/core/Shaders/default.vertex';
import '@babylonjs/core/Shaders/default.fragment';
import '@babylonjs/core/Animations/animatable';
import { FxaaPostProcess } from '@babylonjs/core/PostProcesses/fxaaPostProcess';
// Side-effect imports needed for camera pointer input system
import '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';

import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { generateIcoHexGrid, type HexCell } from '$lib/engine/icosphere';
import { buildGlobeMesh, buildHexEdgeLines, updateCellTerrain } from '$lib/engine/globe-mesh';
import { createTerrainMaterial, applyTerrainSettings } from '$lib/engine/terrain-material';
import { createWaterMaterial } from '$lib/engine/water-material';
// picking is inlined below using the lightweight pickSphere
import { assignTerrain } from '$lib/engine/terrain-gen';
import { TERRAIN_TYPES, type TerrainTypeId, type TerrainSettings } from '$lib/world/terrain-types';

/** Icosphere resolution — controls hex count. Total ~ 10 * res² + 2 */
const ICO_RESOLUTION = 20;

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	setGridVisible(visible: boolean): void;
	setTerrainSettings(settings: TerrainSettings): void;
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

	// ── FXAA Anti-Aliasing ──────────────────────────────────
	// Smooths sub-pixel hairline artifacts at hex mesh boundaries
	new FxaaPostProcess('fxaa', 1.0, camera);

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


	// ── Depth Renderer + Water Surface ─────────────────────
	// Depth renderer captures terrain depth. Water shader samples it
	// to discard fragments where terrain is closer → land occludes water.
	const depthRenderer = scene.enableDepthRenderer(camera, false);
	const depthTexture = depthRenderer.getDepthMap();
	// Force renderList to terrain only — depth renderer defaults to null (all meshes)
	depthTexture.renderList = [];
	depthTexture.renderList.push(globeMesh);

	const waterSphere = MeshBuilder.CreateSphere('waterSurface', {
		diameter: EARTH_RADIUS_KM * 2 * 0.9995,
		segments: 64
	}, scene);
	const waterMat = createWaterMaterial(scene, depthTexture);
	waterSphere.material = waterMat;
	waterSphere.isPickable = false;

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

	// ── MapLibre-style sphere-trackball pan ────────────────────
	// Replace Babylon's drag-plane pan (which drifts when the camera is tilted,
	// because the tangent plane orientation depends on camera pose) with a pure
	// world-space sphere rotation. Each pointermove computes the quaternion that
	// rotates the previous globe hit point to the current one and applies it to
	// camera.center.
	//
	// Critical detail (the reason this fixes "left drag dies after tilt"): at
	// high pitch the cursor often points above the horizon, so a normal pick
	// against the sphere misses and the previous code did nothing. We instead
	// project the cursor ray onto the sphere — when the ray misses, we use the
	// closest point of the ray to the planet center, normalized to the sphere
	// surface (the limb). This always yields a valid sphere point, just like
	// MapLibre's globe drag, and keeps left-drag responsive at any tilt.
	//
	// GeospatialCameraPointersInput stays attached so right-drag tilt continues
	// to work (it writes to rotationAccumulatedPixels, which we don't touch).
	// Babylon's left-drag pan also still runs and writes to panAccumulatedPixels,
	// but we zero those out each pointermove so _applyGeocentricTranslation is
	// never invoked. Net effect: Babylon's pan is neutralized, ours wins.
	const SPHERE_PICK_RADIUS = EARTH_RADIUS_KM * 0.997;

	function projectCursorToSphere(sx: number, sy: number): Vector3 | null {
		const ray = scene.createPickingRay(sx, sy, null, camera);
		const o = ray.origin;
		const d = ray.direction; // Babylon's createPickingRay returns a normalized direction
		// Closest approach of the ray (parameterized as o + t*d) to the world origin
		// (sphere center). For unit d, t* = -dot(o, d).
		const t = -Vector3.Dot(o, d);
		if (t < 0) return null; // sphere is behind the camera
		const closest = o.add(d.scale(t));
		const closestLenSq = closest.lengthSquared();
		const r2 = SPHERE_PICK_RADIUS * SPHERE_PICK_RADIUS;
		if (closestLenSq <= r2) {
			// Ray intersects the sphere — return the front (entry) hit, the same
			// point scene.pick would return.
			const dt = Math.sqrt(r2 - closestLenSq);
			return o.add(d.scale(t - dt));
		}
		// Ray misses — clamp to the visible limb so dragging still produces a
		// well-defined rotation. This is what makes high-pitch panning feel
		// natural instead of dead.
		return closest.normalize().scale(SPHERE_PICK_RADIUS);
	}

	let sphereDragPrev: Vector3 | null = null;

	canvas.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		pointerDownPos = { x: e.clientX, y: e.clientY };
		sphereDragPrev = projectCursorToSphere(scene.pointerX, scene.pointerY);
	});

	canvas.addEventListener('pointermove', () => {
		if (!sphereDragPrev) return;
		const curr = projectCursorToSphere(scene.pointerX, scene.pointerY);
		if (curr) {
			const fromN = curr.clone().normalize();
			const toN = sphereDragPrev.clone().normalize();
			const cosA = Math.max(-1, Math.min(1, Vector3.Dot(fromN, toN)));
			if (cosA < 0.9999999) {
				const axis = Vector3.Cross(fromN, toN).normalize();
				const rot = Matrix.RotationAxis(axis, Math.acos(cosA));
				camera.center = Vector3.TransformCoordinates(
					camera.center.clone().normalize(),
					rot
				).scale(EARTH_RADIUS_KM);
			}
			sphereDragPrev = curr;
		}
		// Neutralize Babylon's pan: it added to panAccumulatedPixels in its own
		// pointermove handler (registered earlier, runs first); zeroing here
		// means computeCurrentFrameDeltas sees 0 and _applyGeocentricTranslation
		// never fires to fight our rotation.
		camera.movement.panAccumulatedPixels.setAll(0);
	});

	canvas.addEventListener('pointerup', (e) => {
		if (e.button !== 0) return;
		sphereDragPrev = null;
		if (pointerDownPos) {
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
		waterMat.setFloat('cameraNear', camera.minZ);
		waterMat.setFloat('cameraFar', camera.maxZ);
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

		setTerrainSettings(settings: TerrainSettings) {
			applyTerrainSettings(terrainMat, settings);
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
