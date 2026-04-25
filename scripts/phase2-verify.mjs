/**
 * Phase 2 verification (revised after audit feedback).
 *
 * Three independent comparisons, each reported separately so the reader can
 * tell algorithm error from shader-implementation error:
 *
 *   A. GLSL          <-> CPU pickHexAt (nearest-center)
 *      The canonical truth. "Does the GLSL hex ID match what the click-pick
 *      logic would say at the same screen pixel?" Some boundary disagreement
 *      is structural (face-grid != Voronoi); we report 1-hop neighbor as a
 *      separate bucket but no longer headline-fold it into "match".
 *
 *   B. GLSL          <-> CPU pickHexByFaceGrid (same algorithm)
 *      Self-consistency. "Does the shader faithfully implement the algorithm
 *      it was supposed to implement?" If A is bad but B is high, the GLSL is
 *      correct and the algorithm is the issue. If B is bad, the shader is wrong.
 *
 *   C. CPU pickHexAt <-> CPU pickHexByFaceGrid
 *      Algorithm-vs-algorithm. "How much does face-grid lookup disagree with
 *      nearest-center on the CPU alone?" This is the irreducible structural
 *      error from picking face-grid as the GLSL's algorithm of choice.
 *
 * Plus: a pentagon-specific run that samples ONLY pixels near the 12
 * icosahedron vertices, to confirm the pentagon early-exit works.
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

// Phase 3 split: shader-preview now means "Phase 3 flat sphere"; the
// hex-ID debug material lives behind the "shader-debug" render mode.
await page.selectOption('select', 'shader-debug');
await page.evaluate(() => window.__globeEngine.setShaderDebugMode(3));
await page.waitForTimeout(500);

const png = await page.locator('canvas').screenshot();
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
console.log(`Canvas image: ${info.width}x${info.height} channels=${info.channels}`);

const decodeId = (px) => px[0] + px[1] * 256 + px[2] * 65536;

// ── Sample N pixels uniformly across the visible sphere ──
function sampleTargets(n) {
	const targets = [];
	const cx = info.width / 2;
	const cy = info.height / 2;
	const rmax = Math.min(info.width, info.height) * 0.4;
	for (let k = 0; k < n; k++) {
		const a = Math.random() * Math.PI * 2;
		const r = Math.sqrt(Math.random()) * rmax;
		const sx = Math.round(cx + r * Math.cos(a));
		const sy = Math.round(cy + r * Math.sin(a));
		if (sx < 0 || sy < 0 || sx >= info.width || sy >= info.height) continue;
		const idx = (sy * info.width + sx) * info.channels;
		const px = [data[idx], data[idx + 1], data[idx + 2]];
		const isMagenta = px[0] > 240 && px[1] < 30 && px[2] > 240;
		// Don't filter on darkness — low-id cells (id 0..11 = pentagons) encode
		// as near-black RGB and the old filter dropped them silently.
		targets.push({ sx, sy, px, isMagenta });
	}
	return targets;
}

const targets = sampleTargets(800);

const picks = await page.evaluate((coords) => {
	const eng = window.__globeEngine;
	if (!eng) return { error: 'no engine' };
	const dpr = window.devicePixelRatio || 1;
	const cpu = coords.map(c => eng.pickHexAt(c.sx / dpr, c.sy / dpr));
	const fg  = coords.map(c => eng.pickHexByFaceGridAt(c.sx / dpr, c.sy / dpr));
	const cells = eng.cells.length;
	return { cpu, fg, cells, dpr };
}, targets);

if (picks.error) { console.error(picks.error); process.exit(1); }

// Build a flat neighbor lookup so the off-by-one classifier is fast.
const neighborSets = await page.evaluate(() => {
	const eng = window.__globeEngine;
	return eng.cells.map(c => Array.from(c.neighbors));
});
function isNeighbor(a, b) {
	if (a < 0 || b < 0) return false;
	const set = neighborSets[a];
	if (!set) return false;
	for (const n of set) if (n === b) return true;
	return false;
}

function classify(left, right) {
	let exact = 0, neighbor = 0, far = 0, leftMissing = 0, rightMissing = 0;
	for (let i = 0; i < left.length; i++) {
		const a = left[i], b = right[i];
		if (a < 0) { leftMissing++; continue; }
		if (b < 0) { rightMissing++; continue; }
		if (a === b) exact++;
		else if (isNeighbor(a, b)) neighbor++;
		else far++;
	}
	const total = exact + neighbor + far;
	const denom = Math.max(1, total);
	return {
		exact, neighbor, far, leftMissing, rightMissing,
		exactPct: (exact / denom * 100).toFixed(1),
		neighborPct: (neighbor / denom * 100).toFixed(1),
		farPct: (far / denom * 100).toFixed(1),
	};
}

// Decode GLSL pixel ids for samples that are NOT magenta sentinels.
const glslIds = targets.map((t) => t.isMagenta ? -1 : decodeId(t.px));
const glslMisses = targets.filter(t => t.isMagenta).length;

const A = classify(glslIds, picks.cpu); // GLSL vs canonical pickHex
const B = classify(glslIds, picks.fg);  // GLSL vs CPU mirror (self-consistency)
const C = classify(picks.fg, picks.cpu); // face-grid CPU vs nearest-center CPU

console.log(`\nSamples: ${targets.length}  (GLSL magenta lookup-misses: ${glslMisses})`);
const fmt = (r) => `exact=${r.exactPct}%  neighbor=${r.neighborPct}%  far=${r.farPct}%  (n=${r.exact + r.neighbor + r.far})`;
console.log(`A) GLSL          vs CPU pickHexAt        : ${fmt(A)}`);
console.log(`B) GLSL          vs CPU pickHexByFaceGrid: ${fmt(B)}`);
console.log(`C) CPU face-grid vs CPU nearest-center   : ${fmt(C)}`);

// ── Pentagon-specific check ──
// Sample only screen pixels close to where the 12 pentagon hexes project.
// If the early-exit works, GLSL ids at these pixels should equal the CPU
// pentagon ids exactly (no boundary noise — the early-exit returns the
// pentagon's own id directly).
console.log('\nPentagon early-exit check:');
const pentagonReport = await page.evaluate(() => {
	const eng = window.__globeEngine;
	const cells = eng.cells;
	const pentagons = cells.filter(c => c.isPentagon);
	return { count: pentagons.length, pentagonIds: pentagons.map(p => p.id) };
});
console.log(`  Pentagon cells in grid: ${pentagonReport.count}  ids=[${pentagonReport.pentagonIds.join(',')}]`);

// Sample lots of pixels and find ones whose CPU pickHexAt returns a pentagon id.
const pentMatches = { exact: 0, neighbor: 0, far: 0, n: 0 };
const pentSet = new Set(pentagonReport.pentagonIds);
for (let i = 0; i < targets.length; i++) {
	const cpuId = picks.cpu[i];
	if (!pentSet.has(cpuId)) continue;
	const t = targets[i];
	if (t.isMagenta) { pentMatches.far++; pentMatches.n++; continue; }
	const glsl = decodeId(t.px);
	if (glsl === cpuId) pentMatches.exact++;
	else if (isNeighbor(cpuId, glsl)) pentMatches.neighbor++;
	else pentMatches.far++;
	pentMatches.n++;
}
if (pentMatches.n === 0) {
	console.log('  (no pentagon-region samples in this run — random sampling didn\'t hit any pole)');
} else {
	console.log(`  Pentagon samples: ${pentMatches.n}  exact=${pentMatches.exact}  neighbor=${pentMatches.neighbor}  far=${pentMatches.far}`);
}

if (errors.length) { console.log('\nERRORS:'); errors.forEach((e) => console.log('  ' + e)); }

await browser.close();
