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
import { generateIcoHexGridWithFaces, type HexCell } from '$lib/engine/icosphere';
import { buildGlobeMesh, buildHexEdgeLines, updateCellTerrain } from '$lib/engine/globe-mesh';
import { createTerrainMaterial, applyTerrainSettings } from '$lib/engine/terrain-material';
import { createWaterMaterial } from '$lib/engine/water-material';
// picking is inlined below using the lightweight pickSphere
import { assignTerrain } from '$lib/engine/terrain-gen';
import { TERRAIN_TYPES, type TerrainTypeId, type TerrainSettings } from '$lib/world/terrain-types';
import { createGpuFrameTimer, type GpuFrameTimer } from '$lib/engine/perf-gpu-timer';
import { runBenchmark, type BenchmarkResult } from '$lib/engine/benchmark';
import { createHexIdLookup, pickHexByFaceGrid } from '$lib/engine/hex-id-lookup';
import { createShaderGlobeDebugMaterial, setShaderGlobeDebugMode } from '$lib/engine/shader-globe-debug-material';

/** Icosphere resolution — controls hex count. Total ~ 10 * res² + 2 */
const ICO_RESOLUTION = 40;

export type RenderMode = 'legacy' | 'shader-preview';

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	setGridVisible(visible: boolean): void;
	setTerrainSettings(settings: TerrainSettings): void;
	/** Switch which renderer is showing. Phase 0/2 — only legacy is fully featured.
	 *  shader-preview shows the Phase 2 hex-ID heat map on a smooth sphere. */
	setRenderMode(mode: RenderMode): void;
	/** Set heat-map output mode for shader-preview:
	 *  0 = id hash, 1 = face index, 2 = (i,j), 3 = raw ID bits (for verification). */
	setShaderDebugMode(mode: 0 | 1 | 2 | 3): void;
	/** Run the 8-waypoint benchmark and resolve with min/median/p99 frame ms. */
	runBenchmark(opts?: { onProgress?: (t: number) => void }): Promise<BenchmarkResult>;
	/** CPU-side hex pick for the current pointer pos (nearest cell.center). */
	pickHexAt(sx: number, sy: number): number;
	/** CPU mirror of GLSL face-grid lookup. Used by phase2-verify.mjs. */
	pickHexByFaceGridAt(sx: number, sy: number): number;
	readonly hexCount: number;
	readonly cells: HexCell[];
	readonly renderMode: RenderMode;
	onHexClick: ((cellIndex: number) => void) | null;
	// Performance instrumentation
	readonly perf: {
		fps: number;          // averaged frames-per-second from Babylon's performanceMonitor
		frameMs: number;      // last frame CPU+GPU wall time in ms
		gpuFrameMs: number;   // last frame GPU time in ms (0 if extension unavailable)
		drawCalls: number;    // draw calls last frame
		vertexCount: number;  // total vertices in globe mesh
		meshBuildMs: number;  // wall time spent in buildGlobeMesh at startup
		totalBuildMs: number; // wall time of full createGlobeEngine
	};
}

export async function createGlobeEngine(
	canvas: HTMLCanvasElement,
	onProgress?: (message: string) => void
): Promise<GlobeEngine> {
	const report = onProgress ?? (() => {});
	const totalBuildStart = performance.now();

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
	// Smooths sub-pixel hairline artifacts at hex mesh boundaries.
	// Disabled in shader-preview because FXAA averages pixel colors and
	// destroys the raw-ID bit encoding used by phase2-verify.mjs.
	const fxaa = new FxaaPostProcess('fxaa', 1.0, camera);

	// ── Generate Icosahedral Hex Grid ────────────────────────
	report('Generating icosahedral hex grid...');
	await tick();

	const grid = generateIcoHexGridWithFaces(ICO_RESOLUTION);
	const cells = grid.cells;
	report(`Generated ${cells.length} hex cells`);
	await tick();

	// ── Assign Procedural Terrain ───────────────────────────
	report('Generating terrain...');
	await tick();
	assignTerrain(cells);

	// ── Build Globe Mesh ────────────────────────────────────
	report('Building globe mesh...');
	await tick();

	const meshBuildStart = performance.now();
	const { mesh: globeMesh, vertexStarts, totalVerticesPerCell, colorsBuffer, positionsBuffer } =
		buildGlobeMesh(cells, EARTH_RADIUS_KM, scene);
	const meshBuildMs = performance.now() - meshBuildStart;

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

	// ── Phase 2 spike: shader-preview hex-ID heat map ───────
	// Builds a (face, i, j) → cellId lookup texture and a smooth sphere
	// rendered with the debug material. Hidden until setRenderMode('shader-preview').
	report('Building Phase 2 hex-ID lookup...');
	await tick();
	const hexLookup = createHexIdLookup(grid, scene);
	const debugMat = createShaderGlobeDebugMaterial(scene, { lookup: hexLookup, resolution: ICO_RESOLUTION });
	// Slightly larger than mean planet radius so it's visible when toggled on
	// without depth-fighting the legacy mesh (which we hide anyway in shader-preview).
	const debugSphere = MeshBuilder.CreateSphere('shaderDebugSphere', {
		diameter: EARTH_RADIUS_KM * 2 * 1.001,
		segments: 96,
	}, scene);
	debugSphere.material = debugMat;
	debugSphere.isPickable = false;
	debugSphere.setEnabled(false);

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

	// ── Performance instrumentation ──────────────────────────
	// Default path: lightweight, observer-free CPU+GPU wall time via
	// engine.getDeltaTime(). Babylon's EngineInstrumentation broke rendering
	// on this machine because its captureGPUFrameTime hook leaked GL query
	// state into the next frame.
	//
	// Optional GPU timing: enable via ?gputime=1. Uses our own wrapper around
	// EXT_disjoint_timer_query_webgl2 with begin/end issued at the very start
	// and end of scene.render — no observer chain, results lag ~2 frames.
	const params = typeof window !== 'undefined'
		? new URLSearchParams(window.location.search)
		: new URLSearchParams();
	const gpuTimerEnabled = params.get('gputime') === '1';
	const gpuTimer: GpuFrameTimer | null = gpuTimerEnabled ? createGpuFrameTimer(canvas) : null;
	if (gpuTimerEnabled && !gpuTimer) {
		console.warn('[Globe] ?gputime=1 set but EXT_disjoint_timer_query_webgl2 unavailable.');
	}
	let frameMsAvg = 0;
	scene.onAfterRenderObservable.add(() => {
		// Babylon updates engine.getDeltaTime() each frame; smooth it for the
		// overlay so the readout is stable instead of jittering frame-to-frame.
		const dt = engine.getDeltaTime();
		frameMsAvg = frameMsAvg * 0.9 + dt * 0.1;
	});
	const totalBuildMs = performance.now() - totalBuildStart;

	// ── Render mode ─────────────────────────────────────────
	let renderMode: RenderMode = 'legacy';
	function applyRenderMode(mode: RenderMode) {
		renderMode = mode;
		if (mode === 'legacy') {
			globeMesh.setEnabled(true);
			waterSphere.setEnabled(true);
			debugSphere.setEnabled(false);
			// Re-attach FXAA. attachPostProcess is idempotent.
			camera.attachPostProcess(fxaa);
		} else {
			// shader-preview: hide legacy land + water; show only the debug sphere.
			// Detach FXAA so the raw ID bits in mode-3 pixels aren't averaged
			// into neighbors — phase2-verify.mjs needs unfiltered output.
			globeMesh.setEnabled(false);
			waterSphere.setEnabled(false);
			debugSphere.setEnabled(true);
			camera.detachPostProcess(fxaa);
		}
	}
	applyRenderMode('legacy');

	// ── ?ref=1 hook for snapshot-references.mjs ─────────────
	if (typeof window !== 'undefined' && params.get('ref') === '1') {
		(window as unknown as { __setCam: (lat: number, lng: number, radius: number, pitch: number, yaw: number) => void }).__setCam =
			(lat, lng, radius, pitch, yaw) => {
				camera.center = latLngToWorld(lat, lng, EARTH_RADIUS_KM);
				camera.radius = radius;
				camera.pitch = pitch;
				camera.yaw = yaw;
			};
	}

	// ── Render Loop ─────────────────────────────────────────
	let waterTime = 0;
	engine.runRenderLoop(() => {
		gpuTimer?.begin();
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
		gpuTimer?.end();
	});

	const onResize = () => engine.resize();
	window.addEventListener('resize', onResize);

	// ── Public API ──────────────────────────────────────────
	return {
		dispose() {
			window.removeEventListener('resize', onResize);
			gpuTimer?.dispose();
			scene.dispose();
			engine.dispose();
		},

		setRenderMode(mode: RenderMode) { applyRenderMode(mode); },
		setShaderDebugMode(mode: 0 | 1 | 2 | 3) { setShaderGlobeDebugMode(debugMat, mode); },
		runBenchmark(opts) {
			return new Promise<BenchmarkResult>((resolve) => {
				runBenchmark({
					camera,
					getFrameMs: () => engine.getDeltaTime(),
					getGpuFrameMs: gpuTimer ? () => gpuTimer.lastMs : undefined,
					onComplete: resolve,
					onProgress: opts?.onProgress,
				});
			});
		},
		pickHexAt(sx: number, sy: number) { return pickHex(sx, sy); },
		pickHexByFaceGridAt(sx: number, sy: number) {
			const result = scene.pick(sx, sy, (m) => m === pickSphere);
			if (!result?.hit || !result.pickedPoint) return -1;
			const p = result.pickedPoint;
			return pickHexByFaceGrid({ x: p.x, y: p.y, z: p.z }, hexLookup, ICO_RESOLUTION, grid);
		},
		get renderMode() { return renderMode; },

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
		get onHexClick() { return onHexClickCallback; },

		get perf() {
			return {
				fps: engine.getFps(),
				frameMs: frameMsAvg,
				gpuFrameMs: gpuTimer ? gpuTimer.lastMs : 0,
				drawCalls: scene.getActiveMeshes().length,
				vertexCount: globeMesh.getTotalVertices(),
				meshBuildMs,
				totalBuildMs,
			};
		}
	};
}

function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
