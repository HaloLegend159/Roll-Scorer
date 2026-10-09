(() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const STATE_KEY = 'rs-oauth-state';
  const RETURN_KEY = 'rs-return'; // where the inventory page sends people after sign-in
  const $ = s => document.querySelector(s);

  const state = { mode: 'all', items: [], source: '', lookup: null, weapons: new Map() };

  const configured = CFG.bungieApiKey && CFG.bungieClientId &&
    !/PASTE/.test(CFG.bungieApiKey + CFG.bungieClientId);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function status(html) { $('#xur-msg').hidden = false; $('#xur').hidden = true; $('#xur-status').innerHTML = html; }

  // ---------- Sign-in (shared with the inventory page) ----------

  function getToken() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
      return t && t.expiresAt > Date.now() + 60_000 ? t : null;
    } catch { return null; }
  }

  function signIn() {
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      sessionStorage.setItem(STATE_KEY, st);
      sessionStorage.setItem(RETURN_KEY, 'xur.html');
    } catch {}
    location.href = `${BUNGIE}/en/OAuth/Authorize?client_id=${encodeURIComponent(CFG.bungieClientId)}` +
      `&response_type=code&state=${st}`;
  }

  async function api(path) {
    const t = getToken();
    if (!t) return null;
    const res = await fetch(`${BUNGIE}/Platform${path}`, {
      headers: { 'X-API-Key': CFG.bungieApiKey, Authorization: `Bearer ${t.accessToken}` },
    });
    const j = await res.json().catch(() => null);
    if (res.status === 401 || j?.ErrorCode === 99 || j?.ErrorCode === 2111) {
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      return null;
    }
    if (!j || j.ErrorCode !== 1) throw new Error(j?.Message || `Bungie API error ${res.status}`);
    return j.Response;
  }

  // ---------- Finding Xûr's stock ----------

  // Signed in: read Xûr's inventory as your character sees it, rolls included
  async function fromAccount() {
    const mem = await api('/User/GetMembershipsForCurrentUser/');
    if (!mem) return null;
    const list = mem.destinyMemberships || [];
    const m = list.find(x => x.membershipId === mem.primaryMembershipId) || list[0];
    if (!m) return null;
    const prof = await api(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=200`);
    const chars = Object.values(prof?.characters?.data || {})
      .sort((a, b) => new Date(b.dateLastPlayed) - new Date(a.dateLastPlayed));
    if (!chars.length) return null;
    const v = await api(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Character/${chars[0].characterId}/Vendors/?components=400,402,305,310&filter=0`);
    if (!v) return null;
    state.raw = v;

    const items = [];
    let present = false;
    const base = `/Destiny2/${m.membershipType}/Profile/${m.membershipId}/Character/${chars[0].characterId}/Vendors`;
    state.single = {};
    for (const vh of state.lookup.xurVendors || []) {
      if (v.vendors?.data?.[vh]) present = true;
      let saleItems = v.sales?.data?.[vh]?.saleItems || {};
      let comps = v.itemComponents?.[vh] || {};
      // The all-vendors request leaves out weapon perks, so ask for this vendor on its own,
      // the way the Destiny app does
      if (Object.keys(saleItems).length) {
        const one = await api(`${base}/${vh}/?components=400,402,305,310`).catch(() => null);
        if (one) {
          state.single[vh] = one;
          saleItems = one.sales?.data || saleItems;
          comps = one.itemComponents || comps;
        }
      }
      for (const [idx, sale] of Object.entries(saleItems)) {
        const entry = state.lookup.items[sale.itemHash];
        if (!entry) continue;
        const live = comps.sockets?.data?.[idx]?.sockets || [];
        const reusable = comps.reusablePlugs?.data?.[idx]?.plugs || {};
        const perks = entry[1].map(si => {
          const hs = new Set((reusable[si] || []).map(p => p.plugItemHash));
          if (live[si]?.plugHash) hs.add(live[si].plugHash);
          return [...hs];
        });
        items.push({ id: entry[0], hash: sale.itemHash, perks });
      }
    }
    return { present, items, source: 'account' };
  }

  // Not signed in: the list the daily update saved from Bungie's public data
  async function fromPublic() {
    const res = await fetch('data/xur.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const x = await res.json();
    // Xûr leaves at the weekly reset; a list saved before then is out of date
    if (Date.now() - new Date(x.fetched) > 8 * 24 * 3600 * 1000) return { present: false, items: [] };
    return { present: x.present, items: x.items || [], source: 'public', fetched: x.fetched };
  }

  async function loadWeapons(ids) {
    await Promise.all([...ids].map(async id => {
      if (state.weapons.has(id)) return;
      const res = await fetch(`data/w/${encodeURIComponent(id)}.json`).catch(() => null);
      if (res?.ok) state.weapons.set(id, RollScore.prepare(await res.json()));
    }));
  }

  // ---------- Scoring ----------

  function prepareItem(raw) {
    const ctx = state.weapons.get(raw.id);
    if (!ctx) return null;
    const options = ctx.w.columns.map((_, ci) => {
      const idx = new Set();
      for (const h of raw.perks?.[ci] || []) {
        const i = ctx.byName[ci].get(state.lookup.perks[h]);
        if (i !== undefined) idx.add(i);
      }
      return [...idx];
    });
    return { ...raw, ctx, options, known: options.some(o => o.length), scores: {} };
  }

  // Rolls aren't known (Xûr's copy rolls when you buy it): show what to hope for instead
  function chaseHtml(item) {
    const s = item.ctx.stats(state.mode);
    if (!s.rolls.length) return '<div class="inv-sub muted">No recommended rolls for this gun yet.</div>';
    const traits = item.ctx.w.columns.map((c, ci) => (c.weight >= 3 ? ci : -1)).filter(ci => ci >= 0);
    const tally = new Map();
    s.rolls.forEach((roll, k) => {
      const ps = roll.filter(p => traits.includes(item.ctx.colOf[p]));
      if (ps.length < 2) return;
      const key = ps.slice(0, 2).join('.');
      tally.set(key, (tally.get(key) || 0) + s.weights[k]);
    });
    const top = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (!top) return '';
    const names = top[0].split('.').map(p => esc(item.ctx.perk(Number(p)).name)).join(' + ');
    return `<div class="inv-sub muted">Look for <strong class="chase">${names}</strong>.</div>`;
  }

  function scoreFor(item) {
    if (!item.known) return null;
    return (item.scores[state.mode] ||= RollScore.best(item.ctx, state.mode, item.options));
  }

  // ---------- Rendering ----------

  function render() {
    document.querySelectorAll('.modes button').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    const rows = [...state.items].sort((a, b) =>
      ((scoreFor(b)?.total ?? -1) - (scoreFor(a)?.total ?? -1)) || a.ctx.w.name.localeCompare(b.ctx.w.name));
    $('#xur-list').innerHTML = rows.map(rowHtml).join('');
  }

  function rowHtml(item) {
    const w = item.ctx.w;
    const s = scoreFor(item);
    let perks = '';
    if (s) {
      perks = s.picks.map((p, ci) => {
        if (p === null) return '';
        const others = item.options[ci].filter(o => o !== p).map(o => item.ctx.perk(o).name);
        return others.length
          ? `<li class="multi"><strong>${esc(item.ctx.perk(p).name)}</strong> <span class="alt">/ ${others.map(esc).join(' / ')}</span></li>`
          : `<li>${esc(item.ctx.perk(p).name)}</li>`;
      }).join('');
    }
    const badges = [];
    if (w.craftable) badges.push('<span class="badge craft" title="Has a crafting pattern. Once unlocked, you can craft exactly the roll you want.">Craftable</span>');
    if (w.estimated) badges.push('<span class="badge">Estimated</span>');

    let scoreHtml;
    if (!s) {
      const label = state.source === 'account' ? 'Roll unknown' : configured ? 'Sign in' : 'Roll hidden';
      scoreHtml = `<div class="inv-score"><span class="num">?</span><span class="grade">${label}</span></div>`;
    } else if (s.total === null) {
      scoreHtml = '<div class="inv-score"><span class="num">–</span><span class="grade">No data</span></div>';
    } else {
      const [label, color] = RollScore.grade(s.total);
      scoreHtml = `<div class="inv-score" style="--grade:${color}"><span class="num">${s.total}</span><span class="grade">${label}</span></div>`;
    }

    let link = `./#/${encodeURIComponent(w.id)}/${state.mode}/`;
    if (s) {
      link += s.picks.map(p => (p === null ? '_' : p)).join('-') + '/' +
        item.options.map(o => (o.length ? o.join('.') : '_')).join('-');
    }
    return `<li class="inv-row">
      <a href="${link}" target="_blank" rel="noopener" aria-label="Open ${esc(w.name)} on the Score a roll page">
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" width="56" height="56" loading="lazy">
        <div class="inv-main">
          <div class="inv-name">${esc(w.name)} ${badges.join('')}</div>
          <div class="inv-sub muted">${esc(w.type)}</div>
          ${perks ? `<ul class="inv-perks">${perks}</ul>`
            : state.source === 'account' ? chaseHtml(item)
            : '<div class="inv-sub muted">Exact perks show when you sign in.</div>'}
        </div>
        ${scoreHtml}
      </a>
    </li>`;
  }

  // Xûr is around from the Friday reset (17:00 UTC) to the Tuesday reset
  function xurHereNow() {
    const now = new Date();
    const fri = new Date(now);
    fri.setUTCHours(17, 0, 0, 0);
    fri.setUTCDate(fri.getUTCDate() - ((fri.getUTCDay() - 5 + 7) % 7)); // most recent Friday
    if (fri > now) fri.setUTCDate(fri.getUTCDate() - 7);
    return now - fri < 4 * 24 * 3600 * 1000;
  }

  // Xûr arrives at the Friday reset (17:00 UTC) and leaves at the Tuesday reset
  function nextArrival() {
    const d = new Date();
    d.setUTCHours(17, 0, 0, 0);
    while (d.getUTCDay() !== 5 || d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
    return d.toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  }

  // ---------- Start ----------

  async function start() {
    const tip = $('#tip');
    if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;
    try {
      const lr = await fetch('data/lookup.json', { cache: 'no-cache' });
      if (!lr.ok) throw new Error('Weapon data is missing. Run the "Update roll data" workflow.');
      state.lookup = await lr.json();

      let stock = null;
      if (configured && getToken()) {
        status('Checking Xûr\'s inventory on your account…');
        stock = await fromAccount().catch(() => null);
      }
      stock ||= await fromPublic();

      if ((!stock || !stock.items.length) && xurHereNow()) {
        status(configured
          ? 'Xûr is here this weekend. <button class="primary" id="xur-signin2">Sign in to see his weapons and rolls</button>'
          : 'Xûr is here this weekend, but his list isn\'t available yet. Check back after the next daily update.');
        $('#xur-signin2')?.addEventListener('click', signIn);
        return;
      }
      if (!stock || (!stock.present && !stock.items.length)) {
        status(`Xûr isn't here right now. He arrives at the weekly reset, ${esc(nextArrival())} your time, and stays until Tuesday's reset.`);
        return;
      }
      if (!stock.items.length) {
        status('Xûr is here, but he isn\'t selling any random-roll weapons this week.');
        return;
      }

      await loadWeapons(new Set(stock.items.map(i => i.id)));
      state.items = stock.items.map(prepareItem).filter(Boolean);
      state.source = stock.source;
      const anyHidden = state.items.some(i => !i.known);

      const count = `${state.items.length} weapon${state.items.length === 1 ? '' : 's'}`;
      $('#xur-sub').textContent = stock.source === 'account'
        ? (anyHidden
          ? `${count}. Bungie didn't send the perks for ${state.items.every(i => !i.known) ? 'these' : 'some of these'}, so each one shows the perks to look for. Check the roll in-game before buying.`
          : '')
        : `${count}.${anyHidden ? ' Bungie only shares the exact rolls with signed-in players.' : ''}`;
      $('#xur-signin').hidden = !(configured && stock.source !== 'account' && anyHidden);
      $('#xur-msg').hidden = true;
      $('#xur').hidden = false;
      render();
      if (/[?&]debug=1/.test(location.search)) showDebug();
    } catch (err) {
      status(esc(err.message || err));
    }
  }

  // xur.html?debug=1 shows what Bungie returned, to copy and share when something looks off
  function showDebug() {
    const v = state.raw;
    const out = { source: state.source, xurVendors: state.lookup.xurVendors, vendors: {} };
    for (const vh of state.lookup.xurVendors || []) {
      const one = state.single?.[vh];
      const sales = one?.sales?.data || v?.sales?.data?.[vh]?.saleItems || {};
      const comps = one?.itemComponents || v?.itemComponents?.[vh] || {};
      out.vendors[vh] = {
        present: !!v?.vendors?.data?.[vh],
        askedSingly: !!one,
        sales: Object.entries(sales).slice(0, 4).map(([i, s]) => ({ i, itemHash: s.itemHash, weapon: state.lookup.items[s.itemHash]?.[0] })),
        componentKeys: Object.keys(comps),
        sockets: Object.fromEntries(Object.entries(comps.sockets?.data || {}).slice(0, 3)),
        reusablePlugs: Object.fromEntries(Object.entries(comps.reusablePlugs?.data || {}).slice(0, 2)),
      };
    }
    const pre = document.createElement('pre');
    pre.className = 'debug';
    pre.textContent = JSON.stringify(out, null, 1);
    $('#xur').append(pre);
  }

  $('#xur-signin').addEventListener('click', signIn);
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    render();
  }));

  start();
})();
