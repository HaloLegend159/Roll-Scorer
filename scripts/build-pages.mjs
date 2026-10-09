// Builds a real page for every weapon (w/<id>/index.html), a page listing them all (w/index.html)
// and sitemap.xml, so search engines can find each gun. Runs after build-data.mjs.
// Each page is the normal scorer (index.html) opened on that gun, plus a plain-text roll summary.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.env.SITE_DIR || '.');
const SITE = 'https://d2rollcheck.com';
const OUT = path.join(ROOT, 'w');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = t => (/s$/.test(t) ? t : t + 's');

// Only write files whose content changed, so the daily commit stays small
async function put(file, text) {
  const old = await readFile(file, 'utf8').catch(() => null);
  if (old === text) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return true;
}

// Point relative links and files at the site root, since these pages live two folders down
function rootLinks(html) {
  return html.replace(/(\s(?:href|src)=")(?!https?:|#|\/|data:|mailto:)(?:\.\/)?/g, '$1/');
}

function setHead(html, { title, desc, url }) {
  const t = esc(title), d = esc(desc), u = esc(url);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`)
    .replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${u}">`)
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`)
    .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`)
    .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
}

// Same page as the scorer, opened on a gun (or on nothing), with extra text at the end
function page(template, { title, desc, url, start, body }) {
  let html = setHead(rootLinks(template), { title, desc, url });
  html = html.replace('<section id="empty" class="hero">', '<section id="empty" class="hero" hidden>');
  html = html.replace('  </main>', `${body}\n  </main>`);
  if (start) html = html.replace('<script src="/app.js">', `<script>window.RS_START = ${JSON.stringify(start)};</script>\n  <script src="/app.js">`);
  return html;
}

// Perk index -> [column, perk]
function perkMap(w) {
  const map = [];
  w.columns.forEach((c, ci) => c.perks.forEach(p => map.push([ci, p])));
  return map;
}

function summary(w, entry, index) {
  const map = perkMap(w);
  const name = i => map[i]?.[1]?.name;
  const traitCols = w.columns.map((c, ci) => (c.weight >= 3 ? ci : -1)).filter(ci => ci >= 0);
  const parts = [];

  const bestRoll = mode => {
    const r = w.modes?.[mode]?.rolls?.[0];
    if (!r) return null;
    return [...r].sort((a, b) => (map[a]?.[0] ?? 0) - (map[b]?.[0] ?? 0)).map(name).filter(Boolean);
  };
  const topPerks = mode => {
    const rolls = w.modes?.[mode]?.rolls || [];
    const weights = w.modes?.[mode]?.weights || [];
    return w.columns.map((c, ci) => {
      const count = new Map();
      rolls.forEach((r, ri) => r.forEach(i => { if (map[i]?.[0] === ci) count.set(i, (count.get(i) || 0) + (weights[ri] || 1)); }));
      const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => name(i));
      return top.length ? [c.label, top] : null;
    }).filter(Boolean);
  };

  const what = [w.tier, w.type].filter(Boolean).join(' ') + (w.frame ? `, ${w.frame}` : '');
  const basis = w.estimated
    ? `No curators have posted rolls for ${esc(w.name)} yet, so these picks are estimated from ${w.estimated.rolls?.toLocaleString?.('en-US') || 'the'} recommended rolls on ${esc(w.estimated.basis || 'similar weapons')}.`
    : `Based on ${(w.modes?.all?.rolls?.length || 0).toLocaleString('en-US')} rolls recommended by the Destiny 2 community.`;
  parts.push(`<h1>${esc(w.name)} god roll</h1>`,
    `<p>${esc(what)}. ${basis} </p>`);

  const cards = [['pve', 'PvE'], ['pvp', 'PvP']].map(([m, label]) => {
    const best = bestRoll(m);
    if (!best) return '';
    const tops = topPerks(m);
    return `<div><h2>${esc(w.name)} ${label} god roll</h2><p class="about-roll">${best.map(esc).join(' · ')}</p>` +
      `<dl>${tops.map(([l, ps]) => `<dt>${esc(l)}</dt><dd>${ps.map(esc).join(', ')}</dd>`).join('')}</dl></div>`;
  }).filter(Boolean);
  if (cards.length) parts.push(`<div class="about-grid">${cards.join('')}</div>`);

  // Similar guns with the most recommended rolls. (Not usage: that shifts daily and would rewrite every page.)
  const peers = index.filter(x => x.type === w.type && x.id !== w.id && x.n)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8);
  if (peers.length) parts.push(`<h2>Other ${esc(plural(w.type))}</h2><ul class="about-links">${peers.map(p => `<li><a href="/w/${encodeURIComponent(p.id)}/">${esc(p.name)}</a></li>`).join('')}</ul>`);

  return `    <section class="about">\n      ${parts.join('\n      ')}\n    </section>`;
}

async function main() {
  const template = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const index = JSON.parse(await readFile(path.join(ROOT, 'data', 'index.json'), 'utf8'));
  let changed = 0, failed = 0;

  for (const entry of index) {
    let w;
    try { w = JSON.parse(await readFile(path.join(ROOT, 'data', 'w', `${entry.id}.json`), 'utf8')); }
    catch { failed++; continue; }
    const pve = (() => {
      const r = w.modes?.pve?.rolls?.[0] || w.modes?.all?.rolls?.[0];
      if (!r) return '';
      const map = perkMap(w);
      const traits = r.filter(i => w.columns[map[i]?.[0]]?.weight >= 3).map(i => map[i][1].name);
      return traits.length ? traits.join(' + ') : '';
    })();
    const title = `${w.name} God Roll (PvE & PvP) · D2 Roll Check`;
    const desc = `${w.name} god roll for Destiny 2${pve ? `: ${pve} tops the list` : ''}. See the best PvE and PvP perks, top trait combos and how to get it, then score your own ${w.name} out of 100.`;
    const html = page(template, { title, desc, url: `${SITE}/w/${entry.id}/`, start: entry.id, body: summary(w, entry, index) });
    if (await put(path.join(OUT, entry.id, 'index.html'), html)) changed++;
  }

  // Remove pages for guns that are no longer in the data
  const keep = new Set(index.map(x => x.id));
  for (const d of await readdir(OUT, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && !keep.has(d.name)) await rm(path.join(OUT, d.name), { recursive: true });
  }

  // All weapons, grouped by type
  const byType = new Map();
  for (const x of [...index].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!byType.has(x.type)) byType.set(x.type, []);
    byType.get(x.type).push(x);
  }
  const types = [...byType.keys()].sort();
  const listBody = `    <section class="about">
      <h1>All Destiny 2 weapons</h1>
      <p>Every weapon that can drop with random perks, with its god rolls for PvE and PvP. ${index.length} weapons.</p>
      ${types.map(t => `<h2>${esc(plural(t))}</h2><ul class="about-links">${byType.get(t).map(x => `<li><a href="/w/${encodeURIComponent(x.id)}/">${esc(x.name)}</a></li>`).join('')}</ul>`).join('\n      ')}
    </section>`;
  await put(path.join(OUT, 'index.html'), page(template, {
    title: 'All Destiny 2 Weapons and God Rolls · D2 Roll Check',
    desc: `God rolls for all ${index.length} Destiny 2 weapons with random perks, sorted by weapon type. Pick a gun to see its best PvE and PvP perks and score your own roll.`,
    url: `${SITE}/w/`,
    body: listBody,
  }));

  // Sitemap
  const urls = ['/', '/guide.html', '/changelog.html', '/w/', '/compare.html', '/xur.html', '/inventory.html', '/armor.html', ...index.map(x => `/w/${encodeURIComponent(x.id)}/`)];
  await put(path.join(ROOT, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u => `  <url><loc>${SITE}${u}</loc></url>`).join('\n') + '\n</urlset>\n');

  console.log(`Weapon pages: ${index.length - failed} built, ${changed} changed${failed ? `, ${failed} skipped (no data file)` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
