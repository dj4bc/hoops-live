/* Team stat tracker (Plus): a phone page where a coach or a parent taps team stats live.
   Team totals only, no player names. Coaches unlock with the team's 4-digit PIN; a scorer
   opens the coach's link (game id + key) with no login. Every tap is kept on the phone and
   sent in batches, so poor reception at the venue does not lose anything. */
(function () {
  'use strict';
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: still works for this visit */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  const COLOURS = ['#C53030', '#2F855A', '#2B6CB0', '#6B46C1'];
  const QNAME = (q) => (q <= 4 ? 'Q' + q : q === 5 ? 'OT' : 'OT' + (q - 4));
  let CAT = null;          // metric catalogue from the server
  let CLUBS = null;        // club branding
  let timer = null;        // sync loop for the scoring screen
  let view = '';           // current route, so stale async renders are dropped

  /* ---------- helpers ---------- */
  function rid() { const a = new Uint8Array(8); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
  const nextKey = (club, team) => 'trk.next.' + club + '|' + team;
  function nextGame(club, team) {
    try { const n = JSON.parse(sessionStorage.getItem(nextKey(club, team)) || 'null'); const today = new Date(Date.now() + 10.5 * 3600e3).toISOString().slice(0, 10); return n && n.opp && (!n.d || n.d >= today) ? n : null; } catch (e) { return null; }
  }
  const tokKey = (club, team) => 'trk.tok.' + club + '|' + team;
  function token(club, team) { const t = store.get(tokKey(club, team)); return t && t.expires > Date.now() ? t.token : null; }
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.key) headers['X-Scorer-Key'] = opts.key;
    const res = await fetch('/api/tracker' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error || 'Something went wrong (' + res.status + ')'); e.status = res.status; throw e; }
    return j;
  }
  async function catalogue() {
    if (CAT) return CAT;
    CAT = await api('/metrics');
    CAT.byId = Object.fromEntries(CAT.metrics.map((m) => [m.id, m]));
    return CAT;
  }
  async function brand(slug) {
    if (!CLUBS) { try { CLUBS = (await fetch('/api/public/clubs').then((r) => r.json())).clubs || []; } catch (e) { CLUBS = []; } }
    const c = CLUBS.find((x) => x.slug === slug);
    if (c && c.colours) {
      const r = document.documentElement.style;
      r.setProperty('--p', c.colours.primary); r.setProperty('--d', c.colours.dark); r.setProperty('--a', c.colours.accent);
      document.querySelector('meta[name=theme-color]').setAttribute('content', c.colours.dark);
    }
    return c || { slug, short: slug, name: slug };
  }
  function header(back, title, sub, extra) {
    return '<header class="hd"><div class="top">' + (back ? '<a href="' + esc(back[0]) + '">◀ ' + esc(back[1]) + '</a>' : '<span>Team stat tracker</span>') + '<span class="plus">PLUS</span></div>' +
      '<h1>' + esc(title) + '</h1>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + (extra || '') + '</header>';
  }
  const fmtDay = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return d; } };
  const teamHref = (club, team) => '#/t/' + encodeURIComponent(club) + '/' + encodeURIComponent(team);

  /* ---------- goals ---------- */
  function sumTotals(perQ) { // { q: { val: n } } -> { '+': n, made: n, missed: n }
    const out = { '+': 0, made: 0, missed: 0 };
    Object.values(perQ || {}).forEach((x) => Object.entries(x).forEach(([k, n]) => { out[k] = (out[k] || 0) + n; }));
    return out;
  }
  function measure(def, t) { // t = { '+', made, missed }
    if (def.tap === 'made_missed') { const att = (t.made || 0) + (t.missed || 0); return { n: att, made: t.made || 0, att, pct: att ? Math.round((t.made || 0) / att * 100) : null }; }
    return { n: t['+'] || 0 };
  }
  function goalText(def, goal) {
    if (goal == null || def.goal === 'none') return '';
    return def.goal === 'under' ? 'under ' + goal : def.goal === 'atleast' ? goal + ' or more' : goal + '% made';
  }
  function goalHit(def, goal, v) {
    if (goal == null || def.goal === 'none') return null;
    if (def.goal === 'under') return v.n < goal;
    if (def.goal === 'atleast') return v.n >= goal;
    return v.att ? v.pct >= goal : false;
  }
  function valueText(def, v) { return def.tap === 'made_missed' ? v.made + '/' + v.att + (v.pct != null ? ' · ' + v.pct + '%' : '') : String(v.n); }

  /* ---------- router ---------- */
  async function route() {
    clearInterval(timer); timer = null;
    let raw = location.hash.replace(/^#\/?/, '');
    // Some iPhone hand-offs (a home-screen web app opening this link) arrive with the "?" encoded
    // as %3F, which put the whole query string into the team name. Treat %3F as the query start.
    if (raw.indexOf('?') < 0 && /%3F/i.test(raw)) raw = raw.replace(/%3F/i, '?');
    const qi = raw.indexOf('?');
    let query = qi >= 0 ? raw.slice(qi + 1) : '';
    if (query.indexOf('=') < 0 && /%3D/i.test(query)) { try { query = decodeURIComponent(query); } catch (e) { /* leave it */ } }
    const params = new URLSearchParams(query);
    const dec = (x) => { try { return decodeURIComponent(x); } catch (e) { return x; } };
    const parts = (qi >= 0 ? raw.slice(0, qi) : raw).split('/').map(dec);
    // Opened bare (e.g. from the home-screen icon): go back to the last team used on this phone.
    if (!parts[0]) { const last = store.get('trk.last'); if (last && last.club && last.team && token(last.club, last.team)) { location.replace('#' + teamHref(last.club, last.team).slice(1)); return; } }
    // The club site sends the next game (opponent, date, match id) so the coach never types it.
    if (parts[0] === 't' && parts[1] && parts[2] && params.has('opp')) {
      try { sessionStorage.setItem(nextKey(parts[1], parts[2]), JSON.stringify({ opp: params.get('opp'), d: params.get('d'), m: params.get('m'), r: params.get('r') })); } catch (e) { /* fine */ }
      history.replaceState(null, '', '#' + raw.slice(0, qi));
    }
    view = location.hash;
    try {
      await catalogue();
      if (parts[0] === 't' && parts[1] && parts[2]) {
        const club = parts[1], team = parts[2];
        await brand(club);
        store.set('trk.last', { club, team });
        const tok = token(club, team);
        if (!tok) return renderPin(club, team);
        if (parts[3] === 'new') return renderNew(club, team, tok);
        if (parts[3] === 'g' && parts[4]) return parts[5] === 'summary' ? renderSummary({ id: parts[4], club, team, tok }) : renderScore({ id: parts[4], club, team, tok });
        return renderTeam(club, team, tok);
      }
      if (parts[0] === 's' && parts[1] && parts[2]) return parts[3] === 'summary' ? renderSummary({ id: parts[1], key: parts[2] }) : renderScore({ id: parts[1], key: parts[2] });
      app.innerHTML = header(null, 'Team stat tracker') + '<div class="pad"><div class="card">Open the tracker from your team\'s page on the club site, or from the scorer link your coach sent you.</div></div>';
    } catch (e) {
      app.innerHTML = header(null, 'Team stat tracker') + '<div class="pad"><div class="err">' + esc(e.message) + '</div><button class="btn o" onclick="location.reload()">Try again</button></div>';
    }
  }
  window.addEventListener('hashchange', route);

  /* ---------- PIN ---------- */
  function renderPin(club, team, msg) {
    let pin = '';
    app.innerHTML = header(null, team, 'Coaches and team managers') +
      '<div class="pin"><h2>Enter team PIN</h2><div class="muted">4 digits, from your club.</div><div class="dots" id="dots"><i></i><i></i><i></i><i></i></div>' +
      '<div class="err" id="msg">' + esc(msg || '') + '</div><div class="keys">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '<button type="button" data-k="' + n + '">' + n + '</button>').join('') +
      '<button type="button" class="blank" tabindex="-1"></button><button type="button" data-k="0">0</button><button type="button" data-k="del" aria-label="Delete">⌫</button></div>' +
      '<p class="muted" style="font-size:13px;margin-top:22px">Scoring for the coach? Use the scorer link they share instead.</p></div>';
    const dots = app.querySelector('#dots'), msgEl = app.querySelector('#msg');
    const draw = () => dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
    async function submit() {
      try {
        const r = await api('/unlock', { method: 'POST', body: { club, team, pin } });
        store.set(tokKey(club, team), { token: r.token, expires: r.expires });
        route();
      } catch (e) {
        pin = ''; draw(); msgEl.textContent = e.message;
        dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
      }
    }
    app.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (k === 'del') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      msgEl.textContent = ''; draw();
      if (pin.length === 4) submit();
    }));
    const onKey = (e) => {
      if (!app.querySelector('#dots')) { document.removeEventListener('keydown', onKey); return; }
      if (/^\d$/.test(e.key)) app.querySelector('[data-k="' + e.key + '"]').click();
      else if (e.key === 'Backspace') app.querySelector('[data-k="del"]').click();
    };
    document.addEventListener('keydown', onKey);
  }
  function lockedOut(club, team, e) {
    if (e && e.status === 401) { store.del(tokKey(club, team)); renderPin(club, team, 'Please enter the PIN again.'); return true; }
    return false;
  }

  /* ---------- team home: live game, history, trends ---------- */
  function teamSub(club, team) {
    const n = nextGame(club, team);
    if (n) return 'Next: v ' + n.opp + (n.r ? ' · ' + n.r : '');
    const c = (CLUBS || []).find((x) => x.slug === club);
    return c ? c.name : '';
  }
  // On an iPhone in Safari (or opened from another home-screen app), suggest pinning the tracker
  // itself so it opens full screen with no address bar.
  function installTip() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    if (!ios || standalone || store.get('trk.tipDone')) return '';
    setTimeout(() => { const x = document.getElementById('tipx'); if (x) x.addEventListener('click', () => { store.set('trk.tipDone', 1); x.parentNode.remove(); }); });
    return '<div class="tip">Full screen at games: tap <b>Share</b> (or <b>⋯</b>) → <b>Add to Home Screen</b>, then open the tracker from that icon.<button type="button" id="tipx" aria-label="Dismiss">✕</button></div>';
  }
  async function renderTeam(club, team, tok) {
    const here = view;
    app.innerHTML = header(null, team, teamSub(club, team)) + '<div class="pad muted">Loading…</div>';
    let data;
    try { data = await api('/team', { token: tok }); } catch (e) { if (!lockedOut(club, team, e)) app.querySelector('.pad').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    if (here !== view) return;
    const live = data.games.filter((g) => g.status === 'live');
    const done = data.games.filter((g) => g.status !== 'live');
    const gameRow = (g) => {
      const res = g.metrics.map((m) => { const def = CAT.byId[m.id]; return def ? goalHit(def, m.goal, measure(def, g.totals[m.id] || {})) : null; }).filter((x) => x != null);
      const hit = res.filter(Boolean).length;
      const d = new Date(g.date + 'T00:00:00');
      return '<a class="gl" href="' + teamHref(club, team) + '/g/' + g.id + (g.status === 'live' ? '' : '/summary') + '"><div class="d">' + esc(d.toLocaleDateString('en-AU', { month: 'short' }).toUpperCase()) + '<b>' + d.getDate() + '</b></div>' +
        '<div class="grow"><div class="t">' + esc(g.opponent ? 'v ' + g.opponent : 'Game') + '</div><div class="m">' + esc(g.metrics.map((m) => (CAT.byId[m.id] || {}).name).filter(Boolean).join(' · ')) + '</div></div>' +
        (g.status === 'live' ? '<span class="pill live">LIVE</span>' : res.length ? '<span class="pill' + (hit === res.length ? '' : ' miss') + '">' + hit + '/' + res.length + ' goals</span>' : '') + '</a>';
    };
    app.innerHTML = header(null, team, teamSub(club, team)) + installTip() + '<div class="pad">' +
      (live.length ? '<div class="lbl" style="margin-top:4px">Live now</div><div class="card">' + live.map(gameRow).join('') + '</div>' : '') +
      '<a class="btn" href="' + teamHref(club, team) + '/new">＋ Start tracking ' + (nextGame(club, team) ? 'v ' + esc(nextGame(club, team).opp) : 'a game') + '</a>' +
      '<div class="lbl">Games</div><div class="card">' + (done.length ? done.map(gameRow).join('') : '<div class="muted">No finished games yet. Start one at tip-off.</div>') + '</div>' +
      trends(done.slice().reverse()) +
      ((data.deleted || []).length ? '<div class="lbl">Recently deleted</div><div class="card">' + data.deleted.map((g) => '<div class="gl bin"><div class="grow"><div class="t">' + esc(g.opponent ? 'v ' + g.opponent : 'Game') + ' · ' + esc(fmtDay(g.date)) + '</div>' +
        '<div class="m">Gone for good in ' + esc(leftText(g.until)) + '</div></div><button class="btn o sm" type="button" data-restore="' + esc(g.id) + '">Restore</button></div>').join('') + '</div>' : '') +
      '<p class="muted" style="font-size:13px">Team totals only, no player names. Only people with the team PIN can see this page.</p>' +
      '<button class="btn o sm" id="lock" type="button">Lock this phone</button></div>';
    app.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api('/games/' + b.dataset.restore + '/restore', { method: 'POST', token: tok }); toast('Game restored'); renderTeam(club, team, tok); }
      catch (e) { b.disabled = false; toast(e.message); }
    }));
    app.querySelector('#lock').addEventListener('click', async () => {
      await api('/lock', { method: 'POST', token: tok }).catch(() => {});
      store.del(tokKey(club, team)); route();
    });
  }
  function trends(games) { // oldest first
    const ids = [];
    games.forEach((g) => g.metrics.forEach((m) => { if (!ids.includes(m.id) && CAT.byId[m.id]) ids.push(m.id); }));
    if (!ids.length || games.length < 2) return '';
    const rows = ids.map((id) => {
      const def = CAT.byId[id];
      const pts = games.map((g) => { const m = g.metrics.find((x) => x.id === id); if (!m) return null; const v = measure(def, g.totals[id] || {}); return { y: def.goal === 'pct' ? v.pct : v.n, goal: m.goal }; });
      const ys = pts.filter((p) => p && p.y != null).map((p) => p.y);
      if (ys.length < 2) return '';
      const lastGoal = (pts.filter((p) => p && p.goal != null).pop() || {}).goal;
      const all = ys.concat(lastGoal != null ? [lastGoal] : []);
      const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
      const W = 200, H = 44, step = pts.length > 1 ? (W - 10) / (pts.length - 1) : 0;
      const Y = (y) => 6 + (H - 12) * (1 - (y - lo) / span);
      const line = pts.map((p, i) => (p && p.y != null ? (5 + i * step).toFixed(1) + ',' + Y(p.y).toFixed(1) : null)).filter(Boolean);
      const last = line[line.length - 1].split(',');
      const col = def.goal === 'under' ? '#C53030' : def.goal === 'pct' ? '#2B6CB0' : '#2F855A';
      return '<div class="spark"><div class="k">' + esc(def.name) + '<small>' + esc(lastGoal != null ? 'goal ' + goalText(def, lastGoal) : def.group) + '</small></div>' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + (lastGoal != null ? '<line x1="0" x2="' + W + '" y1="' + Y(lastGoal).toFixed(1) + '" y2="' + Y(lastGoal).toFixed(1) + '" stroke="#CBD2DC" stroke-dasharray="4 4"/>' : '') +
        '<polyline fill="none" stroke="' + col + '" stroke-width="2.5" vector-effect="non-scaling-stroke" points="' + line.join(' ') + '"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="' + col + '"/></svg>' +
        '<div class="v">' + ys[ys.length - 1] + (def.goal === 'pct' ? '%' : '') + '</div></div>';
    }).join('');
    return rows ? '<div class="lbl">Season trends</div><div class="card">' + rows + '</div>' : '';
  }

  /* ---------- pick this game's focus ---------- */
  async function renderNew(club, team, tok) {
    const here = view;
    app.innerHTML = header([teamHref(club, team), team], 'This game\'s focus') + '<div class="pad muted">Loading…</div>';
    let data;
    try { data = await api('/team', { token: tok }); } catch (e) { if (!lockedOut(club, team, e)) app.querySelector('.pad').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    if (here !== view) return;
    const last = data.games[0];
    const max = CAT.max || 4;
    // chosen: id -> goal (string, '' = no goal)
    let chosen = new Map();
    const lastGoals = {};
    data.games.slice().reverse().forEach((g) => g.metrics.forEach((m) => { if (m.goal != null) lastGoals[m.id] = m.goal; }));
    const useList = (ids, goals) => { chosen = new Map(); ids.filter((id) => CAT.byId[id]).slice(0, max).forEach((id) => chosen.set(id, goals && goals[id] != null ? String(goals[id]) : lastGoals[id] != null ? String(lastGoals[id]) : '')); };
    let from = last ? 'last' : 'core';
    if (last) useList(last.metrics.map((m) => m.id), Object.fromEntries(last.metrics.map((m) => [m.id, m.goal])));
    else useList(CAT.core);
    const today = new Date(Date.now() + 10.5 * 3600e3).toISOString().slice(0, 10);
    const nx = nextGame(club, team);

    function draw() {
      const groups = [];
      CAT.metrics.forEach((m) => { if (!groups.includes(m.group)) groups.push(m.group); });
      const chips = (last ? [['last', '↻ Same as last game']] : []).concat([['core', 'Club core']], Object.keys(CAT.presets).map((k) => [k, k]));
      app.querySelector('#body').innerHTML =
        (nx && !app.dataset.edit ? '<div class="card row" style="margin-top:2px"><div class="grow"><div class="lbl" style="margin:0 0 2px">This game</div><b>v ' + esc(nx.opp) + '</b><div class="muted" style="font-size:14px">' + esc([nx.r, nx.d ? fmtDay(nx.d) : ''].filter(Boolean).join(' · ')) + '</div></div><button type="button" class="btn o sm" id="other">Different game</button></div>'
          : '<div class="lbl" style="margin-top:4px">Opponent (optional)</div><input class="field" id="opp" placeholder="e.g. Echoes Dark" maxlength="60" value="' + esc(app.dataset.opp || '') + '">') +
        '<div class="lbl">Start from</div><div class="chips">' + chips.map(([k, l]) => '<button type="button" class="chip' + (from === k ? ' on' : '') + '" data-from="' + esc(k) + '">' + esc(l) + '</button>').join('') + '</div>' +
        '<div class="lbl">Pick up to ' + max + ' · set a goal <span style="color:var(--muted);letter-spacing:0">(' + chosen.size + '/' + max + ')</span></div><div class="card" style="padding-top:2px">' +
        groups.map((gname) => '<div class="grp">' + esc(gname) + '</div>' + CAT.metrics.filter((m) => m.group === gname).map((m) => {
          const on = chosen.has(m.id), full = !on && chosen.size >= max;
          return '<div class="mrow' + (full ? ' off' : '') + '"><input type="checkbox" data-m="' + m.id + '"' + (on ? ' checked' : '') + (full ? ' disabled' : '') + ' id="c_' + m.id + '">' +
            '<div class="grow"><label for="c_' + m.id + '" class="nm">' + esc(m.name) + (m.tap === 'made_missed' ? ' <span class="muted" style="font-weight:500">(made / missed)</span>' : '') + '</label><div class="df">' + esc(m.def) + '</div>' +
            (on && m.goal !== 'none' ? '<div class="goal">Goal: ' + (m.goal === 'under' ? 'under ' : '') + '<input type="number" inputmode="numeric" min="0" max="' + (m.goal === 'pct' ? 100 : 999) + '" data-goal="' + m.id + '" value="' + esc(chosen.get(m.id)) + '" placeholder="–">' +
              (m.goal === 'atleast' ? ' or more' : m.goal === 'pct' ? '% made' : '') + '</div>' : '') + '</div></div>';
        }).join('')).join('') + '</div>' +
        '<div class="err" id="msg"></div><button class="btn" id="go" type="button"' + (chosen.size ? '' : ' disabled') + '>Start tracking</button>' +
        '<p class="muted" style="font-size:13px">Goals are optional. You will get a scorer link to share with whoever is tapping.</p>';
      const body = app.querySelector('#body');
      const oppEl = body.querySelector('#opp');
      if (oppEl) oppEl.addEventListener('input', (e) => { app.dataset.opp = e.target.value; });
      const other = body.querySelector('#other');
      if (other) other.addEventListener('click', () => { app.dataset.edit = '1'; app.dataset.opp = ''; draw(); });
      body.querySelectorAll('[data-from]').forEach((b) => b.addEventListener('click', () => {
        from = b.dataset.from;
        if (from === 'last') useList(last.metrics.map((m) => m.id), Object.fromEntries(last.metrics.map((m) => [m.id, m.goal])));
        else if (from === 'core') useList(CAT.core); else useList(CAT.presets[from] || []);
        draw();
      }));
      body.querySelectorAll('[data-m]').forEach((c) => c.addEventListener('change', () => {
        if (c.checked) chosen.set(c.dataset.m, lastGoals[c.dataset.m] != null ? String(lastGoals[c.dataset.m]) : ''); else chosen.delete(c.dataset.m);
        from = ''; draw();
      }));
      body.querySelectorAll('[data-goal]').forEach((i) => i.addEventListener('input', () => { chosen.set(i.dataset.goal, i.value); }));
      body.querySelector('#go').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const g = await api('/games', { method: 'POST', token: tok, body: { opponent: nx && !app.dataset.edit ? nx.opp : app.dataset.opp || '', date: nx && !app.dataset.edit && nx.d ? nx.d : today, metrics: [...chosen].map(([id, goal]) => ({ id, goal: goal === '' ? null : Number(goal) })) } });
          delete app.dataset.opp; delete app.dataset.edit;
          location.hash = teamHref(club, team) + '/g/' + g.id + '?share=1';
        } catch (err) { e.target.disabled = false; if (!lockedOut(club, team, err)) body.querySelector('#msg').textContent = err.message; }
      });
    }
    app.innerHTML = header([teamHref(club, team), team], 'This game\'s focus', 'Pick what the team is working on today') + '<div class="pad" id="body"></div>';
    draw();
  }

  /* ---------- live scoring ---------- */
  async function renderScore(ctx) {
    let here = view;
    const id = ctx.id.replace(/\?.*$/, '');
    const wantShare = /\?share=1/.test(location.hash);
    const auth = ctx.key ? { key: ctx.key } : { token: ctx.tok };
    const qKey = 'trk.q.' + id, uKey = 'trk.u.' + id, qtKey = 'trk.qt.' + id;
    let queue = store.get(qKey, []);       // taps not yet confirmed by the server
    let mine = store.get(uKey, []);        // this phone's taps, newest last, for undo
    let quarter = store.get(qtKey, 1);
    let game = store.get('trk.g.' + id, null);
    let inflight = null, lastErr = '', finishArm = false;
    const back = ctx.key ? null : [teamHref(ctx.club, ctx.team), ctx.team];

    async function fetchGame() {
      try {
        game = await api('/games/' + id, auth); store.set('trk.g.' + id, game); lastErr = '';
      } catch (e) {
        if (!ctx.key && lockedOut(ctx.club, ctx.team, e)) return false;
        if (!game || e.status === 404 || e.status === 403) { app.innerHTML = header(back, 'Tracker') + '<div class="pad"><div class="err">' + esc(e.message) + '</div></div>'; return false; }
        lastErr = navigator.onLine ? e.message : 'offline';
      }
      return true;
    }
    if (!game || game.id !== id) { app.innerHTML = header(back, 'Tracker') + '<div class="pad muted">Loading…</div>'; if (!(await fetchGame())) return; }
    else fetchGame().then((ok) => { if (ok && here === view) draw(); });
    if (here !== view) return;
    if (game.status !== 'live' && !ctx.key) { /* coach can still fix a finished game */ }
    if (game.status !== 'live' && ctx.key) { location.hash = '#/s/' + id + '/' + ctx.key + '/summary'; return; }

    function shown() { // server totals plus taps this phone has not had confirmed yet
      const t = JSON.parse(JSON.stringify(game.totals || {}));
      queue.forEach((e) => {
        const m = t[e.m] || (t[e.m] = {}); const q = m[e.q] || (m[e.q] = {});
        q[e.v] = Math.max(0, (q[e.v] || 0) + (e.del ? -1 : 1));
      });
      return t;
    }
    function save() { store.set(qKey, queue); store.set(uKey, mine.slice(-200)); store.set(qtKey, quarter); }
    async function sync() {
      if (inflight || !navigator.onLine) { paintStatus(); return; }
      if (!queue.length) { await fetchGame(); if (here === view) paint(); return; }
      const batch = queue.slice(0, 300);
      inflight = new Set(batch.map((e) => e.id + (e.del ? ':d' : '')));
      try {
        game = await api('/games/' + id + '/taps', Object.assign({ method: 'POST', body: { events: batch } }, auth));
        store.set('trk.g.' + id, game);
        queue = queue.filter((e) => !inflight.has(e.id + (e.del ? ':d' : '')));
        lastErr = '';
      } catch (e) {
        lastErr = e.status === 409 ? 'This game was finished, so these taps were not saved.' : navigator.onLine ? e.message : 'offline';
        if (e.status === 409) queue = [];
      }
      inflight = null; save();
      if (here === view) paint();
    }
    function tap(m, v) {
      const e = { id: rid(), m, v, q: quarter, t: Date.now() };
      queue.push(e); mine.push({ id: e.id, m, v, q: quarter }); save();
      if (navigator.vibrate) navigator.vibrate(12);
      paint(m); setTimeout(sync, 300);
    }
    function undo() {
      const last = mine.pop();
      if (!last) { toast('Nothing to undo'); return; }
      const i = queue.findIndex((e) => e.id === last.id && !e.del);
      const sending = inflight && inflight.has(last.id);
      if (i >= 0 && !sending) queue.splice(i, 1);
      else queue.push({ id: last.id, m: last.m, v: last.v, q: last.q, t: Date.now(), del: 1 });
      save(); paint(); toast('Removed: ' + ((CAT.byId[last.m] || {}).name || '') + (last.v === '+' ? '' : ' (' + last.v + ')')); setTimeout(sync, 300);
    }

    function draw() {
      const opp = game.opponent ? 'v ' + game.opponent : fmtDay(game.date);
      app.innerHTML = header(back, ctx.key ? game.team : 'Tracking: this game\'s focus', ctx.key ? 'Scoring ' + opp : opp,
        '<div class="score-hd"><span id="qtag" class="qtag' + (game.status === 'live' ? '' : ' final') + '"></span><span id="sync" class="sync"></span>' +
        (ctx.key ? '' : '<button type="button" class="btn sm o" id="share" style="background:rgba(255,255,255,.15);color:#fff;border:0">Share scorer link</button>') + '</div>') +
        '<div class="pad" style="padding-bottom:40px"><div class="lbl" style="margin-top:2px">Tap when it happens · Undo fixes a mistake</div><div class="tiles n' + game.metrics.length + '" id="tiles"></div>' +
        '<div class="card" style="margin-top:12px"><div class="qline" id="qline"></div></div>' +
        (game.status !== 'live' ? '<div class="card">This game is finished. Taps you add now still count (coach only). <a href="' + teamHref(ctx.club, ctx.team) + '/g/' + id + '/summary">See the summary</a></div>' : '') +
        '</div><div class="bottom"><button type="button" id="undo">↶ Undo</button><button type="button" id="qnext"></button><button type="button" id="finish" class="go">Finish</button></div>';
      app.querySelector('#undo').addEventListener('click', undo);
      app.querySelector('#qnext').addEventListener('click', () => { quarter = Math.min(8, quarter + 1); save(); paint(); toast(QNAME(quarter) + ' started'); });
      app.querySelector('#qnext').addEventListener('contextmenu', (e) => { e.preventDefault(); quarter = Math.max(1, quarter - 1); save(); paint(); });
      const fin = app.querySelector('#finish');
      fin.addEventListener('click', async () => {
        if (game.status !== 'live') { location.hash = teamHref(ctx.club, ctx.team) + '/g/' + id + '/summary'; return; }
        if (!finishArm) { finishArm = true; fin.textContent = 'Tap again'; fin.className = 'warn'; setTimeout(() => { finishArm = false; if (fin.isConnected) { fin.textContent = 'Finish'; fin.className = 'go'; } }, 3000); return; }
        fin.disabled = true;
        await sync();
        if (queue.length) { fin.disabled = false; toast('Still sending taps. Try again when you have signal.'); return; }
        try { await api('/games/' + id + '/finish', Object.assign({ method: 'POST' }, auth)); }
        catch (e) { fin.disabled = false; toast(e.message); return; }
        [qKey, uKey, qtKey].forEach(store.del);
        location.hash = ctx.key ? '#/s/' + id + '/' + ctx.key + '/summary' : teamHref(ctx.club, ctx.team) + '/g/' + id + '/summary';
      });
      const sh = app.querySelector('#share');
      if (sh) sh.addEventListener('click', share);
      paint();
      if (wantShare && game.scorerKey && !ctx.shared) { ctx.shared = true; history.replaceState(null, '', location.hash.replace('?share=1', '')); view = here = location.hash; share(); }
    }
    function paint(flash) {
      const tl = app.querySelector('#tiles'); if (!tl) return;
      const t = shown();
      tl.innerHTML = game.metrics.map((m, i) => {
        const def = CAT.byId[m.id]; if (!def) return '';
        const v = measure(def, sumTotals(t[m.id]));
        const hit = goalHit(def, m.goal, v);
        const col = COLOURS[i % COLOURS.length];
        let bar = '';
        if (m.goal != null && def.goal !== 'none') {
          const frac = def.goal === 'pct' ? (v.pct || 0) / 100 : m.goal ? v.n / m.goal : 1;
          bar = '<div class="bar"><i style="width:' + Math.min(100, Math.round(frac * 100)) + '%"></i></div>';
        }
        const g = (m.goal != null && def.goal !== 'none' ? 'Goal: ' + goalText(def, m.goal) + (hit === true ? ' ✓' : def.goal === 'under' && hit === false ? ' ✗' : '') : def.group) + bar;
        const cls = 'tile' + (flash === m.id ? ' flash' : '');
        if (def.tap === 'made_missed') {
          return '<div class="' + cls + ' mmt" style="background:' + col + '"><div class="k">' + esc(def.name) + '</div><div class="v">' + v.made + '<small>/' + v.att + '</small></div>' +
            '<div class="mm"><button type="button" data-tap="' + m.id + '" data-v="made">✓ Made</button><button type="button" data-tap="' + m.id + '" data-v="missed">✗ Missed</button></div>' +
            '<div class="g" style="margin-top:8px">' + (v.pct != null ? v.pct + '% · ' : '') + g + '</div><button type="button" class="info" data-info="' + m.id + '" aria-label="What counts">?</button></div>';
        }
        return '<button type="button" class="' + cls + '" style="background:' + col + '" data-tap="' + m.id + '" data-v="+"><span class="pm">+</span><div class="k">' + esc(def.name) + '</div><div class="v">' + v.n + '</div><div class="g">' + g + '</div>' +
          '<span class="info" role="button" data-info="' + m.id + '" aria-label="What counts" style="display:flex;align-items:center;justify-content:center">?</span></button>';
      }).join('');
      tl.querySelectorAll('[data-tap]').forEach((b) => b.addEventListener('click', (e) => { if (e.target.closest('[data-info]')) return; tap(b.dataset.tap, b.dataset.v); }));
      tl.querySelectorAll('[data-info]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const d = CAT.byId[b.dataset.info]; sheet('<h3>' + esc(d.name) + '</h3><p>' + esc(d.def) + '</p><button class="btn" data-close>Got it</button>'); }));
      app.querySelector('#qtag').textContent = game.status === 'live' ? 'LIVE ' + QNAME(quarter) : 'FINISHED';
      app.querySelector('#qnext').textContent = quarter < 4 ? QNAME(quarter) + ' ▸ ' + QNAME(quarter + 1) : QNAME(quarter) + ' ▸ ' + QNAME(quarter + 1);
      app.querySelector('#qline').innerHTML = '<b>' + QNAME(quarter) + ' so far:</b> ' + game.metrics.map((m) => {
        const def = CAT.byId[m.id]; if (!def) return '';
        const v = measure(def, sumTotals({ x: (t[m.id] || {})[quarter] || {} }));
        return esc(def.name) + ' ' + (def.tap === 'made_missed' ? v.made + '/' + v.att : v.n);
      }).join(' · ');
      paintStatus();
    }
    function paintStatus() {
      const s = app.querySelector('#sync'); if (!s) return;
      if (queue.length) { s.className = 'sync wait'; s.textContent = '● ' + queue.length + ' on phone' + (lastErr === 'offline' || !navigator.onLine ? ' · no signal' : ' · sending'); }
      else if (lastErr && lastErr !== 'offline') { s.className = 'sync wait'; s.textContent = lastErr; }
      else { s.className = 'sync'; s.style.color = '#9AE6B4'; s.textContent = '● Saved'; }
    }
    function share() {
      const link = location.origin + location.pathname + '#/s/' + id + '/' + game.scorerKey;
      sheet('<h3>Share the scorer link</h3><p class="muted" style="margin:0">Whoever opens this can tap for this game only, for 48 hours. No PIN needed.</p><div class="qr" id="qr"></div><div class="linkbox">' + esc(link) + '</div>' +
        '<div class="row"><button class="btn o" id="copy">Copy link</button>' + (navigator.share ? '<button class="btn" id="native">Share…</button>' : '') + '</div><button class="btn o" data-close style="margin-top:10px">Done</button>');
      try { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); document.getElementById('qr').innerHTML = q.createImgTag(5, 4, 'Scorer link QR code'); } catch (e) { /* the link is enough */ }
      document.getElementById('copy').onclick = () => { navigator.clipboard.writeText(link).then(() => toast('Link copied')); };
      const n = document.getElementById('native');
      if (n) n.onclick = () => navigator.share({ title: 'Scorer link: ' + game.team, text: 'Tap team stats for ' + game.team + (game.opponent ? ' v ' + game.opponent : ''), url: link }).catch(() => {});
    }
    draw();
    timer = setInterval(sync, queue.length ? 4000 : 8000);
    window.addEventListener('online', sync);
    setTimeout(sync, 500);
  }

  function leftText(until) { const h = Math.max(0, (until - Date.now()) / 3600e3); return h >= 1 ? Math.floor(h) + ' h' : Math.max(1, Math.round(h * 60)) + ' min'; }
  function sheet(html) {
    const s = document.createElement('div'); s.className = 'sheet'; s.innerHTML = '<div>' + html + '</div>';
    s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) s.remove(); });
    document.body.appendChild(s);
    return s;
  }

  /* ---------- after the game ---------- */
  async function renderSummary(ctx) {
    const here = view;
    const auth = ctx.key ? { key: ctx.key } : { token: ctx.tok };
    const back = ctx.key ? null : [teamHref(ctx.club, ctx.team), ctx.team];
    app.innerHTML = header(back, 'Game summary') + '<div class="pad muted">Loading…</div>';
    let game, team = null;
    try {
      game = await api('/games/' + ctx.id, auth);
      if (!ctx.key) team = await api('/team', { token: ctx.tok });
    } catch (e) { if (!(ctx.key ? false : lockedOut(ctx.club, ctx.team, e))) app.querySelector('.pad').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; return; }
    if (here !== view) return;
    // the previous finished game, for "last game" comparisons
    let prev = null;
    if (team) { const done = team.games.filter((g) => g.status !== 'live'); const i = done.findIndex((g) => g.id === game.id); prev = i >= 0 ? done[i + 1] : done[0]; if (prev && prev.id === game.id) prev = null; }
    const rows = game.metrics.map((m) => {
      const def = CAT.byId[m.id]; if (!def) return null;
      const v = measure(def, sumTotals(game.totals[m.id]));
      const hit = goalHit(def, m.goal, v);
      let cmp = '';
      if (prev && prev.metrics.some((x) => x.id === m.id)) { const pv = measure(def, prev.totals[m.id] || {}); cmp = 'Last game ' + valueText(def, pv); }
      return { def, m, v, hit, cmp };
    }).filter(Boolean);
    const withGoal = rows.filter((r) => r.hit != null), hits = withGoal.filter((r) => r.hit).length;
    const quarters = [];
    Object.values(game.totals).forEach((x) => Object.keys(x).forEach((q) => { if (!quarters.includes(+q)) quarters.push(+q); }));
    quarters.sort((a, b) => a - b);
    const text = game.team + (game.opponent ? ' v ' + game.opponent : '') + ' (' + fmtDay(game.date) + ')\n' +
      rows.map((r) => r.def.name + ': ' + valueText(r.def, r.v) + (r.hit != null ? ' (goal ' + goalText(r.def, r.m.goal) + ' ' + (r.hit ? '✓' : '✗') + ')' : '')).join('\n') +
      (withGoal.length ? '\nTeam goals hit: ' + hits + ' of ' + withGoal.length : '');
    app.innerHTML = header(back, (game.opponent ? 'v ' + game.opponent : 'Game') + ' · ' + fmtDay(game.date), withGoal.length ? 'Team goals: ' + hits + ' of ' + withGoal.length + ' hit' : game.team) +
      '<div class="pad">' + (game.status === 'live' ? '<div class="card"><span class="pill live">LIVE</span> Still being tracked. Numbers will change.</div>' : '') +
      '<div class="card" style="padding:2px 16px">' + rows.map((r) => '<div class="res"><div class="ic" style="background:' + (r.hit == null ? '#A0AEC0' : r.hit ? 'var(--ok)' : 'var(--bad)') + '">' + (r.hit == null ? '•' : r.hit ? '✓' : '✗') + '</div>' +
        '<div class="grow"><div class="k">' + esc(r.def.name) + (r.hit != null ? ' · ' + esc(goalText(r.def, r.m.goal)) : '') + '</div><div class="dd">' + esc(r.cmp || r.def.group) + '</div></div>' +
        '<div class="v">' + esc(r.def.tap === 'made_missed' ? (r.v.pct != null ? r.v.pct + '%' : '–') : r.v.n) + '</div></div>').join('') + '</div>' +
      (quarters.length ? '<div class="lbl">By quarter</div><div class="card"><table class="q"><thead><tr><th></th>' + quarters.map((q) => '<th>' + QNAME(q) + '</th>').join('') + '<th>ALL</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td>' + esc(r.def.name) + '</td>' + quarters.map((q) => { const v = measure(r.def, sumTotals({ x: (game.totals[r.m.id] || {})[q] || {} })); return '<td>' + (r.def.tap === 'made_missed' ? v.made + '/' + v.att : v.n) + '</td>'; }).join('') +
          '<td><b>' + (r.def.tap === 'made_missed' ? r.v.made + '/' + r.v.att : r.v.n) + '</b></td></tr>').join('') + '</tbody></table></div>' : '') +
      '<button class="btn" id="copy" type="button">Copy team summary</button><p class="muted" style="font-size:13px">Team totals only, no names. Paste it into the team chat.</p>' +
      (ctx.key ? '' : '<div class="row" style="margin-top:8px"><a class="btn o sm" href="' + teamHref(ctx.club, ctx.team) + '/g/' + game.id + '">Fix taps</a>' +
        (game.status === 'live' ? '' : '<button class="btn o sm" id="reopen" type="button">Reopen for scorer</button>') + '</div>' +
        '<div class="dz"><button class="btn danger sm" id="del" type="button">Delete game…</button></div>') + '</div>';
    app.querySelector('#copy').addEventListener('click', () => { navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => sheet('<h3>Team summary</h3><div class="linkbox" style="white-space:pre-wrap">' + esc(text) + '</div><button class="btn" data-close>Done</button>')); });
    const ro = app.querySelector('#reopen');
    if (ro) ro.addEventListener('click', async () => { await api('/games/' + game.id + '/reopen', { method: 'POST', token: ctx.tok }); location.hash = teamHref(ctx.club, ctx.team) + '/g/' + game.id; });
    const del = app.querySelector('#del');
    if (del) {
      del.addEventListener('click', () => {
        const sh = sheet('<h3>Delete this game?</h3><p>' + esc((game.opponent ? 'v ' + game.opponent + ', ' : '') + fmtDay(game.date)) + '. It comes off your games and trends, and the scorer link stops working. You can restore it from your team page for 24 hours.</p>' +
          '<div class="row"><button class="btn o" data-close type="button">Keep it</button><button class="btn warn" id="delyes" type="button">Delete</button></div>');
        sh.querySelector('#delyes').addEventListener('click', async (e) => {
          e.target.disabled = true;
          try { await api('/games/' + game.id + '/delete', { method: 'POST', token: ctx.tok }); }
          catch (err) { sh.remove(); toast(err.message); return; }
          sh.remove(); toast('Game deleted. Restore it from Recently deleted.');
          location.hash = teamHref(ctx.club, ctx.team);
        });
      });
    }
  }

  route();
})();
