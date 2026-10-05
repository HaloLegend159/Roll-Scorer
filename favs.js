// Favorite weapons, saved in this browser only. Shared by every page.
window.RollFavs = (() => {
  const KEY = 'rs-favs';
  function list() {
    try { const a = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function has(id) { return list().includes(id); }
  function toggle(id) {
    const a = list();
    const i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1); else a.push(id);
    try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {}
    return i < 0;
  }
  // A star button. Clicks are handled once per page by wire().
  function button(id, name) {
    const on = has(id);
    return `<button class="fav" data-fav="${id}" aria-pressed="${on}" title="${on ? 'Remove from' : 'Add to'} favorites" ` +
      `aria-label="${on ? 'Remove' : 'Add'} ${String(name).replace(/"/g, '&quot;')} ${on ? 'from' : 'to'} favorites">${on ? '★' : '☆'}</button>`;
  }
  function wire(onChange) {
    document.addEventListener('click', e => {
      const b = e.target.closest('button[data-fav]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(b.dataset.fav);
      onChange?.(b.dataset.fav);
    });
  }
  return { list, has, toggle, button, wire };
})();
