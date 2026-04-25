/**
 * Phase 1 + Phase 3 verification.
 *
 * Phase 1 (data textures): for every cell, the bytes in the texture at
 * position (id % size, id / size) must equal cells[id].terrain (R) and
 * cells[id].heightLevel (R) for the height texture. We do this CPU-side
 * by reading back the engine's mirror buffers — the texture itself is
 * never read from GPU; if the mirror is correct and the upload is straight
 * gl.texImage2D the GPU side trivially is too. We also exercise the
 * GPU-side path via the shader-debug "terrain from texture" mode and
 * confirm the rendered image matches the cells' terrain assignments.
 *
 * Phase 3 (smooth icosphere): switch render-mode to shader-preview, take
 * a screenshot, confirm a sphere appears in the canvas (non-trivial
 * fraction of pixels are not the clear color, sphere region is mostly
 * uniform color from the flat material).
 *
 * Also: take screenshots so we can visually inspect modes 4 (terrain) and
 * 5 (height) and compare against the legacy rendering.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const URL = 'http://localhost:5174/globe?ref=1';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.loading-bar'), { timeout: 90000 });
await page.waitForTimeout(2500);

// ── Phase 1 CPU check: every cell's data texture entry matches its struct. ──
const cpuCheck = await page.evaluate(() => {
	const eng = window.__globeEngine;
	if (!eng) return { error: 'no engine' };
	// Reach into the engine internals via the same handle used by other tests.
	// The engine doesn't expose hexData directly, but we can probe it through
	// the cells array vs what setHexTerrain would do. For verification, we
	// expose hex data textures via a helper: skip if not available.
	return {
		cells: eng.cells.map(c => ({ id: c.id, terrain: c.terrain, heightLevel: c.heightLevel })),
	};
});

if (cpuCheck.error) { console.error(cpuCheck.error); process.exit(1); }
console.log(`Cells: ${cpuCheck.cells.length}`);

// Phase 1 byte-level integrity: every cells[i].terrain/heightLevel must
// match the texture CPU mirror at offset i*4.
const integrity = await page.evaluate(() => window.__globeEngine._phase1DataIntegrity());
console.log(`Phase 1 CPU integrity: ${integrity.mismatches} byte mismatches across ${integrity.totalCells} cells (${integrity.mismatches === 0 ? 'PASS' : 'FAIL'})`);

// GPU readback: prove the texture upload actually landed correctly. Catches
// any RawTexture.update() bug the CPU-mirror check can't see.
const gpuIntegrity = await page.evaluate(async () => await window.__globeEngine._phase1GpuIntegrity());
if (gpuIntegrity.error) {
	console.log(`Phase 1 GPU integrity: ERROR ${gpuIntegrity.error}`);
} else {
	const mis = (gpuIntegrity.terrainMis ?? 0) + (gpuIntegrity.heightMis ?? 0);
	console.log(`Phase 1 GPU integrity: terrain=${gpuIntegrity.terrainMis} height=${gpuIntegrity.heightMis} mismatches across ${gpuIntegrity.sampled} samples (${mis === 0 ? 'PASS' : 'FAIL'})`);
}

// Paint round-trip: change a cell's terrain, confirm the GPU-side texture
// reflects the new value. This actually exercises RawTexture.update() and
// the GPU upload pipeline, not just the CPU mirror.
const paintCheck = await page.evaluate(async () => {
	const eng = window.__globeEngine;
	const targetCell = eng.cells[100];
	const oldTerrain = targetCell.terrain;
	const newTerrain = oldTerrain === 4 ? 7 : 4;
	const tIds = ['ocean','shallow','coast','lake','plains','grass','desert','swamp','tundra','hills'];
	eng.setHexTerrain(100, tIds[newTerrain]);
	const cpuMirror = eng._phase1DataIntegrity();
	const gpu = await eng._phase1GpuIntegrity();
	eng.setHexTerrain(100, tIds[oldTerrain]); // revert
	return { mismatches: cpuMirror.mismatches, gpu, oldTerrain, newTerrain };
});
const gpuMis = (paintCheck.gpu.terrainMis ?? 0) + (paintCheck.gpu.heightMis ?? 0);
console.log(`Phase 1 paint round-trip: cpu=${paintCheck.mismatches} gpu=${gpuMis} mismatches (${paintCheck.mismatches === 0 && gpuMis === 0 ? 'PASS' : 'FAIL'})`);

// ── GPU-side check: shader-debug mode 4 (terrain from texture). ──
// Sample N pixels, decode the terrain ID we expect from the displayed color,
// compare with the cell's terrain via pickHexAt.
await page.selectOption('select', 'shader-debug');
await page.evaluate(() => window.__globeEngine.setShaderDebugMode(4));
await page.waitForTimeout(800);

// Mode-4 palette in the GLSL (mirror it here exactly).
const TERRAIN_PALETTE = [
	[0.05, 0.10, 0.40], [0.20, 0.40, 0.70], [0.30, 0.55, 0.80], [0.50, 0.70, 0.85],
	[0.45, 0.65, 0.30], [0.30, 0.55, 0.20], [0.78, 0.70, 0.45], [0.40, 0.50, 0.30],
	[0.78, 0.78, 0.85], [0.55, 0.45, 0.32],
];
function nearestTerrainId(rgb) {
	const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
	let best = -1, bestD = Infinity;
	for (let i = 0; i < TERRAIN_PALETTE.length; i++) {
		const p = TERRAIN_PALETTE[i];
		const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
		if (d < bestD) { bestD = d; best = i; }
	}
	return { id: best, dist: Math.sqrt(bestD) };
}

const png4 = await page.locator('canvas').screenshot();
writeFileSync('/tmp/phase1-mode4.png', png4);
const { data, info } = await sharp(png4).raw().toBuffer({ resolveWithObject: true });

const N = 600;
const cx = info.width / 2;
const cy = info.height / 2;
const rmax = Math.min(info.width, info.height) * 0.4;

// For each sample, what terrain does the CPU say is at that pixel?
const samples = [];
for (let k = 0; k < N; k++) {
	const a = Math.random() * Math.PI * 2;
	const r = Math.sqrt(Math.random()) * rmax;
	const sx = Math.round(cx + r * Math.cos(a));
	const sy = Math.round(cy + r * Math.sin(a));
	if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) continue;
	const idx = (sy * info.width + sx) * info.channels;
	const px = [data[idx], data[idx + 1], data[idx + 2]];
	if (px[0] < 12 && px[1] < 12 && px[2] < 32) continue; // background
	if (px[0] > 240 && px[1] < 30 && px[2] > 240) continue; // magenta lookup-miss
	samples.push({ sx, sy, px });
}

const cpuTerrains = await page.evaluate((coords) => {
	const eng = window.__globeEngine;
	const dpr = window.devicePixelRatio || 1;
	return coords.map(c => {
		const id = eng.pickHexAt(c.sx / dpr, c.sy / dpr);
		return id < 0 ? -1 : eng.cells[id].terrain;
	});
}, samples);

let matches = 0, neighbors = 0, far = 0;
for (let i = 0; i < samples.length; i++) {
	const cpuTerrain = cpuTerrains[i];
	if (cpuTerrain < 0) continue;
	const decoded = nearestTerrainId(samples[i].px);
	if (decoded.id === cpuTerrain && decoded.dist < 0.12) matches++;
	else if (Math.abs(decoded.id - cpuTerrain) === 1) neighbors++;
	else far++;
}
console.log(`Mode 4 (terrain from texture): exact=${matches} neighbor-id=${neighbors} far=${far}  (n=${samples.length})`);

// ── Phase 3 visual check: shader-preview mode shows a sphere ──
await page.selectOption('select', 'shader-preview');
await page.waitForTimeout(800);
const png3 = await page.locator('canvas').screenshot();
writeFileSync('/tmp/phase3-flat.png', png3);
const p3 = await sharp(png3).raw().toBuffer({ resolveWithObject: true });
let nonBackground = 0;
let total = 0;
for (let py = 0; py < p3.info.height; py += 4) {
	for (let px = 0; px < p3.info.width; px += 4) {
		const i = (py * p3.info.width + px) * p3.info.channels;
		const r = p3.data[i], g = p3.data[i + 1], b = p3.data[i + 2];
		total++;
		if (!(r < 12 && g < 12 && b < 32)) nonBackground++;
	}
}
const fillRatio = nonBackground / total;
console.log(`Phase 3 (shader-preview flat sphere): ${(fillRatio * 100).toFixed(1)}% of canvas is non-background`);
console.log(`  Expected: ~30%-50% (sphere occupies the central main panel area).`);

// Sample center pixel of the shader-preview screenshot — should be the
// unshaded flat color (0.45, 0.55, 0.70) → RGB ~(115, 140, 178).
const ci = (Math.floor(p3.info.height / 2) * p3.info.width + Math.floor(p3.info.width / 2)) * p3.info.channels;
const cr = p3.data[ci], cg = p3.data[ci + 1], cb = p3.data[ci + 2];
console.log(`Phase 3 center pixel RGB = (${cr}, ${cg}, ${cb})`);
// Allow ±5 per channel for sRGB / driver rounding.
const expectFlat = (Math.abs(cr - 115) <= 5 && Math.abs(cg - 140) <= 5 && Math.abs(cb - 178) <= 5);
console.log(`Phase 3 flat color: ${expectFlat ? 'PASS' : 'FAIL'} (expected ~(115, 140, 178))`);

// ── Phase 1 mode-5 (height) screenshot ──
await page.selectOption('select', 'shader-debug');
await page.evaluate(() => window.__globeEngine.setShaderDebugMode(5));
await page.waitForTimeout(800);
const png5 = await page.locator('canvas').screenshot();
writeFileSync('/tmp/phase1-mode5.png', png5);
console.log('Saved /tmp/phase1-mode4.png /tmp/phase1-mode5.png /tmp/phase3-flat.png');

if (errors.length) { console.log('\nERRORS:'); errors.forEach((e) => console.log('  ' + e)); }

await browser.close();
