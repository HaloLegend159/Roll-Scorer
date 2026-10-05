(() => {
  const BUNGIE = 'https://www.bungie.net';
  const MAX = 3;
  const MODES = ['all', 'pve', 'pvp'];
  const $ = s => document.querySelector(s);

  const state = { index: [], byId: new Map(), mode: 'all', ids: [], weapons: new Map(), type: '' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const modeIdx = () => MODES.indexOf(state.mode);
  const modeWord = () => (state.mode === 'all' ? '' : state.mode === 'pve' ? 'PvE ' : 'PvP ');
  const plural = t => (/s$/.test(t) ? t : t + 's');

  // ---------- Address bar: compare.html#gun-a,gun-b/pve ----------

  function readHash() {
    const [ids, mode] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (MODES.includes(mode)) state.mode = mode;
    state.ids = [...new Set((ids || '').split(',').filter(id => state.byId.has(id)))].slice(0, MAX);
  }
  function writeHash() {
    history.replaceState(null, '', `#${state.ids.join(',')}/${state.mode}`);
  }

  async function loadWeapons() {
    await Promise.all(state.ids.map(async id => {
      if (state.weapons.has(id)) return;
      const res = await fetch(`data/w/${encodeURIComponent(id)}.json`).catch(() => null);
      if (res?.ok) state.weapons.set(id, RollScore.prepare(await res.json()));
    }));
  }

  function add(id) {
    if (state.ids.includes(id) || state.ids.length >= MAX) return;
    state.ids.push(id);
    update();
  }
  function remove(id) {
    state.ids = state.ids.filter(x => x !== id);
    update();
  }
  async function update() {
    writeHash();
    await loadWeapons();
    render();
  }

  // ---------- Side-by-side comparison ----------

  function topTraitPair(ctx) {
    const s = ctx.stats(state.mode);
    const traits = ctx.w.columns.map((c, ci) => (c.weight >= 3 ? ci : -1)).filter(ci => ci >= 0);
    const tally = new Map();
    s.rolls.forEach((roll, k) => {
      const ps = roll.filter(p => traits.includes(ctx.colOf[p]));
      if (ps.length < 2) return;
      const key = ps.slice(0, 2).join('.');
      tally.set(key, (tally.get(key) || 0) + s.weights[k]);
    });
    const top = [...tally].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0].split('.').map(p => ctx.perk(Number(p)).name).join(' + ') : '';
  }

  function rankText(id) {
    const r = RollScore.rank(state.index, id, modeIdx());
    const type = plural(state.byId.get(id).type);
    if (!r || r.rank === null) return `<span class="muted">Not seen enough in ${modeWord()}matches to rank</span>`;
    return `<strong>#${r.rank}</strong> of ${r.of} ${esc(type)}<br><span class="muted small">${r.share >= 10 ? r.share.toFixed(0) : r.share.toFixed(1)}% of ${esc(type)} seen (${r.n} copies)</span>`;
  }

  function renderCompare() {
    const el = $('#cmp-table');
    const guns = state.ids.map(id => state.weapons.get(id)).filter(Boolean);
    if (!guns.length) {
      el.innerHTML = '<p class="muted cmp-empty">No guns picked yet. Search for one, tap a favorite, or use a Compare button in the rankings.</p>';
      return;
    }
    const info = guns.map(ctx => {
      const picks = RollScore.bestRoll(ctx, state.mode);
      return { ctx, w: ctx.w, picks, stats: RollScore.statLine(ctx, picks || []) };
    });

    const head = info.map(({ w }) => `<th scope="col">
        <div class="cmp-gun">
          <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" width="48" height="48">
          <div><a href="./#/${encodeURIComponent(w.id)}/${state.mode}/">${esc(w.name)}</a> ${RollFavs.button(w.id, w.name)}
            <br><button class="linkish" data-remove="${w.id}">Remove</button></div>
        </div></th>`).join('');
    const row = (label, cells, cls = '') => `<tr class="${cls}"><th scope="row">${label}</th>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;

    const rows = [];
    rows.push(row('Type', info.map(({ w }) => esc([w.type, w.frame].filter(Boolean).join(' · ')))));
    rows.push(row('Gun rank by usage', info.map(({ w }) => rankText(w.id))));
    rows.push(row(`Top ${modeWord()}trait pair`, info.map(({ ctx }) => esc(topTraitPair(ctx)) || '<span class="muted">No recommended rolls</span>')));
    rows.push(row('Best roll', info.map(({ ctx, picks }) => (picks
      ? picks.filter(p => p !== null).map(p => esc(ctx.perk(p).name)).join(', ')
      : '<span class="muted">No recommended rolls</span>'))));

    // Stats at the best roll, lined up by name
    const names = [];
    info.forEach(g => g.stats.forEach(s => { if (!names.includes(s.name)) names.push(s.name); }));
    if (names.length) rows.push(`<tr class="sect"><th scope="row" colspan="${info.length + 1}">Stats at the best roll</th></tr>`);
    names.forEach(name => {
      const vals = info.map(g => g.stats.find(s => s.name === name)?.value);
      const real = vals.filter(v => v !== undefined);
      const max = Math.max(...real);
      const mark = real.length > 1 && real.some(v => v !== max);
      rows.push(row(esc(name), vals.map(v => (v === undefined ? '<span class="muted">–</span>'
        : mark && v === max ? `<strong class="hi">${v}</strong>` : String(v))), 'stat'));
    });

    rows.push(row('Craftable', info.map(({ w }) => (w.craftable ? 'Yes' : 'No'))));
    rows.push(row('Roll data', info.map(({ w, ctx }) => (w.estimated ? 'Estimated from similar guns'
      : (n => `${n.toLocaleString()} recommended ${modeWord()}roll${n === 1 ? '' : 's'}`)(ctx.stats(state.mode).rolls.length)))));
    rows.push(row('', info.map(({ w, picks }) =>
      `<a href="./#/${encodeURIComponent(w.id)}/${state.mode}/${picks ? picks.map(p => (p === null ? '_' : p)).join('-') : ''}">Open this roll in the scorer</a>`)));

    el.innerHTML = `<div class="cmp-scroll"><table class="cmp"><thead><tr><td></td>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` +
      (names.length ? '<p class="small muted">Bold marks the highest number in a row. Higher isn\'t better for every stat (charge time and draw time, for example). Stats leave out masterworks and mods.</p>' : '');
    el.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => remove(b.dataset.remove)));
  }

  function renderFavQuick() {
    const favs = RollFavs.list().map(id => state.byId.get(id)).filter(Boolean);
    const full = state.ids.length >= MAX;
    $('#fav-quick').innerHTML = favs.length
      ? `<span class="muted small">Your favorites:</span> ${favs.map(w =>
          `<button class="combo" data-add="${w.id}" ${state.ids.includes(w.id) || full ? 'disabled' : ''}>${esc(w.name)}</button>`).join('')}`
      : '<span class="muted small">Tap the ☆ next to any weapon to save it as a favorite. Favorites show up here and as a filter in My inventory.</span>';
    $('#fav-quick').querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => add(b.dataset.add)));
  }

  // ---------- Rankings ----------

  function renderRanks() {
    const mi = modeIdx();
    const n = w => (w.u ? w.u[mi] : 0);
    const favOnly = $('#r-fav').checked;
    const favs = new Set(RollFavs.list());
    const peers = state.index.filter(w => w.type === state.type);
    const total = peers.reduce((a, w) => a + n(w), 0);
    const seen = peers.filter(w => n(w) > 0).sort((a, b) => n(b) - n(a) || a.name.localeCompare(b.name));
    const unseen = peers.length - seen.length;
    const maxN = seen.length ? n(seen[0]) : 1;
    const full = state.ids.length >= MAX;

    $('#rank-note').textContent = !total ? `No ${plural(state.type)} have been seen in sampled ${modeWord()}matches yet.`
      : total < 50 ? `Only ${total} ${plural(state.type)} seen so far, so this order is rough.`
      : `Based on ${total.toLocaleString()} ${plural(state.type)} seen in sampled ${modeWord()}matches. Recent matches count more.`;

    let rank = 0, prev = null;
    const rows = seen.map((w, i) => {
      if (n(w) !== prev) { rank = i + 1; prev = n(w); }
      if (favOnly && !favs.has(w.id)) return '';
      const share = (100 * n(w)) / total;
      return `<li class="rank-row${state.ids.includes(w.id) ? ' picked' : ''}">
        <span class="rk">${rank}</span>
        ${RollFavs.button(w.id, w.name)}
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" width="40" height="40" loading="lazy">
        <span class="rname"><a href="./#/${encodeURIComponent(w.id)}/${state.mode}/">${esc(w.name)}</a>${w.c ? ' <span class="badge craft">Craftable</span>' : ''}
          <br><span class="muted small">${esc(w.f || '')}</span></span>
        <span class="rbar" title="${share.toFixed(1)}% of ${esc(plural(state.type))} seen, ${n(w)} copies"><span style="width:${Math.max(1, (100 * n(w)) / maxN)}%"></span></span>
        <span class="rval">${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%<br><span class="muted small">${n(w)} seen</span></span>
        <button class="ghost rcmp" data-add="${w.id}" ${state.ids.includes(w.id) || full ? 'disabled' : ''}>${state.ids.includes(w.id) ? 'Comparing' : 'Compare'}</button>
      </li>`;
    }).join('');
    $('#rank-list').innerHTML = (rows || (favOnly ? '<li class="muted">None of your favorites are in this list.</li>' : '')) +
      (unseen && !favOnly ? `<li class="muted small rank-tail">${unseen} more ${plural(state.type)} haven't been seen in sampled matches yet.</li>` : '');
    $('#rank-list').querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => add(b.dataset.add)));
  }

  function render() {
    document.querySelectorAll('.modes button').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
    renderFavQuick();
    renderCompare();
    renderRanks();
  }

  // ---------- Search ----------

  const q = $('#q'), list = $('#results'), box = $('.search');
  let hits = [], active = -1;
  const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '');
  function closeList() { list.hidden = true; box.setAttribute('aria-expanded', 'false'); }
  function drawList() {
    list.innerHTML = hits.length ? hits.map((w, i) =>
      `<li role="option" id="opt-${i}" aria-selected="${i === active}" data-i="${i}">
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" loading="lazy">
        <span><span class="r-name">${esc(w.name)}</span><br><span class="r-type">${esc([w.type, w.f].filter(Boolean).join(' · '))}</span></span>
        <span class="r-count"></span>
      </li>`).join('') : '<li aria-disabled="true">No weapons match that name.</li>';
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
  }
  function choose(i) {
    const w = hits[i];
    if (!w) return;
    q.value = '';
    closeList();
    if (state.ids.length >= MAX) state.ids.shift(); // swap out the oldest pick
    add(w.id);
  }
  q.addEventListener('input', () => {
    const term = norm(q.value.trim());
    if (!term) { closeList(); return; }
    hits = state.index.filter(w => norm(w.name).includes(term))
      .sort((a, b) => (norm(b.name).startsWith(term) - norm(a.name).startsWith(term)) || (b.u?.[0] || 0) - (a.u?.[0] || 0))
      .slice(0, 30);
    active = hits.length ? 0 : -1;
    drawList();
  });
  q.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); drawList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); drawList(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') closeList();
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
  });
  q.addEventListener('blur', () => setTimeout(closeList, 100));

  // ---------- Start ----------

  async function start() {
    const tip = $('#tip');
    if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;
    fetch('data/meta.json').then(r => r.json()).then(m => {
      $('#meta').textContent = `Data updated ${new Date(m.builtAt).toLocaleDateString()}` +
        (m.usageLoadouts ? ` · ${m.usageLoadouts.toLocaleString()} weapons seen in real matches` : '');
    }).catch(() => {});
    try {
      const res = await fetch('data/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error();
      state.index = await res.json();
    } catch {
      $('#cmp-table').innerHTML = '<p class="muted">Weapon data is missing. Run the "Update roll data" workflow.</p>';
      return;
    }
    state.index.forEach(w => state.byId.set(w.id, w));
    readHash();

    const types = [...new Set(state.index.map(w => w.type))].filter(Boolean).sort();
    state.type = state.byId.get(state.ids[0])?.type || (types.includes('Auto Rifle') ? 'Auto Rifle' : types[0]);
    $('#r-type').innerHTML = types.map(t => `<option ${t === state.type ? 'selected' : ''}>${esc(t)}</option>`).join('');

    await loadWeapons();
    render();
  }

  $('#r-type').addEventListener('change', e => { state.type = e.target.value; renderRanks(); });
  $('#r-fav').addEventListener('change', renderRanks);
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    writeHash();
    render();
  }));
  RollFavs.wire(render);
  window.addEventListener('hashchange', async () => { readHash(); await loadWeapons(); render(); });

  start();
})();
