#!/usr/bin/env node
/**
 * Capture 4 standard reference screenshots of the legacy renderer.
 *
 * These are the locked-in "what the world looks like today" baseline against
 * which Phase 4 sub-phases will be visually compared. Re-run only when the
 * legacy art intentionally changes; otherwise leave the PNGs frozen.
 *
 * Usage:
 *   node scripts/snapshot-references.mjs            # uses http://localhost:5173
 *   DEV_URL=http://localhost:5174 node scripts/snapshot-references.mjs
 *
 * Requires the dev server to be running. Writes to docs/reference-screenshots/.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'docs', 'reference-screenshots');
const DEV_URL = process.env.DEV_URL || 'http://localhost:5173';

// 4 reference camera positions from the transition plan: top-down, near-horizon,
// equator, polar. Each (lat, lng, radius, pitch, yaw) is fed via window.__setCam,
// which globe.ts exposes when ?ref=1 is present.
const VIEWS = [
	{ name: 'top-down',     lat:  35, lng: -20, radius: 12000, pitch: 0,         yaw: 0 },
	{ name: 'near-horizon', lat:  48, lng:   2, radius:  1500, pitch: Math.PI/3, yaw: 0.5 },
	{ name: 'equator',      lat:   0, lng:  90, radius:  4000, pitch: 0,         yaw: 0 },
	{ name: 'polar',        lat:  78, lng: -30, radius:  3500, pitch: Math.PI/4, yaw: 0 },
];

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

// ?ref=1 makes globe.ts expose window.__setCam and disables auto-fit
const url = `${DEV_URL}/globe?ref=1`;
console.log(`Loading ${url}…`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

// Wait for mesh build to complete (loading overlay removed)
await page.waitForFunction(() => !document.querySelector('.loading-bar'), { timeout: 90000 });
// Plus a few seconds for shader compile / texture upload
await page.waitForTimeout(3000);

for (const v of VIEWS) {
	console.log(`Snapshot: ${v.name}`);
	await page.evaluate(({ lat, lng, radius, pitch, yaw }) => {
		// @ts-expect-error injected by globe.ts when ?ref=1
		window.__setCam(lat, lng, radius, pitch, yaw);
	}, v);
	// Settle: 1 second to let the camera math finalize and the next frame land
	await page.waitForTimeout(1000);
	const file = resolve(OUT_DIR, `${v.name}.png`);
	await page.locator('canvas').screenshot({ path: file });
	console.log(`  → ${file}`);
}

await browser.close();
console.log('Done.');
