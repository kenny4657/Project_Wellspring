<script lang="ts">
	import { TERRAIN_PROFILES, type RGB, type TerrainSettings } from '$lib/world/terrain-types';
	import type { GlobeEngine } from '$lib/engine/globe';

	type Props = {
		settings: TerrainSettings;
		editingIdx: number;
		engine: GlobeEngine | null;
		onSave: () => void;
		onReset: () => void;
	};
	let { settings = $bindable(), editingIdx = $bindable(), engine, onSave, onReset }: Props = $props();

	const BAND_LABELS = ['Shore', 'Grass', 'Hill', 'Snow'];

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
</script>

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
		<button class="tool-btn flex-1" onclick={onSave}>Save</button>
		<button class="tool-btn flex-1" onclick={onReset}>Reset</button>
	</div>
</div>

<style>
	.tool-btn { padding: 4px 10px; font-size: 10px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #a09890; cursor: pointer; transition: all 0.15s; }
	.tool-btn:hover { background: rgba(196,169,106,0.1); color: #e8dfd0; }
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
