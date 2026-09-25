// Builds the site's data files from the Destiny 2 manifest and the DIM community wish list.
// Output:
//   data/index.json      list of weapons for search
//   data/w/<id>.json     perk columns + recommended rolls for one weapon
//   data/meta.json       when the data was built and from which manifest version
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_KEY = process.env.BUNGIE_API_KEY || '';
const WISHLIST_URL = process.env.WISHLIST_URL ||
  'https://raw.githubusercontent.com/48klocs/dim-wish-list-sources/master/voltron.txt';
const OUT = path.resolve(process.env.OUT_DIR || 'data');
const BUNGIE = 'https://www.bungie.net';

const WEAPON_PERKS_CATEGORY = 4241085061; // "Weapon Perks" socket category
const INTRINSIC_CATEGORY = 3956125808;    // holds the weapon's frame (e.g. "Support Frame")
const MIN_ESTIMATE_ROLLS = 10;            // fewest borrowed rolls needed for an estimate
const MAX_ROLLS_PER_SOURCE = 200;         // so one popular gun can't drown out the rest
const ITEM_TYPE_WEAPON = 3;
const DUMMY_CATEGORY = 3109687656;
const MAX_ROLLS_PER_MODE = 3000;          // keeps per-weapon files small
const SKIP_PLUG_CATEGORY = /tracker|shader|masterwork|memento|crafting|v400\.empty/i;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} while fetching ${url}`);
  return res.json();
}

async function loadManifest() {
  // For local testing: point LOCAL_MANIFEST_DIR at a folder with items.json and plugsets.json
  if (process.env.LOCAL_MANIFEST_DIR) {
    const dir = process.env.LOCAL_MANIFEST_DIR;
    return {
      version: 'local',
      items: JSON.parse(await readFile(path.join(dir, 'items.json'), 'utf8')),
      plugSets: JSON.parse(await readFile(path.join(dir, 'plugsets.json'), 'utf8')),
    };
  }
  const headers = API_KEY ? { 'X-API-Key': API_KEY } : {};
  const manifest = await getJson(`${BUNGIE}/Platform/Destiny2/Manifest/`, headers);
  if (manifest.ErrorCode !== 1) {
    throw new Error(`Bungie API error: ${manifest.Message}. Is the BUNGIE_API_KEY secret set?`);
  }
  const paths = manifest.Response.jsonWorldComponentContentPaths.en;
  console.log('Downloading manifest', manifest.Response.version);
  const [items, plugSets] = await Promise.all([
    getJson(BUNGIE + paths.DestinyInventoryItemDefinition),
    getJson(BUNGIE + paths.DestinyPlugSetDefinition),
  ]);
  return { version: manifest.Response.version, items, plugSets };
}

// ---------- Wish list ----------

function classifyMode(notes) {
  const tagIdx = notes.indexOf('|tags:');
  const text = (tagIdx >= 0 ? notes.slice(tagIdx + 6) : notes).toLowerCase();
  const pvp = /\bpvp\b|crucible|trials/.test(text);
  const pve = /\bpve\b/.test(text);
  if (pvp && !pve) return 'pvp';
  if (pve && !pvp) return 'pve';
  return 'both';
}

// Strip the tag list and tidy whitespace; returns '' when there's nothing useful
function cleanNote(notes) {
  const tagIdx = notes.indexOf('|tags:');
  const text = (tagIdx >= 0 ? notes.slice(0, tagIdx) : notes).replace(/\s+/g, ' ').trim();
  return text.length >= 8 ? text : '';
}

export function parseWishlist(text) {
  const entries = [];
  let blockNotes = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { blockNotes = ''; continue; }
    if (line.startsWith('//notes:')) { blockNotes = line.slice(8); continue; }
    if (!line.startsWith('dimwishlist:')) continue;

    const noteIdx = line.indexOf('#notes:');
    const body = line.slice(12, noteIdx >= 0 ? noteIdx : undefined);
    const notes = noteIdx >= 0 ? line.slice(noteIdx + 7) : blockNotes;
    const params = new URLSearchParams(body);
    const item = Number(params.get('item'));
    if (!item || item < 0) continue; // negative = trash list or "any item" wildcard
    const perks = (params.get('perks') || '').split(',').map(Number).filter(Boolean);
    if (!perks.length) continue;
    entries.push({ item, perks, mode: classifyMode(notes), note: cleanNote(notes) });
  }
  return entries;
}

// ---------- Weapons ----------

// Every weapon perk hash we see -> its name, so the inventory page can read rolled perks
const perkNames = {};

function perkColumns(item, items, plugSets) {
  const cat = item.sockets?.socketCategories?.find(c => c.socketCategoryHash === WEAPON_PERKS_CATEGORY);
  if (!cat) return null;
  const columns = [];
  let hasRandomRolls = false;

  for (const idx of cat.socketIndexes) {
    const entry = item.sockets.socketEntries[idx];
    if (!entry) continue;
    if (entry.randomizedPlugSetHash) hasRandomRolls = true;

    let hashes = [];
    const setHash = entry.randomizedPlugSetHash || entry.reusablePlugSetHash;
    if (setHash && plugSets[setHash]) {
      const all = plugSets[setHash].reusablePlugItems;
      for (const p of all) {
        const n = items[p.plugItemHash]?.displayProperties?.name;
        if (n) perkNames[p.plugItemHash] = n;
      }
      hashes = all.filter(p => p.currentlyCanRoll !== false).map(p => p.plugItemHash);
    } else if (entry.reusablePlugItems?.length) {
      hashes = entry.reusablePlugItems.map(p => p.plugItemHash);
    } else if (entry.singleInitialItemHash) {
      hashes = [entry.singleInitialItemHash];
    }

    const byName = new Map();
    for (const h of hashes) {
      const plug = items[h];
      if (plug?.displayProperties?.name) perkNames[h] = plug.displayProperties.name;
      const name = plug?.displayProperties?.name;
      if (!name || /^empty\b/i.test(name)) continue;
      if (SKIP_PLUG_CATEGORY.test(plug.plug?.plugCategoryIdentifier || '')) continue;
      const type = plug.itemTypeDisplayName || '';
      const enhanced = /enhanced/i.test(type);
      const existing = byName.get(name);
      // Enhanced and base perks share a name; keep the base version for display
      if (existing && !(existing.enhanced && !enhanced)) continue;
      byName.set(name, {
        name,
        icon: plug.displayProperties.icon || '',
        desc: plug.displayProperties.description || '',
        type: type.replace(/^enhanced\s+/i, ''),
        enhanced,
      });
    }
    if (!byName.size) continue;
    const perks = [...byName.values()];
    columns.push({ label: perks[0].type || 'Perk', perks, socket: idx });
  }
  return hasRandomRolls ? columns : null;
}

function frameName(item, items) {
  const cat = item.sockets?.socketCategories?.find(c => c.socketCategoryHash === INTRINSIC_CATEGORY);
  const entry = cat && item.sockets.socketEntries[cat.socketIndexes[0]];
  return items[entry?.singleInitialItemHash]?.displayProperties?.name || '';
}

function columnWeight(label) {
  if (/origin/i.test(label)) return 0.5;
  if (/trait/i.test(label)) return 3;
  return 1;
}

function mergeColumns(base, extra) {
  if (extra.length > base.length) [base, extra] = [extra, base];
  base.forEach((col, i) => {
    const other = extra[i];
    if (!other || other.label !== col.label) return;
    const names = new Set(col.perks.map(p => p.name));
    for (const p of other.perks) if (!names.has(p.name)) col.perks.push(p);
  });
  return base;
}

function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'weapon';
}

// ---------- Main ----------

async function main() {
  const [{ version, items, plugSets }, wishText] = await Promise.all([
    loadManifest(),
    process.env.LOCAL_WISHLIST
      ? readFile(process.env.LOCAL_WISHLIST, 'utf8')
      : fetch(WISHLIST_URL).then(r => { if (!r.ok) throw new Error(`Wish list ${r.status}`); return r.text(); }),
  ]);

  // Group every random-roll weapon by name (reissues share a name)
  const groups = new Map();
  const hashToGroup = new Map();
  for (const [hash, item] of Object.entries(items)) {
    if (item.itemType !== ITEM_TYPE_WEAPON || item.redacted) continue;
    if (item.itemCategoryHashes?.includes(DUMMY_CATEGORY)) continue;
    const name = item.displayProperties?.name;
    if (!name) continue;
    const cols = perkColumns(item, items, plugSets);
    if (!cols?.length) continue;

    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        hashes: [],
        type: item.itemTypeDisplayName || '',
        tier: item.inventory?.tierTypeName || '',
        icon: item.displayProperties.icon || '',
        screenshot: item.screenshot || '',
        frame: frameName(item, items),
        columns: cols,
        sockets: {},
      };
      groups.set(name, g);
    } else {
      g.columns = mergeColumns(g.columns, cols);
    }
    g.hashes.push(Number(hash));
    g.sockets[hash] = cols.map(c => c.socket); // which socket holds each perk column
    hashToGroup.set(Number(hash), g);
  }
  console.log(`Found ${groups.size} random-roll weapons`);

  // Flatten perk indices so rolls can reference them compactly
  for (const g of groups.values()) {
    g.nameToIdx = new Map();
    g.idxToName = [];
    let i = 0;
    g.columns.forEach(col => {
      col.weight = columnWeight(col.label);
      for (const p of col.perks) { g.nameToIdx.set(p.name, i++); g.idxToName.push(p.name); }
    });
    // Perks in trait columns; a recommended roll with no trait perk says little about the gun
    g.traitIdx = new Set();
    let j = 0;
    g.columns.forEach(col => col.perks.forEach(() => { if (col.weight >= 3) g.traitIdx.add(j); j++; }));
    g.rolls = { all: new Map(), pve: new Map(), pvp: new Map() };
    g.notes = [];           // unique curator notes for this weapon
    g.noteIdx = new Map();  // note text -> index
  }

  const wish = parseWishlist(wishText);
  console.log(`Parsed ${wish.length} wish list rolls`);
  let matched = 0;
  for (const { item, perks, mode, note } of wish) {
    const g = hashToGroup.get(item);
    if (!g) continue;
    const idx = [...new Set(perks
      .map(h => g.nameToIdx.get(items[h]?.displayProperties?.name))
      .filter(v => v !== undefined))].sort((a, b) => a - b);
    if (!idx.length) continue;
    if (g.traitIdx.size && !idx.some(i => g.traitIdx.has(i))) continue;
    const key = idx.join(',');
    let ni = -1;
    if (note) {
      if (!g.noteIdx.has(note)) { g.noteIdx.set(note, g.notes.length); g.notes.push(note); }
      ni = g.noteIdx.get(note);
    }
    const targets = mode === 'both' ? ['all', 'pve', 'pvp'] : ['all', mode];
    for (const t of targets) {
      const r = g.rolls[t].get(key) || { w: 0, notes: new Set() };
      r.w++;
      if (ni >= 0 && r.notes.size < 3) r.notes.add(ni);
      g.rolls[t].set(key, r);
    }
    matched++;
  }
  console.log(`Matched ${matched} rolls to weapons`);

  // Weapons nobody has posted rolls for: borrow rolls from similar weapons.
  // First try the same type and frame (e.g. Support Frame Auto Rifles), then just the same type.
  const pools = new Map();
  for (const g of groups.values()) {
    if (!g.rolls.all.size) continue;
    for (const key of [`${g.type}|${g.frame}`, `${g.type}|*`]) {
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(g);
    }
  }
  let estimated = 0;
  for (const g of groups.values()) {
    if (g.rolls.all.size) continue;
    const tries = [[`${g.type}|${g.frame}`, g.frame ? `${g.frame} ${g.type}s` : `${g.type}s`], [`${g.type}|*`, `${g.type}s`]];
    for (const [key, label] of tries) {
      const sources = pools.get(key) || [];
      if (!sources.length) continue;
      const est = { all: new Map(), pve: new Map(), pvp: new Map() };
      let used = 0;
      for (const src of sources) {
        for (const m of Object.keys(est)) {
          const top = [...src.rolls[m].entries()].sort((a, b) => b[1].w - a[1].w).slice(0, MAX_ROLLS_PER_SOURCE);
          for (const [k, r] of top) {
            const idx = [...new Set(k.split(',')
              .map(x => g.nameToIdx.get(src.idxToName[Number(x)]))
              .filter(v => v !== undefined))].sort((a, b) => a - b);
            if (!idx.length) continue;
            if (g.traitIdx.size && !idx.some(x => g.traitIdx.has(x))) continue;
            const key2 = idx.join(',');
            const cur = est[m].get(key2) || { w: 0, notes: new Set() };
            cur.w += r.w;
            est[m].set(key2, cur);
            if (m === 'all') used += r.w;
          }
        }
      }
      if (used >= MIN_ESTIMATE_ROLLS) {
        g.rolls = est;
        g.estimated = { basis: label, weapons: sources.length, rolls: used };
        estimated++;
        break;
      }
    }
  }
  console.log(`Estimated rolls for ${estimated} weapons with no wish list data`);

  await rm(path.join(OUT, 'w'), { recursive: true, force: true });
  await mkdir(path.join(OUT, 'w'), { recursive: true });

  const index = [];
  const lookup = { items: {}, perks: perkNames };
  const usedIds = new Set();
  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const g of sorted) {
    let id = slug(g.name);
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    for (const h of g.hashes) lookup.items[h] = [id, g.sockets[h]];

    const modes = {};
    for (const [m, map] of Object.entries(g.rolls)) {
      const list = [...map.entries()]
        .sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1))
        .slice(0, MAX_ROLLS_PER_MODE);
      modes[m] = {
        rolls: list.map(([k]) => k.split(',').map(Number)),
        weights: list.map(([, r]) => r.w),
        notes: list.map(([, r]) => [...r.notes]), // indices into the weapon's notes list
      };
    }

    const out = {
      id,
      name: g.name,
      type: g.type,
      tier: g.tier,
      icon: g.icon,
      screenshot: g.screenshot,
      columns: g.columns.map(c => ({
        label: c.label,
        weight: c.weight,
        perks: c.perks.map(p => ({ name: p.name, icon: p.icon, desc: p.desc })),
      })),
      notes: g.notes,
      estimated: g.estimated || null,
      modes,
    };
    await writeFile(path.join(OUT, 'w', `${id}.json`), JSON.stringify(out));
    index.push({
      id, name: g.name, type: g.type, tier: g.tier, icon: g.icon,
      n: g.estimated ? 0 : modes.all.rolls.length,
      ...(g.estimated ? { est: 1 } : {}),
    });
  }

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  await writeFile(path.join(OUT, 'lookup.json'), JSON.stringify(lookup));
  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify({
    manifestVersion: version,
    builtAt: new Date().toISOString(),
    weapons: index.length,
    wishlistRolls: matched,
  }, null, 2));
  console.log(`Wrote ${index.length} weapons to ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
