<script lang="ts">
	type InspectedHex = { id: number; terrain: number; heightLevel: number; isPentagon: boolean; neighborCount: number; lat: number; lng: number };
	let { inspectedHex = $bindable() }: { inspectedHex: InspectedHex | null } = $props();
</script>

{#if inspectedHex}
	<div class="absolute top-3 right-3 bg-[#1E1B18]/95 border border-[#C4A96A]/30 text-[#E8DFD0] text-xs font-mono rounded px-3 py-2 z-20 shadow-lg">
		<div class="flex items-center justify-between gap-4 mb-1">
			<span class="text-[#C4A96A] font-semibold">Hex Inspector</span>
			<button class="text-[#706860] hover:text-[#E8DFD0]" onclick={() => inspectedHex = null}>✕</button>
		</div>
		<div>ID: <span class="text-[#C4A96A]">{inspectedHex.id}</span></div>
		<div>Terrain: {inspectedHex.terrain}</div>
		<div>Height: {inspectedHex.heightLevel}</div>
		<div>Pent: {inspectedHex.isPentagon ? 'yes' : 'no'}</div>
		<div>Neighbors: {inspectedHex.neighborCount}</div>
		<div>Lat/Lng: {inspectedHex.lat.toFixed(2)}, {inspectedHex.lng.toFixed(2)}</div>
	</div>
{/if}
