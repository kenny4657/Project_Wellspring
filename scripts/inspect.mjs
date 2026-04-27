import { chromium } from 'playwright';
const b = await chromium.launch({headless:true});
const p = await (await b.newContext()).newPage();
p.setDefaultTimeout(180000);
const logs = [];
p.on('console', m => {
  const t = m.text();
  if (t.includes('[vite]') || t.includes('Babylon.js v') || t.includes('GL Driver')) return;
  logs.push(t);
});
await p.goto('http://localhost:5173/globe', {waitUntil:'domcontentloaded', timeout:180000});
await p.waitForFunction(() => typeof window.engine !== 'undefined', {timeout:180000});
await p.waitForTimeout(800);

const summary = await p.evaluate(() => {
  const groups = [
    { label: '12926/12964/12965 (same-tier gap)', ids: [12926, 12964, 12965] },
    { label: '12818 (similar position, no gap)', ids: [12818] },
    { label: '12774/12775/12757 (cliff gap)', ids: [12774, 12775, 12757] },
    { label: '12927/12966/12928 (tiny cliff gap)', ids: [12927, 12966, 12928] },
  ];
  const out = [];
  for (const grp of groups) {
    const cells = grp.ids.map(id => engine.cells[id]);
    const cellInfo = cells.map(c => ({
      id: c.id,
      tier: c.heightLevel,
      ncorners: c.corners.length,
      nbrs: Array.from(c.neighbors).map(nb => {
        const id = (nb && typeof nb === 'object') ? nb.id : nb;
        const t = engine.cells[id]?.heightLevel;
        return { id, tier: t };
      }),
    }));
    const m = new Map();
    for (const c of cells) for (const co of c.corners) {
      if (!m.has(co)) m.set(co, []);
      m.get(co).push(c.id);
    }
    const shared = [];
    for (const [co, owners] of m) if (owners.length >= 2) shared.push({ pos: [co.x, co.y, co.z], owners });
    out.push({ label: grp.label, ids: grp.ids, cellInfo, shared });
  }
  return out;
});

console.log("=== TOPOLOGY ===");
for (const g of summary) {
  console.log(`\n[${g.label}]`);
  for (const c of g.cellInfo) {
    console.log(`  cell ${c.id} tier=${c.tier} ncorners=${c.ncorners} nbrs=[${c.nbrs.map(n=>`${n.id}:t${n.tier}`).join(', ')}]`);
  }
  for (const s of g.shared) {
    if (s.owners.length >= 2) {
      const tag = s.owners.length >= 3 ? '*** 3-CELL ***' : '';
      console.log(`  shared corner [${s.pos.map(v=>v.toFixed(6)).join(',')}] owners=${s.owners.join(',')} ${tag}`);
    }
  }
}

console.log("\n=== H DUMPS AT 3-CELL CORNERS ===");
for (const g of summary) {
  const sh3 = g.shared.filter(s => s.owners.length >= 3);
  for (const s of sh3) {
    console.log(`\n--- ${g.label} corner at ${s.pos.map(v=>v.toFixed(6)).join(',')} owners=${s.owners.join(',')} ---`);
    logs.length = 0;
    await p.evaluate((args) => engine.dumpH(args.owners, args.pos[0], args.pos[1], args.pos[2]), s);
    await p.waitForTimeout(50);
    for (const l of logs) console.log('  ' + l);
  }
}

await b.close();
