// Club portal API for the multi-club results site.
// Runs as a Cloudflare Worker with a D1 database (clubs, logins, sponsor counts) and an
// R2 bucket (club and sponsor logos). The portal's own pages are static files in public/.

import { METRICS, PRESETS, CLUB_CORE, MAX_FOCUS } from './metrics.js';

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
  // Team stat tracker: its own PIN and scorer-link access, not portal logins.
  if (p.startsWith('/api/tracker/')) return json(await tracker(req, env, url));

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
    if (sub === '/tracker' && m === 'GET') return json(await trackerTeams(env, club));
    if (sub === '/tracker' && m === 'POST') return json(await setTrackerPin(req, env, club, !me.club));
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

/* ---------- team stat tracker (Plus) ---------- */
// A coach unlocks their team with a 4-digit PIN that the club sets in the portal. Starting a game
// makes a scorer link (game id + random key) that a parent can tap on without any login.
// Taps are made on the phone first and sent in batches, so they survive bad reception.
const TRK_SESSION_DAYS = 3;          // stays unlocked over a weekend
const TRK_MAX_FAILS = 5, TRK_LOCK_MIN = 15;
const TRK_SCORER_HOURS = 48;         // scorer links stop working after this
const METRIC_BY_ID = Object.fromEntries(METRICS.map((x) => [x.id, x]));
const plusActive = (c) => !!c && !!c.plus && (!c.plus_until || c.plus_until >= new Date().toISOString().slice(0, 10));
const cleanTeam = (t) => clean(t, 80).replace(/\s+/g, ' ');

async function trackerTeams(env, club) {
  const { results } = await env.DB.prepare('SELECT team, updated_at, locked_until FROM tracker_teams WHERE club = ? ORDER BY team').bind(club.slug).all();
  return { plus: plusActive(club), teams: results.map((r) => ({ team: r.team, updatedAt: r.updated_at, locked: r.locked_until > Date.now() })) };
}
async function setTrackerPin(req, env, club, isAdmin) {
  if (!plusActive(club) && !isAdmin) fail(403, 'The team stat tracker is part of Plus');
  const b = await body(req);
  const team = cleanTeam(b.team);
  if (!team) fail(400, 'Which team?');
  // A new or removed PIN signs out every phone that used the old one.
  await env.DB.prepare('DELETE FROM tracker_sessions WHERE club = ? AND team = ?').bind(club.slug, team).run();
  if (b.pin === null) {
    await env.DB.prepare('DELETE FROM tracker_teams WHERE club = ? AND team = ?').bind(club.slug, team).run();
  } else {
    const pin = String(b.pin || '');
    if (!/^\d{4}$/.test(pin)) fail(400, 'PINs are 4 digits');
    const salt = rand(16);
    await env.DB.prepare('INSERT INTO tracker_teams (club, team, salt, pin, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, 0, 0, datetime(\'now\')) ' +
      'ON CONFLICT(club, team) DO UPDATE SET salt = excluded.salt, pin = excluded.pin, fails = 0, locked_until = 0, updated_at = excluded.updated_at')
      .bind(club.slug, team, salt, await hashPw(pin, salt)).run();
  }
  return trackerTeams(env, club);
}

async function tracker(req, env, url) {
  const p = url.pathname.slice('/api/tracker'.length), m = req.method;
  if (p === '/metrics' && m === 'GET') return { metrics: METRICS, presets: PRESETS, core: CLUB_CORE, max: MAX_FOCUS };
  if (p === '/unlock' && m === 'POST') return trackerUnlock(req, env);
  if (p === '/team' && m === 'GET') return trackerTeam(env, await trackerAuth(req, env));
  if (p === '/lock' && m === 'POST') {
    const t = bearer(req);
    if (t) await env.DB.prepare('DELETE FROM tracker_sessions WHERE token = ?').bind(t).run();
    return { ok: true };
  }
  if (p === '/games' && m === 'POST') return trackerNewGame(req, env, await trackerAuth(req, env));
  let mm;
  if ((mm = p.match(/^\/games\/([a-z0-9]{10})(\/[a-z]+)?$/))) {
    const game = await env.DB.prepare('SELECT * FROM tracker_games WHERE id = ?').bind(mm[1]).first();
    if (!game) fail(404, 'Game not found');
    const sub = mm[2] || '';
    const who = await gameAccess(req, env, url, game, sub === '' && m === 'GET');
    if (sub === '' && m === 'GET') return gameState(env, game, who);
    if (sub === '/taps' && m === 'POST') return gameTaps(req, env, game, who);
    if (sub === '/finish' && m === 'POST') {
      await env.DB.prepare('UPDATE tracker_games SET status = \'final\', finished_at = ? WHERE id = ?').bind(Date.now(), game.id).run();
      return gameState(env, Object.assign({}, game, { status: 'final' }), who);
    }
    if (sub === '/reopen' && m === 'POST') {
      if (who !== 'coach') fail(403, 'Only the coach can reopen a game');
      await env.DB.prepare('UPDATE tracker_games SET status = \'live\', finished_at = NULL WHERE id = ?').bind(game.id).run();
      return gameState(env, Object.assign({}, game, { status: 'live' }), who);
    }
    if (sub === '/delete' && m === 'POST') {
      if (who !== 'coach') fail(403, 'Only the coach can delete a game');
      await env.DB.batch([env.DB.prepare('DELETE FROM tracker_taps WHERE game = ?').bind(game.id), env.DB.prepare('DELETE FROM tracker_games WHERE id = ?').bind(game.id)]);
      return { ok: true };
    }
  }
  fail(404, 'Not found');
}

function bearer(req) { const m = (req.headers.get('Authorization') || '').match(/^Bearer ([a-f0-9]{48})$/); return m ? m[1] : null; }
async function trackerAuth(req, env, optional) {
  const t = bearer(req);
  const s = t && await env.DB.prepare('SELECT club, team FROM tracker_sessions WHERE token = ? AND expires > ?').bind(t, Date.now()).first();
  if (!s && !optional) fail(401, 'Enter the team PIN');
  if (s) {
    const club = await getClub(env, s.club);
    if (!plusActive(club)) { if (optional) return null; fail(403, 'The team stat tracker is part of Plus'); }
  }
  return s || null;
}

async function trackerUnlock(req, env) {
  const b = await body(req);
  const clubSlug = clean(b.club, 30), team = cleanTeam(b.team), pin = String(b.pin || '');
  const club = await getClub(env, clubSlug);
  if (!club) fail(404, 'No such club');
  if (!plusActive(club)) fail(403, 'The team stat tracker is part of Plus');
  const row = await env.DB.prepare('SELECT * FROM tracker_teams WHERE club = ? AND team = ?').bind(club.slug, team).first();
  if (!row) fail(404, 'This team has no PIN yet. Ask your club to set one in the club portal.');
  const now = Date.now();
  if (row.locked_until > now) fail(429, 'Too many wrong PINs. Try again in ' + Math.ceil((row.locked_until - now) / 60000) + ' min.');
  const ok = /^\d{4}$/.test(pin) && sameStr(await hashPw(pin, row.salt), row.pin);
  if (!ok) {
    const fails = row.fails + 1, lock = fails >= TRK_MAX_FAILS;
    await env.DB.prepare('UPDATE tracker_teams SET fails = ?, locked_until = ? WHERE club = ? AND team = ?')
      .bind(lock ? 0 : fails, lock ? now + TRK_LOCK_MIN * 60000 : 0, club.slug, team).run();
    fail(lock ? 429 : 401, lock ? 'Too many wrong PINs. Try again in ' + TRK_LOCK_MIN + ' min.' : 'Wrong PIN (' + (TRK_MAX_FAILS - fails) + (TRK_MAX_FAILS - fails === 1 ? ' try' : ' tries') + ' left)');
  }
  const token = rand(24), expires = now + TRK_SESSION_DAYS * 864e5;
  await env.DB.batch([
    env.DB.prepare('UPDATE tracker_teams SET fails = 0 WHERE club = ? AND team = ?').bind(club.slug, team),
    env.DB.prepare('INSERT INTO tracker_sessions (token, club, team, expires) VALUES (?, ?, ?, ?)').bind(token, club.slug, team, expires),
    env.DB.prepare('DELETE FROM tracker_sessions WHERE expires < ?').bind(now)
  ]);
  return { token, expires, club: club.slug, team };
}

// Every game for the team, with totals per metric, for the game list and the season trends.
async function trackerTeam(env, s) {
  const { results: games } = await env.DB.prepare('SELECT id, opponent, game_date, metrics, status, created_at FROM tracker_games WHERE club = ? AND team = ? ORDER BY created_at DESC LIMIT 60').bind(s.club, s.team).all();
  const { results: rows } = await env.DB.prepare('SELECT t.game, t.metric, t.val, COUNT(*) AS n FROM tracker_taps t JOIN tracker_games g ON g.id = t.game ' +
    'WHERE g.club = ? AND g.team = ? AND t.deleted = 0 GROUP BY t.game, t.metric, t.val').bind(s.club, s.team).all();
  const tot = {};
  rows.forEach((r) => { const g = tot[r.game] || (tot[r.game] = {}); const x = g[r.metric] || (g[r.metric] = {}); x[r.val] = r.n; });
  return { club: s.club, team: s.team, games: games.map((g) => ({ id: g.id, opponent: g.opponent, date: g.game_date, metrics: parse(g.metrics, []), status: g.status, createdAt: g.created_at, totals: tot[g.id] || {} })) };
}

async function trackerNewGame(req, env, s) {
  const b = await body(req);
  const seen = new Set();
  const metrics = (Array.isArray(b.metrics) ? b.metrics : []).filter((x) => x && METRIC_BY_ID[x.id] && !seen.has(x.id) && seen.add(x.id)).slice(0, MAX_FOCUS).map((x) => {
    const def = METRIC_BY_ID[x.id];
    let goal = x.goal === '' || x.goal == null ? null : Number(x.goal);
    if (def.goal === 'none' || !Number.isFinite(goal)) goal = null;
    else goal = Math.max(0, Math.min(def.goal === 'pct' ? 100 : 999, Math.round(goal)));
    return { id: x.id, goal };
  });
  if (!metrics.length) fail(400, 'Pick at least one thing to track');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : adelaideDay();
  const id = rand(5), key = rand(8);
  await env.DB.prepare('INSERT INTO tracker_games (id, club, team, opponent, game_date, metrics, scorer_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'live\', ?)')
    .bind(id, s.club, s.team, clean(b.opponent, 60) || null, date, JSON.stringify(metrics), key, Date.now()).run();
  const game = await env.DB.prepare('SELECT * FROM tracker_games WHERE id = ?').bind(id).first();
  return gameState(env, game, 'coach');
}

// The team's coach (PIN) can always see and fix a game. A scorer link works for 48 hours
// and, once the game is finished, only for reading the summary.
async function gameAccess(req, env, url, game, readOnly) {
  const s = await trackerAuth(req, env, true);
  if (s && s.club === game.club && s.team === game.team) return 'coach';
  const k = url.searchParams.get('k') || req.headers.get('X-Scorer-Key') || '';
  if (k && sameStr(k, game.scorer_key)) {
    const club = await getClub(env, game.club);
    if (!plusActive(club)) fail(403, 'The team stat tracker is part of Plus');
    if (Date.now() - game.created_at > TRK_SCORER_HOURS * 3600e3) fail(403, 'This scorer link has expired');
    if (!readOnly && game.status !== 'live') fail(409, 'This game is finished. Ask the coach to reopen it.');
    return 'scorer';
  }
  fail(401, 'Enter the team PIN, or use the scorer link from the coach');
}

async function gameState(env, game, who) {
  const { results } = await env.DB.prepare('SELECT metric, val, q, COUNT(*) AS n FROM tracker_taps WHERE game = ? AND deleted = 0 GROUP BY metric, val, q').bind(game.id).all();
  const totals = {};
  results.forEach((r) => { const x = totals[r.metric] || (totals[r.metric] = {}); const q = x[r.q] || (x[r.q] = {}); q[r.val] = r.n; });
  const out = { id: game.id, club: game.club, team: game.team, opponent: game.opponent, date: game.game_date, metrics: parse(game.metrics, []), status: game.status, createdAt: game.created_at, totals, role: who };
  if (who === 'coach') out.scorerKey = game.scorer_key;
  return out;
}

async function gameTaps(req, env, game, who) {
  if (who !== 'coach' && game.status !== 'live') fail(409, 'This game is finished');
  const b = await body(req);
  const allowed = Object.fromEntries(parse(game.metrics, []).map((x) => [x.id, METRIC_BY_ID[x.id]]));
  const stmts = [];
  (Array.isArray(b.events) ? b.events.slice(0, 300) : []).forEach((e) => {
    const def = e && allowed[e.m];
    if (!def || !/^[a-z0-9]{6,24}$/.test(e.id || '')) return;
    const okVal = def.tap === 'made_missed' ? e.v === 'made' || e.v === 'missed' : e.v === '+';
    const q = parseInt(e.q, 10);
    if (!okVal || !(q >= 1 && q <= 8)) return;
    stmts.push(env.DB.prepare('INSERT INTO tracker_taps (game, id, metric, val, q, ts, deleted) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(game, id) DO UPDATE SET deleted = MAX(deleted, excluded.deleted)')
      .bind(game.id, e.id, e.m, e.v, q, Number(e.t) || Date.now(), e.del ? 1 : 0));
  });
  if (stmts.length) await env.DB.batch(stmts);
  return gameState(env, game, who);
}
