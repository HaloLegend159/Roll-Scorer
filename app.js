(() => {
  const BUNGIE = 'https://www.bungie.net';
  const $ = (s) => document.querySelector(s);

  const state = {
    index: [],
    weapon: null,   // loaded weapon file
    mode: 'all',
    picks: [],      // one perk index per column, or null
    colOf: [],      // perk index -> column index
  };

  // ---------- Loading ----------

  async function init() {
    try {
      const res = await fetch('data/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      state.index = await res.json();
      $('#status').textContent = `${state.index.length} weapons loaded. Search for one above to start.`;
    } catch {
      $('#status').textContent =
        'No weapon data yet. Open the repo\'s Actions tab, run "Update roll data", then reload this page.';
      return;
    }
    fetch('data/meta.json').then(r => r.json()).then(m => {
      const d = new Date(m.builtAt);
      $('#meta').textContent = `Data updated ${d.toLocaleDateString()} · ${m.wishlistRolls.toLocaleString()} community rolls`;
    }).catch(() => {});
    readHash();
  }

  async function loadWeapon(id, picksFromUrl) {
    const res = await fetch(`data/w/${encodeURIComponent(id)}.json`);
    if (!res.ok) { $('#status').textContent = `Couldn't load that weapon (${res.status}).`; return; }
    const w = await res.json();
    state.weapon = w;
    state.colOf = [];
    w.columns.forEach((c, ci) => c.perks.forEach(() => state.colOf.push(ci)));
    state.picks = w.columns.map((_, ci) => {
      const p = picksFromUrl?.[ci];
      return Number.isInteger(p) && state.colOf[p] === ci ? p : null;
    });
    $('#empty').hidden = true;
    $('#weapon').hidden = false;
    $('#w-icon').src = w.icon ? BUNGIE + w.icon : '';
    $('#w-icon').hidden = !w.icon;
    $('#w-name').textContent = w.name;
    $('#w-type').textContent = [w.tier, w.type].filter(Boolean).join(' ');
    document.title = `${w.name} · Roll Scorer`;
    render();
  }

  // ---------- Scoring ----------

  function stats() {
    const { rolls, weights } = state.weapon.modes[state.mode];
    const freq = new Map();
    rolls.forEach((r, i) => r.forEach(p => freq.set(p, (freq.get(p) || 0) + weights[i])));
    let start = 0;
    const colMax = state.weapon.columns.map(col => {
      let m = 0;
      col.perks.forEach((_, j) => { m = Math.max(m, freq.get(start + j) || 0); });
      start += col.perks.length;
      return m;
    });
    return { rolls, weights, freq, colMax };
  }

  function score(s) {
    const cols = state.weapon.columns;
    const picked = new Set(state.picks.filter(p => p !== null));
    if (!s.rolls.length || !picked.size) return null;

    // 1) How popular each chosen perk is within its column (traits weigh the most)
    let wSum = 0, wScore = 0;
    const perCol = cols.map((col, ci) => {
      const p = state.picks[ci];
      if (!s.colMax[ci] || p === null) return null;
      const v = (s.freq.get(p) || 0) / s.colMax[ci];
      wSum += col.weight; wScore += col.weight * v;
      return v;
    });
    const popularity = wSum ? wScore / wSum : 0;

    // 2) How close the roll is to the nearest complete recommended roll
    const pickedCols = new Set(state.picks.map((p, ci) => (p === null ? -1 : ci)));
    let best = 0, bestIdx = -1, bestWeight = 0;
    s.rolls.forEach((roll, i) => {
      const relevant = roll.filter(p => pickedCols.has(state.colOf[p]));
      if (!relevant.length) return;
      const m = relevant.filter(p => picked.has(p)).length / relevant.length;
      if (m > best || (m === best && s.weights[i] > bestWeight)) {
        best = m; bestIdx = i; bestWeight = s.weights[i];
      }
    });

    const matches = s.rolls.filter(roll => roll.every(p => picked.has(p))).length;
    const total = Math.round(100 * (0.55 * best + 0.45 * popularity));
    return { total, perCol, best, matches, closest: bestIdx >= 0 ? s.rolls[bestIdx] : null };
  }

  function grade(n) {
    if (n >= 90) return ['God roll', 'var(--gold)'];
    if (n >= 75) return ['Keeper', '#9ccf7a'];
    if (n >= 55) return ['Solid', 'var(--text)'];
    if (n >= 35) return ['Situational', '#d8a25e'];
    return ['Shard it', 'var(--bad)'];
  }

  // ---------- Rendering ----------

  function perkByIndex(i) {
    const ci = state.colOf[i];
    let start = 0;
    for (let c = 0; c < ci; c++) start += state.weapon.columns[c].perks.length;
    return state.weapon.columns[ci].perks[i - start];
  }

  function render() {
    const w = state.weapon;
    const s = stats();

    document.querySelectorAll('.modes button').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));

    const colsEl = $('#columns');
    colsEl.innerHTML = '';
    let idx = 0;
    w.columns.forEach((col, ci) => {
      const el = document.createElement('div');
      el.className = 'col' + (col.weight >= 3 ? ' key' : '') + (state.picks[ci] !== null ? ' has-pick' : '');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', col.label);
      el.innerHTML = `<h3>${esc(col.label)}</h3>`;
      col.perks.forEach(perk => {
        const i = idx++;
        const f = s.freq.get(i) || 0;
        const rel = s.colMax[ci] ? f / s.colMax[ci] : 0;
        const b = document.createElement('button');
        b.className = 'perk';
        b.title = perk.name;
        b.setAttribute('aria-label', perk.name);
        b.setAttribute('aria-pressed', String(state.picks[ci] === i));
        b.innerHTML = (perk.icon ? `<img src="${BUNGIE + perk.icon}" alt="" loading="lazy">` : '') +
          (rel >= 0.999 ? '<span class="pip"></span>' : rel >= 0.5 ? '<span class="pip soft"></span>' : '');
        b.addEventListener('click', () => {
          state.picks[ci] = state.picks[ci] === i ? null : i;
          showDetail(i, s);
          render();
          writeHash();
        });
        b.addEventListener('mouseenter', () => showDetail(i, s));
        b.addEventListener('focus', () => showDetail(i, s));
        el.appendChild(b);
      });
      colsEl.appendChild(el);
    });

    renderScore(s);
  }

  function showDetail(i, s) {
    const perk = perkByIndex(i);
    const count = s.freq.get(i) || 0;
    const total = s.rolls.reduce((a, _, k) => a + s.weights[k], 0);
    const pct = total ? Math.round((100 * count) / total) : 0;
    $('#perk-detail').innerHTML =
      `<h4>${esc(perk.name)}</h4><p>${esc(perk.desc || 'No description.')}</p>` +
      `<p class="stat">In ${pct}% of recommended ${modeWord()} rolls for this weapon.</p>`;
  }

  function modeWord() { return state.mode === 'all' ? '' : state.mode === 'pve' ? 'PvE' : 'PvP'; }

  function renderScore(s) {
    const el = $('#score');
    const cols = state.weapon.columns;
    if (!s.rolls.length) {
      el.style.removeProperty('--grade');
      el.innerHTML = `<p class="grade">No data</p><p class="note">The community wish list has no ${modeWord()} rolls for this weapon yet${state.mode !== 'all' ? '. Try another activity filter.' : '.'}</p>`;
      return;
    }
    const r = score(s);
    if (!r) {
      el.style.removeProperty('--grade');
      el.innerHTML = `<p class="num">–</p><p class="note">Pick perks to see a score. Based on ${s.rolls.length.toLocaleString()} recommended ${modeWord()} rolls.</p>`;
      return;
    }
    const [label, color] = grade(r.total);
    el.style.setProperty('--grade', color);

    const missing = state.picks.filter((p, ci) => p === null && s.colMax[ci]).length;
    const why = r.matches
      ? `Matches ${r.matches} recommended roll${r.matches > 1 ? 's' : ''} exactly.`
      : `${Math.round(r.best * 100)}% of the way to the closest recommended roll.`;

    const bars = cols.map((col, ci) => {
      const v = r.perCol[ci];
      if (v === null || v === undefined) return '';
      const pct = Math.round(v * 100);
      return `<li><span>${esc(col.label)}: ${esc(perkByIndex(state.picks[ci]).name)}</span><span>${pct}</span>
        <div class="track"><div class="fill${pct === 100 ? ' max' : ''}" style="width:${pct}%"></div></div></li>`;
    }).join('');

    const closest = r.closest && r.best < 1
      ? `<div class="closest"><h3>Closest recommended roll</h3><ul>${
          r.closest.map(p => `<li class="${state.picks.includes(p) ? 'hit' : ''}">${esc(perkByIndex(p).name)}</li>`).join('')
        }</ul></div>` : '';

    el.innerHTML =
      `<p class="num">${r.total}<small>/100</small></p>` +
      `<p class="grade">${label}</p>` +
      `<p class="why">${why}${missing ? ` ${missing} column${missing > 1 ? 's' : ''} still empty.` : ''}</p>` +
      `<ul class="bars" aria-label="Perk strength by column">${bars}</ul>` + closest;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Share links: #/weapon-id/mode/perk-perk-perk ----------

  function writeHash() {
    if (!state.weapon) return;
    const p = state.picks.map(x => (x === null ? '_' : x)).join('-');
    history.replaceState(null, '', `#/${state.weapon.id}/${state.mode}/${p}`);
  }

  function readHash() {
    const [, id, mode, p] = location.hash.split('/');
    if (!id) return;
    if (['all', 'pve', 'pvp'].includes(mode)) state.mode = mode;
    const picks = (p || '').split('-').map(x => (x === '_' || x === '' ? null : Number(x)));
    loadWeapon(decodeURIComponent(id), picks);
  }

  // ---------- Search ----------

  const q = $('#q'), list = $('#results'), box = $('.search');
  let hits = [], active = -1;

  function norm(s) { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ''); }

  function search() {
    const term = norm(q.value.trim());
    if (!term) { closeList(); return; }
    hits = state.index
      .filter(w => norm(w.name).includes(term))
      .sort((a, b) => (norm(b.name).startsWith(term) - norm(a.name).startsWith(term)) || b.n - a.n)
      .slice(0, 30);
    active = hits.length ? 0 : -1;
    drawList();
  }

  function drawList() {
    list.innerHTML = hits.length ? hits.map((w, i) =>
      `<li role="option" id="opt-${i}" aria-selected="${i === active}" data-i="${i}">
        <img src="${w.icon ? BUNGIE + w.icon : ''}" alt="" loading="lazy">
        <span><span class="r-name">${esc(w.name)}</span><br><span class="r-type">${esc(w.type)}</span></span>
        <span class="r-count">${w.n ? `${w.n} rolls` : 'no data'}</span>
      </li>`).join('') : '<li aria-disabled="true">No weapons match that name.</li>';
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
    q.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function closeList() { list.hidden = true; box.setAttribute('aria-expanded', 'false'); }

  function choose(i) {
    const w = hits[i];
    if (!w) return;
    q.value = '';
    closeList();
    state.picks = [];
    location.hash = `/${w.id}/${state.mode}/`;
  }

  q.addEventListener('input', search);
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
  window.addEventListener('hashchange', readHash);

  // ---------- Controls ----------

  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    render();
    writeHash();
  }));
  $('#clear').addEventListener('click', () => {
    state.picks = state.picks.map(() => null);
    render();
    writeHash();
  });
  $('#share').addEventListener('click', async () => {
    const btn = $('#share');
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Link copied';
    } catch {
      btn.textContent = 'Copy the address bar instead';
    }
    setTimeout(() => { btn.textContent = 'Copy link to this roll'; }, 2000);
  });

  init();
})();
