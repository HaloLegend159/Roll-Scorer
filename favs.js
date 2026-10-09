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
      `aria-label="${on ? 'Remove' : 'Add'} ${String(name).replace(/"/g, '&quot;')} ${on ? 'from' : 'to'} favorites"><svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><path d="M12 2.8l2.75 5.95 6.5.7-4.87 4.4 1.38 6.4L12 17l-5.76 3.25 1.38-6.4L2.75 9.45l6.5-.7z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>`;
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
