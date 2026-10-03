// Records which weapons Xûr is selling, using Bungie's public vendor data (no login).
// If Bungie includes the rolled perks, those are saved too, so the Xûr page can score
// them for everyone. Signed-in players always get their exact rolls on the page itself.
// Allowed to fail in the workflow; it never blocks the main data build.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.BUNGIE_API_KEY || '';
const ROOT = process.env.BUNGIE_ROOT || 'https://www.bungie.net';
const DATA = path.resolve(process.env.OUT_DIR || 'data');

async function main() {
  const lookup = JSON.parse(await readFile(path.join(DATA, 'lookup.json'), 'utf8'));
  const vendorHashes = lookup.xurVendors || [];
  if (!vendorHashes.length) throw new Error('No Xûr vendor entries in lookup.json; run the data build first');

  const get = async comps => {
    const res = await fetch(`${ROOT}/Platform/Destiny2/Vendors/?components=${comps}`, { headers: { 'X-API-Key': API_KEY } });
    const j = await res.json().catch(() => null);
    if (!j || j.ErrorCode !== 1) console.log(`Bungie said (${comps}): ${j?.ErrorStatus || res.status} ${j?.Message || ''}`);
    return j?.ErrorCode === 1 ? j : null;
  };
  const j = (await get('400,402,305,310')) || (await get('400,402'));
  if (!j) throw new Error('Bungie public vendor data unavailable');
  console.log('Vendors in public data:', Object.keys(j.Response?.sales?.data || {}).length);
  const r = j.Response || {};
  const sales = r.sales?.data || {};
  const vendors = r.vendors?.data || {};

  const items = [];
  const seen = new Set();
  let present = false;
  for (const vh of vendorHashes) {
    if (vendors[vh]?.enabled || sales[vh]) present = true;
    const comps = r.itemComponents?.[vh] || {};
    for (const [idx, sale] of Object.entries(sales[vh]?.saleItems || {})) {
      const entry = lookup.items[sale.itemHash];
      if (!entry) continue; // not a random-roll weapon
      const live = comps.sockets?.data?.[idx]?.sockets || [];
      const reusable = comps.reusablePlugs?.data?.[idx]?.plugs || {};
      const [id, socketIdx] = entry;
      // Perk hashes per column; empty when Bungie doesn't share the roll publicly
      const perks = socketIdx.map(si => {
        const hs = new Set((reusable[si] || []).map(p => p.plugItemHash));
        if (live[si]?.plugHash) hs.add(live[si].plugHash);
        return [...hs];
      });
      const key = `${id}|${perks.flat().join('.')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id, hash: sale.itemHash, perks });
    }
  }

  const out = { fetched: new Date().toISOString(), present, items };
  await writeFile(path.join(DATA, 'xur.json'), JSON.stringify(out, null, 2));
  const withRolls = items.filter(i => i.perks.some(p => p.length)).length;
  console.log(`Xûr ${present ? 'is here' : 'is away'}: ${items.length} weapons, ${withRolls} with public rolls`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
