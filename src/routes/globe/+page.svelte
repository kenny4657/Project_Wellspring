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

	onMount(async () => {
		try {
			const { createGlobeEngine } = await import('$lib/engine/globe');
			engine = await createGlobeEngine(canvasEl, (msg) => {
				loadingMessage = msg;
			});
			hexCount = engine.hexCount;

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
		} catch (e) {
			error = String(e);
			loading = false;
			console.error('[Globe] Init failed:', e);
		}
	});

	onDestroy(() => {
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
			<div class="flex gap-1 flex-wrap mt-1">
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
</style>
