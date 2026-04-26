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
	window.engine.dumpSeam(0, 9471);
	return {
		totalsCpuVsSim: r.totalsCpuVsSim,
		totalsSeam: r.totalsSeam,
		maxCpuVsSim: r.maxCpuVsSim,
		maxSeam: r.maxSeam,
		cpuMismatchCount: r.cpuVsSim.length,
		seamMismatchCount: r.seam.length,
	};
});

console.log('--- Captured console logs ---');
for (const l of logs) console.log(l);
console.log('--- Diagnostic summary ---');
console.log(JSON.stringify(result, null, 2));

await browser.close();
