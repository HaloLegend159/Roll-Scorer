(() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const STATE_KEY = 'rs-oauth-state';
  const CLASS_NAMES = ['Titan', 'Hunter', 'Warlock'];
  const CRAFTED = 8; // ItemState flag
  const POSTMASTER = 215593132; // "Lost Items" bucket
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
  function loading(msg) {
    show('loading');
    $('#loading').classList.remove('failed');
    $('#load-msg').textContent = msg;
  }
  // Fill the loading bar by real progress (0 to 1)
  function progress(p) {
    const i = $('#loading .loader-bar i');
    if (i) { i.style.animation = 'none'; i.style.width = `${Math.round(Math.min(1, p) * 100)}%`; }
  }

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

    loading('Signing in…');
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
    // Signed in from another page (e.g. Xûr): send them back there
    let back = null;
    try { back = sessionStorage.getItem('rs-return'); sessionStorage.removeItem('rs-return'); } catch {}
    if (back && /^[\w-]+\.html$/.test(back)) { location.replace(back); await new Promise(() => {}); }
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
        $('#load-msg').textContent = `Decrypting weapons… ${done} of ${ids.size}`;
        progress(done / ids.size);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  async function loadInventory() {
    loading('Contacting the Tower…');
    await loadLookup();
    const mem = await api('/User/GetMembershipsForCurrentUser/');
    const list = mem.destinyMemberships || [];
    const m = list.find(x => x.membershipId === mem.primaryMembershipId) || list[0];
    if (!m) throw new Error('No Destiny 2 account found on this Bungie login.');
    state.who = m.bungieGlobalDisplayName
      ? `${m.bungieGlobalDisplayName}#${String(m.bungieGlobalDisplayNameCode).padStart(4, '0')}`
      : m.displayName;

    loading('Opening your vault…');
    const p = await api(`/Destiny2/${m.membershipType}/Profile/${m.membershipId}/?components=102,200,201,205,300,305,309,310`);

    const raw = [];
    const chars = p.characters?.data || {};
    state.mt = m.membershipType;
    // Vault items are changed through the most recently played character
    state.mainChar = Object.entries(chars)
      .sort((a, b) => new Date(b[1].dateLastPlayed || 0) - new Date(a[1].dateLastPlayed || 0))[0]?.[0] || null;
    for (const it of p.profileInventory?.data?.items || []) raw.push({ it, where: 'Vault', equipped: false, cid: state.mainChar });
    for (const [cid, c] of Object.entries(chars)) {
      const cls = CLASS_NAMES[c.classType] || 'Character';
      for (const it of p.characterInventories?.data?.[cid]?.items || []) {
        raw.push({ it, where: cls, equipped: false, postmaster: it.bucketHash === POSTMASTER, cid });
      }
      for (const it of p.characterEquipment?.data?.[cid]?.items || []) raw.push({ it, where: cls, equipped: true, cid });
    }
    if (!p.itemComponents?.sockets?.data) {
      throw new Error('Bungie didn\'t return perk data. Check that the app has the "Read your Destiny 2 information" scope.');
    }

    const owned = raw.filter(r => r.it.itemInstanceId && state.lookup.items[r.it.itemHash]);
    const ids = new Set(owned.map(r => state.lookup.items[r.it.itemHash][0]));
    loading(`Decrypting weapons… 0 of ${ids.size}`);
    await loadWeapons(ids);

    state.items = owned.map(r => readItem(r, p)).filter(Boolean);
    // Let the Score a roll page apply perks for weapons opened from here
    RollApply.saveAll(Object.fromEntries(state.items.filter(x => x.applyInfo).map(x => [x.iid, x.applyInfo])));
    loading('Checking your rolls…');
    await scoreAll();
    buildTypeFilter();
    show('inv');
    render();
  }

  // Turn one inventory item into perk options per column
  function readItem({ it, where, equipped, postmaster, cid }, p) {
    const [id, sockets] = state.lookup.items[it.itemHash];
    const ctx = state.weapons.get(id);
    if (!ctx) return null;
    const iid = it.itemInstanceId;
    const live = p.itemComponents.sockets.data[iid]?.sockets || [];
    const reusable = p.itemComponents.reusablePlugs?.data?.[iid]?.plugs || {};
    const crafted = (it.state & CRAFTED) !== 0;
    const toIdx = (ci, h) => ctx.byName[ci].get(state.lookup.perks[h]);

    // slotted: the perk in each column right now. options: every perk this copy can switch to
    // (both perks of a two-perk column, or every unlocked perk on a crafted gun).
    const slotted = [];
    const plugs = {}; // perk index -> [socket, exact plug id on this copy], for switching perks in game
    const options = ctx.w.columns.map((col, ci) => {
      const si = sockets[ci];
      slotted.push(si === undefined || !live[si]?.plugHash ? null : toIdx(ci, live[si].plugHash) ?? null);
      if (si === undefined) return [];
      const hashes = (reusable[si] || []).filter(x => x.canInsert !== false && x.enabled !== false).map(x => x.plugItemHash);
      if (live[si]?.plugHash) hashes.push(live[si].plugHash);
      const idx = new Set();
      for (const h of hashes) {
        const i = toIdx(ci, h);
        if (i === undefined) continue;
        idx.add(i);
        if (!plugs[i] || h === live[si]?.plugHash) plugs[i] = [si, h];
      }
      return [...idx];
    });
    // Perks can be switched through the API on normal drops with a choice in some column.
    // Crafted guns are reshaped at the Enclave instead, and Postmaster items must be picked up first.
    // Kills on this copy, read from its kill tracker (the plug slotted on the gun that carries one counter).
    // Guns with no tracker switched on have no count.
    let kills = null;
    const perPlug = p.itemComponents.plugObjectives?.data?.[iid]?.objectivesPerPlug || {};
    for (const s of live) {
      const obj = s.plugHash ? perPlug[s.plugHash] : null;
      if (obj && obj.length === 1 && Number.isFinite(obj[0].progress)) kills = Math.max(kills ?? 0, obj[0].progress);
    }
    const canApply = !crafted && !postmaster && cid && options.some(o => o.length > 1);
    const applyInfo = canApply ? { mt: state.mt, ch: cid, plugs, slotted: [...slotted] } : null;
    // Item IDs count upward as items are created, so a bigger ID means acquired more recently
    let order = 0n;
    try { order = BigInt(iid); } catch {}
    return { iid, id, ctx, where, equipped, crafted, options, slotted, scores: {}, postmaster: !!postmaster, order, applyInfo, kills };
  }

  // Best possible score from this copy's perks, plus the score of what's slotted now
  function bestSetup(item, mode) {
    const best = RollScore.best(item.ctx, mode, item.options, item.slotted);
    const multi = item.options.some(o => o.length > 1);
    const now = multi && item.slotted.some(p => p !== null) ? RollScore.score(item.ctx, mode, item.slotted) : null;
    best.now = now && now.total < (best.total ?? -1) ? now.total : null;
    return best;
  }

  const scoreCache = new Map();
  async function scoreAll() {
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      if (item.scores[state.mode] === undefined) {
        const key = `${item.id}|${state.mode}|${item.options.map(o => o.join('.')).join('/')}|${item.slotted.join('.')}`;
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
    const post = $('#f-post').checked;
    const favOnly = $('#f-fav').checked;
    const favs = new Set(RollFavs.list());
    $('#f-fav-label').textContent = `Favorites only (${state.items.filter(x => favs.has(x.id)).length})`;
    const postCount = state.items.filter(x => x.postmaster).length;
    $('#f-post-label').textContent = `Postmaster only (${postCount})`;

    let rows = state.items.filter(x =>
      (!term || x.ctx.w.name.toLowerCase().includes(term)) &&
      (!type || x.ctx.w.type === type) &&
      (!dupes || x.copies > 1) &&
      (!post || x.postmaster) &&
      (!favOnly || favs.has(x.id)) &&
      (!shard || isShard(x)));

    const sc = x => x.scores[state.mode].total;
    const byName = (a, b) => a.ctx.w.name.localeCompare(b.ctx.w.name) || (sc(b) ?? -1) - (sc(a) ?? -1);
    rows.sort({
      'score-desc': (a, b) => (sc(b) ?? -1) - (sc(a) ?? -1) || byName(a, b),
      'score-asc': (a, b) => (sc(a) ?? 999) - (sc(b) ?? 999) || byName(a, b),
      newest: (a, b) => (a.order === b.order ? 0 : a.order > b.order ? -1 : 1),
      oldest: (a, b) => (a.order === b.order ? 0 : a.order < b.order ? -1 : 1),
      kills: (a, b) => (b.kills ?? -1) - (a.kills ?? -1) || byName(a, b),
      name: byName,
      type: (a, b) => a.ctx.w.type.localeCompare(b.ctx.w.type) || byName(a, b),
    }[sort]);

    const shardCount = state.items.filter(isShard).length;
    const hasMulti = rows.some(x => x.options.some(o => o.length > 1));
    $('#summary').textContent = `Showing ${rows.length} of ${state.items.length} weapons · ${shardCount} shard candidate${shardCount === 1 ? '' : 's'}` +
      (hasMulti ? ' · Scores are the best each gun can reach with its own perks; bold perks are the ones to use' : '');

    $('#list').innerHTML = rows.map(rowHtml).join('') ||
      '<li class="inv-empty">No weapons match these filters.</li>';
  }

  function rowHtml(item) {
    const w = item.ctx.w;
    const s = item.scores[state.mode];
    // The best perk first; any other perks in the same column after a slash
    const perks = s.picks.map((p, ci) => {
      if (p === null) return '';
      const name = item.ctx.perk(p).name;
      const others = item.options[ci].filter(o => o !== p).map(o => item.ctx.perk(o).name);
      if (!others.length) return `<li>${esc(name)}</li>`;
      const shown = others.length > 3 ? [...others.slice(0, 3), `${others.length - 3} more`] : others;
      return `<li class="multi" title="Best pick: ${esc(name)}. This column also has ${esc(others.join(', '))}.">` +
        `<strong>${esc(name)}</strong> <span class="alt">/ ${shown.map(esc).join(' / ')}</span></li>`;
    }).join('');

    // Slotted perks score lower than the best setup: say what to swap
    let swapHtml = '';
    if (s.now !== null && s.now !== undefined) {
      const swaps = s.picks.map((p, ci) => {
        const cur = item.slotted[ci];
        return p !== null && cur !== null && cur !== p ? `${item.ctx.perk(cur).name} → ${item.ctx.perk(p).name}` : null;
      }).filter(Boolean);
      const btn = RollApply.enabled && item.applyInfo && RollApply.pending(item.applyInfo, s.picks).length
        ? ` <button class="ghost apply" data-apply="${item.iid}">Apply these perks in game</button>` : '';
      swapHtml = `<div class="swap">Slotted now: ${s.now}.${swaps.length ? ` Swap ${swaps.map(esc).join(', ')} to reach ${s.total}.` : ''}${btn}</div>`;
    }

    const badges = [];
    if (item.copies > 1 && s.total !== null) {
      badges.push(s.total !== null && s.total >= item.bestOther
        ? `<span class="badge good">Best of ${item.copies} copies</span>`
        : `<span class="badge">Weaker copy (best is ${item.bestOther})</span>`);
    }
    if (item.postmaster) badges.push('<span class="badge post" title="Sitting at the Postmaster. Pick it up or it can be lost when the Postmaster fills up.">Postmaster</span>');
    if (w.estimated) badges.push('<span class="badge">Estimated</span>');
    if (item.crafted) badges.push('<span class="badge">Crafted</span>');
    if (item.kills !== null) badges.push(`<span class="badge" title="From this copy's kill tracker">${item.kills.toLocaleString()} kills</span>`);
    else if (w.craftable) badges.push('<span class="badge craft" title="Has a crafting pattern. Once unlocked, you can craft exactly the roll you want.">Craftable</span>');

    let scoreHtml;
    if (s.total === null) {
      scoreHtml = '<div class="inv-score"><span class="num">–</span><span class="grade">No data</span></div>';
    } else {
      const [label, color] = RollScore.grade(s.total);
      scoreHtml = `<div class="inv-score" style="--grade:${color}"><span class="num">${s.total}</span><span class="grade">${label}</span></div>`;
    }
    // Open with what's slotted now, plus this copy's perks for the "Your gun's perks" view
    const openPicks = item.slotted.map((p, ci) => (p !== null ? p : s.picks[ci]));
    const avail = item.options.map(o => (o.length ? o.join('.') : '_')).join('-');
    const link = `./#/${encodeURIComponent(w.id)}/${state.mode}/${openPicks.map(p => (p === null ? '_' : p)).join('-')}/${avail}` +
      (item.applyInfo ? `/${item.iid}` : '');

    return `<li class="inv-row has-star">
      ${RollFavs.button(w.id, w.name)}
      <a href="${link}" target="_blank" rel="noopener" aria-label="Open ${esc(w.name)} on the Score a roll page">
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" width="56" height="56" loading="lazy">
        <div class="inv-main">
          <div class="inv-name">${esc(w.name)} ${badges.join('')}</div>
          <div class="inv-sub muted">${esc(w.type)} · ${esc(item.where)}${item.equipped ? ' · Equipped' : ''}</div>
          <ul class="inv-perks">${perks}</ul>
        </div>
        ${scoreHtml}
      </a>
      ${swapHtml}
    </li>`;
  }

  // ---------- Wiring ----------

  async function start() {
    const tip = $('#tip');
    if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;
    fetch('data/meta.json').then(r => r.json()).then(m => {
      $('#meta').textContent = `Data updated ${new Date(m.builtAt).toLocaleDateString()} · ${m.wishlistRolls.toLocaleString()} community rolls` +
        (m.usageLoadouts ? ` · ${m.usageLoadouts.toLocaleString()} weapons seen in real matches` : '');
    }).catch(() => {});

    if (RollApply.enabled) {
      $('#access-note').textContent = 'The site reads your inventory. It can also switch a weapon between the perks it already has, ' +
        'but only when you press an Apply button. It never moves, equips or deletes anything. Your login stays in this browser ' +
        'and is never sent anywhere except Bungie. Bungie logs you out of this site after about an hour.';
    }
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
      $('#loading').classList.add('failed');
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
    $('#loading').classList.add('failed');
      $('#load-msg').innerHTML = `${esc(err.message || err)} <button class="ghost" id="retry">Try again</button>`;
    $('#retry').addEventListener('click', () => start());
  }

  RollFavs.wire(() => { if (state.items.length) render(); });

  // "Apply these perks in game" on a row
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-apply]');
    if (!b) return;
    const item = state.items.find(x => x.iid === b.dataset.apply);
    if (!item) return;
    b.disabled = true;
    b.textContent = 'Applying…';
    const res = await RollApply.apply(item.iid, item.applyInfo, item.scores[state.mode].picks);
    if (res.changed) {
      item.slotted = [...item.applyInfo.slotted];
      item.scores = {};
      await scoreAll();
    }
    render();
    const msg = $('#apply-msg');
    msg.textContent = `${item.ctx.w.name}: ${res.message}`;
    msg.className = res.ok ? 'apply-msg ok' : 'apply-msg bad';
    msg.hidden = false;
  });
  $('#signin').addEventListener('click', signIn);
  $('#signout').addEventListener('click', () => { clearToken(); state.items = []; show('signed-out'); });
  $('#refresh').addEventListener('click', () => loadInventory().catch(showError));
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', async () => {
    state.mode = b.dataset.mode;
    await scoreAll();
    render();
  }));
  ['#f-name', '#f-type', '#f-sort', '#f-dupes', '#f-shard', '#f-post', '#f-fav'].forEach(sel =>
    $(sel).addEventListener(sel === '#f-name' ? 'input' : 'change', render));

  start();
})();
