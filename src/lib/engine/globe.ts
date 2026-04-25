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
import { TERRAIN_TYPES, loadTerrainSettings, type TerrainTypeId, type TerrainSettings } from '$lib/world/terrain-types';
import { createGpuFrameTimer, type GpuFrameTimer } from '$lib/engine/perf-gpu-timer';
import { runBenchmark, type BenchmarkResult } from '$lib/engine/benchmark';
import { createHexIdLookup, pickHexByFaceGrid } from '$lib/engine/hex-id-lookup';
import { createShaderGlobeDebugMaterial, setShaderGlobeDebugMode, type ShaderGlobeDebugMode } from '$lib/engine/shader-globe-debug-material';
import { createHexDataTextures, updateHex as updateHexDataTextures, disposeHexDataTextures } from '$lib/engine/hex-data-textures';
import { createShaderGlobeMesh } from '$lib/engine/shader-globe-mesh';
import { createShaderGlobeMaterial, applyShaderGlobeSettings } from '$lib/engine/shader-globe-material';

/** Icosphere resolution — controls hex count. Total ~ 10 * res² + 2 */
const ICO_RESOLUTION = 40;

export type RenderMode = 'legacy' | 'shader-preview' | 'shader-debug';

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	setGridVisible(visible: boolean): void;
	setTerrainSettings(settings: TerrainSettings): void;
	/** Switch which renderer is showing.
	 *  legacy = per-hex prism mesh with biome shading (the original).
	 *  shader-preview = Phase 3 smooth icosphere with shader-globe-material.
	 *  shader-debug   = same smooth icosphere with shader-globe-debug-material
	 *                   (Phase 2 hex ID heat-maps, Phase 1 texture validation). */
	setRenderMode(mode: RenderMode): void;
	/** Set heat-map output mode for shader-debug:
	 *  0 = id hash, 1 = face index, 2 = (i,j), 3 = raw ID bits,
	 *  4 = terrain from texture, 5 = height from texture. */
	setShaderDebugMode(mode: ShaderGlobeDebugMode): void;
	/** Run the 8-waypoint benchmark and resolve with min/median/p99 frame ms. */
	runBenchmark(opts?: { onProgress?: (t: number) => void }): Promise<BenchmarkResult>;
	/** CPU-side hex pick for the current pointer pos (nearest cell.center). */
	pickHexAt(sx: number, sy: number): number;
	/** CPU mirror of GLSL face-grid lookup. Used by phase2-verify.mjs. */
	pickHexByFaceGridAt(sx: number, sy: number): number;
	/** Phase 3 mesh stats (vertex / triangle count of the shader-globe sphere). */
	_phase3MeshStats(): { vertexCount: number; triangleCount: number };
	/** Phase 1 byte-level integrity check; see implementation for details. */
	_phase1DataIntegrity(): { totalCells: number; mismatches: number };
	/** Phase 1 GPU-side integrity check; reads pixels back from textures. */
	_phase1GpuIntegrity(): Promise<{ sampled?: number; terrainMis?: number; heightMis?: number; error?: string }>;
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

	// ── Depth Renderer (always created -- empty renderList by default) ──
	const depthRenderer = scene.enableDepthRenderer(camera, false);
	const depthTexture = depthRenderer.getDepthMap();
	depthTexture.renderList = [];

	// ── Lazy legacy mesh build ──────────────────────────────
	// Building the per-hex prism mesh costs ~16 s for 16k hexes (it's the
	// pre-Phase-3 architecture). The shader-preview default doesn't need
	// it, so defer until the user explicitly switches into legacy mode.
	// This drops first-paint from ~17 s to ~1 s.
	type LegacyMeshHandle = {
		mesh: ReturnType<typeof buildGlobeMesh>['mesh'];
		vertexStarts: number[];
		totalVerticesPerCell: number[];
		colorsBuffer: Float32Array;
		positionsBuffer: Float32Array;
		terrainMat: ReturnType<typeof createTerrainMaterial>;
		waterSphere: ReturnType<typeof MeshBuilder.CreateSphere>;
		waterMat: ReturnType<typeof createWaterMaterial>;
		edgeLines: ReturnType<typeof buildHexEdgeLines>;
	};
	let legacy: LegacyMeshHandle | null = null;
	let meshBuildMs = 0;
	function ensureLegacyBuilt(progress?: (msg: string) => void) {
		if (legacy) return;
		const log = progress ?? (() => {});
		log('Building legacy globe mesh (~17 s for 16k hexes)...');
		const t0 = performance.now();
		const { mesh, vertexStarts, totalVerticesPerCell, colorsBuffer, positionsBuffer } =
			buildGlobeMesh(cells, EARTH_RADIUS_KM, scene);
		meshBuildMs = performance.now() - t0;

		const terrainMat = createTerrainMaterial(scene);
		mesh.material = terrainMat;
		mesh.hasVertexAlpha = false;
		mesh.isPickable = false;
		mesh.setEnabled(false); // current renderMode handles toggling

		const waterSphere = MeshBuilder.CreateSphere('waterSurface', {
			diameter: EARTH_RADIUS_KM * 2 * 0.9995,
			segments: 64,
		}, scene);
		const waterMat = createWaterMaterial(scene, depthTexture);
		waterSphere.material = waterMat;
		waterSphere.isPickable = false;
		waterSphere.setEnabled(false);

		log('Building hex grid overlay...');
		const edgeLines = buildHexEdgeLines(cells, EARTH_RADIUS_KM, scene);
		edgeLines.setEnabled(false);

		legacy = { mesh, vertexStarts, totalVerticesPerCell, colorsBuffer, positionsBuffer, terrainMat, waterSphere, waterMat, edgeLines };

		// Push current settings into the just-built legacy material so the
		// user's color edits don't visually snap when switching modes.
		applyTerrainSettings(terrainMat, currentSettings);
	}

	// Track latest applied settings so a lazy legacy build picks them up.
	let currentSettings = loadTerrainSettings();

	// ── Phase 1: per-hex data textures ──────────────────────
	// Three RGBA8 textures (terrain / height / owner) keyed by hexId. The
	// shader-driven renderer pulls per-hex info from these instead of from
	// per-vertex attributes, so painting a hex becomes a single texel write.
	report('Building Phase 1 hex-data textures...');
	await tick();
	const hexData = createHexDataTextures(cells, scene);

	// ── Phase 2: hex-ID lookup texture + face data ──────────
	report('Building Phase 2 hex-ID lookup...');
	await tick();
	const hexLookup = createHexIdLookup(grid, scene);

	// ── Phase 3: smooth-icosphere mesh + flat-color material ─
	// Single mesh, two materials. shader-preview uses the production-bound
	// shader-globe-material (flat color today, full biome shading in Phase 4).
	// shader-debug swaps in the debug material so we can run hex-ID heat
	// maps and Phase 1 texture validation on the same geometry.
	report('Building Phase 3 shader-globe mesh...');
	await tick();
	const shaderGlobe = createShaderGlobeMesh(EARTH_RADIUS_KM, scene);
	const shaderGlobeMat = createShaderGlobeMaterial(scene, { hexLookup, hexData, planetRadiusKm: EARTH_RADIUS_KM });
	const debugMat = createShaderGlobeDebugMaterial(scene, {
		lookup: hexLookup,
		resolution: ICO_RESOLUTION,
		hexData,
	});

	// Pre-bind the preview material at creation time and force-compile both
	// shaders during init. Without this, the first switch into shader-preview
	// or shader-debug triggers a synchronous shader compile mid-frame -- a
	// visible ~50-300 ms stall depending on driver. Forcing here pays the
	// cost up front while the loading overlay is still showing.
	shaderGlobe.mesh.material = shaderGlobeMat;
	report('Compiling shader-globe materials...');
	await tick();
	await new Promise<void>((resolve) => {
		let pending = 2;
		const done = () => { if (--pending === 0) resolve(); };
		shaderGlobeMat.forceCompilation(shaderGlobe.mesh, done);
		debugMat.forceCompilation(shaderGlobe.mesh, done);
	});

	report(`Globe ready: ${cells.length} cells, ${shaderGlobe.vertexCount.toLocaleString()} shader-globe verts (legacy mesh deferred)`);

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
	// Default: shader-preview. The legacy per-hex-prism mesh is large
	// (~16 s build for 16k hexes) and not needed unless the user explicitly
	// switches into legacy mode -- ensureLegacyBuilt() handles that lazily.
	let renderMode: RenderMode = 'shader-preview';
	function applyRenderMode(mode: RenderMode) {
		renderMode = mode;
		if (mode === 'legacy') {
			// Lazy build on first switch into legacy mode. ~17 s wait the
			// first time; cached on subsequent switches.
			ensureLegacyBuilt();
			if (!legacy) return;
			legacy.mesh.setEnabled(true);
			legacy.waterSphere.setEnabled(true);
			shaderGlobe.mesh.setEnabled(false);
			depthTexture.renderList = [legacy.mesh];
			camera.attachPostProcess(fxaa);
		} else if (mode === 'shader-debug') {
			// shader-debug renders raw bit-encoded IDs in mode 3; FXAA would
			// average those bytes and corrupt the verifier output. Water
			// sphere off so the bit-encoded debug colors aren't masked.
			if (legacy) { legacy.mesh.setEnabled(false); legacy.waterSphere.setEnabled(false); }
			shaderGlobe.mesh.setEnabled(true);
			shaderGlobe.mesh.material = debugMat;
			depthTexture.renderList = [];
			camera.detachPostProcess(fxaa);
		} else {
			// shader-preview: real biome rendering with Phase 5/6 displacement.
			// Water sphere stays OFF: Babylon's depth renderer uses a
			// default vertex shader that doesn't apply our displacement,
			// so water-sphere depth-occlusion would see the un-displaced
			// sphere and discard everywhere. A displacement-aware custom
			// depth material is Phase 8 work; for now water is rendered
			// inline by shader-globe-material with a sharp coast boundary.
			if (legacy) { legacy.mesh.setEnabled(false); legacy.waterSphere.setEnabled(false); }
			shaderGlobe.mesh.setEnabled(true);
			shaderGlobe.mesh.material = shaderGlobeMat;
			depthTexture.renderList = [];
			camera.attachPostProcess(fxaa);
		}
	}
	applyRenderMode('shader-preview');

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
		// Sun follows camera: direction from origin toward camera, offset slightly upward
		const cx = camPos.x, cy = camPos.y, cz = camPos.z;
		const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
		const sx = cx / cl + 0.3, sy = cy / cl + 0.5, sz = cz / cl;
		const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
		const sunDirVec = new Vector3(sx / sl, sy / sl, sz / sl);
		waterTime += engine.getDeltaTime() * 0.001;

		// Legacy material uniforms only matter when legacy mode is active
		// (and only after the lazy build has run).
		if (legacy) {
			legacy.terrainMat.setVector3('cameraPos', camPos);
			legacy.terrainMat.setVector3('sunDir', sunDirVec);
			legacy.terrainMat.setFloat('time', waterTime);
			legacy.waterMat.setFloat('time', waterTime);
			legacy.waterMat.setVector3('cameraPos', camPos);
			legacy.waterMat.setVector3('sunDir', sunDirVec);
			legacy.waterMat.setFloat('cameraNear', camera.minZ);
			legacy.waterMat.setFloat('cameraFar', camera.maxZ);
		}
		// Phase 4 biome-shaded material: same per-frame uniforms as the
		// legacy terrain material so legacy and shader-preview produce
		// matching colors at every camera state.
		shaderGlobeMat.setVector3('sunDir', sunDirVec);
		shaderGlobeMat.setVector3('cameraPos', camPos);
		shaderGlobeMat.setFloat('time', waterTime);
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
			disposeHexDataTextures(hexData);
			scene.dispose();
			engine.dispose();
		},

		setRenderMode(mode: RenderMode) { applyRenderMode(mode); },
		setShaderDebugMode(mode: ShaderGlobeDebugMode) { setShaderGlobeDebugMode(debugMat, mode); },
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
		/** Phase 1 validation hook: returns true iff every cell's terrain and
		 *  heightLevel match the bytes in the data textures' CPU mirrors.
		 *  Cheap (no GPU round-trip) — use _phase1GpuIntegrity() to also
		 *  prove the GPU upload is correct. */
		/** Phase 3 visibility: vertex/triangle counts of the new shader sphere. */
		_phase3MeshStats() {
			return { vertexCount: shaderGlobe.vertexCount, triangleCount: shaderGlobe.triangleCount };
		},
		_phase1DataIntegrity() {
			let mismatches = 0;
			for (let i = 0; i < cells.length; i++) {
				const c = cells[i];
				const idx = c.id * 4;
				if (hexData._terrainData[idx] !== c.terrain) mismatches++;
				if (hexData._heightData[idx] !== c.heightLevel) mismatches++;
			}
			return { totalCells: cells.length, mismatches };
		},
		/** Phase 1 GPU-side integrity check. Reads pixels back from each
		 *  texture and compares to cells. Catches the case the CPU-mirror
		 *  check can't: a broken `RawTexture.update()` upload. Async because
		 *  Babylon's readPixels returns a promise. */
		async _phase1GpuIntegrity() {
			const samplesPerTex = Math.min(cells.length, 1024);
			let terrainMis = 0, heightMis = 0;
			// Read full textures once; comparing 1k random cells gives strong
			// signal without the readback's ~5ms cost dominating.
			const tBuf = await hexData.terrain.readPixels(0, 0);
			const hBuf = await hexData.height.readPixels(0, 0);
			if (!tBuf || !hBuf) return { error: 'readPixels returned null' };
			const tArr = new Uint8Array((tBuf as ArrayBufferView).buffer, (tBuf as ArrayBufferView).byteOffset, (tBuf as ArrayBufferView).byteLength);
			const hArr = new Uint8Array((hBuf as ArrayBufferView).buffer, (hBuf as ArrayBufferView).byteOffset, (hBuf as ArrayBufferView).byteLength);
			const seen = new Set<number>();
			for (let s = 0; s < samplesPerTex; s++) {
				const i = (s * 7919) % cells.length;
				if (seen.has(i)) continue;
				seen.add(i);
				const c = cells[i];
				const idx = c.id * 4;
				if (tArr[idx] !== c.terrain) terrainMis++;
				if (hArr[idx] !== c.heightLevel) heightMis++;
			}
			return { sampled: seen.size, terrainMis, heightMis };
		},
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
			const c = cells[cellIndex];
			c.terrain = TERRAIN_TYPES[terrain];
			// Legacy mesh update only if it's been built.
			if (legacy) {
				updateCellTerrain(legacy.mesh, cells, cellIndex, legacy.vertexStarts, legacy.totalVerticesPerCell, EARTH_RADIUS_KM, legacy.colorsBuffer, legacy.positionsBuffer);
			}
			// Phase 1 textures always update -- shader-preview reads from them.
			updateHexDataTextures(hexData, c.id, c.terrain, c.heightLevel);
		},

		setGridVisible(visible: boolean) {
			// Edge wireframe only exists once legacy is built. Force the
			// build if user toggles grid before ever switching to legacy.
			if (visible) ensureLegacyBuilt();
			if (legacy) legacy.edgeLines.setEnabled(visible);
		},

		setTerrainSettings(settings: TerrainSettings) {
			currentSettings = settings;
			if (legacy) applyTerrainSettings(legacy.terrainMat, settings);
			applyShaderGlobeSettings(shaderGlobeMat, settings);
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
				vertexCount: legacy ? legacy.mesh.getTotalVertices() : shaderGlobe.vertexCount,
				meshBuildMs,
				totalBuildMs,
			};
		}
	};
}

function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
