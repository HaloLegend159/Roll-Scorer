// Samples what perks players actually run, using public Bungie data:
//   1. find the newest match reports (post-game carnage reports, "PGCRs")
//   2. pick random recent matches and read who played in them
//   3. read each player's equipped weapons on the character they played
//   4. add the perks to a running tally in data/usage/usage.json
// Old counts fade a little every run, so the numbers follow the current meta.
// This step is allowed to fail in the workflow; it never blocks the main data build.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.BUNGIE_API_KEY || '';
const ROOT = process.env.BUNGIE_ROOT || 'https://www.bungie.net';
const STATS = process.env.BUNGIE_STATS_ROOT || 'https://stats.bungie.net';
const DATA = path.resolve(process.env.OUT_DIR || 'data');
const USAGE_DIR = path.join(DATA, 'usage');

const MATCHES = Number(process.env.USAGE_MATCHES || 300);          // matches sampled per run
const MAX_PLAYERS = Number(process.env.USAGE_MAX_PLAYERS || 2500); // profile lookups per run
const WINDOW = Number(process.env.USAGE_WINDOW || 400000);         // how far back from the newest match to sample
const DECAY = 0.97;          // each run, old counts shrink 3% (about a month to fall to half)
const CONCURRENCY = 6;
const PVP_MODE = 5;          // DestinyActivityModeType.AllPvP
const MAX_RUNTIME_MS = 20 * 60 * 1000;

const started = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;

// Returns the Response, { missing: true } when Bungie says it doesn't exist, or null on network trouble
async function bungie(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    calls++;
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
      const j = await res.json().catch(() => null);
      if (j?.ErrorCode === 1) return j.Response;
      if (res.status === 429 || j?.ThrottleSeconds > 0) {
        await sleep(Math.max(1, j?.ThrottleSeconds || 2) * 1000);
        continue;
      }
      if (j?.ErrorCode === 5) throw new Error('Bungie API is down for maintenance');
      if (j?.ErrorCode) return { missing: true, code: j.ErrorCode, status: j.ErrorStatus };
    } catch (err) {
      if (/maintenance/.test(err.message)) throw err;
    }
    await sleep(600 * (t + 1));
  }
  return null;
}

const pgcr = id => bungie(`${STATS}/Platform/Destiny2/Stats/PostGameCarnageReport/${id}/`);

// Does a match with this id (or one just below it) exist?
async function existsNear(id) {
  for (let k = 0; k < 4; k++) {
    const r = await pgcr(id - k * 7);
    if (r && !r.missing) return true;
  }
  return false;
}

// Find roughly the newest match id. Match ids count up, so search upward from the last one we saw.
async function findTip(hint) {
  let lo = null;
  if (hint && await existsNear(hint)) lo = hint;
  if (!lo) {
    for (let x = 1e8; x < 1e12; x *= 2) {
      if (await existsNear(x)) lo = x; else if (lo) break;
    }
  }
  if (!lo) throw new Error('Could not find any recent match reports');
  let step = 250000;
  while (await existsNear(lo + step)) { lo += step; step *= 2; }
  let hi = lo + step;
  while (hi - lo > 2000) {
    const mid = Math.floor((lo + hi) / 2);
    if (await existsNear(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

async function pool(list, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < list.length && Date.now() - started < MAX_RUNTIME_MS) {
      const item = list[i++];
      await fn(item);
      await sleep(80);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

async function main() {
  if (!API_KEY) throw new Error('BUNGIE_API_KEY is not set');
  const lookup = JSON.parse(await readFile(path.join(DATA, 'lookup.json'), 'utf8'));
  await mkdir(USAGE_DIR, { recursive: true });
  const statePath = path.join(USAGE_DIR, 'state.json');
  const usagePath = path.join(USAGE_DIR, 'usage.json');
  const saved = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
  const usage = await readFile(usagePath, 'utf8').then(JSON.parse).catch(() => ({ weapons: {} }));

  const tip = await findTip(saved.tip);
  console.log(`Newest match id ≈ ${tip} (${calls} calls to find it)`);

  // 1) Sample recent matches and collect players
  const ids = new Set();
  while (ids.size < MATCHES) ids.add(tip - 2000 - Math.floor(Math.random() * WINDOW));
  const players = new Map(); // key -> { type, id, charId, mode }
  let matchesRead = 0;
  await pool([...ids], CONCURRENCY, async id => {
    const r = await pgcr(id);
    if (!r || r.missing || !r.entries) return;
    matchesRead++;
    const mode = (r.activityDetails?.modes || []).includes(PVP_MODE) ? 'pvp' : 'pve';
    for (const e of r.entries) {
      if (players.size >= MAX_PLAYERS) break;
      const u = e.player?.destinyUserInfo;
      if (!u?.membershipId || !e.characterId) continue;
      const type = u.crossSaveOverride || u.membershipType;
      const key = `${type}/${u.membershipId}/${e.characterId}`;
      if (!players.has(key)) players.set(key, { type, id: u.membershipId, charId: e.characterId, mode });
    }
  });
  console.log(`Read ${matchesRead} matches, ${players.size} players`);

  // 2) Read each player's equipped weapons on that character
  const counts = {}; // weapon id -> mode -> { n, perks: {name: count} }
  const seenInstances = new Set();
  let loadouts = 0;
  await pool([...players.values()], CONCURRENCY, async pl => {
    const p = await bungie(`${ROOT}/Platform/Destiny2/${pl.type}/Profile/${pl.id}/?components=205,305`);
    if (!p || p.missing) return;
    const items = p.characterEquipment?.data?.[pl.charId]?.items || [];
    const sockets = p.itemComponents?.sockets?.data || {};
    let counted = false;
    for (const it of items) {
      const entry = lookup.items[it.itemHash];
      if (!entry || !it.itemInstanceId || seenInstances.has(it.itemInstanceId)) continue;
      const live = sockets[it.itemInstanceId]?.sockets;
      if (!live) continue; // private profile
      seenInstances.add(it.itemInstanceId);
      const [wid, socketIdx] = entry;
      const c = ((counts[wid] ||= {})[pl.mode] ||= { n: 0, perks: {} });
      c.n++;
      for (const si of socketIdx) {
        const name = lookup.perks[live[si]?.plugHash];
        if (name) c.perks[name] = (c.perks[name] || 0) + 1;
      }
      counted = true;
    }
    if (counted) loadouts++;
  });
  console.log(`Counted ${seenInstances.size} weapons from ${loadouts} loadouts (${calls} API calls)`);
  if (!seenInstances.size) throw new Error('No weapons counted this run; leaving usage data unchanged');

  // 3) Fade old counts, add new ones
  for (const w of Object.values(usage.weapons)) {
    for (const m of Object.values(w)) {
      m.n *= DECAY;
      for (const k of Object.keys(m.perks)) {
        m.perks[k] *= DECAY;
        if (m.perks[k] < 0.05) delete m.perks[k];
      }
    }
  }
  for (const [wid, modes] of Object.entries(counts)) {
    for (const [mode, c] of Object.entries(modes)) {
      const m = (((usage.weapons[wid] ||= {})[mode]) ||= { n: 0, perks: {} });
      m.n += c.n;
      for (const [k, v] of Object.entries(c.perks)) m.perks[k] = (m.perks[k] || 0) + v;
    }
  }
  // Round to keep the file small and stable
  for (const w of Object.values(usage.weapons)) {
    for (const m of Object.values(w)) {
      m.n = Math.round(m.n * 100) / 100;
      for (const k of Object.keys(m.perks)) m.perks[k] = Math.round(m.perks[k] * 100) / 100;
    }
  }
  usage.updated = new Date().toISOString();
  usage.lastRun = { matches: matchesRead, players: players.size, weapons: seenInstances.size };

  await writeFile(usagePath, JSON.stringify(usage));
  await writeFile(statePath, JSON.stringify({ tip }, null, 2));
  console.log(`Usage data now covers ${Object.keys(usage.weapons).length} weapons`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
