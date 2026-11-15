/* Club portal: lets a club manage its sponsors, branding and logins for the results site. */
(function () {
  'use strict';
  const root = document.getElementById('root');
  const COMPS = [2861]; // competitions the site shows, for the team list
  // Clubs outside this competition that use the portal (for now just the team stat tracker).
  const CLUB_COMPS = { lions: [2890, 2891, 2892] };
  const SQUADI = 'https://api-basketball.squadi.com';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let ME = null, CLUB = null, PAGE = 'overview', DIRTY = false;

  async function call(path, opts) {
    opts = opts || {};
    const res = await fetch(path, Object.assign({ credentials: 'same-origin', headers: opts.raw ? { 'Content-Type': opts.type } : { 'Content-Type': 'application/json' } }, opts, { body: opts.raw ? opts.raw : opts.body ? JSON.stringify(opts.body) : undefined }));
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { ME = null; renderLogin(); throw new Error(j.error || 'Please sign in'); }
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  /* ---------- sign in ---------- */
  function renderLogin(msg) {
    root.innerHTML = '<div class="center"><h1>Club portal</h1><p class="muted">Sign in to manage your club\'s page, sponsors and Plus.</p>' +
      '<form class="card" id="login"><label>Email</label><input type="email" name="email" autocomplete="username" required>' +
      '<label>Password</label><input type="password" name="password" autocomplete="current-password" required>' +
      '<div style="margin-top:16px"><button class="btn" type="submit">Sign in</button></div>' + (msg ? '<div class="err">' + esc(msg) + '</div>' : '') + '</form></div>';
    root.querySelector('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await call('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); await boot(); }
      catch (err) { renderLogin(err.message); }
    });
  }

  async function boot() {
    try { ME = await call('/api/me'); } catch (e) { return renderLogin(); }
    const want = sessionStorage.getItem('portal.club');
    CLUB = ME.clubs.find((c) => c.slug === want) || ME.clubs.find((c) => c.slug === ME.club) || ME.clubs[0];
    const h = location.hash.replace('#', '');
    if (h) PAGE = h;
    render();
  }

  /* ---------- layout ---------- */
  const PAGES = [['overview', 'Overview'], ['sponsors', 'Sponsors'], ['branding', 'Branding'], ['plus', 'Plus and club link'], ['tracker', 'Team tracker'], ['people', 'Club logins']];
  function render() {
    if (!CLUB) { root.innerHTML = '<div class="center">No club is linked to this login.</div>'; return; }
    const pageList = PAGES.concat(ME.admin ? [['clubs', 'All clubs']] : []);
    root.innerHTML = '<div class="shell"><aside class="side">' +
      (ME.admin ? '<select id="clubpick">' + ME.clubs.map((c) => '<option value="' + esc(c.slug) + '"' + (c.slug === CLUB.slug ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>' : '') +
      '<div class="club">' + badge(CLUB, 42) + '<div><b>' + esc(CLUB.name) + '</b><span>' + (CLUB.plus ? 'Plus' + (CLUB.plusUntil ? ' until ' + esc(fmtDate(CLUB.plusUntil)) : '') : 'Free') + '</span></div></div>' +
      '<nav class="nav">' + pageList.map(([k, l]) => (k === 'clubs' ? '<div class="sep">SITE ADMIN</div>' : '') + '<a href="#' + k + '" data-page="' + k + '" class="' + (PAGE === k ? 'on' : '') + '">' + esc(l) + (k === 'plus' ? ' <span class="pill' + (CLUB.plus ? ' plus' : '') + '">' + (CLUB.plus ? 'ACTIVE' : 'OFF') + '</span>' : '') + '</a>').join('') + '</nav>' +
      '<div class="who">' + esc(ME.name || ME.email) + '<br><a href="#account" data-page="account" style="color:#C9D1DD">Password</a> · <button type="button" id="logout">Sign out</button></div>' +
      '</aside><main class="main" id="main"></main></div>';
    const pick = root.querySelector('#clubpick');
    if (pick) pick.addEventListener('change', () => { CLUB = ME.clubs.find((c) => c.slug === pick.value); sessionStorage.setItem('portal.club', CLUB.slug); render(); });
    root.querySelector('#logout').addEventListener('click', async () => { await call('/api/logout', { method: 'POST' }).catch(() => {}); ME = null; renderLogin(); });
    const main = root.querySelector('#main');
    ({ overview: pageOverview, sponsors: pageSponsors, branding: pageBranding, plus: pagePlus, tracker: pageTracker, people: pagePeople, clubs: pageClubs, account: pageAccount }[PAGE] || pageOverview)(main);
  }
  window.addEventListener('hashchange', () => {
    if (!ME) return;
    if (DIRTY && !confirmLeave()) { history.replaceState(null, '', '#' + PAGE); return; }
    DIRTY = false; PAGE = location.hash.replace('#', '') || 'overview'; render();
  });
  function confirmLeave() { return window.confirm('You have unsaved changes. Leave without saving?'); }
  function badge(c, size) {
    const st = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:none;overflow:hidden;';
    if (c.logo) return '<span style="' + st + 'background:' + esc((c.colours && c.colours.dark) || '#071648') + '"><img src="' + esc(c.logo) + '" alt="" style="width:86%;height:86%;object-fit:contain"></span>';
    return '<span style="' + st + 'background:#8A94A6;color:#fff;font-weight:800;font-size:' + Math.round(size * 0.34) + 'px">' + esc(c.short.slice(0, 2).toUpperCase()) + '</span>';
  }
  const fmtDate = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; } };
  const n = (x) => Number(x || 0).toLocaleString('en-AU');
  function siteLink(c) { return (ME.siteUrl || '').replace(/\/$/, '') + '/?c=' + encodeURIComponent(c.slug); }
  function refreshClub(c) { CLUB = c; ME.clubs = ME.clubs.map((x) => (x.slug === c.slug ? c : x)); }

  /* ---------- overview ---------- */
  async function pageOverview(main) {
    main.innerHTML = '<h1>Overview</h1><div class="muted">Loading numbers…</div>';
    let s;
    try { s = await call('/api/clubs/' + CLUB.slug + '/stats?days=30'); } catch (e) { main.innerHTML = '<h1>Overview</h1><div class="err">' + esc(e.message) + '</div>'; return; }
    const pct = (a, b) => (b ? Math.round((a - b) / b * 100) : null);
    const ch = (a, b) => { const p = pct(a, b); return p == null ? '<span class="s">last 30 days</span>' : '<span class="s' + (p >= 0 ? ' up' : '') + '">' + (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p) + '% on the 30 days before</span>'; };
    const sp = CLUB.sponsors || { list: {} };
    const rows = Object.entries(s.bySponsor).sort((a, b) => b[1].views - a[1].views);
    const max = Math.max(1, ...rows.map((r) => r[1].views));
    main.innerHTML = '<h1>Overview</h1>' +
      '<div class="kpis"><div class="kpi"><div class="k">Sponsor views</div><div class="v">' + n(s.views) + '</div>' + ch(s.views, s.prevViews) + '</div>' +
      '<div class="kpi"><div class="k">Taps to sponsor sites</div><div class="v">' + n(s.taps) + '</div>' + ch(s.taps, s.prevTaps) + '</div>' +
      '<div class="kpi"><div class="k">Sponsors</div><div class="v">' + Object.keys(sp.list || {}).length + '</div><span class="s">on your club page</span></div>' +
      '<div class="kpi"><div class="k">Plus</div><div class="v" style="font-size:26px">' + (CLUB.plus ? 'Active' : 'Off') + '</div><span class="s">' + (CLUB.plusUntil ? 'until ' + esc(fmtDate(CLUB.plusUntil)) : CLUB.plus ? '' : 'Branding and sponsors show once Plus is on') + '</span></div></div>' +
      '<div class="card"><div class="row"><h2 class="grow" style="margin:0">Sponsor report · last 30 days</h2><button class="btn o sm" type="button" id="csv">Download CSV</button></div>' +
      (rows.length ? '<table><thead><tr><th>Sponsor</th><th>Views</th><th></th><th>Taps</th><th>Tap rate</th></tr></thead><tbody>' + rows.map(([id, r]) =>
        '<tr><td><b>' + esc((sp.list[id] || {}).name || id) + '</b></td><td>' + n(r.views) + '</td><td style="width:30%"><div class="bar"><i style="width:' + (r.views / max * 100).toFixed(1) + '%"></i></div></td><td>' + n(r.taps) + '</td><td>' + (r.views ? (r.taps / r.views * 100).toFixed(1) + '%' : '–') + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="muted">No sponsor views yet. They are counted each time a family sees a sponsor on your club page.</p>') +
      '<p class="muted" style="font-size:13px">A view is counted once per sponsor per page a family opens. A tap is a tap through to the sponsor\'s website.</p></div>' +
      '<div class="card"><h2>Your club page</h2><p><a href="' + esc(siteLink(CLUB)) + '" target="_blank" rel="noopener">' + esc(siteLink(CLUB)) + '</a></p></div>';
    main.querySelector('#csv').addEventListener('click', () => {
      const lines = [['Sponsor', 'Views', 'Taps']].concat(rows.map(([id, r]) => [(sp.list[id] || {}).name || id, r.views, r.taps]));
      const blob = new Blob([lines.map((l) => l.map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = CLUB.slug + '-sponsor-report.csv'; a.click();
    });
  }

  /* ---------- logo upload ---------- */
  async function uploadLogo(file, kind) {
    if (!file) return null;
    if (file.size > 1024 * 1024) throw new Error('That image is over 1 MB. Please use a smaller one.');
    return call('/api/clubs/' + CLUB.slug + '/upload?kind=' + kind, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
  }

  /* ---------- sponsors ---------- */
  let TEAM_NAMES = null;
  async function teamNames() {
    if (TEAM_NAMES && TEAM_NAMES.club === CLUB.slug) return TEAM_NAMES.list;
    const re = new RegExp(CLUB.match, 'i');
    const out = new Set();
    try {
      for (const id of CLUB_COMPS[CLUB.slug] || COMPS) {
        const j = await fetch(SQUADI + '/livescores/round/matches?competitionId=' + id + '&divisionId=&teamIds=&ignoreStatuses=[1]').then((r) => r.json());
        (j.rounds || []).forEach((rd) => (rd.matches || []).forEach((m) => [m.team1, m.team2].forEach((t) => { if (t && t.name && re.test(t.name.trim())) out.add(teamKey(t.name)); })));
      }
    } catch (e) { /* the list is a convenience; typing still works */ }
    TEAM_NAMES = { club: CLUB.slug, list: [...out].sort() };
    return TEAM_NAMES.list;
  }
  // Same naming as the site's team page heading, e.g. "U14 Girls Panthers" or "Senior Men Panthers A".
  function teamKey(name) {
    const SEX = { B: 'Boys', G: 'Girls', M: 'Men', W: 'Women' };
    const nm = name.trim().replace(/\s+/g, ' ');
    let age = '', sex = '', num = '', grade = '', rest = nm, m;
    if ((m = nm.match(/^(U\d+|S|R)([BGMW])\s+(.*)$/))) { age = m[1] === 'S' ? 'Senior' : m[1] === 'R' ? 'Reserves' : m[1]; sex = SEX[m[2]]; rest = m[3]; num = (rest.match(/\s(\d+)$/) || [])[1] || ''; if (num) rest = rest.replace(/\s\d+$/, ''); }
    else if ((m = nm.match(/U(\d+)(?:\/(\d+))?([BG])([A-Z]?\d*)(?![a-z])/))) { age = 'U' + m[1] + (m[2] ? '/' + m[2] : ''); sex = SEX[m[3]]; num = m[4] || ''; rest = nm.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); }
    else if ((m = nm.match(/\b([ABC])(?:\/\d)?\s+(Men|Women)\b/))) { age = 'Senior'; grade = m[1]; sex = m[2]; rest = nm.replace(new RegExp('\\b' + m[1] + '\\s+' + m[2] + '\\b', 'g'), ' ').replace(/\s+/g, ' ').trim(); }
    const re = new RegExp(CLUB.match, 'i');
    const extra = rest.replace(re, '').replace(/^[\s-]+|[\s-]+$/g, '');
    const short = [[CLUB.short, extra].filter(Boolean).join(' '), grade, num].filter(Boolean).join(' ');
    return ((age + ' ' + sex).trim() + ' ' + short).trim();
  }

  function pageSponsors(main) {
    const sp = JSON.parse(JSON.stringify(CLUB.sponsors || {}));
    sp.list = sp.list || {}; sp.wall = sp.wall || []; sp.teams = sp.teams || {};
    const ids = () => Object.keys(sp.list);
    const opt = (sel) => '<option value="">None</option>' + ids().map((id) => '<option value="' + esc(id) + '"' + (sel === id ? ' selected' : '') + '>' + esc(sp.list[id].name) + '</option>').join('');
    function draw() {
      main.innerHTML = '<h1>Sponsors</h1>' + (CLUB.plus ? '' : '<div class="card" style="border-color:#F2C14E;background:#FFFBEF"><b>Plus is off for this club.</b> You can set sponsors up now; they appear on the site once Plus is switched on.</div>') +
        '<div class="card"><div class="row"><h2 class="grow" style="margin:0">Your sponsors</h2><button class="btn sm" type="button" id="add">+ Add sponsor</button></div>' +
        (ids().length ? '' : '<p class="muted">No sponsors yet.</p>') +
        ids().map((id) => { const s = sp.list[id]; return '<div class="sp-edit" data-id="' + esc(id) + '"><div class="row"><div class="logo-box' + (s.dark ? ' dark' : '') + '">' + (s.logoUrl || s.logo ? '<img src="' + esc(s.logoUrl || '/files/' + s.logo) + '" alt="">' : 'LOGO') + '</div>' +
          '<div class="grow"><b>' + esc(s.name) + '</b><div>' + placements(id).map((p) => '<span class="tag' + (p.g ? ' gold' : p.t ? ' green' : '') + '">' + esc(p.l) + '</span>').join('') + '</div></div>' +
          '<label class="btn o sm" style="margin:0">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo hidden></label><button class="btn danger sm" type="button" data-del>Remove</button></div>' +
          '<div class="grid2"><div><label>Name</label><input type="text" data-f="name" value="' + esc(s.name) + '"></div><div><label>Website</label><input type="url" data-f="url" placeholder="https://" value="' + esc(s.url) + '"></div>' +
          '<div><label>Short blurb (results feed card)</label><input type="text" data-f="blurb" maxlength="160" value="' + esc(s.blurb) + '"></div><div><label>Button text</label><input type="text" data-f="cta" maxlength="30" placeholder="Visit website" value="' + esc(s.cta) + '"></div></div>' +
          '<label class="chk"><input type="checkbox" data-f="dark"' + (s.dark ? ' checked' : '') + '> Logo is light, show it on a dark background</label></div>'; }).join('') + '</div>' +
        '<div class="card"><h2>Where they appear</h2><div class="grid2">' +
        '<div><label>Header strip on Game day</label><select data-p="presenting">' + opt(sp.presenting) + '</select></div>' +
        '<div><label>Strip wording</label><input type="text" data-p="presentingLabel" placeholder="Game day presented by" value="' + esc(sp.presentingLabel || '') + '"></div>' +
        '<div><label>Card in the Game day feed</label><select data-p="feed">' + opt(sp.feed) + '</select></div>' +
        '<div><label>Empty "Your logo here" spots on the wall</label><input type="number" min="0" max="8" data-p="wallSlots" value="' + esc(sp.wallSlots || 0) + '"></div></div>' +
        '<label>Sponsor wall (bottom of every page)</label>' + (ids().length ? ids().map((id) => '<label class="chk"><input type="checkbox" data-wall="' + esc(id) + '"' + (sp.wall.includes(id) ? ' checked' : '') + '> ' + esc(sp.list[id].name) + '</label>').join('') : '<p class="muted">Add a sponsor first.</p>') +
        '<label>Team sponsors (shown on the team page)</label><div id="teams">' + Object.entries(sp.teams).map(([t, id]) => teamRow(t, id)).join('') + '</div>' +
        '<button class="btn o sm" type="button" id="addteam" style="margin-top:8px">+ Team sponsor</button><datalist id="teamlist"></datalist></div>' +
        '<div class="row"><button class="btn" type="button" id="save">Save sponsors</button><span id="msg"></span></div>';
      wire();
    }
    function teamRow(team, id) {
      return '<div class="row team-row" style="margin:6px 0"><input type="text" list="teamlist" class="grow" data-team placeholder="e.g. U14 Girls ' + esc(CLUB.short) + '" value="' + esc(team) + '" style="min-width:200px;flex:2"><select data-teamsp style="flex:1;min-width:140px">' + opt(id) + '</select><button class="btn danger sm" type="button" data-rmteam>×</button></div>';
    }
    function placements(id) {
      const out = [];
      if (sp.presenting === id) out.push({ l: 'Header strip', g: 1 });
      if (sp.feed === id) out.push({ l: 'Feed card' });
      if (sp.wall.includes(id)) out.push({ l: 'Sponsor wall' });
      Object.entries(sp.teams).forEach(([t, s]) => { if (s === id) out.push({ l: t, t: 1 }); });
      if (!out.length) out.push({ l: 'Not placed yet' });
      return out;
    }
    function collect() {
      main.querySelectorAll('.sp-edit').forEach((el) => {
        const s = sp.list[el.dataset.id];
        el.querySelectorAll('[data-f]').forEach((i) => { s[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value; });
      });
      main.querySelectorAll('[data-p]').forEach((i) => { sp[i.dataset.p] = i.value || null; });
      sp.wallSlots = parseInt(sp.wallSlots, 10) || 0;
      sp.wall = [...main.querySelectorAll('[data-wall]')].filter((i) => i.checked).map((i) => i.dataset.wall);
      sp.teams = {};
      main.querySelectorAll('.team-row').forEach((r) => { const t = r.querySelector('[data-team]').value.trim(), id = r.querySelector('[data-teamsp]').value; if (t && id) sp.teams[t] = id; });
    }
    function wire() {
      main.addEventListener('input', () => { DIRTY = true; }, { once: true });
      main.querySelector('#add').addEventListener('click', () => {
        collect();
        const name = window.prompt('Sponsor name');
        if (!name) return;
        let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'sponsor';
        while (sp.list[id]) id += '-2';
        sp.list[id] = { name, url: '', blurb: '', cta: '', dark: false, logo: null };
        DIRTY = true; draw();
      });
      main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
        collect();
        const id = b.closest('.sp-edit').dataset.id;
        if (!window.confirm('Remove ' + sp.list[id].name + '? It comes off the site when you save.')) return;
        delete sp.list[id];
        if (sp.presenting === id) sp.presenting = null;
        if (sp.feed === id) sp.feed = null;
        sp.wall = sp.wall.filter((x) => x !== id);
        Object.keys(sp.teams).forEach((t) => { if (sp.teams[t] === id) delete sp.teams[t]; });
        DIRTY = true; draw();
      }));
      main.querySelectorAll('[data-logo]').forEach((inp) => inp.addEventListener('change', async () => {
        collect();
        const id = inp.closest('.sp-edit').dataset.id;
        try { const r = await uploadLogo(inp.files[0], 'sponsor'); sp.list[id].logo = r.key; sp.list[id].logoUrl = r.url; DIRTY = true; draw(); toast('Logo uploaded. Save to put it live.'); }
        catch (e) { toast(e.message); }
      }));
      main.querySelector('#addteam').addEventListener('click', () => { main.querySelector('#teams').insertAdjacentHTML('beforeend', teamRow('', '')); wireTeams(); });
      wireTeams();
      teamNames().then((list) => { const dl = main.querySelector('#teamlist'); if (dl) dl.innerHTML = list.map((t) => '<option value="' + esc(t) + '">').join(''); });
      main.querySelector('#save').addEventListener('click', async (e) => {
        collect();
        e.target.disabled = true;
        const out = JSON.parse(JSON.stringify(sp));
        Object.values(out.list).forEach((s) => { delete s.logoUrl; if (s.logo && s.logo.startsWith('/files/')) s.logo = s.logo.slice(7); });
        try { refreshClub(await call('/api/clubs/' + CLUB.slug + '/sponsors', { method: 'PUT', body: out })); DIRTY = false; toast('Sponsors saved. The site picks them up within a minute.'); render(); }
        catch (err) { e.target.disabled = false; main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
      });
    }
    function wireTeams() { main.querySelectorAll('[data-rmteam]').forEach((b) => { b.onclick = () => { b.closest('.team-row').remove(); DIRTY = true; }; }); }
    // Logos come back from the API as /files/<key>; keep the key for saving.
    Object.values(sp.list).forEach((s) => { if (s.logo && s.logo.startsWith('/files/')) { s.logoUrl = s.logo; s.logo = s.logo.slice(7); } });
    draw();
  }

  /* ---------- branding ---------- */
  function pageBranding(main) {
    const c = JSON.parse(JSON.stringify(CLUB));
    c.colours = c.colours || { primary: '#14309A', dark: '#071648', accent: '#F28C28' };
    function draw() {
      main.innerHTML = '<h1>Branding</h1><div class="row" style="align-items:flex-start;gap:24px"><div class="card grow" style="min-width:300px">' +
        '<label>Club name</label><input type="text" id="name" value="' + esc(c.name) + '">' +
        '<label>Short name (used for teams, e.g. "' + esc(c.short) + ' 1")</label><input type="text" id="short" value="' + esc(c.short) + '">' +
        '<label>Colours</label><div class="row"><span>Main <input type="color" id="primary" value="' + esc(c.colours.primary) + '"></span><span>Dark <input type="color" id="dark" value="' + esc(c.colours.dark) + '"></span><span>Highlight <input type="color" id="accent" value="' + esc(c.colours.accent) + '"></span></div>' +
        '<label>Club logo (PNG with a see-through background works best)</label><div class="row"><div class="logo-box dark" style="width:64px;height:64px;border-radius:50%">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : 'LOGO') + '</div>' +
        '<label class="btn o sm" style="margin:0">Upload logo<input type="file" id="logo" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden></label>' + (c.logo ? '<button class="btn danger sm" type="button" id="nologo">Remove</button>' : '') + '</div>' +
        '<div class="row" style="margin-top:18px"><button class="btn" type="button" id="save">Save branding</button><span id="msg"></span></div></div>' +
        '<div><label style="margin-top:0">Preview</label><div class="preview"><div class="h" style="background:' + esc(c.colours.primary) + '">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : '') + '<div><b>' + esc(c.name.toUpperCase()) + '</b><span style="font-size:12px;opacity:.8">Summer Season 2026/27</span></div></div>' +
        '<div class="tabs" style="background:' + esc(c.colours.primary) + '"><span class="on" style="border-color:' + esc(c.colours.accent) + '">Game day</span><span>Results</span><span>Teams</span></div>' +
        '<div class="b"><div style="background:' + esc(c.colours.dark) + ';color:#fff;border-radius:10px;padding:10px 12px"><b style="color:' + esc(c.colours.accent) + '">● LIVE</b> · ' + esc(c.short) + ' 31 – 24</div></div></div>' +
        (CLUB.plus ? '' : '<p class="muted" style="max-width:380px">Your logo and colours show on the site once Plus is on. Until then the club appears in neutral grey with its initials.</p>') + '</div></div>';
      ['name', 'short', 'primary', 'dark', 'accent'].forEach((k) => main.querySelector('#' + k).addEventListener('change', (e) => { DIRTY = true; if (k === 'name' || k === 'short') c[k] = e.target.value; else c.colours[k] = e.target.value; draw(); }));
      main.querySelector('#logo').addEventListener('change', async (e) => {
        try { const r = await uploadLogo(e.target.files[0], 'club'); c.logo = r.url; c.logoKey = r.key; DIRTY = true; draw(); toast('Logo uploaded. Save to put it live.'); } catch (err) { toast(err.message); }
      });
      const nl = main.querySelector('#nologo'); if (nl) nl.addEventListener('click', () => { c.logo = null; c.logoKey = null; DIRTY = true; draw(); });
      main.querySelector('#save').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { refreshClub(await call('/api/clubs/' + CLUB.slug, { method: 'PUT', body: { name: c.name, short: c.short, colours: c.colours, logoKey: c.logoKey } })); DIRTY = false; toast('Branding saved.'); render(); }
        catch (err) { e.target.disabled = false; main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
      });
    }
    draw();
  }

  /* ---------- plus and link ---------- */
  function pagePlus(main) {
    const link = siteLink(CLUB);
    main.innerHTML = '<h1>Plus and club link</h1>' +
      '<div class="card"><div class="row"><span class="pill' + (CLUB.plus ? ' plus' : '') + '" style="font-size:14px">' + (CLUB.plus ? 'PLUS' : 'FREE') + '</span><div class="grow"><b>' + (CLUB.plus ? 'Plus is on for every ' + esc(CLUB.short) + ' team' : 'Plus is off') + '</b><br><span class="muted">' +
      (CLUB.plus ? (CLUB.plusUntil ? 'Until ' + esc(fmtDate(CLUB.plusUntil)) : 'No end date') + (CLUB.plusNote ? ' · ' + esc(CLUB.plusNote) : '') : 'Families see fixtures, live scores, results and ladders. Plus adds live fouls, the live worm, alerts, and your logo, colours and sponsors.') + '</span></div></div>' +
      (ME.admin ? '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><b>Site admin</b><div class="grid2"><div><label class="chk" style="margin-top:14px"><input type="checkbox" id="plus"' + (CLUB.plus ? ' checked' : '') + '> Plus on</label></div><div><label>Plus until</label><input type="date" id="until" value="' + esc(CLUB.plusUntil || '') + '"></div>' +
        '<div><label>Note (who pays, invoice)</label><input type="text" id="note" value="' + esc(CLUB.plusNote || '') + '"></div><div><label>Team name pattern</label><input type="text" id="match" value="' + esc(CLUB.match) + '"></div>' +
        '<div><label>Club domain (shown to the club)</label><input type="text" id="link" placeholder="panthers.adamforb.es" value="' + esc(CLUB.link || '') + '"></div></div><div class="row" style="margin-top:14px"><button class="btn" id="saveplus" type="button">Save</button><span id="msg"></span></div>' : '') + '</div>' +
      '<div class="card"><h2>Your club link</h2><p>Share this anywhere. It opens the site straight on your club, and phones remember it.</p><p><a href="' + esc(link) + '" target="_blank" rel="noopener"><b>' + esc(CLUB.link || link) + '</b></a></p>' +
      '<div class="row" style="align-items:flex-start"><div class="qr" id="qr"></div><div><p class="muted" style="max-width:320px">Print the QR code for the canteen, the newsletter or the bench. Right-click (or long-press) the code to save it.</p><button class="btn o sm" type="button" id="copy">Copy link</button></div></div></div>';
    const target = CLUB.link ? 'https://' + CLUB.link.replace(/^https?:\/\//, '') : link;
    try { const q = window.qrcode(0, 'M'); q.addData(target); q.make(); main.querySelector('#qr').innerHTML = q.createImgTag(5, 8, 'QR code for ' + target); } catch (e) { main.querySelector('#qr').textContent = 'QR code unavailable'; }
    main.querySelector('#copy').addEventListener('click', () => { navigator.clipboard.writeText(target).then(() => toast('Link copied')); });
    const sv = main.querySelector('#saveplus');
    if (sv) sv.addEventListener('click', async () => {
      sv.disabled = true;
      try {
        refreshClub(await call('/api/clubs/' + CLUB.slug, { method: 'PUT', body: { plus: main.querySelector('#plus').checked, plusUntil: main.querySelector('#until').value || null, plusNote: main.querySelector('#note').value, match: main.querySelector('#match').value, link: main.querySelector('#link').value } }));
        toast('Saved'); render();
      } catch (err) { sv.disabled = false; main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
    });
  }

  /* ---------- team stat tracker PINs ---------- */
  // Each team gets a 4-digit PIN. Coaches open the tracker from their team page on the site and enter it.
  async function pageTracker(main) {
    main.innerHTML = '<h1>Team tracker</h1><div class="muted">Loading…</div>';
    let t, names;
    try { [t, names] = await Promise.all([call('/api/clubs/' + CLUB.slug + '/tracker'), teamNames()]); }
    catch (e) { main.innerHTML = '<h1>Team tracker</h1><div class="err">' + esc(e.message) + '</div>'; return; }
    const set = new Map(t.teams.map((x) => [x.team, x]));
    const all = [...new Set(names.concat(t.teams.map((x) => x.team)))].sort();
    const open = (team) => location.origin + '/track/#/t/' + encodeURIComponent(CLUB.slug) + '/' + encodeURIComponent(team);
    main.innerHTML = '<h1>Team tracker</h1>' +
      (t.plus || ME.admin ? '' : '<div class="card"><b>The team stat tracker is part of Plus.</b> <span class="muted">Ask about switching Plus on for your club.</span></div>') +
      '<div class="card"><p>Coaches, managers or parents tap team stats live on a phone: turnovers, rebounds, deflections and so on. Team totals only, no player names. ' +
      'Give each team a <b>4-digit PIN</b> and send it to the coach. They open the tracker from their team\'s page on the club site (or the link below) and enter it. ' +
      'Five wrong tries locks the team for 15 minutes. Changing or removing a PIN signs out every phone using the old one.</p>' +
      '<table><thead><tr><th>Team</th><th>PIN</th><th>New PIN</th><th></th></tr></thead><tbody>' +
      all.map((team) => { const x = set.get(team);
        return '<tr><td><b>' + esc(team) + '</b><br><a href="' + esc(open(team)) + '" target="_blank" rel="noopener" style="font-size:12px">Open tracker</a></td>' +
          '<td>' + (x ? '<span class="tag green">SET</span>' + (x.locked ? ' <span class="tag gold">LOCKED</span>' : '') + '<br><span class="muted" style="font-size:12px">' + esc((x.updatedAt || '').slice(0, 10)) + '</span>' : '<span class="muted">None</span>') + '</td>' +
          '<td><input type="text" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" placeholder="4 digits" style="width:110px" data-pin="' + esc(team) + '"></td>' +
          '<td style="white-space:nowrap"><button class="btn sm" type="button" data-save="' + esc(team) + '">' + (x ? 'Change' : 'Set PIN') + '</button>' +
          (x ? ' <button class="btn danger sm" type="button" data-rm="' + esc(team) + '">Remove</button>' : '') + '</td></tr>'; }).join('') +
      '</tbody></table>' + (all.length ? '' : '<p class="muted">No teams found for this club yet.</p>') + '<div id="msg"></div></div>';
    const msg = main.querySelector('#msg');
    async function save(team, pin) {
      try { await call('/api/clubs/' + CLUB.slug + '/tracker', { method: 'POST', body: { team, pin } }); toast(pin ? 'PIN saved for ' + team : 'PIN removed'); pageTracker(main); }
      catch (err) { msg.innerHTML = '<div class="err">' + esc(err.message) + '</div>'; }
    }
    main.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
      const inp = [...main.querySelectorAll('[data-pin]')].find((i) => i.dataset.pin === b.dataset.save);
      const pin = (inp.value || '').trim();
      if (!/^\d{4}$/.test(pin)) { msg.innerHTML = '<div class="err">PINs are 4 digits</div>'; inp.focus(); return; }
      save(b.dataset.save, pin);
    }));
    main.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { if (window.confirm('Remove the PIN for ' + b.dataset.rm + '? Coaches will not be able to open the tracker.')) save(b.dataset.rm, null); }));
  }

  /* ---------- people ---------- */
  async function pagePeople(main) {
    main.innerHTML = '<h1>Club logins</h1><div class="muted">Loading…</div>';
    let u;
    try { u = await call('/api/clubs/' + CLUB.slug + '/users'); } catch (e) { main.innerHTML = '<h1>Club logins</h1><div class="err">' + esc(e.message) + '</div>'; return; }
    main.innerHTML = '<h1>Club logins</h1><div class="card"><p class="muted">Everyone here can change ' + esc(CLUB.name) + '\'s sponsors and branding.</p>' +
      (u.users.length ? '<table><thead><tr><th>Name</th><th>Email</th><th>Added</th></tr></thead><tbody>' + u.users.map((x) => '<tr><td>' + esc(x.name || '') + '</td><td>' + esc(x.email) + '</td><td>' + esc((x.created_at || '').slice(0, 10)) + '</td></tr>').join('') + '</tbody></table>' : '<p>No club logins yet.</p>') + '</div>' +
      '<form class="card" id="add"><h2>Add a login</h2><div class="grid2"><div><label>Name</label><input type="text" name="name"></div><div><label>Email</label><input type="email" name="email" required></div>' +
      '<div><label>Starting password (10+ characters, they can change it)</label><input type="text" name="password" required minlength="10"></div></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn" type="submit">Add login</button><span id="msg"></span></div></form>';
    main.querySelector('#add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await call('/api/clubs/' + CLUB.slug + '/users', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), password: f.get('password') } }); toast('Login added. Send them the portal link and their password.'); pagePeople(main); }
      catch (err) { main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
    });
  }

  /* ---------- all clubs (site admin) ---------- */
  function pageClubs(main) {
    main.innerHTML = '<h1>All clubs</h1><div class="card"><table><thead><tr><th></th><th>Club</th><th>Team names</th><th>Plus</th><th></th></tr></thead><tbody>' +
      ME.clubs.map((c) => '<tr><td>' + badge(c, 34) + '</td><td><b>' + esc(c.name) + '</b><br><span class="muted">' + esc(c.slug) + '</span></td><td><code>' + esc(c.match) + '</code></td><td><span class="pill' + (c.plus ? ' plus' : '') + '">' + (c.plus ? 'PLUS' : 'FREE') + '</span></td>' +
        '<td><button class="btn o sm" type="button" data-open="' + esc(c.slug) + '">Manage</button></td></tr>').join('') + '</tbody></table></div>' +
      '<form class="card" id="newclub"><h2>Add a club</h2><div class="grid2"><div><label>Club name</label><input type="text" name="name" required></div><div><label>Short name (as in team names)</label><input type="text" name="short" required></div>' +
      '<div><label>Link name (lowercase, e.g. echoes)</label><input type="text" name="slug" required pattern="[a-z0-9-]{2,30}"></div><div><label>Team name pattern (optional)</label><input type="text" name="match" placeholder="^Echoes\\b"></div></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn" type="submit">Add club</button><span id="msg"></span></div></form>';
    main.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { CLUB = ME.clubs.find((c) => c.slug === b.dataset.open); sessionStorage.setItem('portal.club', CLUB.slug); location.hash = '#plus'; }));
    main.querySelector('#newclub').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { const c = await call('/api/clubs', { method: 'POST', body: Object.fromEntries(f) }); ME.clubs.push(c); toast('Club added'); pageClubs(main); }
      catch (err) { main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
    });
  }

  /* ---------- account ---------- */
  function pageAccount(main) {
    main.innerHTML = '<h1>Your password</h1><form class="card" id="pw" style="max-width:420px"><label>Current password</label><input type="password" name="current" required autocomplete="current-password">' +
      '<label>New password (10+ characters)</label><input type="password" name="password" required minlength="10" autocomplete="new-password">' +
      '<div class="row" style="margin-top:14px"><button class="btn" type="submit">Change password</button><span id="msg"></span></div></form>';
    main.querySelector('#pw').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await call('/api/password', { method: 'POST', body: { current: f.get('current'), password: f.get('password') } }); toast('Password changed'); e.target.reset(); }
      catch (err) { main.querySelector('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
    });
  }

  window.addEventListener('beforeunload', (e) => { if (DIRTY) { e.preventDefault(); e.returnValue = ''; } });
  boot();
})();
