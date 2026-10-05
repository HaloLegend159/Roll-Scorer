// Switching a weapon's perks in game through Bungie's API (the same free, reversible action DIM uses).
// Only active when config.js sets allowPerkChanges and the Bungie app has the
// "Move or equip Destiny gear" permission. Nothing here runs unless the player presses Apply.
window.RollApply = (() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const KEY = 'rs-apply';
  const enabled = !!(CFG.allowPerkChanges && CFG.bungieApiKey && CFG.bungieClientId);

  function token() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
      return t && t.expiresAt > Date.now() + 30_000 ? t.accessToken : null;
    } catch { return null; }
  }

  // What each owned weapon can switch to, saved by the inventory page so the scorer page can use it:
  // { [itemId]: { mt: membershipType, ch: characterId, plugs: { perkIndex: [socketIndex, plugHash] }, slotted: [perkIndex per column] } }
  function all() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function saveAll(map) { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {} }
  function get(iid) { return iid ? all()[iid] || null : null; }
  function put(iid, info) { const m = all(); m[iid] = info; saveAll(m); }

  // Columns where the wanted perk differs from what's slotted and this copy can switch to it
  function pending(info, picks) {
    if (!info) return [];
    return picks.map((p, ci) => ({ ci, p }))
      .filter(({ ci, p }) => p !== null && p !== undefined && p !== info.slotted[ci] && info.plugs[p]);
  }

  function explain(status, j) {
    const s = j?.ErrorStatus || '';
    if (status === 401 || j?.ErrorCode === 99 || j?.ErrorCode === 2111) return 'Your Bungie login expired. Sign in again on the My inventory tab.';
    if (/scope|notpermitted|insufficientprivileges/i.test(s) || status === 403) {
      return 'This site doesn\'t have your permission to change perks yet. Sign out on the My inventory tab, then sign in again and approve it.';
    }
    if (/location|orbit|tower|activity|notinsocial|cannotperformaction/i.test(s)) {
      return 'Bungie only allows perk changes while your character is in orbit, in a social space like the Tower, or offline.';
    }
    return `Bungie said: ${j?.Message || s || 'error ' + status}`;
  }

  // Switch the picked perks. Returns { ok, changed, message } and updates info.slotted as it goes.
  async function apply(iid, info, picks) {
    if (!enabled) return { ok: false, changed: 0, message: 'Changing perks isn\'t turned on for this site.' };
    const todo = pending(info, picks);
    if (!todo.length) return { ok: true, changed: 0, message: 'Those perks are already slotted.' };
    const t = token();
    if (!t) return { ok: false, changed: 0, message: 'Sign in on the My inventory tab first.' };
    let changed = 0;
    for (const { ci, p } of todo) {
      const [socketIndex, plugItemHash] = info.plugs[p];
      let res, j = null;
      try {
        res = await fetch(`${BUNGIE}/Platform/Destiny2/Actions/Items/InsertSocketPlugFree/`, {
          method: 'POST',
          headers: { 'X-API-Key': CFG.bungieApiKey, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plug: { socketIndex, socketArrayType: 0, plugItemHash },
            itemId: iid, characterId: info.ch, membershipType: info.mt,
          }),
        });
        j = await res.json().catch(() => null);
      } catch {
        put(iid, info);
        return { ok: false, changed, message: 'Couldn\'t reach Bungie. Check your connection and try again.' };
      }
      if (!j || j.ErrorCode !== 1) {
        put(iid, info);
        return { ok: false, changed, message: explain(res.status, j) };
      }
      info.slotted[ci] = p;
      changed++;
    }
    put(iid, info);
    return { ok: true, changed, message: `Done. ${changed} perk${changed === 1 ? '' : 's'} switched in game.` };
  }

  return { enabled, saveAll, get, pending, apply };
})();
