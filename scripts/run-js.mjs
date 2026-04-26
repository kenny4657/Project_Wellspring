/**
 * Minimal Playwright runner for executing arbitrary JS on the live page
 * and streaming console output back. No screenshots.
 *
 *   node scripts/run-js.mjs "engine.findRenderedGaps()"
 */
import { chromium } from 'playwright';

const expr = process.argv.slice(2).join(' ').trim();
if (!expr) {
	console.error('Usage: node scripts/run-js.mjs "<js expression>"');
	process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on('console', (msg) => {
	const t = msg.text();
	if (t.includes('[vite]') || t.includes('Babylon.js v') || t.includes('GL Driver Message')) return;
	console.log(t);
});
page.on('pageerror', (err) => console.error('[page error]', err.message));

await page.goto('http://localhost:5173/globe', { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.engine !== 'undefined', { timeout: 60000 });
await page.waitForTimeout(500);

const result = await page.evaluate(async (code) => {
	try {
		// eslint-disable-next-line no-new-func
		const fn = new Function(`return (async () => { return await (${code}); })()`);
		return await fn();
	} catch (e) {
		return { __error: String(e) };
	}
}, expr);

if (result && typeof result === 'object' && result.__error) {
	console.error('[exec error]', result.__error);
} else if (result !== undefined) {
	console.log('--- result ---');
	console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
}

await browser.close();
