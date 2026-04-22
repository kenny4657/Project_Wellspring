<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { GlobeEngine } from '$lib/engine/globe';
	import { TERRAIN_PROFILES, type TerrainTypeId, type RGB, loadTerrainSettings, saveTerrainSettings, type TerrainSettings } from '$lib/world/terrain-types';

	let canvasEl: HTMLCanvasElement;
	let engine: GlobeEngine | null = null;
	let loading = $state(true);
	let loadingMessage = $state('Initializing...');
	let error = $state<string | null>(null);
	let selectedTerrain = $state<TerrainTypeId>('plains');
	let hexCount = $state(0);
	let gridVisible = $state(false);

	// Tab: 'paint' or 'colors'
	let activeTab = $state<'paint' | 'colors'>('paint');

	// Color editor state
	let settings = $state<TerrainSettings>(loadTerrainSettings());
	let editingIdx = $state(4); // plains by default

	const BAND_LABELS = ['Shore', 'Grass', 'Hill', 'Snow'];

	onMount(async () => {
		try {
			const { createGlobeEngine } = await import('$lib/engine/globe');
			engine = await createGlobeEngine(canvasEl, (msg) => {
				loadingMessage = msg;
			});
			hexCount = engine.hexCount;

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

	function hexToRgb(hex: string): RGB {
		const v = parseInt(hex.slice(1), 16);
		return [(v >> 16) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
	}

	function onBandChange(bandIdx: number, hex: string) {
		settings.palettes[editingIdx][bandIdx] = hexToRgb(hex);
		engine?.setTerrainSettings(settings);
	}

	function onBlendChange(value: number) {
		settings.blends[editingIdx] = value;
		engine?.setTerrainSettings(settings);
	}

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
		</div>

		<!-- Paint tab -->
		{#if activeTab === 'paint'}
			<div class="flex-1 overflow-y-auto px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Terrain Types</div>
				{#each TERRAIN_PROFILES as profile, i}
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
		{/if}

		<!-- Colors tab -->
		{#if activeTab === 'colors'}
			<div class="flex-1 overflow-y-auto px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">Select Terrain</div>
				<div class="grid grid-cols-2 gap-1 mb-3">
					{#each TERRAIN_PROFILES as profile, i}
						<button
							class="terrain-chip"
							class:chip-active={editingIdx === i}
							onclick={() => editingIdx = i}
						>
							{profile.name}
						</button>
					{/each}
				</div>

				<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1.5">
					{TERRAIN_PROFILES[editingIdx].name} Bands
				</div>

				{#each BAND_LABELS as label, b}
					{#if settings.palettes[editingIdx]}
						{@const c = settings.palettes[editingIdx][b]}
						<div class="band-row">
							<span class="text-[10px] text-[#A09890] w-10">{label}</span>
							<input
								type="color"
								value={rgbToHex(c[0], c[1], c[2])}
								oninput={(e) => onBandChange(b, (e.target as HTMLInputElement).value)}
								class="color-input"
							/>
							<span class="text-[10px] text-[#706860] font-mono">
								{rgbToHex(c[0], c[1], c[2])}
							</span>
						</div>
					{/if}
				{/each}

				<!-- Blend slider -->
				<div class="band-row mt-2">
					<span class="text-[10px] text-[#A09890] w-10">Blend</span>
					<input
						type="range"
						min="0.01"
						max="0.20"
						step="0.005"
						value={settings.blends[editingIdx]}
						oninput={(e) => onBlendChange(parseFloat((e.target as HTMLInputElement).value))}
						class="blend-slider flex-1"
					/>
					<span class="text-[10px] text-[#706860] font-mono w-8 text-right">
						{settings.blends[editingIdx].toFixed(2)}
					</span>
				</div>

				<!-- Blend position slider -->
				<div class="band-row">
					<span class="text-[10px] text-[#A09890] w-10">Split</span>
					<input
						type="range"
						min="-0.10"
						max="0.10"
						step="0.005"
						value={settings.blendPositions[editingIdx]}
						oninput={(e) => { settings.blendPositions[editingIdx] = parseFloat((e.target as HTMLInputElement).value); engine?.setTerrainSettings(settings); }}
						class="blend-slider flex-1"
					/>
					<span class="text-[10px] text-[#706860] font-mono w-8 text-right">
						{settings.blendPositions[editingIdx] > 0 ? '+' : ''}{settings.blendPositions[editingIdx].toFixed(2)}
					</span>
				</div>

				<!-- Gradient preview -->
				{#if settings.palettes[editingIdx]}
					<div class="mt-3 mb-2">
						<div class="text-[10px] text-[#A09890] mb-1">Preview</div>
						<div class="h-4 rounded-sm overflow-hidden flex">
							{#each settings.palettes[editingIdx] as c}
								<div class="flex-1" style="background: {rgbToHex(c[0], c[1], c[2])};"></div>
							{/each}
						</div>
						<div class="flex text-[8px] text-[#706860] mt-0.5">
							{#each BAND_LABELS as label}
								<span class="flex-1 text-center">{label}</span>
							{/each}
						</div>
					</div>
				{/if}

				<div class="flex gap-1.5 mt-2">
					<button class="tool-btn flex-1" onclick={saveColors}>Save</button>
					<button class="tool-btn flex-1" onclick={resetColors}>Reset</button>
				</div>
			</div>
		{/if}

		<!-- View -->
		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] space-y-1">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890] mb-1">View</div>
			<label class="flex items-center gap-2 text-xs cursor-pointer">
				<input type="checkbox" bind:checked={gridVisible} onchange={() => engine?.setGridVisible(gridVisible)} class="accent-[#C4A96A]" />
				Hex grid
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

	.tab-btn { flex: 1; padding: 6px 0; font-size: 11px; font-weight: 500; color: #706860; background: transparent; border: none; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
	.tab-btn:hover { color: #a09890; }
	.tab-active { color: #C4A96A; border-bottom-color: #C4A96A; }

	.terrain-chip { padding: 3px 6px; font-size: 10px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.08); background: transparent; color: #a09890; cursor: pointer; transition: all 0.15s; text-align: center; }
	.terrain-chip:hover { background: rgba(255,255,255,0.05); color: #e8dfd0; }
	.chip-active { background: rgba(196,169,106,0.15); border-color: rgba(196,169,106,0.3); color: #C4A96A; }

	.band-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
	.color-input { width: 28px; height: 20px; padding: 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; cursor: pointer; background: transparent; }
	.color-input::-webkit-color-swatch-wrapper { padding: 1px; }
	.color-input::-webkit-color-swatch { border: none; border-radius: 2px; }

	.blend-slider { -webkit-appearance: none; appearance: none; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; }
	.blend-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #C4A96A; cursor: pointer; }
	.blend-slider::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #C4A96A; cursor: pointer; border: none; }
</style>
