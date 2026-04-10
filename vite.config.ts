import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	optimizeDeps: {
		// MapLibre fork is UMD — force Vite to pre-bundle it to ESM
		include: ['maplibre-gl']
	}
});
