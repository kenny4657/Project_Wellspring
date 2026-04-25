<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { GlobeEngine } from '$lib/engine/globe';
	import { TERRAIN_PROFILES, DEFAULT_CLIFF_PALETTES, type TerrainTypeId, type RGB, loadTerrainSettings, saveTerrainSettings, type TerrainSettings } from '$lib/world/terrain-types';
	import PaintTab from './PaintTab.svelte';
	import ColorsTab from './ColorsTab.svelte';
	import CliffsTab from './CliffsTab.svelte';
	import InspectOverlay from './InspectOverlay.svelte';

	let canvasEl: HTMLCanvasElement;
	let engine = $state<GlobeEngine | null>(null);
	let loading = $state(true);
	let loadingMessage = $state('Initializing...');
	let error = $state<string | null>(null);
	let selectedTerrain = $state<TerrainTypeId>('plains');
	let hexCount = $state(0);
	let gridVisible = $state(false);
	let inspectMode = $state(false);
	let inspectedHex = $state<{ id: number; terrain: number; heightLevel: number; isPentagon: boolean; neighborCount: number; lat: number; lng: number } | null>(null);

	let activeTab = $state<'paint' | 'colors' | 'cliffs'>('paint');

	let settings = $state<TerrainSettings>(loadTerrainSettings());
	let editingIdx = $state(4); // plains by default

	let perf = $state({ fps: 0, frameMs: 0, gpuFrameMs: 0, drawCalls: 0, vertexCount: 0, meshBuildMs: 0, totalBuildMs: 0 });
	let perfTimer: ReturnType<typeof setInterval> | null = null;

	// Phase 0/1/2/3 — render mode + benchmark UI state
	let renderMode = $state<'legacy' | 'shader-preview' | 'shader-debug'>('legacy');
	let shaderDebugMode = $state<0 | 1 | 2 | 3 | 4 | 5>(0);
	let benchProgress = $state<number | null>(null);
	let benchResult = $state<null | { frames: number; minMs: number; medianMs: number; p99Ms: number; meanMs: number; gpuMedianMs: number }>(null);

	function onRenderModeChange() {
		engine?.setRenderMode(renderMode);
	}
	function onShaderDebugChange() {
		engine?.setShaderDebugMode(shaderDebugMode);
	}
	async function startBenchmark() {
		if (!engine || benchProgress !== null) return;
		benchResult = null;
		benchProgress = 0;
		const r = await engine.runBenchmark({ onProgress: (t) => { benchProgress = t; } });
		benchResult = r;
		benchProgress = null;
	}

	onMount(async () => {
		try {
			const { createGlobeEngine } = await import('$lib/engine/globe');
			engine = await createGlobeEngine(canvasEl, (msg) => {
				loadingMessage = msg;
			});
			hexCount = engine.hexCount;
			// Expose for the Phase 2 verifier (scripts/phase2-verify.mjs).
			// Only when ?ref=1 — production users never see this handle.
			if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('ref') === '1') {
				(window as unknown as { __globeEngine: typeof engine }).__globeEngine = engine;
			}

			engine.onHexClick = (cellIndex: number) => {
				if (inspectMode) {
					const cell = engine!.cells[cellIndex];
					const c = cell.center;
					const lat = Math.asin(c.y / Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z)) * 180 / Math.PI;
					const lng = Math.atan2(c.z, c.x) * 180 / Math.PI;
					inspectedHex = {
						id: cell.id,
						terrain: cell.terrain,
						heightLevel: cell.heightLevel,
						isPentagon: cell.isPentagon,
						neighborCount: cell.neighbors.size,
						lat, lng,
					};
				} else {
					engine!.setHexTerrain(cellIndex, selectedTerrain);
				}
			};

			loading = false;

			// Poll perf at 4 Hz — keeps the overlay readable without thrashing
			perf = engine.perf;
			perfTimer = setInterval(() => { if (engine) perf = engine.perf; }, 250);
		} catch (e) {
			error = String(e);
			loading = false;
			console.error('[Globe] Init failed:', e);
		}
	});

	onDestroy(() => {
		if (perfTimer) clearInterval(perfTimer);
		engine?.dispose();
	});

	function saveColors() {
		saveTerrainSettings(settings);
	}

	function resetColors() {
		settings = loadTerrainSettings();
		// Clear localStorage so defaults are restored
		if (typeof localStorage !== 'undefined') localStorage.removeItem('wellspring-terrain-settings');
		settings = {
			palettes: TERRAIN_PROFILES.map(p => [...p.palette] as [RGB, RGB, RGB, RGB]),
			blends: TERRAIN_PROFILES.map(p => p.blend),
			blendPositions: TERRAIN_PROFILES.map(p => p.blendPos),
			cliffPalettes: DEFAULT_CLIFF_PALETTES.map(p => [...p] as [RGB, RGB, RGB]),
		};
		engine?.setTerrainSettings(settings);
	}
</script>

<svelte:head>
	<title>Globe — Project Wellspring</title>
	<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=Source+Sans+3:wght@300;400;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div class="flex h-screen overflow-hidden bg-black">
	<aside class="w-64 flex flex-col bg-[#2A2520] text-[#E8DFD0] border-r border-[rgba(255,255,255,0.08)]"
		style="font-family: 'Source Sans 3', sans-serif;">
		<div class="px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
			<h1 class="text-lg text-[#C4A96A] font-semibold" style="font-family: 'Cormorant Garamond', Georgia, serif;">
				Project Wellspring
			</h1>
			<p class="text-[10px] text-[#A09890] mt-0.5">Babylon.js 9.0 Globe · {hexCount.toLocaleString()} hexes</p>
		</div>

		<!-- Tab bar -->
		<div class="flex border-b border-[rgba(255,255,255,0.08)]">
			<button class="tab-btn" class:tab-active={activeTab === 'paint'} onclick={() => activeTab = 'paint'}>Paint</button>
			<button class="tab-btn" class:tab-active={activeTab === 'colors'} onclick={() => activeTab = 'colors'}>Colors</button>
			<button class="tab-btn" class:tab-active={activeTab === 'cliffs'} onclick={() => activeTab = 'cliffs'}>Cliffs</button>
		</div>

		{#if activeTab === 'paint'}
			<PaintTab bind:selectedTerrain />
		{:else if activeTab === 'colors'}
			<ColorsTab bind:settings bind:editingIdx {engine} onSave={saveColors} onReset={resetColors} />
		{:else if activeTab === 'cliffs'}
			<CliffsTab bind:settings bind:editingIdx {engine} onSave={saveColors} onReset={resetColors} />
		{/if}

		<!-- View -->
		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] space-y-1">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1">View</div>
			<label class="flex items-center gap-2 text-xs cursor-pointer">
				<input type="checkbox" bind:checked={gridVisible} onchange={() => engine?.setGridVisible(gridVisible)} class="accent-[#C4A96A]" />
				Hex grid
			</label>
			<label class="flex items-center gap-2 text-xs cursor-pointer">
				<input type="checkbox" bind:checked={inspectMode} class="accent-[#C4A96A]" />
				Inspect mode (click hex for ID)
			</label>

			<!-- Render mode:
			     Legacy        -- per-hex prism mesh, real biome shading.
			     Shader        -- Phase 3 smooth icosphere with flat material.
			     Shader debug  -- same sphere + Phase 2 / Phase 1 visualizations. -->
			<label class="block text-xs mt-2">
				<span class="text-[#A09890]">Render mode</span>
				<select bind:value={renderMode} onchange={onRenderModeChange}
					class="block w-full mt-0.5 px-1 py-0.5 bg-[#1E1B18] border border-[rgba(255,255,255,0.1)] text-[#E8DFD0] text-xs rounded">
					<option value="legacy">Legacy</option>
					<option value="shader-preview">Shader (preview)</option>
					<option value="shader-debug">Shader (debug)</option>
				</select>
			</label>
			{#if renderMode === 'shader-debug'}
				<label class="block text-xs">
					<span class="text-[#A09890]">Debug visualization</span>
					<select bind:value={shaderDebugMode} onchange={onShaderDebugChange}
						class="block w-full mt-0.5 px-1 py-0.5 bg-[#1E1B18] border border-[rgba(255,255,255,0.1)] text-[#E8DFD0] text-xs rounded">
						<option value={0}>Hex ID hash</option>
						<option value={1}>Face index (0-19)</option>
						<option value={2}>(i, j) heatmap</option>
						<option value={4}>Terrain from texture</option>
						<option value={5}>Height from texture</option>
					</select>
				</label>
			{/if}

			<button class="tool-btn mt-2" onclick={startBenchmark} disabled={benchProgress !== null}>
				{#if benchProgress !== null}Benchmark… {(benchProgress * 100).toFixed(0)}%{:else}Run benchmark (16s){/if}
			</button>
			{#if benchResult}
				<div class="text-[10px] text-[#A09890] mt-1 leading-tight">
					<div>frames {benchResult.frames}</div>
					<div>median {benchResult.medianMs.toFixed(2)} ms · p99 {benchResult.p99Ms.toFixed(2)} ms</div>
					<div>min {benchResult.minMs.toFixed(2)} · mean {benchResult.meanMs.toFixed(2)}</div>
					{#if benchResult.gpuMedianMs > 0}
						<div>GPU median {benchResult.gpuMedianMs.toFixed(2)} ms</div>
					{/if}
				</div>
			{/if}

			<div class="flex gap-1 flex-wrap mt-2">
				<button class="tool-btn" onclick={() => engine?.flyTo(48.86, 2.35, 500)}>Paris</button>
				<button class="tool-btn" onclick={() => engine?.flyTo(40.71, -74.01, 500)}>NYC</button>
				<button class="tool-btn" onclick={() => engine?.flyTo(35.68, 139.69, 500)}>Tokyo</button>
				<button class="tool-btn" onclick={() => engine?.flyTo(35, -20, 12000)}>Reset</button>
			</div>
		</div>

		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] text-[10px] text-[#A09890]">
			<a href="/" class="text-[#C4A96A] hover:underline">Back to 2D Editor</a>
		</div>
	</aside>

	<main class="flex-1 relative">
		<canvas bind:this={canvasEl} class="w-full h-full block"></canvas>

		<InspectOverlay bind:inspectedHex />

		{#if !loading && !error}
			<div class="perf-overlay">
				<div class="perf-row"><span>FPS</span><span class:perf-warn={perf.fps > 0 && perf.fps < 50} class:perf-bad={perf.fps > 0 && perf.fps < 30}>{perf.fps.toFixed(0)}</span></div>
				<div class="perf-row"><span>Frame</span><span>{perf.frameMs.toFixed(2)} ms</span></div>
				<div class="perf-row"><span>GPU</span><span>{perf.gpuFrameMs > 0 ? perf.gpuFrameMs.toFixed(2) + ' ms' : 'n/a'}</span></div>
				<div class="perf-row"><span>Draw calls</span><span>{perf.drawCalls}</span></div>
				<div class="perf-row"><span>Verts</span><span>{(perf.vertexCount / 1e6).toFixed(2)} M</span></div>
				<div class="perf-row perf-divider"><span>Hexes</span><span>{hexCount.toLocaleString()}</span></div>
				<div class="perf-row"><span>Mesh build</span><span>{(perf.meshBuildMs / 1000).toFixed(2)} s</span></div>
				<div class="perf-row"><span>Total init</span><span>{(perf.totalBuildMs / 1000).toFixed(2)} s</span></div>
			</div>
		{/if}

		{#if loading}
			<div class="absolute inset-0 flex flex-col items-center justify-center bg-[#1E1B18]/90 z-10">
				<div class="text-xl text-[#C4A96A] mb-2" style="font-family: 'Cormorant Garamond', Georgia, serif;">
					Project Wellspring
				</div>
				<div class="text-sm text-[#A09890]">{loadingMessage}</div>
				<div class="mt-4 w-48 h-1 bg-[#3A3530] rounded overflow-hidden">
					<div class="h-full bg-[#C4A96A] rounded loading-bar"></div>
				</div>
			</div>
		{/if}

		{#if error}
			<div class="absolute inset-0 flex items-center justify-center bg-[#1E1B18]/90 z-10">
				<div class="text-red-400 text-sm max-w-md text-center">
					<div class="text-lg mb-2">Failed to initialize</div>
					<pre class="text-xs text-left bg-black/50 p-3 rounded overflow-auto max-h-96">{error}</pre>
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.tool-btn { padding: 4px 10px; font-size: 10px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #a09890; cursor: pointer; transition: all 0.15s; }
	.tool-btn:hover { background: rgba(196,169,106,0.1); color: #e8dfd0; }
	.loading-bar { animation: loading 2s ease-in-out infinite; }
	@keyframes loading { 0% { width: 5%; } 50% { width: 70%; } 100% { width: 5%; } }

	.tab-btn { flex: 1; padding: 6px 0; font-size: 11px; font-weight: 500; color: #706860; background: transparent; border: none; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
	.tab-btn:hover { color: #a09890; }
	.tab-active { color: #C4A96A; border-bottom-color: #C4A96A; }

	.perf-overlay { position: absolute; top: 8px; right: 8px; padding: 8px 10px; background: rgba(0,0,0,0.6); border: 1px solid rgba(196,169,106,0.25); border-radius: 4px; color: #E8DFD0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; line-height: 1.4; min-width: 150px; pointer-events: none; user-select: none; z-index: 5; }
	.perf-row { display: flex; justify-content: space-between; gap: 12px; }
	.perf-row > span:first-child { color: #A09890; }
	.perf-divider { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.08); }
	.perf-warn { color: #E0B870; }
	.perf-bad { color: #E07070; }
</style>
