/**
 * Phase 2 verification: GLSL `worldPosToHexId` <-> CPU `pickHex`.
 *
 * Strategy:
 *   1. Load the globe page in shader-preview mode.
 *   2. Capture the canvas via Playwright (screenshot bypasses the
 *      preserveDrawingBuffer:false constraint).
 *   3. Sample N pixels distributed across the sphere area.
 *   4. For each sample: read pixel RGB, compare with idColor(cellId)
 *      where cellId = engine.pickHexAt(sx, sy).
 *   5. Report match/mismatch/lookup-miss counts. Acceptance per the plan:
 *      "heat-map shader on the legacy mesh should produce output identical
 *      to a CPU-rendered 'color by hexId' sanity check."
 */
import { chromium } from 'playwright';
import sharp from 'sharp';

const URL = 'http://localhost:5174/globe?ref=1';
const VIEW_W = 1280;
const VIEW_H = 800;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

console.log('Loading...');
await page.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForFunction(() => !document.querySelector('.loading-bar'), { timeout: 90000 });
await page.waitForTimeout(2500);

await page.selectOption('select', 'shader-preview');
// Switch to mode 3 (raw ID bits) so we can compare hex IDs *exactly*.
// GLSL `sin` is fp32 — its hash diverges from JS Math.sin (fp64), so the
// id-hash color in mode 0 isn't reproducible cross-platform. Mode 3 outputs
// vec3(id_lowByte, id_midByte, id_highByte)/255.
await page.evaluate(() => window.__globeEngine.setShaderDebugMode(3));
await page.waitForTimeout(500);

const canvasBox = await page.locator('canvas').boundingBox();
if (!canvasBox) { console.error('no canvas'); process.exit(1); }
const png = await page.locator('canvas').screenshot();
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
console.log(`Canvas image: ${info.width}x${info.height} channels=${info.channels}`);

function decodeId(px) {
	// Inverse of the GLSL mode-3 encode: id = R + G*256 + B*65536.
	return px[0] + px[1] * 256 + px[2] * 65536;
}

const N = 400;
const cx = info.width / 2;
const cy = info.height / 2;
const rmax = Math.min(info.width, info.height) * 0.4;
const targets = [];
for (let k = 0; k < N; k++) {
	const a = Math.random() * Math.PI * 2;
	const r = Math.sqrt(Math.random()) * rmax;
	const sx = Math.round(cx + r * Math.cos(a));
	const sy = Math.round(cy + r * Math.sin(a));
	if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) continue;
	const idx = (sy * info.width + sx) * info.channels;
	const px = [data[idx], data[idx + 1], data[idx + 2]];
	if (px[0] < 12 && px[1] < 12 && px[2] < 32) continue;
	const isMagenta = px[0] > 240 && px[1] < 30 && px[2] > 240;
	targets.push({ sx, sy, px, isMagenta });
}

// Compare GLSL output against the CPU mirror of the SAME face-grid algorithm.
// This is the apples-to-apples test: "GLSL faithfully implements face-grid
// hex lookup." Comparing against pickHex (nearest-center) would conflate
// algorithm differences with shader bugs.
const pickResults = await page.evaluate((coords) => {
	const eng = window.__globeEngine;
	if (!eng) return { error: 'no engine' };
	const dpr = window.devicePixelRatio || 1;
	const out = coords.map(c => eng.pickHexByFaceGridAt(c.sx / dpr, c.sy / dpr));
	const cpuPick = coords.map(c => eng.pickHexAt(c.sx / dpr, c.sy / dpr));
	return { ids: out, cpuPick, dpr };
}, targets);

if (pickResults.error) { console.error(pickResults.error); process.exit(1); }

let match = 0, mismatch = 0, miss = 0, cpuMiss = 0;
const examples = [];
const offByOne = []; // mismatches where GLSL id differs from CPU id by a single neighbor hex
for (let i = 0; i < targets.length; i++) {
	const t = targets[i];
	const cpuId = pickResults.ids[i];
	if (t.isMagenta) { miss++; continue; }
	if (cpuId < 0) { cpuMiss++; continue; }
	const glslId = decodeId(t.px);
	if (glslId === cpuId) { match++; continue; }
	mismatch++;
	// Note off-by-one neighbors separately: that's expected near hex
	// boundaries where the "nearest center" pickHex and the GLSL face-grid
	// inverse can disagree by a single cell at sub-pixel distances.
	if (examples.length < 8) examples.push({ ...t, cpuId, glslId });
}

// Cross-check: how many mismatches are CPU-side neighbors of the GLSL id?
// We can't query neighbors here without exposing the cells array; the page
// already has it on `engine.cells`. Ask the browser.
const neighborCheck = await page.evaluate((pairs) => {
	const eng = window.__globeEngine;
	if (!eng) return [];
	return pairs.map(([cpuId, glslId]) => {
		if (cpuId < 0 || glslId < 0 || glslId >= eng.cells.length) return false;
		const c = eng.cells[cpuId];
		return c.neighbors.has ? c.neighbors.has(glslId) : Array.from(c.neighbors).includes(glslId);
	});
}, examples.map(e => [e.cpuId, e.glslId]));
const exampleAnnotated = examples.map((e, i) => ({ ...e, isNeighbor: neighborCheck[i] }));
const totalNeighborOff = (await page.evaluate((all) => {
	const eng = window.__globeEngine;
	let n = 0;
	for (const [cpu, glsl] of all) {
		if (cpu < 0 || glsl < 0 || glsl >= eng.cells.length) continue;
		const c = eng.cells[cpu];
		const has = c.neighbors.has ? c.neighbors.has(glsl) : Array.from(c.neighbors).includes(glsl);
		if (has) n++;
	}
	return n;
}, targets.map((t, i) => [pickResults.ids[i], decodeId(t.px)]).filter(([cpu, glsl]) => cpu !== glsl && cpu >= 0)));

console.log(`\nSamples       : ${targets.length}`);
console.log(`Exact matches : ${match}`);
console.log(`Mismatches    : ${mismatch}  (of which ${totalNeighborOff} are neighbor cells)`);
console.log(`Lookup misses : ${miss}  (magenta sentinel - face-edge artifacts)`);
console.log(`CPU pickHex -1: ${cpuMiss}  (sphere edge / off-globe)`);
console.log(`Exact rate    : ${(match / Math.max(1, match + mismatch) * 100).toFixed(1)}%`);
console.log(`Exact+neighbor: ${((match + totalNeighborOff) / Math.max(1, match + mismatch) * 100).toFixed(1)}%`);
if (examples.length) console.log('\nFirst mismatches:', JSON.stringify(exampleAnnotated, null, 2));

if (errors.length) { console.log('\nERRORS:'); errors.forEach((e) => console.log('  ' + e)); }

await browser.close();
