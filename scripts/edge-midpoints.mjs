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

const groups = [
  { label: '12757/12774/12775', ids: [12757, 12774, 12775] },
];

for (const grp of groups) {
  console.log(`\n=== ${grp.label} ===`);
  const cellInfo = await p.evaluate((ids) => {
    const cells = ids.map(id => engine.cells[id]);
    return cells.map(c => ({
      id: c.id, tier: c.heightLevel, ncorners: c.corners.length,
      nbrs: Array.from(c.neighbors).map(nb => ({
        id: nb.id ?? nb,
        tier: typeof nb === 'object' ? nb.heightLevel : engine.cells[nb]?.heightLevel,
      })),
    }));
  }, grp.ids);
  for (const c of cellInfo) {
    console.log(`  ${c.id} t${c.tier} ncorners=${c.ncorners} nbrs=[${c.nbrs.map(n=>`${n.id}:t${n.tier}`).join(', ')}]`);
  }

  const sharedPairs = await p.evaluate((ids) => {
    const cells = ids.map(id => engine.cells[id]);
    const pairs = [];
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const A = cells[i], B = cells[j];
        const shared = A.corners.filter(c => B.corners.includes(c));
        if (shared.length === 2) {
          pairs.push({ cellA: A.id, cellB: B.id, corners: shared.map(c => [c.x, c.y, c.z]) });
        }
      }
    }
    return pairs;
  }, grp.ids);

  for (const pr of sharedPairs) {
    console.log(`\n--- shared edge ${pr.cellA} ↔ ${pr.cellB} ---`);
    const [a, c0] = pr.corners;
    const slerps = [0.0, 0.25, 0.5, 0.75, 1.0];
    for (const t of slerps) {
      const x = a[0] * (1 - t) + c0[0] * t;
      const y = a[1] * (1 - t) + c0[1] * t;
      const z = a[2] * (1 - t) + c0[2] * t;
      const len = Math.sqrt(x*x + y*y + z*z);
      const ux = x / len, uy = y / len, uz = z / len;
      logs.length = 0;
      await p.evaluate((args) => engine.dumpH(args.ids, args.ux, args.uy, args.uz),
        { ids: [pr.cellA, pr.cellB], ux, uy, uz });
      await p.waitForTimeout(40);
      console.log(`  t=${t.toFixed(2)} (${ux.toFixed(5)},${uy.toFixed(5)},${uz.toFixed(5)}):`);
      const wanted = logs.filter(l => l.includes('cell ') || l.includes('max h-diff'));
      for (const l of wanted) console.log('    ' + l);
    }
  }
}
await b.close();
