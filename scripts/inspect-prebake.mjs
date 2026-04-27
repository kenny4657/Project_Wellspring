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

// Force GPU mode init so the cliff edge texture is built
const buildLog = await p.evaluate(async () => {
  const orig = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.join(' ')); orig.apply(console, args); };
  await window.engine.setGpuMode(true);
  console.warn = orig;
  return captured;
});
console.log('Build warnings:', buildLog);

const r = await p.evaluate(() => {
  const ids = [12913, 12908, 12910];
  const cells = ids.map(id => engine.cells[id]);
  const cellInfo = cells.map(c => ({
    id: c.id,
    tier: c.heightLevel,
    ncorners: c.corners.length,
    nbrs: Array.from(c.neighbors).map(nbId => ({
      id: nbId,
      tier: engine.cells[nbId]?.heightLevel,
    })),
  }));
  // Count cliff edges that would be collected for each cell
  const cellByIdMap = new Map(engine.cells.filter(c => c).map(c => [c.id, c]));
  const collectFor = (c) => {
    const out = [];
    const recordEdges = (owner) => {
      const n = owner.corners.length;
      for (let k = 0; k < n; k++) {
        const a = owner.corners[k];
        const b = owner.corners[(k + 1) % n];
        let nb = null;
        for (const nbId of owner.neighbors) {
          const cand = cellByIdMap.get(nbId);
          if (!cand) continue;
          let hasA = false, hasB = false;
          for (const cn of cand.corners) {
            if (cn === a) hasA = true;
            if (cn === b) hasB = true;
            if (hasA && hasB) { nb = cand; break; }
          }
          if (nb) break;
        }
        if (nb && nb.heightLevel !== owner.heightLevel) {
          out.push({ ownerId: owner.id, ownerH: owner.heightLevel, nbId: nb.id, nbH: nb.heightLevel });
        }
      }
    };
    recordEdges(c);
    for (const nbId of c.neighbors) {
      const nb = cellByIdMap.get(nbId);
      if (nb) recordEdges(nb);
    }
    return out;
  };
  return {
    cellInfo,
    collected: cells.map(c => ({ id: c.id, edges: collectFor(c) })),
  };
});

console.log('\n=== Topology ===');
for (const c of r.cellInfo) {
  console.log(`  ${c.id} tier=${c.tier} ncorners=${c.ncorners}`);
  console.log(`    nbrs: ${c.nbrs.map(n => `${n.id}:t${n.tier}`).join(', ')}`);
}
console.log('\n=== Collected cliff edges per cell ===');
for (const c of r.collected) {
  console.log(`  cell ${c.id}: ${c.edges.length} edges${c.edges.length > 12 ? ' *** OVER 12 ***' : ''}`);
  if (c.edges.length > 12) {
    for (const e of c.edges) {
      console.log(`    owner=${e.ownerId}(t${e.ownerH}) ↔ nb=${e.nbId}(t${e.nbH})`);
    }
  }
}
await b.close();
