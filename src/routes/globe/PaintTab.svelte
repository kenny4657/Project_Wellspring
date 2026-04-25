<script lang="ts">
	import { TERRAIN_PROFILES, type TerrainTypeId } from '$lib/world/terrain-types';

	let { selectedTerrain = $bindable() }: { selectedTerrain: TerrainTypeId } = $props();

	function rgbToHex(r: number, g: number, b: number): string {
		const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}
</script>

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

<style>
	.terrain-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid transparent; background: transparent; color: #e8dfd0; cursor: pointer; transition: all 0.15s; text-align: left; }
	.terrain-item:hover { background: rgba(255,255,255,0.05); }
	.terrain-item.selected { background: rgba(196,169,106,0.15); border-color: rgba(196,169,106,0.3); }
</style>
