(() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const STATE_KEY = 'rs-oauth-state';
  const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock'];
  const CRAFTED = 8; // ItemState flag
  const $ = s => document.querySelector(s);

  const state = {
    mode: 'all',
    lookup: null,
    weapons: new Map(), // weapon id -> RollScore context
    items: [],          // owned weapons
    who: '',
  };

  const configured = CFG.bungieApiKey && CFG.bungieClientId &&
    !/PASTE/.test(CFG.bungieApiKey + CFG.bungieClientId);

  function show(id) {
    ['signed-out', 'setup', 'loading', 'inv'].forEach(x => { $('#' + x).hidden = x !== id; });
  }
  function loading(msg) { show('loading'); $('#load-msg').textContent = msg; }

  // ---------- Sign in (Bungie OAuth, public client) ----------

  let memToken = null; // used if the browser blocks storage
  let justSignedIn = false;

  function getToken() {
    let t = memToken;
    try { t = JSON.parse(localStorage.getItem(TOKEN_KEY)) || memToken; } catch {}
    return t && t.expiresAt > Date.now() + 60_000 ? t : null;
  }
  function clearToken() { memToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch {} }

  function signIn() {
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem(STATE_KEY, st); } catch {}
    location.href = `${BUNGIE}/en/OAuth/Authorize?client_id=${encodeURIComponent(CFG.bungieClientId)}` +
      `&response_type=code&state=${st}`;
  }

  // Bungie sends people back here with ?code=...&state=...
  async function finishSignIn() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    let expected = null;
    try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch {}
    if (params.get('error')) throw new Error(`Bungie sign-in was cancelled or failed (${params.get('error')}).`);
    if (!expected || params.get('state') !== expected) {
      throw new Error('Sign-in check failed. Make sure you start sign-in from this page, in the same browser tab.');
    }

    loading('Finishing sign-in…');
    const res = await fetch(`${BUNGIE}/Platform/App/OAuth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-API-Key': CFG.bungieApiKey },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CFG.bungieClientId }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      throw new Error(`Bungie didn't accept the sign-in (${j.error_description || j.error || res.status}).`);
    }
    memToken = {
      accessToken: j.access_token,
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(memToken)); } catch {}
    justSignedIn = true;
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
      const why = j ? `${j.ErrorStatus || ''} ${j.Message || ''}`.trim() : `HTTP ${res.status}`;
      throw new AuthError(`Bungie rejected the login: ${why}`);
    }
    if (!j || j.ErrorCode !== 1) throw new Error(j?.Message || `Bungie API error ${res.status}`);
    return j.Response;
  }

  // ---------- Data ----------

  async function loadLookup() {
    if (state.lookup) return;
    const res = await fetch('data/lookup.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Weapon lookup data is missing. Run the "Update roll data" workflow.');
    state.lookup = await res.json();
  }

  async function loadWeapons(ids) {
    const todo = [...ids].filter(id => !state.weapons.has(id));
    let done = 0;
    const worker = async () => {
      while (todo.length) {
        const id = todo.pop();
        try {
          const res = await fetch(`data/w/${encodeURIComponent(id)}.json`);
          if (res.ok) state.weapons.set(id, RollScore.prepare(await res.json()));
        } catch {}
        done++;
        $('#load-msg').textContent = `Loading weapon data… ${done} of ${ids.size}`;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  async function loadInventory() {
    loading('Loading your account…');
    await loadLookup();
    const mem = await api('/User/GetMembershipsForCurrentUser/');
    const list = mem.destinyMemberships || [];
    const m = list.find(x => x.membershipId === mem.primaryMembershipId) || list[0];
    if (!m) throw new Error('No Destiny 2 account found on this Bungie login.');
    state.who = m.bungieGlobalDisplayName
      ? `${m.bungieGlobalDisplayName}#${String(m.bungieGlobalDisplayNameCode).padStart(4, '0')}`
      : m.displayName;

    loading('Loading your inventory…');
    const p = await api(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=102,200,201,205,300,305,310`);

    const raw = [];
    for (const it of p.profileInventory?.data?.items || []) raw.push({ it, where: 'Vault', equipped: false });
    const chars = p.characters?.data || {};
    for (const [cid, c] of Object.entries(chars)) {
      const cls = CLASS_NAMES[c.classType] || 'Character';
      for (const it of p.characterInventories?.data?.[cid]?.items || []) raw.push({ it, where: cls, equipped: false });
      for (const it of p.characterEquipment?.data?.[cid]?.items || []) raw.push({ it, where: cls, equipped: true });
    }
    if (!p.itemComponents?.sockets?.data) {
      throw new Error('Bungie didn\'t return perk data. Check that the app has the "Read your Destiny 2 information" scope.');
    }

    const owned = raw.filter(r => r.it.itemInstanceId && state.lookup.items[r.it.itemHash]);
    const ids = new Set(owned.map(r => state.lookup.items[r.it.itemHash][0]));
    loading(`Loading weapon data… 0 of ${ids.size}`);
    await loadWeapons(ids);

    state.items = owned.map(r => readItem(r, p)).filter(Boolean);
    loading('Scoring…');
    await scoreAll();
    buildTypeFilter();
    show('inv');
    render();
  }

  // Turn one inventory item into perk options per column
  function readItem({ it, where, equipped }, p) {
    const [id, sockets] = state.lookup.items[it.itemHash];
    const ctx = state.weapons.get(id);
    if (!ctx) return null;
    const iid = it.itemInstanceId;
    const live = p.itemComponents.sockets.data[iid]?.sockets || [];
    const reusable = p.itemComponents.reusablePlugs?.data?.[iid]?.plugs || {};
    const crafted = (it.state & CRAFTED) !== 0;

    const options = ctx.w.columns.map((col, ci) => {
      const si = sockets[ci];
      if (si === undefined) return [];
      let hashes = [];
      // Crafted guns can swap to any unlocked perk, so only the one slotted counts
      if (!crafted) hashes = (reusable[si] || []).filter(x => x.canInsert !== false && x.enabled !== false).map(x => x.plugItemHash);
      if (live[si]?.plugHash) hashes.push(live[si].plugHash);
      const idx = new Set();
      for (const h of hashes) {
        const i = ctx.byName[ci].get(state.lookup.perks[h]);
        if (i !== undefined) idx.add(i);
      }
      return [...idx];
    });
    return { iid, id, ctx, where, equipped, crafted, options, scores: {} };
  }

  // Try every combination of the perks the gun actually has; keep the best
  function bestSetup(item, mode) {
    const cols = item.options.map(o => (o.length ? o : [null]));
    let combos = [[]];
    for (const opts of cols) {
      combos = combos.flatMap(c => opts.map(o => [...c, o]));
      if (combos.length > 64) combos = combos.slice(0, 64);
    }
    let best = null;
    for (const picks of combos) {
      const r = RollScore.score(item.ctx, mode, picks);
      if (r && (!best || r.total > best.total)) best = { ...r, picks };
    }
    return best || { total: null, picks: combos[0] };
  }

  const scoreCache = new Map();
  async function scoreAll() {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      if (item.scores[state.mode] === undefined) {
        const key = `${item.id}|${state.mode}|${item.options.map(o => o.join('.')).join('/')}`;
        if (!scoreCache.has(key)) scoreCache.set(key, bestSetup(item, state.mode));
        item.scores[state.mode] = scoreCache.get(key);
      }
      if (i % 40 === 39) await new Promise(r => setTimeout(r)); // keep the page responsive
    }
    // Best copy of each weapon
    const bestById = new Map();
    for (const item of state.items) {
      const t = item.scores[state.mode].total ?? -1;
      bestById.set(item.id, Math.max(bestById.get(item.id) ?? -1, t));
    }
    const counts = new Map();
    state.items.forEach(x => counts.set(x.id, (counts.get(x.id) || 0) + 1));
    for (const item of state.items) {
      item.copies = counts.get(item.id);
      item.bestOther = bestById.get(item.id);
    }
  }

  // ---------- Rendering ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildTypeFilter() {
    const sel = $('#f-type');
    const cur = sel.value;
    const types = [...new Set(state.items.map(x => x.ctx.w.type))].sort();
    sel.innerHTML = '<option value="">All types</option>' +
      types.map(t => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  }

  function isShard(item) {
    const s = item.scores[state.mode];
    if (s.total === null) return false;
    return s.total < 35 || (item.copies > 1 && s.total < item.bestOther);
  }

  function render() {
    $('#who').textContent = `Signed in as ${state.who}`;
    document.querySelectorAll('.modes button').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));

    const term = $('#f-name').value.trim().toLowerCase();
    const type = $('#f-type').value;
    const dupes = $('#f-dupes').checked;
    const shard = $('#f-shard').checked;
    const sort = $('#f-sort').value;

    let rows = state.items.filter(x =>
      (!term || x.ctx.w.name.toLowerCase().includes(term)) &&
      (!type || x.ctx.w.type === type) &&
      (!dupes || x.copies > 1) &&
      (!shard || isShard(x)));

    const sc = x => x.scores[state.mode].total;
    const byName = (a, b) => a.ctx.w.name.localeCompare(b.ctx.w.name) || (sc(b) ?? -1) - (sc(a) ?? -1);
    rows.sort({
      'score-desc': (a, b) => (sc(b) ?? -1) - (sc(a) ?? -1) || byName(a, b),
      'score-asc': (a, b) => (sc(a) ?? 999) - (sc(b) ?? 999) || byName(a, b),
      name: byName,
      type: (a, b) => a.ctx.w.type.localeCompare(b.ctx.w.type) || byName(a, b),
    }[sort]);

    const shardCount = state.items.filter(isShard).length;
    $('#summary').textContent = `Showing ${rows.length} of ${state.items.length} weapons · ${shardCount} shard candidate${shardCount === 1 ? '' : 's'}`;

    $('#list').innerHTML = rows.map(rowHtml).join('') ||
      '<li class="inv-empty">No weapons match these filters.</li>';
  }

  function rowHtml(item) {
    const w = item.ctx.w;
    const s = item.scores[state.mode];
    const perks = s.picks.map((p, ci) => {
      if (p === null) return '';
      const extra = item.options[ci].length > 1 ? ' <span class="alt">+' + (item.options[ci].length - 1) + '</span>' : '';
      return `<li>${esc(item.ctx.perk(p).name)}${extra}</li>`;
    }).join('');

    const badges = [];
    if (item.copies > 1 && s.total !== null) {
      badges.push(s.total !== null && s.total >= item.bestOther
        ? `<span class="badge good">Best of ${item.copies} copies</span>`
        : `<span class="badge">Weaker copy (best is ${item.bestOther})</span>`);
    }
    if (w.estimated) badges.push('<span class="badge">Estimated</span>');
    if (item.crafted) badges.push('<span class="badge">Crafted</span>');

    let scoreHtml;
    if (s.total === null) {
      scoreHtml = '<div class="inv-score"><span class="num">–</span><span class="grade">No data</span></div>';
    } else {
      const [label, color] = RollScore.grade(s.total);
      scoreHtml = `<div class="inv-score" style="--grade:${color}"><span class="num">${s.total}</span><span class="grade">${label}</span></div>`;
    }
    const link = `./#/${encodeURIComponent(w.id)}/${state.mode}/${s.picks.map(p => (p === null ? '_' : p)).join('-')}`;

    return `<li class="inv-row">
      <a href="${link}" target="_blank" rel="noopener" aria-label="Open ${esc(w.name)} in the roll scorer">
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" width="56" height="56" loading="lazy">
        <div class="inv-main">
          <div class="inv-name">${esc(w.name)} ${badges.join('')}</div>
          <div class="inv-sub muted">${esc(w.type)} · ${esc(item.where)}${item.equipped ? ' · Equipped' : ''}</div>
          <ul class="inv-perks">${perks}</ul>
        </div>
        ${scoreHtml}
      </a>
    </li>`;
  }

  // ---------- Wiring ----------

  async function start() {
    const tip = $('#tip');
    if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;
    fetch('data/meta.json').then(r => r.json()).then(m => {
      $('#meta').textContent = `Data updated ${new Date(m.builtAt).toLocaleDateString()} · ${m.wishlistRolls.toLocaleString()} community rolls`;
    }).catch(() => {});

    if (!configured) { show('setup'); return; }
    try {
      await finishSignIn();
      if (!getToken()) { show('signed-out'); return; }
      await loadInventory();
    } catch (err) {
      showError(err);
    }
  }

  function showError(err) {
    // Right after signing in, a rejected login is a setup problem, so show the details
    if (err instanceof AuthError && justSignedIn) {
      justSignedIn = false;
      show('loading');
      $('#load-msg').innerHTML = `${esc(err.message)}<br><br>This usually means the API key in <code>config.js</code> ` +
        `comes from a different Bungie app than the client ID. Both must come from the same app. ` +
        `<button class="ghost" id="retry">Back to sign in</button>`;
      $('#retry').addEventListener('click', () => show('signed-out'));
      return;
    }
    if (err instanceof AuthError) {
      show('signed-out');
      if (err.message !== 'Signed out') $('#signed-out h2').textContent = 'Your login expired. Sign in again';
      return;
    }
    show('loading');
    $('#load-msg').innerHTML = `${esc(err.message || err)} <button class="ghost" id="retry">Try again</button>`;
    $('#retry').addEventListener('click', () => start());
  }

  $('#signin').addEventListener('click', signIn);
  $('#signout').addEventListener('click', () => { clearToken(); state.items = []; show('signed-out'); });
  $('#refresh').addEventListener('click', () => loadInventory().catch(showError));
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', async () => {
    state.mode = b.dataset.mode;
    await scoreAll();
    render();
  }));
  ['#f-name', '#f-type', '#f-sort', '#f-dupes', '#f-shard'].forEach(sel =>
    $(sel).addEventListener(sel === '#f-name' ? 'input' : 'change', render));

  start();
})();
