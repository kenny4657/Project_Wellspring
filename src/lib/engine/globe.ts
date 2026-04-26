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
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation';
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
// Side-effect import: adds engine.captureGPUFrameTime / startTimeQuery / etc.
// to the engine prototype. Without this import EngineInstrumentation throws
// "this.engine.captureGPUFrameTime is not a function" the moment we enable it.
import '@babylonjs/core/Engines/Extensions/engine.query';
// Side-effect imports needed for camera pointer input system
import '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';

import { EARTH_RADIUS_KM, latLngToWorld } from '$lib/geo/coords';
import { generateIcoHexGrid, type HexCell } from '$lib/engine/icosphere';
import { buildGlobeMesh, buildHexEdgeLines, updateCellTerrain } from '$lib/engine/globe-mesh';
import { assignCellsToChunks, isChunkVisible } from '$lib/engine/globe-chunks';
import { initGpuDisplacement, type GpuDisplacementResources } from '$lib/engine/gpu-displacement';
import { createTerrainMaterial, applyTerrainSettings } from '$lib/engine/terrain-material';
import { createHexDebugMaterial } from '$lib/engine/hex-debug-material';
import { createWaterMaterial } from '$lib/engine/water-material';
// picking is inlined below using the lightweight pickSphere
import { assignTerrain } from '$lib/engine/terrain-gen';
import { TERRAIN_TYPES, type TerrainTypeId, type TerrainSettings } from '$lib/world/terrain-types';

/** Icosphere resolution — controls hex count. Total ~ 10 * res² + 2 */
const ICO_RESOLUTION = 40;

export interface GlobeEngine {
	dispose(): void;
	flyTo(lat: number, lng: number, altitude?: number): void;
	setHexTerrain(cellIndex: number, terrain: TerrainTypeId): void;
	setGridVisible(visible: boolean): void;
	setTerrainSettings(settings: TerrainSettings): void;
	/** Toggle hex-id debug coloring. Each hex gets a hash-derived RGB so
	 *  adjacent hexes are visibly distinct — useful for tracking down
	 *  geometry gaps and seam mismatches. */
	setDebugMode(enabled: boolean): void;
	/** Build the Phase 1 artifacts for the GPU displacement path
	 *  (noise cubemap, per-hex data textures, flat-mesh per chunk).
	 *  Does not change rendering — Phase 2 will wire in the shader. */
	initGpuDisplacement(): Promise<GpuDisplacementResources>;
	readonly hexCount: number;
	readonly cells: HexCell[];
	onHexClick: ((cellIndex: number) => void) | null;
	// Performance instrumentation
	readonly perf: {
		fps: number;          // averaged frames-per-second from Babylon's performanceMonitor
		frameMs: number;      // last frame CPU+GPU wall time in ms
		gpuFrameMs: number;   // last frame GPU time in ms (0 if extension unavailable)
		drawCalls: number;    // draw calls last frame
		vertexCount: number;  // total vertices in globe mesh
		visibleChunks: number;    // chunks not culled this frame
		totalChunks: number;      // total chunks built
		visibleVertexCount: number; // sum of vertices in visible chunks
		altitudeKm: number;       // camera altitude above planet surface, km
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

	const meshBuildStart = performance.now();
	const chunkAssignment = assignCellsToChunks(cells);
	const { chunks, chunkOfCell, totalVerticesPerCell } =
		await buildGlobeMesh(cells, EARTH_RADIUS_KM, scene, chunkAssignment);
	const meshBuildMs = performance.now() - meshBuildStart;

	// Procedural terrain ShaderMaterial — shared across all chunk meshes.
	const terrainMat = createTerrainMaterial(scene);
	for (const chunk of chunks) {
		chunk.mesh.material = terrainMat;
		chunk.mesh.hasVertexAlpha = false;
		// Pick against displaced terrain so cliff clicks resolve to the
		// visible hex (the inner pickSphere offsets the hit point
		// angularly when terrain is high).
		chunk.mesh.isPickable = true;
	}

	// ── Hex-debug attribute (per chunk) ─────────────────────
	// Per-vertex RGB baked CPU-side using Knuth multiplicative hash.
	// Each chunk gets its own attribute buffer sized to its vertex count.
	const debugMat = createHexDebugMaterial(scene);
	for (const chunk of chunks) {
		const totalV = chunk.mesh.getTotalVertices();
		const hexDebugColors = new Float32Array(totalV * 3);
		for (const ci of chunk.cellIds) {
			const start = chunk.cellLocalStart.get(ci);
			const count = chunk.cellVertexCount.get(ci);
			if (start === undefined || count === undefined) continue;
			const id = cells[ci].id;
			const scrambled = Math.imul(id + 1, 2654435761) >>> 8;
			const r = (scrambled & 0xff) / 255;
			const g = ((scrambled >>> 8) & 0xff) / 255;
			const b = ((scrambled >>> 16) & 0xff) / 255;
			for (let v = 0; v < count; v++) {
				const off = (start + v) * 3;
				hexDebugColors[off] = r;
				hexDebugColors[off + 1] = g;
				hexDebugColors[off + 2] = b;
			}
		}
		chunk.mesh.setVerticesData('hexDebugColor', hexDebugColors, false, 3);
	}

	// ── Depth Renderer + Water Surface ─────────────────────
	// Depth renderer captures terrain depth. Water shader samples it
	// to discard fragments where terrain is closer → land occludes water.
	const depthRenderer = scene.enableDepthRenderer(camera, false);
	const depthTexture = depthRenderer.getDepthMap();
	depthTexture.renderList = [];
	for (const chunk of chunks) depthTexture.renderList.push(chunk.mesh);

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

	let totalVertCount = 0;
	for (const chunk of chunks) totalVertCount += chunk.mesh.getTotalVertices();
	report(`Globe ready: ${cells.length} cells, ${totalVertCount.toLocaleString()} vertices, ${chunks.length} chunks`);

	// ── Picking / Painting ──────────────────────────────────
	// Pick against the lightweight pickSphere instead of the 5M-vertex globe mesh.
	// Only fire on click (not drag) so left-click-drag camera orbit still works.
	let onHexClickCallback: ((cellIndex: number) => void) | null = null;
	let pointerDownPos: { x: number; y: number } | null = null;

	const chunkMeshSet = new Set(chunks.map(c => c.mesh));
	function pickHex(sx: number, sy: number): number {
		// Try the displaced terrain (any chunk mesh) first — this is
		// what's visible, so the hit point is exactly where the user
		// clicked. Fall back to pickSphere (with the angular-offset
		// caveat) if the terrain mesh has no hit (clicked off-planet).
		let result = scene.pick(sx, sy, (m) => chunkMeshSet.has(m as never));
		if (!result?.hit || !result.pickedPoint) {
			result = scene.pick(sx, sy, (m) => m === pickSphere);
		}
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
	// EngineInstrumentation.captureGPUFrameTime requires the
	// EXT_disjoint_timer_query WebGL extension. It works in Chrome/Edge on
	// most modern hardware; if unavailable we just report 0 for gpuFrameMs.
	const engineInst = new EngineInstrumentation(engine);
	// Wrapped in try/catch in case EXT_disjoint_timer_query is unavailable on
	// the user's GPU/driver — we still want the rest of the perf overlay.
	let gpuTimingAvailable = false;
	try {
		engineInst.captureGPUFrameTime = true;
		gpuTimingAvailable = true;
	} catch (err) {
		console.warn('[Globe] GPU frame timing unavailable:', err);
	}
	const sceneInst = new SceneInstrumentation(scene);
	sceneInst.captureRenderTime = true;
	const totalBuildMs = performance.now() - totalBuildStart;

	// ── Render Loop ─────────────────────────────────────────
	let waterTime = 0;
	let visibleChunkCount = chunks.length;
	let visibleVertCount = totalVertCount;
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

		// Hemisphere chunk culling: disable chunks whose centroid is
		// past the horizon. ~50% of chunks are off at any given time.
		const camDirX = cx / cl;
		const camDirY = cy / cl;
		const camDirZ = cz / cl;
		let visChunks = 0;
		let visVerts = 0;
		for (const chunk of chunks) {
			const visible = isChunkVisible(chunk.centroid, camDirX, camDirY, camDirZ);
			chunk.mesh.setEnabled(visible);
			if (visible) {
				visChunks++;
				visVerts += chunk.mesh.getTotalVertices();
			}
		}
		visibleChunkCount = visChunks;
		visibleVertCount = visVerts;

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
			updateCellTerrain(chunks, chunkOfCell, cells, cellIndex);
		},

		setGridVisible(visible: boolean) {
			edgeLines.setEnabled(visible);
		},

		setTerrainSettings(settings: TerrainSettings) {
			applyTerrainSettings(terrainMat, settings);
		},

		setDebugMode(enabled: boolean) {
			const mat = enabled ? debugMat : terrainMat;
			for (const chunk of chunks) chunk.mesh.material = mat;
		},

		async initGpuDisplacement() {
			return initGpuDisplacement(cells, chunkAssignment, scene);
		},

		get hexCount() { return cells.length; },
		get cells() { return cells; },

		set onHexClick(cb: ((cellIndex: number) => void) | null) { onHexClickCallback = cb; },
		get onHexClick() { return onHexClickCallback; },

		get perf() {
			return {
				fps: engine.performanceMonitor.averageFPS,
				frameMs: sceneInst.renderTimeCounter.lastSecAverage,
				gpuFrameMs: gpuTimingAvailable
					? engineInst.gpuFrameTimeCounter.lastSecAverage / 1e6 // ns → ms
					: 0,
				drawCalls: scene.getActiveMeshes().length,
				vertexCount: totalVertCount,
				visibleChunks: visibleChunkCount,
				totalChunks: chunks.length,
				visibleVertexCount: visibleVertCount,
				altitudeKm: Math.max(0, Math.sqrt(
					camera.position.x * camera.position.x +
					camera.position.y * camera.position.y +
					camera.position.z * camera.position.z
				) - EARTH_RADIUS_KM),
				meshBuildMs,
				totalBuildMs,
			};
		}
	};
}

function tick(): Promise<void> {
	return new Promise(r => setTimeout(r, 0));
}
