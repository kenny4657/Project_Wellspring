/**
 * Reproducible perf benchmark: orbit the camera through 8 fixed waypoints
 * over 16 seconds, sampling per-frame ms. At end, log min / median / p99 /
 * mean to console and return the result struct.
 *
 * Used to compare legacy vs shader-preview renderers on a fixed motion path
 * so the comparison isn't biased by where the user happened to be looking.
 */

import type { GeospatialCamera } from '@babylonjs/core/Cameras/geospatialCamera';
import { latLngToWorld } from '$lib/geo/coords';
import { EARTH_RADIUS_KM } from '$lib/geo/coords';

interface Waypoint {
	lat: number;
	lng: number;
	radius: number;
	pitch: number;
	yaw: number;
}

// 8 waypoints chosen to exercise: full-globe, mid-zoom, near-surface, polar,
// equatorial, high-tilt. Avoid duplicating identical camera states.
const WAYPOINTS: Waypoint[] = [
	{ lat:  35, lng:  -20, radius: 12000, pitch: 0,           yaw: 0 },
	{ lat:  48, lng:    2, radius:  4000, pitch: 0,           yaw: 0 },
	{ lat:  48, lng:    2, radius:  1500, pitch: Math.PI/3,   yaw: 0.5 },
	{ lat:   0, lng:   90, radius:  8000, pitch: 0,           yaw: 1.5 },
	{ lat: -40, lng:  150, radius:  6000, pitch: Math.PI/4,   yaw: 2.0 },
	{ lat:  70, lng:  -90, radius:  3000, pitch: Math.PI/3.5, yaw: -1.0 },
	{ lat:  20, lng: -100, radius: 15000, pitch: 0,           yaw: 0 },
	{ lat:  35, lng:  -20, radius: 12000, pitch: 0,           yaw: 0 },
];

const DURATION_MS = 16000;

export interface BenchmarkResult {
	frames: number;
	minMs: number;
	medianMs: number;
	p99Ms: number;
	meanMs: number;
	maxMs: number;
	gpuMedianMs: number; // 0 when GPU timer not enabled
}

export interface BenchmarkOpts {
	camera: GeospatialCamera;
	getFrameMs: () => number;        // CPU+GPU wall ms (engine.getDeltaTime())
	getGpuFrameMs?: () => number;    // optional GPU-only ms
	onComplete?: (r: BenchmarkResult) => void;
	onProgress?: (t01: number) => void; // 0..1 for UI
}

/**
 * Start a benchmark run. Returns a cancel function.
 * The orbit loop drives camera fields directly each frame; GeospatialCamera
 * recomputes its view matrix from these without any animation system.
 */
export function runBenchmark(opts: BenchmarkOpts): () => void {
	const { camera, getFrameMs, getGpuFrameMs, onComplete, onProgress } = opts;
	const start = performance.now();
	const samples: number[] = [];
	const gpuSamples: number[] = [];
	let cancelled = false;
	let raf = 0;

	function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
	function lerpAngle(a: number, b: number, t: number) {
		// Unwrap shortest path
		let d = b - a;
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d < -Math.PI) d += 2 * Math.PI;
		return a + d * t;
	}

	function applyWaypoint(idx: number, t: number) {
		const a = WAYPOINTS[idx];
		const b = WAYPOINTS[Math.min(idx + 1, WAYPOINTS.length - 1)];
		const lat = lerp(a.lat, b.lat, t);
		const lng = lerp(a.lng, b.lng, t);
		camera.center = latLngToWorld(lat, lng, EARTH_RADIUS_KM);
		camera.radius = lerp(a.radius, b.radius, t);
		camera.pitch  = lerp(a.pitch,  b.pitch,  t);
		camera.yaw    = lerpAngle(a.yaw, b.yaw, t);
	}

	function tick() {
		if (cancelled) return;
		const elapsed = performance.now() - start;
		const t01 = Math.min(1, elapsed / DURATION_MS);
		onProgress?.(t01);

		// Map t01 to (waypointIdx, segmentT)
		const segCount = WAYPOINTS.length - 1;
		const segPos = t01 * segCount;
		const segIdx = Math.min(segCount - 1, Math.floor(segPos));
		const segT = segPos - segIdx;
		applyWaypoint(segIdx, segT);

		samples.push(getFrameMs());
		if (getGpuFrameMs) {
			const g = getGpuFrameMs();
			if (g > 0) gpuSamples.push(g);
		}

		if (elapsed >= DURATION_MS) {
			finish();
			return;
		}
		raf = requestAnimationFrame(tick);
	}

	function finish() {
		// Drop the first 30 samples (warm-up) to avoid biasing the percentiles
		// with shader compile and texture upload spikes.
		const usable = samples.slice(30).filter(x => x > 0).sort((a, b) => a - b);
		if (usable.length === 0) {
			onComplete?.({ frames: 0, minMs: 0, medianMs: 0, p99Ms: 0, meanMs: 0, maxMs: 0, gpuMedianMs: 0 });
			return;
		}
		const median = usable[Math.floor(usable.length * 0.5)];
		const p99 = usable[Math.floor(usable.length * 0.99)];
		const mean = usable.reduce((s, x) => s + x, 0) / usable.length;
		const gpuSorted = gpuSamples.slice().sort((a, b) => a - b);
		const gpuMedian = gpuSorted.length ? gpuSorted[Math.floor(gpuSorted.length * 0.5)] : 0;

		const r: BenchmarkResult = {
			frames: usable.length,
			minMs: usable[0],
			medianMs: median,
			p99Ms: p99,
			meanMs: mean,
			maxMs: usable[usable.length - 1],
			gpuMedianMs: gpuMedian,
		};
		console.log('[Benchmark]', JSON.stringify(r, null, 2));
		onComplete?.(r);
	}

	raf = requestAnimationFrame(tick);
	return () => { cancelled = true; cancelAnimationFrame(raf); };
}

export const BENCHMARK_WAYPOINTS = WAYPOINTS;
