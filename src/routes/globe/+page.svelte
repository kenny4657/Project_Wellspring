<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { GlobeEngine } from '$lib/engine/globe';
	import { TERRAIN_PROFILES, type TerrainTypeId } from '$lib/world/terrain-types';

	let canvasEl: HTMLCanvasElement;
	let engine: GlobeEngine | null = null;
	let loading = $state(true);
	let loadingMessage = $state('Initializing...');
	let error = $state<string | null>(null);
	let selectedTerrain = $state<TerrainTypeId>('plains');
	let hexCount = $state(0);

	onMount(async () => {
		try {
			const { createGlobeEngine } = await import('$lib/engine/globe');
			engine = await createGlobeEngine(canvasEl, (msg) => {
				loadingMessage = msg;
			});
			hexCount = engine.hexCount;

			// Wire up click-to-paint
			engine.onHexClick = (cellIndex: number) => {
				engine!.setHexTerrain(cellIndex, selectedTerrain);
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

	function rgbToHex(r: number, g: number, b: number): string {
		const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
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

		<!-- Terrain Palette -->
		<div class="flex-1 overflow-y-auto px-3 py-2">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Terrain Types</div>
			{#each TERRAIN_PROFILES as profile}
				<button
					class="terrain-item"
					class:selected={selectedTerrain === profile.id}
					onclick={() => selectedTerrain = profile.id as TerrainTypeId}
				>
					<span
						class="w-4 h-4 rounded-sm flex-shrink-0"
						style="background: {rgbToHex(...profile.color)};"
					></span>
					<span class="flex-1 text-xs truncate">{profile.name}</span>
					<span class="text-[10px] text-[#A09890]">T{profile.tier}</span>
				</button>
			{/each}
		</div>

		<!-- Camera -->
		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] space-y-1">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1">Camera</div>
			<div class="flex gap-1 flex-wrap">
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
	.terrain-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: #e8dfd0; cursor: pointer; transition: all 0.15s; text-align: left; }
	.terrain-item:hover { background: rgba(255,255,255,0.05); }
	.terrain-item.selected { background: rgba(196,169,106,0.15); border-color: rgba(196,169,106,0.3); }
	.loading-bar { animation: loading 2s ease-in-out infinite; }
	@keyframes loading { 0% { width: 5%; } 50% { width: 70%; } 100% { width: 5%; } }
</style>
