// "Is this score right?" under the score. Players sign in with Bungie, then say yes, or no plus the
// score they'd give it and an optional comment. Votes go to Firebase (Firestore) and are private:
// nobody can read them from the site, only you in the Firebase console.
// Stays hidden until the firebase settings in config.js are filled in.
(() => {
  const CFG = window.ROLL_SCORER_CONFIG || {};
  const FB = CFG.firebase || {};
  const BUNGIE = 'https://www.bungie.net';
  const TOKEN_KEY = 'rs-bungie-token';
  const WHO_KEY = 'rs-bungie-who';
  const MINE_KEY = 'rs-votes';       // this browser's votes, so we can show "You said…"
  const PENDING_KEY = 'rs-vote-pending'; // a vote waiting for sign-in to finish
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

  const on = !!(FB.apiKey && FB.projectId && !/PASTE/.test(FB.apiKey + FB.projectId));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k, store = localStorage) => { try { return JSON.parse(store.getItem(k)); } catch { return null; } };
  const write = (k, v, store = localStorage) => { try { v === null ? store.removeItem(k) : store.setItem(k, JSON.stringify(v)); } catch {} };

  function token() {
    const t = read(TOKEN_KEY);
    return t && t.expiresAt > Date.now() + 60_000 ? t : null;
  }

  function signIn(pending) {
    write(PENDING_KEY, pending, sessionStorage);
    try { sessionStorage.setItem('rs-return', location.pathname + location.hash); } catch {}
    const st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('rs-oauth-state', st); } catch {}
    location.href = `${BUNGIE}/en/OAuth/Authorize?client_id=${encodeURIComponent(CFG.bungieClientId)}&response_type=code&state=${st}`;
  }

  // Bungie account id and name for the signed-in player
  async function who() {
    const t = token();
    if (!t) return null;
    const cached = read(WHO_KEY);
    if (cached && cached.token === t.accessToken.slice(-12)) return cached;
    const res = await fetch(`${BUNGIE}/Platform/User/GetMembershipsForCurrentUser/`, {
      headers: { 'X-API-Key': CFG.bungieApiKey, Authorization: `Bearer ${t.accessToken}` },
    });
    const j = await res.json().catch(() => null);
    const r = j?.Response;
    const m = r?.destinyMemberships?.find(x => x.membershipId === r.primaryMembershipId) || r?.destinyMemberships?.[0];
    if (!m) return null;
    const name = m.bungieGlobalDisplayName
      ? `${m.bungieGlobalDisplayName}#${String(m.bungieGlobalDisplayNameCode).padStart(4, '0')}` : m.displayName;
    const me = { id: String(m.membershipId), name: String(name || '').slice(0, 60), token: t.accessToken.slice(-12) };
    write(WHO_KEY, me);
    return me;
  }

  let fb = null;
  async function firebase() {
    if (fb) return fb;
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp({ apiKey: FB.apiKey, authDomain: FB.authDomain, projectId: FB.projectId, appId: FB.appId });
    const a = auth.getAuth(app);
    if (!a.currentUser) await auth.signInAnonymously(a);
    fb = { uid: a.currentUser.uid, db: fs.getFirestore(app), fs };
    return fb;
  }

  async function docId(memberId, key) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return `${memberId}_${[...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }

  async function send(roll, v) {
    const me = await who();
    if (!me) throw Object.assign(new Error('signin'), { signin: true });
    const { uid, db, fs } = await firebase();
    const mine = read(MINE_KEY) || {};
    const first = !mine[roll.key];
    const data = {
      uid, membershipId: me.id, bungieName: me.name,
      weapon: roll.weapon, weaponName: roll.weaponName, mode: roll.mode,
      perks: roll.perks, roll: roll.key,
      shownScore: roll.score, shownGrade: roll.grade,
      agree: v.agree, suggested: v.agree ? null : v.suggested,
      comment: v.comment || '', shareOk: !!v.shareOk,
      updatedAt: fs.serverTimestamp(),
    };
    if (first) data.createdAt = fs.serverTimestamp();
    try {
      await fs.setDoc(fs.doc(db, 'votes', await docId(me.id, roll.key)), data, { merge: true });
    } catch (err) {
      if (err?.code === 'permission-denied' && first) {
        throw new Error('You already voted on this roll from another browser or device.');
      }
      throw err;
    }
    mine[roll.key] = { agree: v.agree, suggested: data.suggested, at: Date.now() };
    write(MINE_KEY, mine);
  }

  // ---------- The box under the score ----------

  function render(slot, roll) {
    if (!on || !slot || !roll) return;
    const mine = (read(MINE_KEY) || {})[roll.key];
    const signedIn = !!token();
    const box = document.createElement('div');
    box.className = 'vote';
    slot.replaceChildren(box);

    const ask = () => {
      box.innerHTML = `<p class="vote-q">Is this score right?</p>
        <div class="vote-btns"><button type="button" class="ghost" data-v="yes">Yes</button><button type="button" class="ghost" data-v="no">No</button></div>
        ${signedIn ? '' : '<p class="vote-note">You\'ll sign in with Bungie first, so each player gets one vote.</p>'}`;
      box.querySelector('[data-v="yes"]').onclick = () => go({ agree: true });
      box.querySelector('[data-v="no"]').onclick = form;
    };

    const done = (v, extra = '') => {
      box.innerHTML = `<p class="vote-done">${v.agree ? 'You said this score is right.' : `You'd give it <b>${v.suggested}</b>.`} Thanks, noted.${extra}
        <button type="button" class="link">Change</button></p>`;
      box.querySelector('.link').onclick = ask;
    };

    const form = (prev = {}) => {
      const start = prev.suggested ?? roll.score;
      box.innerHTML = `<form class="vote-form">
          <p class="vote-q">Is this score right? No</p>
          <label class="vote-range"><span>What would you give it?</span><output>${start}</output>
            <input type="range" min="0" max="100" step="1" value="${start}"></label>
          <p class="vote-hint" hidden>Move the slider to the score you'd give it.</p>
          <textarea maxlength="280" rows="3" placeholder="What's wrong with it? (optional)">${esc(prev.comment || '')}</textarea>
          <label class="check"><input type="checkbox" ${prev.shareOk ? 'checked' : ''}> OK to show my comment on the site with my Bungie name</label>
          <div class="vote-btns"><button type="submit" class="primary">Send</button><button type="button" class="ghost">Cancel</button></div>
          ${signedIn ? '' : '<p class="vote-note">You\'ll sign in with Bungie first, so each player gets one vote.</p>'}
        </form>`;
      const f = box.querySelector('form');
      const range = f.querySelector('input[type=range]');
      const out = f.querySelector('output');
      range.oninput = () => { out.textContent = range.value; f.querySelector('.vote-hint').hidden = true; };
      f.querySelector('.ghost').onclick = ask;
      f.onsubmit = e => {
        e.preventDefault();
        const suggested = Number(range.value);
        if (suggested === roll.score) { f.querySelector('.vote-hint').hidden = false; return; }
        go({ agree: false, suggested, comment: f.querySelector('textarea').value.trim().slice(0, 280), shareOk: f.querySelector('.check input').checked });
      };
    };

    const go = async v => {
      if (!token()) return signIn({ key: roll.key, ...v });
      box.innerHTML = '<p class="vote-done">Sending…</p>';
      try {
        await send(roll, v);
        done(v);
      } catch (err) {
        if (err.signin) return signIn({ key: roll.key, ...v });
        console.error(err);
        box.innerHTML = `<p class="vote-done">${esc(err.message && !/firebase|firestore/i.test(err.message) ? err.message : 'Couldn\'t send that. Try again in a moment.')}
          <button type="button" class="link">Back</button></p>`;
        box.querySelector('.link').onclick = ask;
      }
    };

    // Back from Bungie sign-in with a vote waiting
    const pending = read(PENDING_KEY, sessionStorage);
    if (pending && pending.key === roll.key && signedIn) {
      write(PENDING_KEY, null, sessionStorage);
      const { key, ...v } = pending;
      return go(v);
    }
    if (mine) return done(mine);
    ask();
  }

  window.RollVote = { render };
})();
