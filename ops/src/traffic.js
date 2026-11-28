// Site visits for the Traffic tab.
// Numbers come from Cloudflare Web Analytics (the beacon on lions/settlers.adamforb.es) through
// Cloudflare's GraphQL API, so a page view costs no D1 reads. The answer is cached for 10 minutes.
// Cloudflare only keeps a few weeks we can query, so once a night (and whenever a day is missing)
// one total per site per day is saved to D1 (site_daily, about 2 rows a day) for the season view.
// Reading it is a primary-key range scan: a full season is a few hundred rows.

export const TZ = 'Australia/Adelaide';
const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_SEC = 600;
const DAY = 86400000;
export const HOSTS = {
  'lions.adamforb.es': { name: 'Lions', color: '#163A80' },
  'settlers.adamforb.es': { name: 'Settlers', color: '#2F7D3A' },
  'hoops.adamforb.es': { name: 'Hoops', color: '#BE1823' },
};

// ---------- Time helpers (Adelaide local time, daylight saving aware) ----------

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function local(ts) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: p.year + '-' + p.month + '-' + p.day, hour: +p.hour, minute: +p.minute, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}
// UTC time of local midnight starting the given local day (YYYY-MM-DD).
export function midnight(day) {
  const guess = Date.parse(day + 'T00:00:00Z');
  let ts = guess - 10.5 * 3600000;
  for (let i = 0; i < 3; i++) {
    const l = local(ts);
    const diff = Date.parse(day + 'T00:00:00Z') - Date.parse(l.day + 'T' + String(l.hour).padStart(2, '0') + ':' + String(l.minute).padStart(2, '0') + ':00Z');
    if (!diff) break;
    ts += diff;
  }
  return ts;
}
export function addDays(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10); }
const iso = (ts) => new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z');

// ---------- Cloudflare GraphQL ----------

async function gql(env, dims, from, to, opts = {}) {
  const query = 'query($a: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) { rows: rumPageloadEventsAdaptiveGroups(limit: ' + (opts.limit || 5000) +
    ', filter: { datetime_geq: $from, datetime_lt: $to }' + (opts.orderBy ? ', orderBy: [' + opts.orderBy + ']' : '') + ') { count sum { visits } dimensions { ' + dims + ' } } } } }';
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, from: iso(from), to: iso(to) } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || (j.errors && j.errors.length)) {
    const msg = j && j.errors && j.errors.length ? j.errors.map((e) => e.message).join('; ') : 'HTTP ' + res.status;
    throw new Error(msg.slice(0, 200));
  }
  const acct = j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  return ((acct && acct.rows) || []).map((r) => Object.assign({ views: r.count || 0, visits: (r.sum && r.sum.visits) || 0 }, r.dimensions));
}

// Hourly visits per site for the last N days. Cloudflare may refuse long ranges on the free plan,
// so fall back to a shorter one rather than show nothing.
async function hourly(env, now) {
  let lastErr;
  for (const days of [31, 8]) {
    try { return { days, rows: await gql(env, 'datetimeHour requestHost', now - days * DAY, now + 3600000, { limit: 10000 }) }; } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------- Aggregation (pure, tested) ----------

// Hourly rows -> { 'YYYY-MM-DD': { host: { v, p } } } in local days. Cloudflare's hours are UTC, so
// with Adelaide's half-hour offset an hour is counted in the local day its first half falls in.
export function toDays(rows) {
  const out = {};
  for (const r of rows) {
    const l = local(Date.parse(r.datetimeHour));
    const d = (out[l.day] = out[l.day] || {}), h = (d[r.requestHost] = d[r.requestHost] || { v: 0, p: 0 });
    h.v += r.visits; h.p += r.views;
  }
  return out;
}

// 7 x 24 grid (Mon..Sun x local hour) of visits over the last 28 days.
export function heatmap(rows, now) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) {
    const ts = Date.parse(r.datetimeHour);
    if (ts < now - 28 * DAY) continue;
    const l = local(ts);
    grid[l.dow][l.hour] += r.visits;
  }
  return grid;
}

// Today so far vs the same weekday last week up to the same time of day.
export function todayVsLastWeek(rows, now) {
  const today = local(now).day, t0 = midnight(today), w0 = midnight(addDays(today, -7)), w1 = w0 + (now - t0);
  const out = {};
  for (const r of rows) {
    const ts = Date.parse(r.datetimeHour), h = (out[r.requestHost] = out[r.requestHost] || { visits: 0, views: 0, lastWeek: 0 });
    if (ts >= t0) { h.visits += r.visits; h.views += r.views; } else if (ts >= w0 && ts < w1) h.lastWeek += r.visits;
  }
  return out;
}

// 15-minute buckets today (local), per site.
export function pulse(rows, now) {
  const t0 = midnight(local(now).day), n = Math.ceil((now - t0) / 900000) || 1;
  const buckets = Array.from({ length: n }, () => ({}));
  for (const r of rows) {
    const i = Math.floor((Date.parse(r.datetimeFifteenMinutes) - t0) / 900000);
    if (i >= 0 && i < n) buckets[i][r.requestHost] = (buckets[i][r.requestHost] || 0) + r.visits;
  }
  return { start: t0, step: 900000, buckets };
}

// Agent samples (one a minute) -> time ranges when at least one game was live.
export function liveRanges(samples) {
  const out = [];
  let cur = null;
  for (const s of samples) {
    let live = 0;
    try { live = JSON.parse(s.data || '{}').live || 0; } catch { /* old row */ }
    if (live > 0) { if (cur && s.ts - cur[1] <= 180000) cur[1] = s.ts; else out.push(cur = [s.ts, s.ts]); }
  }
  return out;
}

// Complete local days from an hourly window that are safe to store: not today, and not the first
// day of the window (it may be cut off part way).
export function completeDays(days, now) {
  const keys = Object.keys(days).sort(), today = local(now).day;
  return keys.slice(1).filter((d) => d < today);
}

// ---------- D1 ----------

async function saveDays(env, days, keys) {
  const stmts = [];
  for (const d of keys) for (const [host, x] of Object.entries(days[d])) {
    stmts.push(env.DB.prepare('INSERT INTO site_daily (day, host, visits, views) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(day, host) DO UPDATE SET visits = ?3, views = ?4').bind(d, host, x.v, x.p));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// Nightly (cron): store the last month's complete days. Re-writing days already stored is harmless.
export async function syncDaily(env, now = Date.now()) {
  if (!configured(env)) return 0;
  const { rows } = await hourly(env, now);
  const days = toDays(rows);
  return saveDays(env, days, completeDays(days, now));
}

export function configured(env) { return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID); }

// ---------- /api/traffic ----------

export async function traffic(env, req, ctx) {
  const url = new URL(req.url);
  const range = ['7', '30', 'season'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '7';
  if (env.DEV_NO_AUTH === '1' && url.searchParams.has('mock')) return mock(range, +url.searchParams.get('mockhour') || 0);
  if (!configured(env)) return { configured: false };
  const cacheKey = new Request('https://ops-cache.internal/traffic?range=' + range);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache && !url.searchParams.has('fresh')) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const data = await build(env, range, Date.now());
  if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + CACHE_SEC } })));
  return data;
}

async function build(env, range, now) {
  const today = local(now).day, t0 = midnight(today);
  const topFrom = now - (range === '7' ? 7 : 30) * DAY;
  const errors = [];
  const safe = (name, p) => p.catch((e) => { errors.push(name + ': ' + e.message); return null; });
  const seasonFrom = env.SEASON_START && /^\d{4}-\d\d-\d\d$/.test(env.SEASON_START) ? env.SEASON_START : addDays(today, -400);
  const [hr, quarter, pages, refs, devices, stored, agent] = await Promise.all([
    safe('hourly', hourly(env, now)),
    safe('today', gql(env, 'datetimeFifteenMinutes requestHost', t0, now + 900000, { limit: 1000 })),
    safe('pages', gql(env, 'requestHost requestPath', topFrom, now, { limit: 8, orderBy: 'count_DESC' })),
    safe('referrers', gql(env, 'refererHost', topFrom, now, { limit: 8, orderBy: 'sum_visits_DESC' })),
    safe('devices', gql(env, 'deviceType', topFrom, now, { limit: 6, orderBy: 'sum_visits_DESC' })),
    safe('history', env.DB.prepare('SELECT day, host, visits, views FROM site_daily WHERE day >= ?1 ORDER BY day').bind(seasonFrom).all().then((r) => r.results)),
    safe('games', env.DB.prepare("SELECT ts, data FROM samples WHERE kind = 'agent' AND ts >= ?1 ORDER BY ts").bind(t0).all().then((r) => r.results)),
  ]);

  // Every day we know: stored totals, overwritten by the live hourly numbers for recent days.
  const days = {};
  for (const r of stored || []) (days[r.day] = days[r.day] || {})[r.host] = { v: r.visits, p: r.views };
  if (hr) {
    const live = toDays(hr.rows), keys = Object.keys(live).sort();
    keys.slice(1).forEach((d) => { days[d] = live[d]; });
    // Fill the history now if last night's save didn't happen (first deploy, or a missed cron).
    const want = completeDays(live, now), have = new Set((stored || []).map((r) => r.day));
    const missing = want.filter((d) => !have.has(d));
    if (stored && missing.length) await safe('save', saveDays(env, live, missing));
  }

  const hosts = new Set();
  Object.values(days).forEach((d) => Object.keys(d).forEach((h) => hosts.add(h)));
  return {
    configured: true,
    now, range, today,
    hosts: [...hosts].sort((a, b) => (HOSTS[a] ? 0 : 1) - (HOSTS[b] ? 0 : 1) || a.localeCompare(b)).map((h) => Object.assign({ host: h }, HOSTS[h] || { name: h, color: '#7D8AA5' })),
    days: Object.keys(days).sort().map((d) => ({ day: d, sites: days[d] })),
    todayVs: hr ? todayVsLastWeek(hr.rows, now) : null,
    heat: hr ? heatmap(hr.rows, now) : null,
    pulse: quarter ? pulse(quarter, now) : null,
    live: agent ? liveRanges(agent) : [],
    pages: pages && pages.map((r) => ({ host: r.requestHost, path: r.requestPath, views: r.views })),
    referrers: refs && refs.map((r) => ({ host: r.refererHost || '', visits: r.visits })),
    devices: devices && devices.map((r) => ({ type: r.deviceType || 'other', visits: r.visits })),
    topDays: range === '7' ? 7 : 30,
    errors,
  };
}

// ---------- Sample data for local testing (DEV_NO_AUTH only) ----------

function mock(range, hour) {
  let now = Date.now();
  if (hour) now = midnight(local(now).day) + hour * 3600000;
  const today = local(now).day, days = [];
  for (let i = 70; i >= 0; i--) {
    const d = addDays(today, -i), dow = local(midnight(d) + 43200000).dow;
    const lions = Math.round((dow === 5 ? 420 : dow === 4 ? 260 : 170) * (0.8 + Math.random() * 0.4) * (i === 0 ? 0.6 : 1));
    const carnival = i >= 13 && i <= 14 ? 1900 : 0;
    const set = Math.round(20 + Math.random() * 30 + carnival);
    days.push({ day: d, sites: { 'lions.adamforb.es': { v: lions, p: lions * 3 }, 'settlers.adamforb.es': { v: set, p: set * 3 } } });
  }
  const t0 = midnight(today), n = Math.max(1, Math.ceil((now - t0) / 900000));
  const buckets = Array.from({ length: n }, (_, i) => { const h = i / 4; const v = h < 7 ? 1 : Math.round(10 + 60 * Math.exp(-((h - 9.7) ** 2) / 2) + 30 * Math.exp(-((h - 15) ** 2) / 3)); return { 'lions.adamforb.es': v, 'settlers.adamforb.es': Math.round(v / 12) }; });
  const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => Math.round((h < 7 ? 2 : 10) + (d === 5 && h >= 8 && h <= 12 ? 90 : 0) + (d === 4 && h >= 18 && h <= 21 ? 50 : 0) + Math.random() * 10)));
  return {
    configured: true, now, range, today, mock: true,
    hosts: ['lions.adamforb.es', 'settlers.adamforb.es'].map((h) => Object.assign({ host: h }, HOSTS[h])),
    days,
    todayVs: { 'lions.adamforb.es': { visits: 412, views: 1306, lastWeek: 349 }, 'settlers.adamforb.es': { visits: 38, views: 91, lastWeek: 97 } },
    heat,
    pulse: { start: t0, step: 900000, buckets },
    live: [[t0 + 8.5 * 3600000, t0 + 12 * 3600000], [t0 + 13.5 * 3600000, Math.min(now, t0 + 15.5 * 3600000)]],
    pages: [['lions.adamforb.es', '/', 9820], ['lions.adamforb.es', '/game/1749201', 612], ['settlers.adamforb.es', '/', 4302], ['lions.adamforb.es', '/team/u14-boys-div-1', 1207]].map(([host, path, views]) => ({ host, path, views })),
    referrers: [['', 3100], ['facebook.com', 4100], ['m.facebook.com', 900], ['lm.facebook.com', 1200], ['google.com', 800]].map(([host, visits]) => ({ host, visits })),
    devices: [{ type: 'mobile', visits: 8100 }, { type: 'desktop', visits: 640 }, { type: 'tablet', visits: 200 }],
    topDays: range === '7' ? 7 : 30,
    errors: [],
  };
}
