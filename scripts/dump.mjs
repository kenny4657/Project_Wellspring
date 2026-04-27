import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext()).newPage();
p.setDefaultTimeout(180000);
const logs = [];
p.on('console', m => {
  const t = m.text();
  if (t.includes('[vite]') || t.includes('Babylon.js v') || t.includes('GL Driver')) return;
  logs.push(t);
});
await p.goto('http://localhost:5173/globe', { waitUntil: 'domcontentloaded', timeout: 180000 });
await p.waitForFunction(() => typeof window.engine !== 'undefined', { timeout: 180000 });
await p.waitForTimeout(800);
await p.evaluate(() => window.engine.setGpuMode(true));
await p.waitForTimeout(500);

// Get shared 3-cell corner positions
const corners = await p.evaluate(() => {
  const ids = [9050, 9051, 9079];
  const cells = ids.map(id => engine.cells[id]);
  const m = new Map();
  for (const c of cells) for (const co of c.corners) {
    if (!m.has(co)) m.set(co, []);
    m.get(co).push(c.id);
  }
  const out = [];
  for (const [co, owners] of m) {
    if (owners.length >= 3) out.push({ pos: [co.x, co.y, co.z], owners });
  }
  return out;
});

// dumpH at 3-cell corner using the SIM (which still uses old walk path)
console.log('=== dumpH at 3-cell corners (sim mirror — old walk) ===');
for (const c of corners) {
  console.log(`pos=${c.pos.map(v=>v.toFixed(6)).join(',')} owners=${c.owners.join(',')}`);
  logs.length = 0;
  await p.evaluate((args) => engine.dumpH(args.owners, args.pos[0], args.pos[1], args.pos[2]), c);
  await p.waitForTimeout(40);
  for (const l of logs.filter(l => l.includes('cell ') || l.includes('max h-diff'))) console.log('  ' + l);
}
await b.close();
