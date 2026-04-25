/** Phase 2 perf check: shader-preview mode FPS during the standard benchmark. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto('http://localhost:5174/globe?ref=1', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.loading-bar'), { timeout: 90000 });
await page.waitForTimeout(2500);

for (const mode of ['legacy', 'shader-preview']) {
	await page.selectOption('select', mode);
	await page.waitForTimeout(500);
	const r = await page.evaluate(async () => {
		return await window.__globeEngine.runBenchmark();
	});
	console.log(mode, JSON.stringify(r));
}

await browser.close();
