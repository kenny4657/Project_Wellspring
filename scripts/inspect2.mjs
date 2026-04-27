import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext()).newPage();
p.setDefaultTimeout(180000);
p.on('console', m => {
  const t = m.text();
  if (t.includes('[vite]') || t.includes('Babylon.js v') || t.includes('GL Driver')) return;
  console.log(t);
});
await p.goto('http://localhost:5173/globe', { waitUntil: 'domcontentloaded', timeout: 180000 });
await p.waitForFunction(() => typeof window.engine !== 'undefined', { timeout: 180000 });
await p.waitForTimeout(800);
await p.evaluate(() => window.engine.setGpuMode(true));
await p.waitForTimeout(500);

const r = await p.evaluate(() => {
  const ids = [9050, 9051, 9079];
  const cells = ids.map(id => engine.cells[id]);
  const cellByIdMap = new Map(engine.cells.filter(c => c).map(c => [c.id, c]));
  const cellInfo = cells.map(c => ({
    id: c.id, tier: c.heightLevel, ncorners: c.corners.length,
    nbrs: Array.from(c.neighbors).map(nbId => ({ id: nbId, tier: engine.cells[nbId]?.heightLevel })),
  }));

  // Find shared corners (3-cell)
  const m = new Map();
  for (const c of cells) for (const co of c.corners) {
    if (!m.has(co)) m.set(co, []);
    m.get(co).push(c.id);
  }
  const shared3 = [];
  for (const [co, owners] of m) {
    if (owners.length >= 3) shared3.push({ pos: [co.x, co.y, co.z], owners });
  }

  // Re-run collect-with-dedup for each cell
  const isCliffEdge = (a, b) => a !== b;
  const findNeighborByCorners = (c, k) => {
    const a = c.corners[k];
    const b = c.corners[(k + 1) % c.corners.length];
    for (const nbId of c.neighbors) {
      const nb = cellByIdMap.get(nbId);
      if (!nb) continue;
      let hasA = false, hasB = false;
      for (const cn of nb.corners) {
        if (cn === a) hasA = true;
        if (cn === b) hasB = true;
        if (hasA && hasB) return nb;
      }
    }
    return null;
  };
  const collectFor = (c) => {
    const seen = new Set();
    const edges = [];
    const recordEdges = (owner) => {
      const n = owner.corners.length;
      for (let k = 0; k < n; k++) {
        const a = owner.corners[k];
        const b = owner.corners[(k + 1) % n];
        const nb = findNeighborByCorners(owner, k);
        if (!nb) continue;
        if (!isCliffEdge(owner.heightLevel, nb.heightLevel)) continue;
        const ka = `${a.x.toFixed(7)},${a.y.toFixed(7)},${a.z.toFixed(7)}`;
        const kb = `${b.x.toFixed(7)},${b.y.toFixed(7)},${b.z.toFixed(7)}`;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ owner: owner.id, ownerH: owner.heightLevel, nb: nb.id, nbH: nb.heightLevel, key });
      }
    };
    recordEdges(c);
    for (const nbId of c.neighbors) {
      const nb = cellByIdMap.get(nbId);
      if (nb) recordEdges(nb);
    }
    return edges;
  };

  return {
    cellInfo,
    shared3,
    perCellEdges: cells.map(c => ({ id: c.id, edges: collectFor(c) })),
  };
});

console.log('\n=== Topology ===');
for (const c of r.cellInfo) {
  console.log(`  ${c.id} t${c.tier} ncorners=${c.ncorners}`);
  console.log(`    nbrs: ${c.nbrs.map(n => `${n.id}:t${n.tier}`).join(', ')}`);
}
console.log('\n=== Shared 3-cell corners ===');
for (const s of r.shared3) {
  console.log(`  pos=${s.pos.map(v=>v.toFixed(6)).join(',')} owners=${s.owners.join(',')}`);
}
console.log('\n=== Cliff edge sets per cell (after dedup) ===');
for (const c of r.perCellEdges) {
  console.log(`  cell ${c.id}: ${c.edges.length} unique edges`);
  for (const e of c.edges) console.log(`    ${e.owner}(t${e.ownerH}) ↔ ${e.nb}(t${e.nbH}) key=${e.key.slice(0,30)}...`);
}

// Diff: which edges are in one cell's set but not another's?
console.log('\n=== Set diffs (asymmetric edges) ===');
for (let i = 0; i < r.perCellEdges.length; i++) {
  for (let j = i + 1; j < r.perCellEdges.length; j++) {
    const A = r.perCellEdges[i], B = r.perCellEdges[j];
    const Akeys = new Set(A.edges.map(e => e.key));
    const Bkeys = new Set(B.edges.map(e => e.key));
    const onlyA = A.edges.filter(e => !Bkeys.has(e.key));
    const onlyB = B.edges.filter(e => !Akeys.has(e.key));
    if (onlyA.length || onlyB.length) {
      console.log(`  ${A.id} vs ${B.id}: ${onlyA.length} only-in-${A.id}, ${onlyB.length} only-in-${B.id}`);
      for (const e of onlyA) console.log(`    only ${A.id}: ${e.owner}(t${e.ownerH}) ↔ ${e.nb}(t${e.nbH})`);
      for (const e of onlyB) console.log(`    only ${B.id}: ${e.owner}(t${e.ownerH}) ↔ ${e.nb}(t${e.nbH})`);
    }
  }
}
await b.close();
