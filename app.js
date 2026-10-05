(() => {
  const BUNGIE = 'https://www.bungie.net';
  const $ = (s) => document.querySelector(s);

  const state = {
    index: [],
    weapon: null,   // loaded weapon file
    mode: 'all',
    picks: [],      // one perk index per column, or null
    colOf: [],      // perk index -> column index
    colStart: [],   // column index -> first perk index
    avail: null,    // perks this copy of the gun has (from the inventory page), per column
    iid: null,      // which owned copy this is, when opened from the inventory page
    onlyAvail: true,
    rs: null,       // RollScore context for "best possible"
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
      $('#meta').textContent = `Data updated ${d.toLocaleDateString()} · ${m.wishlistRolls.toLocaleString()} community rolls` +
        (m.usageLoadouts ? ` · ${m.usageLoadouts.toLocaleString()} weapons seen in real matches` : '');
    }).catch(() => {});
    readHash();
  }

  async function loadWeapon(id, picksFromUrl, availFromUrl) {
    const res = await fetch(`data/w/${encodeURIComponent(id)}.json`);
    if (!res.ok) { $('#status').textContent = `Couldn't load that weapon (${res.status}).`; return; }
    const w = await res.json();
    state.weapon = w;
    state.colOf = [];
    state.colStart = [];
    w.columns.forEach((c, ci) => {
      state.colStart.push(state.colOf.length);
      c.perks.forEach(() => state.colOf.push(ci));
    });
    state.picks = w.columns.map((_, ci) => {
      const p = picksFromUrl?.[ci];
      return Number.isInteger(p) && state.colOf[p] === ci ? p : null;
    });
    state.avail = availFromUrl
      ? w.columns.map((_, ci) => (availFromUrl[ci] || []).filter(p => Number.isInteger(p) && state.colOf[p] === ci))
      : null;
    if (state.avail && !state.avail.some(a => a.length)) state.avail = null;
    state.rs = window.RollScore ? RollScore.prepare(w) : null;
    $('#empty').hidden = true;
    $('#weapon').hidden = false;
    $('#w-icon').src = w.icon ? BUNGIE + w.icon : '';
    $('#w-icon').hidden = !w.icon;
    $('#w-name').innerHTML = esc(w.name) + (window.RollFavs ? ' ' + RollFavs.button(w.id, w.name) : '');
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

  // Does this roll agree with the perks picked in every column except skipCol?
  // A roll that says nothing about a column (e.g. traits only) agrees with any pick there.
  function compatible(roll, skipCol) {
    for (let ci = 0; ci < state.picks.length; ci++) {
      const p = state.picks[ci];
      if (p === null || ci === skipCol) continue;
      let hasCol = false, hasPick = false;
      for (const x of roll) {
        if (state.colOf[x] === ci) { hasCol = true; if (x === p) hasPick = true; }
      }
      if (hasCol && !hasPick) return false;
    }
    return true;
  }

  // Perk popularity for one column, counting only rolls that go with the other picks.
  function colStats(s, ci) {
    const start = state.colStart[ci];
    const end = start + state.weapon.columns[ci].perks.length;
    const others = state.picks.some((p, c) => p !== null && c !== ci);
    if (others) {
      const freq = new Map();
      let n = 0, max = 0;
      s.rolls.forEach((roll, k) => {
        if (!compatible(roll, ci)) return;
        let counted = false;
        for (const x of roll) {
          if (x >= start && x < end) { freq.set(x, (freq.get(x) || 0) + s.weights[k]); counted = true; }
        }
        if (counted) n++;
      });
      if (n) {
        freq.forEach(v => { if (v > max) max = v; });
        return { freq, max, paired: true, unpaired: false };
      }
    }
    const freq = new Map();
    for (let x = start; x < end; x++) if (s.freq.get(x)) freq.set(x, s.freq.get(x));
    // "unpaired": other perks are picked, but no recommended roll pairs anything here with them
    return { freq, max: s.colMax[ci], paired: false, unpaired: others };
  }

  // Most common trait-column combinations
  function topCombos(s) {
    const traitCols = state.weapon.columns.map((c, ci) => (c.weight >= 3 ? ci : -1)).filter(ci => ci >= 0);
    if (traitCols.length < 2) return [];
    const map = new Map();
    s.rolls.forEach((roll, k) => {
      const byCol = traitCols.map(ci => roll.filter(x => state.colOf[x] === ci));
      if (byCol.some(a => a.length !== 1)) return;
      const key = byCol.map(a => a[0]).join('-');
      map.set(key, (map.get(key) || 0) + s.weights[k]);
    });
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, w]) => ({ perks: k.split('-').map(Number), w }));
  }

  // Which traits show up alongside perk i
  function partners(i, s) {
    const cols = state.weapon.columns;
    const own = state.colOf[i];
    const target = cols.map((c, ci) => (c.weight >= 3 && ci !== own ? ci : -1)).filter(ci => ci >= 0);
    if (!target.length) return [];
    const f = new Map();
    let tot = 0;
    s.rolls.forEach((roll, k) => {
      if (!roll.includes(i)) return;
      tot += s.weights[k];
      roll.forEach(x => { if (target.includes(state.colOf[x])) f.set(x, (f.get(x) || 0) + s.weights[k]); });
    });
    return [...f].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([x, v]) => ({ name: perkByIndex(x).name, pct: Math.round((100 * v) / tot) }));
  }

  // Real-world usage: how often each picked perk shows up on copies seen in matches,
  // compared with the most-used perk in its column. null when there isn't enough data.
  const MIN_USAGE = 30;
  function usageRatio(w, colStart, usage, picks) {
    if (!usage || usage.n < MIN_USAGE) return null;
    let wSum = 0, wScore = 0;
    w.columns.forEach((col, ci) => {
      const p = picks[ci];
      if (p === null || p === undefined) return;
      let max = 0;
      for (let j = 0; j < col.perks.length; j++) max = Math.max(max, usage.perks[colStart[ci] + j] || 0);
      if (!max) return;
      wSum += col.weight; wScore += col.weight * (usage.perks[p] || 0) / max;
    });
    return wSum ? wScore / wSum : null;
  }
  // Usage can only raise a score for guns with curator data: a rare god roll that few players
  // own is still a god roll. For guns whose roll data is only an estimate, usage counts for 60%
  // either way, since real loadouts beat a guess.
  function blendUsage(w, total, ratio) {
    if (ratio === null) return total;
    if (w.estimated) return Math.round(0.4 * total + 0.6 * 100 * ratio);
    return Math.max(total, Math.round(0.8 * total + 0.2 * 100 * ratio));
  }

  function score(s, cs) {
    const cols = state.weapon.columns;
    const picked = new Set(state.picks.filter(p => p !== null));
    if (!s.rolls.length || !picked.size) return null;

    // 1) How popular each chosen perk is within its column (traits weigh the most)
    let wSum = 0, wScore = 0;
    const perCol = cols.map((col, ci) => {
      const p = state.picks[ci];
      if (!s.colMax[ci] || p === null) return null;
      let v = (cs[ci].freq.get(p) || 0) / cs[ci].max;
      if (cs[ci].unpaired) v *= 0.5; // nobody recommends this perk with your other picks
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

    // Exact matches; remember the most-recommended one for its notes
    let matches = 0, matchIdx = -1;
    s.rolls.forEach((roll, i) => {
      if (!roll.every(p => picked.has(p))) return;
      matches++;
      if (matchIdx < 0 || s.weights[i] > s.weights[matchIdx]) matchIdx = i;
    });
    const usage = state.weapon.modes[state.mode].usage;
    const ratio = usageRatio(state.weapon, state.colStart, usage, state.picks);
    const base = Math.round(100 * (0.55 * best + 0.45 * popularity));
    const total = blendUsage(state.weapon, base, ratio);
    return {
      usageN: usage && usage.n >= MIN_USAGE ? Math.round(usage.n) : 0,
      usageChange: total - base,
      total, perCol, best, matches,
      closest: bestIdx >= 0 ? s.rolls[bestIdx] : null,
      noteRoll: matchIdx >= 0 ? matchIdx : bestIdx,
    };
  }

  // "#3 of 41 Auto Rifles by usage": how the gun itself stands, separate from the roll score
  function gunRankHtml() {
    if (!window.RollScore?.rank || !state.weapon) return '';
    const r = RollScore.rank(state.index, state.weapon.id, ['all', 'pve', 'pvp'].indexOf(state.mode));
    if (!r || r.rank === null) return '';
    const plural = /s$/.test(state.weapon.type) ? state.weapon.type : state.weapon.type + 's';
    return ` · <a class="gun-rank" href="compare.html#${encodeURIComponent(state.weapon.id)}" title="Based on copies seen in sampled ${modeWord() || 'recent'} matches. Popular isn't always best.">#${r.rank} of ${r.of} ${esc(plural)} by usage</a>`;
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
    return state.weapon.columns[ci].perks[i - state.colStart[ci]];
  }

  function render() {
    const w = state.weapon;
    const s = stats();
    const cs = w.columns.map((_, ci) => colStats(s, ci));

    document.querySelectorAll('.modes button').forEach(b =>
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));

    renderAvailToggle();
    const filterAvail = state.avail && state.onlyAvail;

    const colsEl = $('#columns');
    colsEl.innerHTML = '';
    let idx = 0;
    w.columns.forEach((col, ci) => {
      const keep = filterAvail && state.avail[ci].length ? new Set(state.avail[ci]) : null;
      const el = document.createElement('div');
      el.className = 'col' + (col.weight >= 3 ? ' key' : '') + (state.picks[ci] !== null ? ' has-pick' : '');
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', col.label);
      el.innerHTML = `<h3>${esc(col.label)}</h3>`;
      col.perks.forEach(perk => {
        const i = idx++;
        if (keep && !keep.has(i)) return;
        const f = cs[ci].freq.get(i) || 0;
        const rel = cs[ci].max ? f / cs[ci].max : 0;
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

    // Type line: tier, type, where the gun ranks for this activity, craftable
    $('#w-type').innerHTML = esc([w.tier, w.type].filter(Boolean).join(' ')) + gunRankHtml() +
      (w.craftable ? ' <span class="badge craft" title="Has a crafting pattern. Once unlocked, you can craft exactly the roll you want.">Craftable</span>' : '');
    renderApply();
    renderStats();
    renderCombos(s);
    renderScore(s, cs);
    renderTrend();
  }

  // "Your gun's perks / All perks" switch, shown when the weapon came from the inventory page
  function renderAvailToggle() {
    let el = $('#avail-bar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'avail-bar';
      el.className = 'avail-bar';
      $('#columns').before(el);
    }
    if (!state.avail) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="modes" role="radiogroup" aria-label="Perks shown">
        <button role="radio" data-avail="1" aria-checked="${state.onlyAvail}">Your gun's perks</button>
        <button role="radio" data-avail="0" aria-checked="${!state.onlyAvail}">All possible perks</button>
      </div>`;
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.onlyAvail = b.dataset.avail === '1';
      if (state.onlyAvail) {
        // Drop picks this copy can't have
        state.picks = state.picks.map((p, ci) =>
          p === null || !state.avail[ci].length || state.avail[ci].includes(p) ? p : null);
      }
      render();
      writeHash();
    }));
  }

  // Best score this copy can reach by switching between the perks it has
  function bestPossibleHtml(currentTotal) {
    if (!state.avail || !state.rs) return '';
    const b = RollScore.best(state.rs, state.mode, state.avail, state.picks);
    if (b.total === null) return '';
    const same = (currentTotal !== undefined && b.total <= currentTotal) ||
      b.picks.every((p, ci) => p === null || state.picks[ci] === p);
    const names = b.picks.map((p, ci) => (p !== null && state.avail[ci].length > 1 ? perkByIndex(p).name : null)).filter(Boolean);
    return `<div class="best-possible">
        <p><span>Best possible with your gun's perks</span><b>${b.total}</b></p>
        ${same
          ? '<p class="small muted">You\'re already using the best combination this gun has.</p>'
          : `<p class="small muted">${names.length ? `Uses ${names.map(esc).join(' + ')}.` : ''}</p>
             <button class="ghost" id="use-best">Use these perks</button>`}
      </div>`;
  }

  function wireBestPossible() {
    const btn = $('#use-best');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const b = RollScore.best(state.rs, state.mode, state.avail, state.picks);
      state.picks = b.picks.map(p => (p === undefined ? null : p));
      render();
      writeHash();
    });
  }

  function renderCombos(s) {
    let el = $('#combos');
    if (!el) {
      el = document.createElement('div');
      el.id = 'combos';
      el.className = 'combos';
      $('.actions').before(el);
    }
    const combos = topCombos(s);
    if (!combos.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<h3>Most recommended trait pairs</h3><div class="combo-list">${
      combos.map((c, n) => {
        const on = c.perks.every(p => state.picks.includes(p));
        return `<button class="combo" data-n="${n}" aria-pressed="${on}">${
          c.perks.map(p => esc(perkByIndex(p).name)).join(' + ')}<span>${c.w} roll${c.w === 1 ? "" : "s"}</span></button>`;
      }).join('')}</div>`;
    el.querySelectorAll('.combo').forEach(b => b.addEventListener('click', () => {
      combos[Number(b.dataset.n)].perks.forEach(p => { state.picks[state.colOf[p]] = p; });
      render();
      writeHash();
    }));
  }

  function showDetail(i, s) {
    const perk = perkByIndex(i);
    const count = s.freq.get(i) || 0;
    const total = s.rolls.reduce((a, _, k) => a + s.weights[k], 0);
    const pct = total ? Math.round((100 * count) / total) : 0;
    $('#perk-detail').innerHTML =
      `<h4>${esc(perk.name)}</h4><p>${esc(perk.desc || 'No description.')}</p>` +
      `<p class="stat">In ${pct}% of recommended ${modeWord()} rolls for this weapon.</p>` +
      perkStatLine(i) + usageLine(i) + pairLine(i, s);
  }

  // "Players: on 38% of copies" under each perk in the score breakdown
  function usedOn(i) {
    const u = state.weapon.modes[state.mode].usage;
    if (!u || u.n < MIN_USAGE || i === null) return '';
    return `<small class="used">Players: on ${Math.round((100 * (u.perks[i] || 0)) / u.n)}% of copies</small>`;
  }

  function usageSummary(r) {
    if (!r.usageN) return '';
    const where = `${r.usageN.toLocaleString()} copies of this gun seen in ${modeWord() || 'recent'} matches`;
    let effect;
    if (r.usageChange > 0) effect = `Players run these perks a lot, which raised the score by ${r.usageChange}.`;
    else if (r.usageChange < 0) effect = `Players rarely run these perks, which lowered this estimated score by ${-r.usageChange}.`;
    else effect = state.weapon.estimated ? 'It didn\'t change this score.'
      : 'It didn\'t change this score (usage only counts when it helps a gun with curator rolls).';
    return `<p class="usage-line">Real usage: ${where}. ${effect}</p>`;
  }

  function usageLine(i) {
    const u = state.weapon.modes[state.mode].usage;
    if (!u || u.n < MIN_USAGE) return '';
    const pct = Math.round((100 * (u.perks[i] || 0)) / u.n);
    return `<p class="stat">On ${pct}% of the ${Math.round(u.n).toLocaleString()} copies seen in ${modeWord() || 'recent'} matches.</p>`;
  }

  function pairLine(i, s) {
    if (!(s.freq.get(i) > 0)) return '';
    const list = partners(i, s);
    if (!list.length) return '';
    return `<p class="stat">Usually paired with ${list.map(x => `${esc(x.name)} (${x.pct}%)`).join(', ')}.</p>`;
  }

  function modeWord() { return state.mode === 'all' ? '' : state.mode === 'pve' ? 'PvE' : 'PvP'; }

  function renderScore(s, cs) {
    const el = $('#score');
    const cols = state.weapon.columns;
    if (!s.rolls.length) {
      el.style.removeProperty('--grade');
      el.innerHTML = `<p class="grade">No data</p><p class="note">The community wish list has no ${modeWord()} rolls for this weapon yet${state.mode !== 'all' ? '. Try another activity filter.' : '.'}</p>`;
      return;
    }
    const r = score(s, cs);
    renderNotes(s, r);
    if (!r) {
      el.style.removeProperty('--grade');
      const e = state.weapon.estimated;
      if (state.avail) {
        el.innerHTML = bestPossibleHtml();
        wireBestPossible();
        return;
      }
      el.innerHTML = `<p class="num">–</p><p class="note">Pick perks to see a score. Based on ${
        e ? `rolls recommended for ${e.weapons} similar ${esc(basisText(e))}` : `${s.rolls.length.toLocaleString()} recommended ${modeWord()} rolls`}.</p>`;
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
      const warn = (cs[ci].unpaired
        ? '<small class="warn">Not paired with your other picks in any recommended roll</small>' : '') + usedOn(state.picks[ci]);
      return `<li><span>${esc(col.label)}: ${esc(perkByIndex(state.picks[ci]).name)}</span><span>${pct}</span>
        <div class="track"><div class="fill${pct === 100 ? ' max' : ''}" style="width:${pct}%"></div></div>${warn}</li>`;
    }).join('');

    const closest = r.closest && r.best < 1
      ? `<div class="closest"><h3>Closest recommended roll</h3><ul>${
          r.closest.map(p => `<li class="${state.picks.includes(p) ? 'hit' : ''}">${esc(perkByIndex(p).name)}</li>`).join('')
        }</ul></div>` : '';

    const e = state.weapon.estimated;
    const estNote = e
      ? `<p class="est">Estimated. Nobody has posted recommended rolls for this gun yet, so this score uses rolls recommended for ${e.weapons} other ${esc(basisText(e))}.</p>`
      : '';
    el.innerHTML = estNote +
      `<p class="num">${r.total}<small>/100</small></p>` +
      `<p class="grade">${label}</p>` +
      `<p class="why">${why}${missing ? ` ${missing} column${missing > 1 ? 's' : ''} still empty.` : ''}</p>` +
      usageSummary(r) +
      `<ul class="bars" aria-label="Perk strength by column">${bars}</ul>` + bestPossibleHtml(r.total) + closest +
      `<p class="caveat">Scores reflect community picks. Some top rolls are built for a specific subclass or playstyle, so check the curator notes before you shard anything.</p>`;
    wireBestPossible();
  }

  // Curator notes for the matching (or closest) recommended roll
  function renderNotes(s, r) {
    let el = $('#notes');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notes';
      el.className = 'notes';
      $('.actions').before(el);
    }
    const all = state.weapon.notes || [];
    const m = state.weapon.modes[state.mode];
    const idx = r && r.noteRoll >= 0 && m.notes ? m.notes[r.noteRoll] : [];
    if (!idx || !idx.length) { el.innerHTML = ''; return; }
    const heading = r.matches ? 'Why this roll is recommended' : 'Notes on the closest recommended roll';
    el.innerHTML = `<h3>${heading}</h3>` + idx.slice(0, 2).map(n => {
      const text = all[n] || '';
      if (text.length <= 320) return `<blockquote><p>${esc(text)}</p></blockquote>`;
      return `<blockquote><p class="clip">${esc(text.slice(0, 300).replace(/\s+\S*$/, ''))}…</p>` +
        `<p class="full" hidden>${esc(text)}</p><button class="more">Read full note</button></blockquote>`;
    }).join('');
    el.querySelectorAll('.more').forEach(b => b.addEventListener('click', () => {
      const q = b.closest('blockquote');
      const open = !q.querySelector('.full').hidden;
      q.querySelector('.full').hidden = open;
      q.querySelector('.clip').hidden = !open;
      b.textContent = open ? 'Read full note' : 'Show less';
    }));
  }

  function basisText(e) { return e.weapons === 1 ? e.basis.replace(/s$/, '') : e.basis; }

  // ---------- Apply perks in game (weapons opened from My inventory) ----------

  function renderApply(message, ok) {
    const btn = $('#apply-game'), msg = $('#apply-game-msg');
    if (!btn) return;
    const info = window.RollApply?.enabled && state.iid ? RollApply.get(state.iid) : null;
    const todo = info ? RollApply.pending(info, state.picks) : [];
    btn.hidden = !info;
    btn.disabled = !todo.length;
    btn.textContent = !info ? '' : todo.length
      ? `Apply ${todo.length === 1 ? 'this perk' : 'these perks'} in game` : 'These perks are slotted in game';
    if (message !== undefined) {
      msg.textContent = message;
      msg.className = ok ? 'apply-msg ok' : 'apply-msg bad';
      msg.hidden = false;
    } else if (todo.length) {
      msg.hidden = true;
    }
  }

  $('#apply-game')?.addEventListener('click', async () => {
    const btn = $('#apply-game');
    const info = RollApply.get(state.iid);
    if (!info) return;
    btn.disabled = true;
    btn.textContent = 'Applying…';
    const res = await RollApply.apply(state.iid, info, state.picks);
    renderApply(res.message, res.ok);
  });

  // ---------- Weapon stats ----------

  // Turn raw stat points into the number the game shows, using the weapon type's curve
  function shownStat(points, d) {
    const pts = d.interp;
    if (!pts.length) return Math.max(0, Math.min(d.max || 100, points));
    const v = Math.max(pts[0][0], Math.min(pts[pts.length - 1][0], points));
    let end = pts.findIndex(p => p[0] > v);
    if (end < 0) end = pts.length - 1;
    const start = Math.max(0, end - 1);
    const [x0, y0] = pts[start], [x1, y1] = pts[end];
    if (x1 === x0) return y0;
    const y = y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
    const r = Math.round(y); // the game rounds halves to the even number
    return Math.abs(y % 1) === 0.5 ? 2 * Math.round(y / 2) : r;
  }

  function statValues(picks) {
    const st = state.weapon.stats;
    const pts = { ...st.base };
    picks.forEach(p => {
      if (p === null) return;
      for (const [h, v] of Object.entries(perkByIndex(p).s || {})) pts[h] = (pts[h] || 0) + v;
    });
    return st.list.map(d => shownStat(pts[d.h] || 0, d));
  }

  function renderStats() {
    let el = $('#stats');
    if (!el) {
      el = document.createElement('div');
      el.id = 'stats';
      el.className = 'stats';
      $('#perk-detail').after(el);
    }
    const st = state.weapon.stats;
    if (!st) { el.innerHTML = ''; return; }
    const base = statValues(state.picks.map(() => null));
    const now = statValues(state.picks);
    const anyPick = state.picks.some(p => p !== null);
    const rows = st.list.map((d, i) => {
      const diff = now[i] - base[i];
      const change = diff ? `<span class="chg ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)}</span>` : '<span class="chg"></span>';
      const bar = d.num ? '<span class="sbar none"></span>' : (() => {
        const lo = Math.min(base[i], now[i]), hi = Math.max(base[i], now[i]);
        return `<span class="sbar"><span class="sfill" style="width:${Math.min(100, lo)}%"></span>` +
          (diff ? `<span class="sdelta ${diff > 0 ? 'up' : 'down'}" style="left:${Math.min(100, lo)}%;width:${Math.min(100, hi) - Math.min(100, lo)}%"></span>` : '') + '</span>';
      })();
      return `<li><span class="sname">${esc(d.name)}</span>${bar}<span class="sval">${now[i]}</span>${change}</li>`;
    }).join('');
    el.innerHTML = `<h3>Stats${anyPick ? ' with these perks' : ''}</h3><ul>${rows}</ul>` +
      `<p class="small muted">${anyPick ? 'Changes are compared with the bare weapon.' : 'Pick perks to see how they change these.'} Masterworks, mods and conditional bonuses aren't included.</p>`;
  }

  // "Range +10, Handling −5" for the perk details box
  function perkStatLine(i) {
    const st = state.weapon.stats;
    const s = perkByIndex(i).s;
    if (!st || !s) return '';
    // Shown as the change you'd see in-game on the bare weapon (not raw stat points)
    const parts = st.list.filter(d => s[d.h]).map(d => {
      const diff = shownStat((st.base[d.h] || 0) + s[d.h], d) - shownStat(st.base[d.h] || 0, d);
      return diff ? `${esc(d.name)} ${diff > 0 ? '+' : '−'}${Math.abs(diff)}` : '';
    }).filter(Boolean);
    return parts.length ? `<p class="stat">Stats: ${parts.join(', ')}.</p>` : '';
  }

  // ---------- Usage over time ----------

  let historyDays = null;
  fetch('data/history.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null))
    .then(h => { historyDays = h?.days || []; if (state.weapon) renderTrend(); })
    .catch(() => { historyDays = []; });

  const TREND = { share: '#b08f2c' };

  function renderTrend() {
    let el = $('#trend');
    if (!el) {
      el = document.createElement('div');
      el.id = 'trend';
      el.className = 'trend';
      $('.actions').before(el);
    }
    const counts = state.weapon.history;
    const days = historyDays;
    if (!days) { el.innerHTML = ''; return; }
    const n = Math.min(days.length, counts ? counts.length : 0);
    if (n < 3) {
      el.innerHTML = '<h3>Usage over time</h3><p class="small muted">' +
        (days.length < 3 ? 'The site started recording daily usage recently. This chart appears after a few days of data.'
          : 'This gun hasn\'t been seen in enough sampled matches to chart yet.') + '</p>';
      return;
    }
    const D = days.slice(-n), C = counts.slice(-n);
    // 7-day rolling share: copies of this gun out of every weapon seen
    const share = D.map((_, i) => {
      let c = 0, t = 0;
      for (let k = Math.max(0, i - 6); k <= i; k++) { c += C[k]; t += D[k].total; }
      return t ? (100 * c) / t : 0;
    });
    const seen = C.reduce((a, b) => a + b, 0);

    const W = Math.max(280, Math.min(720, el.clientWidth || 640));
    const L = 8, R = 56, PH = 120, TOP = 22, H = TOP + PH + 22;
    const x = i => L + (i * (W - L - R)) / (n - 1);
    const fmtShare = v => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)) + '%';
    const day = d => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const max = Math.max(...share, 0) * 1.15 || 1;
    const y = v => TOP + PH - (v / max) * PH;
    const path = share.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
    const grid = [0.5, 1].map(f => `<line class="g" x1="${L}" x2="${W - R}" y1="${y(max * f / 1.15)}" y2="${y(max * f / 1.15)}"/>` +
      `<text class="tick" x="${W - R + 6}" y="${y(max * f / 1.15) + 4}">${fmtShare(max * f / 1.15)}</text>`).join('');
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of all weapons seen over time for ${esc(state.weapon.name)}">` +
      `<text class="ptitle" x="${L}" y="${TOP - 8}">Share of all weapons seen (7-day average)</text>${grid}` +
      `<line class="base" x1="${L}" x2="${W - R}" y1="${TOP + PH}" y2="${TOP + PH}"/>` +
      `<path d="${path}" fill="none" stroke="${TREND.share}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x(n - 1)}" cy="${y(share[n - 1])}" r="4" fill="${TREND.share}" stroke="var(--panel)" stroke-width="2"/>` +
      `<text class="tick" x="${L}" y="${H - 4}">${day(D[0].d)}</text><text class="tick" x="${W - R}" y="${H - 4}" text-anchor="end">${day(D[n - 1].d)}</text>` +
      `<line class="cross" y1="${TOP}" y2="${TOP + PH}" visibility="hidden"/>` +
      `<circle class="hov" r="4" fill="${TREND.share}" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>` +
      `<rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/></svg>`;

    // Plain-words takeaway
    let takeaway = '';
    if (n >= 8) {
      const s0 = share[Math.min(6, n - 2)], s1 = share[n - 1];
      const chg = s0 ? Math.round((100 * (s1 - s0)) / s0) : 0;
      takeaway = chg <= -15 ? `Players are picking this gun less: its share fell ${-chg}%.`
        : chg >= 15 ? `Players are picking this gun more: its share grew ${chg}%.`
        : 'This gun\'s share has held steady.';
    }
    const table = `<details><summary>Show as table</summary><table><thead><tr><th>Day</th><th>Copies seen</th><th>Share (7-day)</th></tr></thead><tbody>${
      D.map((d, i) => `<tr><td>${day(d.d)}</td><td>${C[i]}</td><td>${fmtShare(share[i])}</td></tr>`).join('')}</tbody></table></details>`;

    el.innerHTML = `<h3>Usage over time</h3>` +
      (takeaway ? `<p class="takeaway">${takeaway}</p>` : '') +
      `<div class="chart">${svg}<div class="ttip" hidden></div></div>` +
      `<p class="small muted">Share is this gun's copies out of every weapon seen in sampled matches. It only moves when players switch guns, not when more or fewer people are playing.` +
      `${seen < 30 ? ` Only ${seen} copies seen so far, so treat this as rough.` : ''}</p>` + table;

    // Hover: crosshair and a tooltip with that day's numbers
    const box = el.querySelector('.chart'), tipEl = el.querySelector('.ttip'), cross = el.querySelector('.cross'), hov = el.querySelector('.hov');
    const move = ev => {
      const r = box.getBoundingClientRect();
      const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      hov.setAttribute('cx', x(i)); hov.setAttribute('cy', y(share[i])); hov.setAttribute('visibility', 'visible');
      tipEl.innerHTML = `<strong>${day(D[i].d)}</strong><br>Share: ${fmtShare(share[i])}<br>Copies seen that day: ${C[i]}`;
      tipEl.hidden = false;
      tipEl.style.left = Math.min(W - 170, Math.max(0, x(i) + 10)) + 'px';
    };
    const leave = () => { tipEl.hidden = true; cross.setAttribute('visibility', 'hidden'); hov.setAttribute('visibility', 'hidden'); };
    const hit = el.querySelector('.hit');
    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
  }
  let trendResize;
  window.addEventListener('resize', () => { clearTimeout(trendResize); trendResize = setTimeout(() => state.weapon && renderTrend(), 150); });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Share links: #/weapon-id/mode/perk-perk-perk ----------

  function writeHash() {
    if (!state.weapon) return;
    const p = state.picks.map(x => (x === null ? '_' : x)).join('-');
    const a = state.avail ? '/' + state.avail.map(o => (o.length ? o.join('.') : '_')).join('-') : '';
    history.replaceState(null, '', `#/${state.weapon.id}/${state.mode}/${p}${a}${a && state.iid ? '/' + state.iid : ''}`);
  }

  function readHash() {
    const [, id, mode, p, a, iid] = location.hash.split('/');
    state.iid = /^\d+$/.test(iid || '') ? iid : null;
    if (!id) return;
    if (['all', 'pve', 'pvp'].includes(mode)) state.mode = mode;
    const picks = (p || '').split('-').map(x => (x === '_' || x === '' ? null : Number(x)));
    const avail = a ? a.split('-').map(x => (x === '_' || x === '' ? [] : x.split('.').map(Number))) : null;
    loadWeapon(decodeURIComponent(id), picks, avail);
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
        <span><span class="r-name">${esc(w.name)}</span><br><span class="r-type">${esc(w.type)}${w.c ? ' · Craftable' : ''}</span></span>
        <span class="r-count">${w.n ? `${w.n} rolls` : w.est ? 'estimated' : 'no data'}</span>
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

  window.RollFavs?.wire(() => {
    if (state.weapon) $('#w-name').innerHTML = esc(state.weapon.name) + ' ' + RollFavs.button(state.weapon.id, state.weapon.name);
  });

  const tip = $('#tip');
  if (tip && !/YOUR-NAME/.test(tip.getAttribute('href'))) tip.hidden = false;

  init();
})();
