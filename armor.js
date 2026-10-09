// Armor page: every armor piece the player owns, ranked by the stats their build needs,
// with shard candidates and set-bonus progress. Sign-in is shared with the My inventory page.
(() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const PICKS_KEY = 'rs-armor-stats';
  const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock', 'Any class'];
  const SLOT_NAMES = ['Helmet', 'Arms', 'Chest', 'Legs', 'Class item'];
  const POSTMASTER = 215593132;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { data: null, items: [], picks: [], who: '', raw: null };

  const configured = CFG.bungieApiKey && CFG.bungieClientId && !/PASTE/.test(CFG.bungieApiKey + CFG.bungieClientId);

  function show(id) { ['signed-out', 'setup', 'loading', 'inv'].forEach(x => { $('#' + x).hidden = x !== id; }); }
  function loading(msg) { show('loading'); $('#loading').classList.remove('failed'); $('#load-msg').textContent = msg; }
  function fail(msg) { loading(msg); $('#loading').classList.add('failed'); }

  // ---------- Sign in (finished on the My inventory page, which sends people back here) ----------

  function getToken() {
    let t = null;
    try { t = JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch {}
    return t && t.expiresAt > Date.now() + 60_000 ? t : null;
  }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }
  function signIn() {
    try { sessionStorage.setItem('rs-return', 'armor.html'); } catch {}
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('rs-oauth-state', st); } catch {}
    location.href = `${BUNGIE}/en/OAuth/Authorize?client_id=${encodeURIComponent(CFG.bungieClientId)}&response_type=code&state=${st}`;
  }

  class AuthError extends Error {}
  async function api(path) {
    const t = getToken();
    if (!t) throw new AuthError('Signed out');
    const res = await fetch(`${BUNGIE}/Platform${path}`, {
      headers: { 'X-API-Key': CFG.bungieApiKey, Authorization: `Bearer ${t.accessToken}` },
    });
    const j = await res.json().catch(() => null);
    if (res.status === 401 || j?.ErrorCode === 99 || j?.ErrorCode === 2111) {
      clearToken();
      throw new AuthError(`Bungie rejected the login: ${j ? `${j.ErrorStatus || ''} ${j.Message || ''}`.trim() : `HTTP ${res.status}`}`);
    }
    if (!j || j.ErrorCode !== 1) throw new Error(j?.Message || `Bungie API error ${res.status}`);
    return j.Response;
  }

  // ---------- Loading ----------

  async function load() {
    loading('Pulling armor records…');
    if (!state.data) {
      const res = await fetch('data/armor.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('Armor data is missing. Run the "Update roll data" workflow.');
      state.data = await res.json();
    }
    const A = state.data;

    loading('Contacting the Tower…');
    const mem = await api('/User/GetMembershipsForCurrentUser/');
    const list = mem.destinyMemberships || [];
    const m = list.find(x => x.membershipId === mem.primaryMembershipId) || list[0];
    if (!m) throw new Error('No Destiny 2 account found on this Bungie login.');
    state.who = m.bungieGlobalDisplayName
      ? `${m.bungieGlobalDisplayName}#${String(m.bungieGlobalDisplayNameCode).padStart(4, '0')}`
      : m.displayName;

    loading('Opening your vault…');
    const p = await api(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=102,200,201,205,300,304,305`);
    state.raw = p;

    const raw = [];
    const chars = p.characters?.data || {};
    for (const it of p.profileInventory?.data?.items || []) raw.push({ it, where: 'Vault' });
    for (const [cid, c] of Object.entries(chars)) {
      const cls = CLASS_NAMES[c.classType] || 'Character';
      for (const it of p.characterInventories?.data?.[cid]?.items || []) raw.push({ it, where: it.bucketHash === POSTMASTER ? 'Postmaster' : cls });
      for (const it of p.characterEquipment?.data?.[cid]?.items || []) raw.push({ it, where: `${cls}, equipped` });
    }

    const ic = p.itemComponents || {};
    state.items = raw.filter(r => r.it.itemInstanceId && A.items[r.it.itemHash]).map(({ it, where }) => {
      const [name, cls, slot, set, icon, exotic] = A.items[it.itemHash];
      const iid = it.itemInstanceId;
      const inst = ic.instances?.data?.[iid] || {};
      const st = ic.stats?.data?.[iid]?.stats || {};
      const sockets = ic.sockets?.data?.[iid]?.sockets || [];
      const arch = sockets.map(s => A.arch[s.plugHash]).find(Boolean) || '';
      const stats = A.stats.map(s => st[s.h]?.value ?? 0);
      let order = 0n;
      try { order = BigInt(iid); } catch {}
      return {
        iid, name, cls, slot, set, icon, exotic: !!exotic, where, arch, stats, order,
        tier: Number.isFinite(inst.gearTier) ? inst.gearTier : null,
        power: inst.primaryStat?.value ?? null,
        total: stats.reduce((a, b) => a + b, 0),
      };
    });

    buildFilters();
    show('inv');
    $('#who').textContent = `Signed in as ${state.who} · ${state.items.length} armor pieces`;
    render();
    if (/[?&]debug=1/.test(location.search)) showDebug(p);
  }

  // ---------- Build stats (saved in this browser) ----------

  function loadPicks() {
    try { state.picks = (JSON.parse(localStorage.getItem(PICKS_KEY)) || []).filter(i => i >= 0 && i < 6).slice(0, 3); } catch { state.picks = []; }
  }
  function savePicks() { try { localStorage.setItem(PICKS_KEY, JSON.stringify(state.picks)); } catch {} }

  function renderPicks() {
    $('#ar-stats').innerHTML = state.data.stats.map((s, i) =>
      `<button type="button" data-i="${i}" aria-pressed="${state.picks.includes(i)}">${esc(s.n)}</button>`).join('');
    $('#ar-stats').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (state.picks.includes(i)) state.picks = state.picks.filter(x => x !== i);
      else if (state.picks.length < 3) state.picks.push(i);
      else { state.picks.shift(); state.picks.push(i); }
      savePicks();
      render();
    }));
  }

  const buildScore = x => (state.picks.length ? state.picks.reduce((a, i) => a + x.stats[i], 0) : x.total);

  // ---------- Shard candidates: a same-kind piece that's at least as good everywhere that matters ----------

  function findBetter() {
    const groups = new Map();
    for (const x of state.items) {
      x.beatenBy = null;
      if (x.exotic) continue;
      const k = `${x.cls}|${x.slot}|${x.set}|${x.arch}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    const focus = state.picks.length ? state.picks : null;
    for (const g of groups.values()) {
      for (const a of g) {
        let best = null;
        for (const b of g) {
          if (b === a || (b.tier ?? 0) < (a.tier ?? 0)) continue;
          const atLeast = focus ? focus.every(i => b.stats[i] >= a.stats[i]) : b.total >= a.total;
          if (!atLeast || buildScore(b) <= buildScore(a)) continue;
          if (!best || buildScore(b) > buildScore(best)) best = b;
        }
        a.beatenBy = best;
      }
    }
  }

  // ---------- Filters ----------

  function fillSelect(sel, values) {
    const el = $(sel), first = el.options[0].outerHTML;
    el.innerHTML = first + values.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  }

  function buildFilters() {
    const A = state.data, its = state.items;
    fillSelect('#a-class', [...new Set(its.map(x => x.cls))].sort().map(c => [c, CLASS_NAMES[c]]));
    fillSelect('#a-slot', [...new Set(its.map(x => x.slot))].sort().map(s => [s, SLOT_NAMES[s]]));
    fillSelect('#a-set', [...new Set(its.map(x => x.set).filter(Boolean))]
      .map(s => [s, A.sets[s]?.n || 'Unknown set']).sort((a, b) => a[1].localeCompare(b[1])));
    fillSelect('#a-arch', [...new Set(its.map(x => x.arch).filter(Boolean))].sort().map(a => [a, a]));
    fillSelect('#a-tier', [...new Set(its.map(x => x.tier).filter(t => t !== null))].sort((a, b) => b - a).map(t => [t, `Tier ${t}`]));
    renderPicks();
  }

  // ---------- Rendering ----------

  function render() {
    renderPicks();
    findBetter();
    const term = $('#a-name').value.trim().toLowerCase();
    const f = {
      cls: $('#a-class').value, slot: $('#a-slot').value, set: $('#a-set').value,
      arch: $('#a-arch').value, tier: $('#a-tier').value,
    };
    const shardOnly = $('#a-shard').checked, noExotic = $('#a-exotic').checked;
    const shardCount = state.items.filter(x => x.beatenBy).length;
    $('#a-shard-label').textContent = `Shard it only (${shardCount})`;

    const rows = state.items.filter(x =>
      (!term || x.name.toLowerCase().includes(term)) &&
      (f.cls === '' || String(x.cls) === f.cls) &&
      (f.slot === '' || String(x.slot) === f.slot) &&
      (f.set === '' || String(x.set) === f.set) &&
      (f.arch === '' || x.arch === f.arch) &&
      (f.tier === '' || String(x.tier) === f.tier) &&
      (!shardOnly || x.beatenBy) && (!noExotic || !x.exotic));

    const byName = (a, b) => a.name.localeCompare(b.name);
    rows.sort({
      build: (a, b) => buildScore(b) - buildScore(a) || (b.tier ?? 0) - (a.tier ?? 0) || byName(a, b),
      total: (a, b) => b.total - a.total || byName(a, b),
      tier: (a, b) => (b.tier ?? 0) - (a.tier ?? 0) || buildScore(b) - buildScore(a),
      newest: (a, b) => (a.order === b.order ? 0 : a.order > b.order ? -1 : 1),
      name: byName,
    }[$('#a-sort').value]);

    const picked = state.picks.map(i => state.data.stats[i].n);
    $('#a-summary').textContent = `Showing ${rows.length} of ${state.items.length} pieces` +
      (picked.length ? ` · Ranked by ${picked.join(' + ')}` : ' · Ranked by total stats');

    const shown = rows.slice(0, 400);
    $('#a-list').innerHTML = shown.map(rowHtml).join('') +
      (rows.length > shown.length ? `<li class="inv-empty">Showing the first ${shown.length}. Use the filters to narrow it down.</li>` : '') ||
      '<li class="inv-empty">No armor matches these filters.</li>';
    renderSets();
  }

  function rowHtml(x) {
    const A = state.data;
    const setName = x.set ? (A.sets[x.set]?.n || '') : '';
    const meta = [SLOT_NAMES[x.slot], CLASS_NAMES[x.cls], x.arch, setName, x.where].filter(Boolean).map(esc).join(' · ');
    const badges = [
      x.tier !== null ? `<span class="badge tier">Tier ${x.tier}</span>` : '',
      x.exotic ? '<span class="badge good">Exotic</span>' : '',
      x.beatenBy ? '<span class="badge craft">Shard it</span>' : '',
    ].join(' ');
    const cells = A.stats.map((s, i) =>
      `<span class="st${state.picks.includes(i) ? ' on' : ''}"><small>${esc(s.n)}</small>${x.stats[i]}</span>`).join('');
    const better = x.beatenBy
      ? `<p class="ar-better">You have a better one: ${esc(x.beatenBy.name)} (${esc(x.beatenBy.where)}${x.beatenBy.tier !== null ? `, tier ${x.beatenBy.tier}` : ''}) gives ${buildScore(x.beatenBy)} vs ${buildScore(x)}.</p>`
      : '';
    return `<li class="ar-row">
      ${x.icon ? `<img src="${BUNGIE + esc(x.icon)}" alt="" width="44" height="44" loading="lazy">` : '<span class="ar-noimg"></span>'}
      <div class="ar-main"><div class="inv-name">${esc(x.name)} ${badges}</div><div class="inv-sub muted">${meta}</div>${better}</div>
      <div class="ar-stats">${cells}<span class="st tot"><small>Total</small>${x.total}</span></div>
      <div class="ar-score"><span class="num">${buildScore(x)}</span><small>${state.picks.length ? 'build' : 'total'}</small></div>
    </li>`;
  }

  // How many slots of each set you own, per class, and what the bonuses need
  function renderSets() {
    const A = state.data;
    const by = new Map();
    for (const x of state.items) {
      if (!x.set) continue;
      const k = `${x.cls}|${x.set}`;
      if (!by.has(k)) by.set(k, { cls: x.cls, set: x.set, slots: new Set() });
      by.get(k).slots.add(x.slot);
    }
    const rows = [...by.values()].sort((a, b) => a.cls - b.cls || b.slots.size - a.slots.size);
    if (!rows.length) { $('#sets-body').innerHTML = '<p class="muted">No set armor found.</p>'; return; }
    $('#sets-body').innerHTML = `<ul class="ar-setlist">${rows.map(r => {
      const s = A.sets[r.set] || { n: 'Unknown set', perks: [] };
      const slots = SLOT_NAMES.map((n, i) => `<span class="${r.slots.has(i) ? 'have' : ''}" title="${esc(n)}">${esc(n)}</span>`).join('');
      const perks = s.perks.map(([need, name, desc]) => {
        const ok = r.slots.size >= need;
        return `<li class="${ok ? 'have' : ''}" title="${esc(desc)}">${need}-piece${name ? `: ${esc(name)}` : ''} ${ok ? '(you can use this)' : `(need ${need - r.slots.size} more)`}</li>`;
      }).join('');
      return `<li><div class="ar-setname"><b>${esc(s.n)}</b> <span class="muted">${esc(CLASS_NAMES[r.cls])} · ${r.slots.size} of 5 slots</span></div>
        <div class="ar-slots">${slots}</div>${perks ? `<ul class="ar-perks">${perks}</ul>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  function showDebug(p) {
    const ic = p.itemComponents || {};
    const sample = state.items.slice(0, 3).map(x => ({
      name: x.name, iid: x.iid, tier: x.tier, arch: x.arch, stats: x.stats,
      instance: ic.instances?.data?.[x.iid],
      rawStats: ic.stats?.data?.[x.iid],
      sockets: ic.sockets?.data?.[x.iid],
    }));
    const el = $('#debug');
    el.hidden = false;
    el.textContent = JSON.stringify({ armorPieces: state.items.length, sample }, null, 1);
  }

  // ---------- Start ----------

  async function start() {
    const tip = $('#tip');
    if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;
    if (!configured) { show('setup'); return; }
    loadPicks();
    if (!getToken()) { show('signed-out'); return; }
    try { await load(); }
    catch (err) {
      if (err instanceof AuthError) { show('signed-out'); return; }
      fail(err.message || String(err));
    }
  }

  $('#signin').addEventListener('click', signIn);
  $('#signout').addEventListener('click', () => { clearToken(); show('signed-out'); });
  $('#refresh').addEventListener('click', () => load().catch(err => fail(err.message || String(err))));
  ['#a-name', '#a-class', '#a-slot', '#a-set', '#a-arch', '#a-tier', '#a-sort', '#a-shard', '#a-exotic']
    .forEach(sel => $(sel).addEventListener(sel === '#a-name' ? 'input' : 'change', render));
  start();
})();
