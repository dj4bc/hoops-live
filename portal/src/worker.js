// Club portal API for the multi-club results site.
// Runs as a Cloudflare Worker with a D1 database (clubs, logins, sponsor counts) and an
// R2 bucket (club and sponsor logos). The portal's own pages are static files in public/.

const SESSION_DAYS = 30;
const PBKDF2_ITER = 20000;
const MAX_UPLOAD = 1024 * 1024; // 1 MB per logo
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname.startsWith('/files/')) return await file(env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors(req, env, url));
      console.error(e && e.stack || e);
      return json({ error: 'Something went wrong' }, 500, cors(req, env, url));
    }
  }
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers) });
}
// Public endpoints are read by the results site, which lives on another domain.
function cors(req, env, url) {
  if (!url.pathname.startsWith('/api/public/') && url.pathname !== '/api/track') return {};
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.SITE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = !origin || allowed.includes(origin) || allowed.includes('*');
  return ok ? { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
}

async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  const h = cors(req, env, url);
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: h });

  // ---- public ----
  if (p === '/api/public/clubs' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clubs ORDER BY sort, name').all();
    return json({ clubs: results.map(publicClub), updatedAt: new Date().toISOString() }, 200, Object.assign({ 'Cache-Control': 'public, max-age=60' }, h));
  }
  if (p === '/api/track' && m === 'POST') return json(await track(req, env), 200, h);
  if (p === '/api/setup' && m === 'POST') return json(await setup(req, env));
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return logout(req, env);

  // ---- signed in ----
  const me = await currentUser(req, env);
  if (!me) fail(401, 'Please sign in');
  if (p === '/api/me' && m === 'GET') {
    const clubs = me.club ? [await getClub(env, me.club)] : (await env.DB.prepare('SELECT * FROM clubs ORDER BY sort, name').all()).results;
    return json({ email: me.email, name: me.name, admin: !me.club, club: me.club, clubs: clubs.filter(Boolean).map(adminClub), siteUrl: env.SITE_URL || '' });
  }
  let mm;
  if ((mm = p.match(/^\/api\/clubs\/([a-z0-9-]+)(\/[a-z]+)?$/))) {
    const slug = mm[1], sub = mm[2] || '';
    if (me.club && me.club !== slug) fail(403, 'You can only manage your own club');
    const club = await getClub(env, slug);
    if (!club) fail(404, 'No such club');
    if (sub === '' && m === 'GET') return json(adminClub(club));
    if (sub === '' && m === 'PUT') return json(adminClub(await saveClub(req, env, club, !me.club)));
    if (sub === '/sponsors' && m === 'PUT') return json(adminClub(await saveSponsors(req, env, club)));
    if (sub === '/upload' && m === 'POST') return json(await upload(req, env, club, url));
    if (sub === '/stats' && m === 'GET') return json(await stats(env, club, url));
    if (sub === '/users' && m === 'GET') return json(await clubUsers(env, slug));
    if (sub === '/users' && m === 'POST') return json(await addUser(req, env, slug, me));
  }
  if (p === '/api/clubs' && m === 'POST') {
    if (me.club) fail(403, 'Only the site admin can add clubs');
    return json(adminClub(await addClub(req, env)));
  }
  if (p === '/api/password' && m === 'POST') return json(await changePassword(req, env, me));
  fail(404, 'Not found');
}

/* ---------- clubs ---------- */
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const fileUrl = (key) => (key ? '/files/' + key : null);
async function getClub(env, slug) { return env.DB.prepare('SELECT * FROM clubs WHERE slug = ?').bind(slug).first(); }

// What the results site sees. Branding and sponsors only go out for clubs with Plus.
function publicClub(c) {
  const plus = !!c.plus && (!c.plus_until || c.plus_until >= new Date().toISOString().slice(0, 10));
  const out = { slug: c.slug, name: c.name, short: c.short, match: c.match, plus };
  if (plus) {
    out.logo = fileUrl(c.logo);
    out.colours = parse(c.colours, null);
    const sp = parse(c.sponsors, null);
    if (sp) {
      Object.values(sp.list || {}).forEach((s) => { s.logo = fileUrl(s.logo); });
      out.sponsors = sp;
    }
  }
  return out;
}
function adminClub(c) {
  return { slug: c.slug, name: c.name, short: c.short, match: c.match, plus: !!c.plus, plusUntil: c.plus_until, plusNote: c.plus_note,
    logo: fileUrl(c.logo), logoKey: c.logo, colours: parse(c.colours, null), sponsors: parse(c.sponsors, { list: {}, wall: [], wallSlots: 0, teams: {} }),
    link: c.link, updatedAt: c.updated_at };
}
const HEX = /^#[0-9a-fA-F]{6}$/;
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
async function body(req) { try { return await req.json(); } catch (e) { fail(400, 'Expected JSON'); } }

async function saveClub(req, env, club, isAdmin) {
  const b = await body(req);
  const name = clean(b.name ?? club.name, 60), short = clean(b.short ?? club.short, 30);
  if (!name || !short) fail(400, 'Name and short name are needed');
  let colours = club.colours;
  if (b.colours) {
    const c = b.colours;
    if (![c.primary, c.dark, c.accent].every((x) => HEX.test(x || ''))) fail(400, 'Colours must look like #14309A');
    colours = JSON.stringify({ primary: c.primary, dark: c.dark, accent: c.accent });
  }
  const logo = b.logoKey === null ? null : (b.logoKey && b.logoKey.startsWith('clubs/' + club.slug + '/') ? b.logoKey : club.logo);
  let match = club.match, plus = club.plus, until = club.plus_until, note = club.plus_note, link = club.link;
  if (isAdmin) {
    if (b.match != null) { try { new RegExp(b.match); } catch (e) { fail(400, 'Team name pattern is not valid'); } match = clean(b.match, 100); }
    if (b.plus != null) plus = b.plus ? 1 : 0;
    if (b.plusUntil !== undefined) until = b.plusUntil ? clean(b.plusUntil, 10) : null;
    if (b.plusNote !== undefined) note = clean(b.plusNote, 120) || null;
    if (b.link !== undefined) link = clean(b.link, 100) || null;
  }
  await env.DB.prepare('UPDATE clubs SET name=?, short=?, colours=?, logo=?, match=?, plus=?, plus_until=?, plus_note=?, link=?, updated_at=datetime(\'now\') WHERE slug=?')
    .bind(name, short, colours, logo, match, plus, until, note, link, club.slug).run();
  return getClub(env, club.slug);
}

async function saveSponsors(req, env, club) {
  const b = await body(req);
  const list = {};
  Object.entries(b.list || {}).slice(0, 40).forEach(([id, s]) => {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !s) return;
    const url = clean(s.url, 300);
    if (url && !/^https?:\/\//i.test(url)) fail(400, 'Sponsor website must start with https://');
    list[id] = { name: clean(s.name, 60) || id, url: url || '', blurb: clean(s.blurb, 160), cta: clean(s.cta, 30), dark: !!s.dark,
      logo: s.logo && String(s.logo).startsWith('clubs/' + club.slug + '/') ? s.logo : null,
      from: clean(s.from, 10) || null, until: clean(s.until, 10) || null };
  });
  const ok = (id) => (id && list[id] ? id : null);
  const teams = {};
  Object.entries(b.teams || {}).slice(0, 80).forEach(([team, id]) => { if (ok(id)) teams[clean(team, 60)] = id; });
  const sp = {
    list,
    presenting: ok(b.presenting), presentingLabel: clean(b.presentingLabel, 40) || null,
    wall: (b.wall || []).filter(ok).slice(0, 12),
    wallSlots: Math.max(0, Math.min(8, parseInt(b.wallSlots, 10) || 0)),
    feed: ok(b.feed),
    teams
  };
  await env.DB.prepare('UPDATE clubs SET sponsors=?, updated_at=datetime(\'now\') WHERE slug=?').bind(JSON.stringify(sp), club.slug).run();
  return getClub(env, club.slug);
}

async function upload(req, env, club, url) {
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext = IMAGE_TYPES[type];
  if (!ext) fail(400, 'Logos must be PNG, JPG, WebP or SVG');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) fail(400, 'Empty file');
  if (buf.byteLength > MAX_UPLOAD) fail(400, 'Logo is over 1 MB. Please use a smaller image.');
  const kind = url.searchParams.get('kind') === 'club' ? 'club' : 'sponsor';
  const key = 'clubs/' + club.slug + '/' + kind + '-' + Date.now().toString(36) + '-' + rand(4) + '.' + ext;
  await env.FILES.put(key, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  return { key, url: fileUrl(key) };
}

async function file(env, url) {
  const key = decodeURIComponent(url.pathname.slice('/files/'.length));
  if (!/^clubs\/[a-z0-9-]+\/[\w.-]+$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.FILES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Access-Control-Allow-Origin', '*');
  if (key.endsWith('.svg')) headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  return new Response(obj.body, { headers });
}

async function addClub(req, env) {
  const b = await body(req);
  const slug = clean(b.slug, 30).toLowerCase();
  if (!/^[a-z0-9-]{2,30}$/.test(slug)) fail(400, 'Short link name: lowercase letters, numbers and dashes');
  const name = clean(b.name, 60), short = clean(b.short || b.name, 30);
  if (!name) fail(400, 'Club name is needed');
  const match = clean(b.match || '^' + short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 100);
  try { new RegExp(match); } catch (e) { fail(400, 'Team name pattern is not valid'); }
  if (await getClub(env, slug)) fail(409, 'That club already exists');
  await env.DB.prepare('INSERT INTO clubs (slug, name, short, match, plus, sort, updated_at) VALUES (?, ?, ?, ?, 0, 99, datetime(\'now\'))').bind(slug, name, short, match).run();
  return getClub(env, slug);
}

/* ---------- sponsor counts ---------- */
// The site sends batches of { c: club, s: sponsor, t: 'v' (view) | 'c' (tap) }. Counts are per day.
async function track(req, env) {
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { fail(400, 'Bad data'); }
  const events = Array.isArray(b.events) ? b.events.slice(0, 200) : [];
  const agg = new Map();
  events.forEach((e) => {
    if (!e || !/^[a-z0-9-]{1,30}$/.test(e.c || '') || !/^[a-z0-9-]{1,40}$/.test(e.s || '')) return;
    const k = e.c + '|' + e.s;
    const a = agg.get(k) || { v: 0, c: 0 };
    if (e.t === 'c') a.c++; else a.v++;
    agg.set(k, a);
  });
  if (!agg.size) return { ok: true, n: 0 };
  const day = adelaideDay();
  const stmts = [];
  agg.forEach((a, k) => {
    const [club, sponsor] = k.split('|');
    stmts.push(env.DB.prepare('INSERT INTO stats (day, club, sponsor, views, taps) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM clubs WHERE slug = ?) ' +
      'ON CONFLICT(day, club, sponsor) DO UPDATE SET views = views + excluded.views, taps = taps + excluded.taps')
      .bind(day, club, sponsor, Math.min(a.v, 50), Math.min(a.c, 10), club));
  });
  await env.DB.batch(stmts);
  return { ok: true, n: agg.size };
}
function adelaideDay(d) {
  const p = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}
async function stats(env, club, url) {
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 30));
  const since = adelaideDay(new Date(Date.now() - (days - 1) * 864e5));
  const prevSince = adelaideDay(new Date(Date.now() - (2 * days - 1) * 864e5));
  const { results } = await env.DB.prepare('SELECT day, sponsor, views, taps FROM stats WHERE club = ? AND day >= ? ORDER BY day').bind(club.slug, prevSince).all();
  const cur = results.filter((r) => r.day >= since), prev = results.filter((r) => r.day < since);
  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const bySponsor = {};
  cur.forEach((r) => { const s = bySponsor[r.sponsor] || (bySponsor[r.sponsor] = { views: 0, taps: 0 }); s.views += r.views; s.taps += r.taps; });
  const daily = {};
  cur.forEach((r) => { const d = daily[r.day] || (daily[r.day] = { views: 0, taps: 0 }); d.views += r.views; d.taps += r.taps; });
  return { days, since, views: sum(cur, 'views'), taps: sum(cur, 'taps'), prevViews: sum(prev, 'views'), prevTaps: sum(prev, 'taps'), bySponsor, daily };
}

/* ---------- people and sign-in ---------- */
function rand(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER }, key, 256);
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function sameStr(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const normEmail = (e) => clean(e, 120).toLowerCase();
function checkPw(pw) { if (String(pw || '').length < 10) fail(400, 'Passwords need at least 10 characters'); }

async function createUser(env, email, name, club, pw) {
  const salt = rand(16);
  await env.DB.prepare('INSERT INTO users (email, name, club, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))')
    .bind(email, name || null, club || null, salt, await hashPw(pw, salt)).run();
}
// One-off: make the first site admin, using the ADMIN_SETUP_TOKEN secret. Does nothing once an admin exists.
async function setup(req, env) {
  const b = await body(req);
  if (!env.ADMIN_SETUP_TOKEN || !sameStr(String(b.token || ''), env.ADMIN_SETUP_TOKEN)) fail(403, 'Wrong setup token');
  const any = await env.DB.prepare('SELECT 1 FROM users WHERE club IS NULL LIMIT 1').first();
  if (any) fail(409, 'The site admin already exists');
  const email = normEmail(b.email); if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Email looks wrong');
  checkPw(b.password);
  await createUser(env, email, clean(b.name, 60), null, b.password);
  return { ok: true };
}
async function addUser(req, env, slug, me) {
  const b = await body(req);
  const email = normEmail(b.email); if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Email looks wrong');
  checkPw(b.password);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) fail(409, 'That email already has a login');
  await createUser(env, email, clean(b.name, 60), slug, b.password);
  return clubUsers(env, slug);
}
async function clubUsers(env, slug) {
  const { results } = await env.DB.prepare('SELECT email, name, created_at FROM users WHERE club = ? ORDER BY created_at').bind(slug).all();
  return { users: results };
}
async function changePassword(req, env, me) {
  const b = await body(req);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(me.email).first();
  if (!sameStr(await hashPw(String(b.current || ''), u.salt), u.hash)) fail(400, 'Current password is wrong');
  checkPw(b.password);
  const salt = rand(16);
  await env.DB.prepare('UPDATE users SET salt=?, hash=? WHERE email=?').bind(salt, await hashPw(b.password, salt), me.email).run();
  return { ok: true };
}

const COOKIE = 'hp_session';
function sessionCookie(token, maxAge) { return COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge; }
async function login(req, env) {
  const b = await body(req);
  const email = normEmail(b.email);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const hash = await hashPw(String(b.password || ''), u ? u.salt : 'no-user-salt');
  if (!u || !sameStr(hash, u.hash)) fail(401, 'Email or password is wrong');
  const token = rand(32);
  await env.DB.prepare('INSERT INTO sessions (token, email, expires) VALUES (?, ?, ?)').bind(token, email, Date.now() + SESSION_DAYS * 864e5).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}
function tokenOf(req) { const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})')); return m ? m[1] : null; }
async function logout(req, env) {
  const t = tokenOf(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(t).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}
async function currentUser(req, env) {
  const t = tokenOf(req);
  if (!t) return null;
  // Changes must come from the portal itself, not another site.
  if (req.method !== 'GET') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== new URL(req.url).origin) fail(403, 'Wrong origin');
  }
  return env.DB.prepare('SELECT u.email, u.name, u.club FROM sessions s JOIN users u ON u.email = s.email WHERE s.token = ? AND s.expires > ?').bind(t, Date.now()).first();
}
