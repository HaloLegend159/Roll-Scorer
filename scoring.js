// Scoring used by the inventory page. Same math as the "Score a roll" page (app.js),
// written as plain functions so it can score many weapons at once.
window.RollScore = (() => {
  function prepare(w) {
    const colOf = [], colStart = [], byName = [];
    w.columns.forEach((c, ci) => {
      colStart.push(colOf.length);
      const m = new Map();
      c.perks.forEach(p => { m.set(p.name, colOf.length); colOf.push(ci); });
      byName.push(m);
    });
    const ctx = { w, colOf, colStart, byName, cache: {} };
    ctx.stats = mode => (ctx.cache[mode] ||= stats(ctx, mode));
    ctx.perk = i => w.columns[colOf[i]].perks[i - colStart[colOf[i]]];
    return ctx;
  }

  function stats(ctx, mode) {
    const { rolls, weights } = ctx.w.modes[mode];
    const freq = new Map();
    rolls.forEach((r, i) => r.forEach(p => freq.set(p, (freq.get(p) || 0) + weights[i])));
    const colMax = ctx.w.columns.map((col, ci) => {
      let m = 0;
      for (let j = 0; j < col.perks.length; j++) m = Math.max(m, freq.get(ctx.colStart[ci] + j) || 0);
      return m;
    });
    return { rolls, weights, freq, colMax };
  }

  function compatible(ctx, roll, picks, skipCol) {
    for (let ci = 0; ci < picks.length; ci++) {
      const p = picks[ci];
      if (p === null || ci === skipCol) continue;
      let hasCol = false, hasPick = false;
      for (const x of roll) {
        if (ctx.colOf[x] === ci) { hasCol = true; if (x === p) hasPick = true; }
      }
      if (hasCol && !hasPick) return false;
    }
    return true;
  }

  function colStats(ctx, s, ci, picks) {
    const start = ctx.colStart[ci];
    const end = start + ctx.w.columns[ci].perks.length;
    const others = picks.some((p, c) => p !== null && c !== ci);
    if (others) {
      const freq = new Map();
      let n = 0, max = 0;
      s.rolls.forEach((roll, k) => {
        if (!compatible(ctx, roll, picks, ci)) return;
        let counted = false;
        for (const x of roll) {
          if (x >= start && x < end) { freq.set(x, (freq.get(x) || 0) + s.weights[k]); counted = true; }
        }
        if (counted) n++;
      });
      if (n) {
        freq.forEach(v => { if (v > max) max = v; });
        return { freq, max, unpaired: false };
      }
    }
    const freq = new Map();
    for (let x = start; x < end; x++) if (s.freq.get(x)) freq.set(x, s.freq.get(x));
    return { freq, max: s.colMax[ci], unpaired: others };
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

  // picks: one perk index per column, or null. Returns null when there's nothing to score.
  function score(ctx, mode, picks) {
    const s = ctx.stats(mode);
    const picked = new Set(picks.filter(p => p !== null));
    if (!s.rolls.length || !picked.size) return null;

    let wSum = 0, wScore = 0;
    ctx.w.columns.forEach((col, ci) => {
      const p = picks[ci];
      if (!s.colMax[ci] || p === null) return;
      const cs = colStats(ctx, s, ci, picks);
      let v = (cs.freq.get(p) || 0) / cs.max;
      if (cs.unpaired) v *= 0.5;
      wSum += col.weight; wScore += col.weight * v;
    });
    const popularity = wSum ? wScore / wSum : 0;

    const pickedCols = new Set(picks.map((p, ci) => (p === null ? -1 : ci)));
    let best = 0, matches = 0;
    s.rolls.forEach(roll => {
      const relevant = roll.filter(p => pickedCols.has(ctx.colOf[p]));
      if (!relevant.length) return;
      const m = relevant.filter(p => picked.has(p)).length / relevant.length;
      if (m > best) best = m;
      if (roll.every(p => picked.has(p))) matches++;
    });
    const base = Math.round(100 * (0.55 * best + 0.45 * popularity));
    const ratio = usageRatio(ctx.w, ctx.colStart, ctx.w.modes[mode].usage, picks);
    return { total: blendUsage(ctx.w, base, ratio), matches, usage: ratio !== null };
  }

  // Best score reachable by choosing one perk per column from `options`
  // (arrays of perk indices; empty = unknown column). Tries every combination when there
  // are few, otherwise improves one column at a time starting from `start`.
  function best(ctx, mode, options, start) {
    const cols = options.map(o => (o.length ? o : [null]));
    const count = cols.reduce((n, o) => n * o.length, 1);
    let top = null;
    const consider = picks => {
      const r = score(ctx, mode, picks);
      if (r && (!top || r.total > top.total)) top = { ...r, picks: [...picks] };
    };
    if (count <= 256) {
      let combos = [[]];
      for (const o of cols) combos = combos.flatMap(c => o.map(x => [...c, x]));
      combos.forEach(consider);
    } else {
      let cur = cols.map((o, ci) => (start && o.includes(start[ci]) ? start[ci] : o[0]));
      consider(cur);
      for (let pass = 0; pass < 4; pass++) {
        let improved = false;
        for (let ci = 0; ci < cols.length; ci++) {
          for (const x of cols[ci]) {
            if (x === cur[ci]) continue;
            const t = [...cur];
            t[ci] = x;
            const r = score(ctx, mode, t);
            if (r && r.total > (top ? top.total : -1)) { top = { ...r, picks: t }; cur = t; improved = true; }
          }
        }
        if (!improved) break;
      }
    }
    return top || { total: null, picks: cols.map(o => o[0]) };
  }

  function grade(n) {
    if (n >= 90) return ['God roll', 'var(--gold)'];
    if (n >= 75) return ['Keeper', '#9ccf7a'];
    if (n >= 55) return ['Solid', 'var(--text)'];
    if (n >= 35) return ['Situational', '#d8a25e'];
    return ['Shard it', 'var(--bad)'];
  }

  return { prepare, score, best, grade };
})();
