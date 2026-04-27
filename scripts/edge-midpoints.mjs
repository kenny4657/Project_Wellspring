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

// For each cliff group, sample h at the canonical corners of every shared edge,
// AND at 1/4, 1/2, 3/4 along each edge (slerp on unit sphere).
const groups = [
  { label: '12774/12775/12757', ids: [12774, 12775, 12757] },
  { label: '12927/12966/12928', ids: [12927, 12966, 12928] },
];

for (const grp of groups) {
  console.log(`\n=== ${grp.label} ===`);

  const sharedPairs = await p.evaluate((ids) => {
    const cells = ids.map(id => engine.cells[id]);
    const m = new Map();
    for (const c of cells) for (const co of c.corners) {
      if (!m.has(co)) m.set(co, []);
      m.get(co).push(c.id);
    }
    const pairs = [];
    // For each pair of cells in the group, find the 2 corners they share
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const A = cells[i], B = cells[j];
        const shared = A.corners.filter(c => B.corners.includes(c));
        if (shared.length === 2) {
          pairs.push({
            cellA: A.id, cellB: B.id,
            corners: shared.map(c => [c.x, c.y, c.z]),
          });
        }
      }
    }
    return pairs;
  }, grp.ids);

  for (const pr of sharedPairs) {
    console.log(`\n--- shared edge ${pr.cellA} ↔ ${pr.cellB} ---`);
    const [a, c0] = pr.corners;
    // 0, 0.25, 0.5, 0.75, 1.0 along the slerp
    const slerps = [0.0, 0.25, 0.5, 0.75, 1.0];
    for (const t of slerps) {
      // simple linear interp + normalize (good enough for short arcs)
      const x = a[0] * (1 - t) + c0[0] * t;
      const y = a[1] * (1 - t) + c0[1] * t;
      const z = a[2] * (1 - t) + c0[2] * t;
      const len = Math.sqrt(x*x + y*y + z*z);
      const ux = x / len, uy = y / len, uz = z / len;
      logs.length = 0;
      // Dump h for ALL cells in the group at this point so we see all participants
      await p.evaluate((args) => engine.dumpH(args.ids, args.ux, args.uy, args.uz), { ids: grp.ids, ux, uy, uz });
      await p.waitForTimeout(40);
      console.log(`  t=${t.toFixed(2)} (${ux.toFixed(5)},${uy.toFixed(5)},${uz.toFixed(5)}):`);
      const wanted = logs.filter(l => l.includes('cell ') || l.includes('max h-diff'));
      for (const l of wanted) console.log('    ' + l);
    }
  }
}

await b.close();
