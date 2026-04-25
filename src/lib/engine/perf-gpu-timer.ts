/**
 * Safer wrapper around EXT_disjoint_timer_query_webgl2.
 *
 * Babylon's EngineInstrumentation.captureGPUFrameTime uses the same extension
 * but its observer hooks broke rendering on some drivers (blank canvas, no
 * error). This wrapper:
 *
 *   - Issues queries from outside the render pipeline (begin/end span around
 *     scene.render, not via observer chain)
 *   - Maintains a small ring of in-flight queries so we never block on a
 *     pending result (results lag ~2 frames; that's fine)
 *   - Validates extension presence and gracefully returns null if missing
 *   - Discards results when the GPU signals "disjoint" (results untrusted)
 *
 * Off by default. Enable via ?gputime=1 in the URL.
 */

const RING_SIZE = 4;

export interface GpuFrameTimer {
	begin(): void;
	end(): void;
	/** Most recent reliable frame time in ms. 0 until first result lands. */
	readonly lastMs: number;
	dispose(): void;
}

interface QuerySlot {
	query: WebGLQuery;
	pending: boolean;
}

export function createGpuFrameTimer(canvas: HTMLCanvasElement): GpuFrameTimer | null {
	const glOpt = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
	if (!glOpt) return null;
	const gl: WebGL2RenderingContext = glOpt;

	const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
	if (!ext) return null;

	// Constants per the extension spec.
	const QUERY_RESULT_AVAILABLE = 0x9194;
	const QUERY_RESULT = 0x9192;
	const TIME_ELAPSED_EXT = 0x88BF;
	const GPU_DISJOINT_EXT = 0x8FBB;

	const slots: QuerySlot[] = [];
	for (let i = 0; i < RING_SIZE; i++) {
		const q = gl.createQuery();
		if (!q) return null;
		slots.push({ query: q, pending: false });
	}

	let writeIdx = 0;
	let lastMs = 0;
	let active = false;

	function readReady(): void {
		// Drain any pending slots whose results are now available.
		const disjoint = gl.getParameter(GPU_DISJOINT_EXT);
		for (const slot of slots) {
			if (!slot.pending) continue;
			const available = gl.getQueryParameter(slot.query, QUERY_RESULT_AVAILABLE);
			if (!available) continue;
			if (!disjoint) {
				const ns = gl.getQueryParameter(slot.query, QUERY_RESULT) as number;
				lastMs = ns / 1e6;
			}
			slot.pending = false;
		}
	}

	return {
		begin() {
			if (active) return; // double-begin guard
			readReady();
			const slot = slots[writeIdx];
			if (slot.pending) return; // ring full; skip this frame
			gl.beginQuery(TIME_ELAPSED_EXT, slot.query);
			active = true;
		},
		end() {
			if (!active) return;
			gl.endQuery(TIME_ELAPSED_EXT);
			slots[writeIdx].pending = true;
			writeIdx = (writeIdx + 1) % RING_SIZE;
			active = false;
		},
		get lastMs() { return lastMs; },
		dispose() {
			for (const slot of slots) gl.deleteQuery(slot.query);
		},
	};
}
