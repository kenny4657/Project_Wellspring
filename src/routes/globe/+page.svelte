<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { GlobeEngine } from '$lib/engine/globe';

	let canvasEl: HTMLCanvasElement;
	let engine: GlobeEngine | null = null;
	let loading = $state(true);
	let error = $state<string | null>(null);

	onMount(async () => {
		try {
			const { createGlobeEngine } = await import('$lib/engine/globe');
			engine = await createGlobeEngine(canvasEl);
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
</script>

<svelte:head>
	<title>Globe — Project Wellspring</title>
</svelte:head>

<div class="flex h-screen overflow-hidden bg-black">
	<!-- Sidebar placeholder — same structure as main editor -->
	<aside class="w-64 flex flex-col bg-[#2A2520] text-[#E8DFD0] border-r border-[rgba(255,255,255,0.08)]"
		style="font-family: 'Source Sans 3', sans-serif;">
		<div class="px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
			<h1 class="text-lg text-[#C4A96A] font-semibold" style="font-family: 'Cormorant Garamond', Georgia, serif;">
				Project Wellspring
			</h1>
			<p class="text-[10px] text-[#A09890] mt-0.5">Babylon.js 9.0 Globe</p>
		</div>

		<div class="flex-1 px-3 py-3 space-y-3">
			<div class="text-[10px] uppercase tracking-wider text-[#A09890]">Camera</div>
			<button class="tool-btn w-full" onclick={() => engine?.flyTo(48.86, 2.35, 500)}>Fly to Paris</button>
			<button class="tool-btn w-full" onclick={() => engine?.flyTo(40.71, -74.01, 500)}>Fly to New York</button>
			<button class="tool-btn w-full" onclick={() => engine?.flyTo(35.68, 139.69, 500)}>Fly to Tokyo</button>
			<button class="tool-btn w-full" onclick={() => engine?.flyTo(-33.87, 151.21, 500)}>Fly to Sydney</button>
			<button class="tool-btn w-full" onclick={() => engine?.flyTo(35, -20, 12000)}>Reset View</button>
		</div>

		<div class="px-3 py-2 border-t border-[rgba(255,255,255,0.08)] text-[10px] text-[#A09890]">
			<a href="/" class="text-[#C4A96A] hover:underline">Back to 2D Editor</a>
		</div>
	</aside>

	<!-- Globe Canvas -->
	<main class="flex-1 relative">
		<canvas bind:this={canvasEl} class="w-full h-full block"></canvas>

		{#if loading}
			<div class="absolute inset-0 flex flex-col items-center justify-center bg-[#1E1B18]/90 z-10">
				<div class="text-xl text-[#C4A96A] mb-2" style="font-family: 'Cormorant Garamond', Georgia, serif;">
					Project Wellspring
				</div>
				<div class="text-sm text-[#A09890]">Initializing 3D globe...</div>
				<div class="mt-4 w-48 h-1 bg-[#3A3530] rounded overflow-hidden">
					<div class="h-full bg-[#C4A96A] rounded loading-bar"></div>
				</div>
			</div>
		{/if}

		{#if error}
			<div class="absolute inset-0 flex items-center justify-center bg-[#1E1B18]/90 z-10">
				<div class="text-red-400 text-sm max-w-md text-center">
					<div class="text-lg mb-2">Failed to initialize</div>
					<pre class="text-xs text-left bg-black/50 p-3 rounded overflow-auto">{error}</pre>
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.tool-btn { padding: 6px 12px; font-size: 11px; font-weight: 500; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #a09890; cursor: pointer; transition: all 0.15s; text-align: left; }
	.tool-btn:hover { background: rgba(196,169,106,0.1); color: #e8dfd0; }
	.loading-bar { animation: loading 2s ease-in-out infinite; }
	@keyframes loading { 0% { width: 5%; } 50% { width: 70%; } 100% { width: 5%; } }
</style>
