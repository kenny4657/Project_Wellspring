/**
 * Phase 4 visual regression: capture the 4 reference camera positions in
 * legacy vs shader-preview, save side-by-side images for visual comparison.
 *
 * Plan threshold: <2% pixel difference in the central globe area, ignoring
 * AA at the silhouette. We don't compute that diff here (would need a
 * proper alignment-aware comparator); we save both PNGs and the user
 * eyeballs them. Future work could integrate pixelmatch.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';

const URL = 'http://localhost:5174/globe?ref=1';
const OUT = '/Users/kennethmei/country-painter/docs/phase4-screenshots';
mkdirSync(OUT, { recursive: true });

const VIEWS = [
	{ name: 'top-down',     lat:  35, lng: -20, radius: 12000, pitch: 0,         yaw: 0 },
	{ name: 'near-horizon', lat:  48, lng:   2, radius:  1500, pitch: Math.PI/3, yaw: 0.5 },
	{ name: 'equator',      lat:   0, lng:  90, radius:  4000, pitch: 0,         yaw: 0 },
	{ name: 'polar',        lat:  78, lng: -30, radius:  3500, pitch: Math.PI/4, yaw: 0 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.loading-bar'), { timeout: 90000 });
await page.waitForTimeout(3000);

for (const v of VIEWS) {
	for (const mode of ['legacy', 'shader-preview']) {
		await page.selectOption('select', mode);
		await page.waitForTimeout(800);
		await page.evaluate(({ lat, lng, radius, pitch, yaw }) => {
			window.__setCam(lat, lng, radius, pitch, yaw);
		}, v);
		await page.waitForTimeout(1200);
		const png = await page.locator('canvas').screenshot();
		writeFileSync(`${OUT}/${v.name}-${mode}.png`, png);
		console.log(`saved ${v.name}-${mode}.png`);
	}
}

// Build side-by-side composites for easy eyeballing
for (const v of VIEWS) {
	const legacy = sharp(`${OUT}/${v.name}-legacy.png`);
	const shader = sharp(`${OUT}/${v.name}-shader-preview.png`);
	const lMeta = await legacy.metadata();
	const sMeta = await shader.metadata();
	const w = Math.max(lMeta.width || 0, sMeta.width || 0);
	const h = Math.max(lMeta.height || 0, sMeta.height || 0);
	const composite = await sharp({
		create: { width: w * 2 + 8, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } },
	})
		.composite([
			{ input: `${OUT}/${v.name}-legacy.png`, left: 0, top: 0 },
			{ input: `${OUT}/${v.name}-shader-preview.png`, left: w + 8, top: 0 },
		])
		.png()
		.toBuffer();
	writeFileSync(`${OUT}/${v.name}-compare.png`, composite);
	console.log(`composite ${v.name}-compare.png`);
}

if (errs.length) { console.log('\nERRORS:'); errs.forEach((e) => console.log('  ' + e.substring(0, 300))); }

await browser.close();
