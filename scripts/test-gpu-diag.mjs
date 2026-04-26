/**
 * Run window.engine.diagnoseGpuDisplacement() in a real browser via
 * Playwright and stream console output back. Lets me iterate on
 * shader/sim fixes without copy-pasting console output.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/globe';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (msg) => {
	const text = msg.text();
	logs.push(`[${msg.type()}] ${text}`);
});
page.on('pageerror', (err) => {
	logs.push(`[ERROR] ${err.message}\n${err.stack ?? ''}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Wait for engine to be exposed (it's set after init).
await page.waitForFunction(() => typeof (window).engine !== 'undefined', { timeout: 60000 });

// Give the engine a moment to settle.
await page.waitForTimeout(500);

// Run the diagnostic and dump a verbose seam.
const result = await page.evaluate(async () => {
	const r = window.engine.diagnoseGpuDisplacement();
	return {
		totalsCpuVsSim: r.totalsCpuVsSim,
		totalsSeam: r.totalsSeam,
		maxCpuVsSim: r.maxCpuVsSim,
		maxSeam: r.maxSeam,
		cpuMismatchCount: r.cpuVsSim.length,
		seamMismatchCount: r.seam.length,
	};
});

await page.setViewportSize({ width: 1280, height: 720 });

// Zoom by sending wheel events directly on the canvas — works in
// headless because Babylon's pointer-input system handles them
// like normal user input.
const canvas = await page.$('canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
// Multiple wheel events to zoom in significantly.
for (let i = 0; i < 50; i++) {
	await page.mouse.move(cx, cy);
	await page.mouse.wheel(0, -120);
}
await page.waitForTimeout(800);
const altitudeKm = await page.evaluate(() => window.engine.perf.altitudeKm);
console.log(`Camera altitude after zoom: ${altitudeKm.toFixed(0)} km`);

await page.screenshot({ path: 'scripts/cpu-mode.png' });
console.log('CPU mode screenshot → scripts/cpu-mode.png');

// Switch to GPU mode at the same camera.
await page.evaluate(async () => {
	await window.engine.setGpuMode(true);
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'scripts/gpu-mode.png' });
console.log('GPU mode screenshot → scripts/gpu-mode.png');

console.log('--- Captured console logs ---');
for (const l of logs) console.log(l);
console.log('--- Diagnostic summary ---');
console.log(JSON.stringify(result, null, 2));

await browser.close();
