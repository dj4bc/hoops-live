// Ops dashboard Worker (ops.adamforb.es).
// - POST /api/heartbeat: the Linode agent sends its readings every minute (bearer AGENT_TOKEN).
// - Cron every minute: checks BasketballConnect and the sites from outside, works out problems,
//   and sends an alert (ntfy) when a problem starts and when it clears.
// - GET /api/status and the page: only for people signed in through Cloudflare Access.

import { evaluate, overall, missingFields, MATCH_FIELDS, ROUND_FIELDS, LIMITS } from './rules.js';

const BC_API = 'https://api-basketball.squadi.com';
// Small, stable request used to time the API: the divisions list for Lions Juniors (comp 2890).
const BC_PING = BC_API + '/livescores/division?competitionKey=8cf25d3b-1b2d-41c0-a4c7-c87389aeafda';
// Schema check every 15 minutes on a finished tournament (Barossa Valley 2026, comp 3023): small and unchanging.
const BC_SCHEMA = BC_API + '/livescores/round/matches?competitionId=3023&divisionId=&teamIds=&ignoreStatuses=[1]';
const BC_SITE = 'https://registration.basketballconnect.com/';
const SITES = {
  'Lions Live': 'https://lions.adamforb.es/',
  'Settlers Live': 'https://settlers.adamforb.es/',
  'Hoops Live': 'https://hoops.adamforb.es/',
  'Hoops portal': 'https://portal.adamforb.es/api/public/clubs',
  'Live fouls feed': 'https://fouls.adamforb.es/events/settlers.json',
};
const KEEP_DAYS = 30;
const MAX_BODY = 256 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/api/heartbeat') return await heartbeat(req, env);
      const who = await accessUser(req, env);
      if (!who) return new Response('Sign in through Cloudflare Access to see this page.', { status: 403 });
      if (url.pathname === '/api/status') return json(await status(env));
      if (url.pathname === '/api/test-alert' && req.method === 'POST') {
        const sent = await notify(env, 'Test alert from Lions Ops', 'If you can read this, alerts work.', 'default');
        return json({ sent });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
  async scheduled(evt, env, ctx) {
    ctx.waitUntil(runChecks(env, new Date(evt.scheduledTime || Date.now())).catch((e) => console.error('checks failed', e && e.stack || e)));
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------- Linode agent ----------

async function heartbeat(req, env) {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const auth = req.headers.get('Authorization') || '';
  if (!env.AGENT_TOKEN || !(await safeEqual(auth, 'Bearer ' + env.AGENT_TOKEN))) return new Response('Unauthorized', { status: 401 });
  const body = await req.text();
  if (body.length > MAX_BODY) return new Response('Too large', { status: 413 });
  let data;
  try { data = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO latest (k, ts, data) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET ts = ?2, data = ?3').bind('agent', now, body),
    env.DB.prepare('INSERT INTO samples (ts, kind, ok, ms, data) VALUES (?1, ?2, 1, NULL, ?3)').bind(now, 'agent', JSON.stringify({
      cpu: data.cpu, mem: data.mem && data.mem.pct, disk: data.disk && data.disk.pct, live: (data.games || []).filter((g) => g.live).length, chromiumMb: data.chromiumMb,
    })),
  ]);
  return json({ ok: true });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ ay[i];
  return diff === 0;
}

// ---------- Cloudflare Access ----------
// Access already blocks anyone not on the policy before the request reaches the Worker. This
// checks its signed token as well, so the page can never be served if Access is switched off.

let certCache = { at: 0, keys: null };

async function accessUser(req, env) {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@localhost' };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = req.headers.get('Cf-Access-Jwt-Assertion') || cookie(req, 'CF_Authorization');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(b64urlText(parts[0])); payload = JSON.parse(b64urlText(parts[1])); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (payload.iss && payload.iss !== 'https://' + team) return null;
  const key = await accessKey(team, header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  return ok ? { email: payload.email || payload.common_name || '' } : null;
}

async function accessKey(team, kid) {
  if (!certCache.keys || Date.now() - certCache.at > 3600 * 1000 || !certCache.keys[kid]) {
    const res = await fetch('https://' + team + '/cdn-cgi/access/certs');
    if (!res.ok) return null;
    const { keys } = await res.json();
    const out = {};
    for (const k of keys || []) {
      out[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    }
    certCache = { at: Date.now(), keys: out };
  }
  return certCache.keys[kid] || null;
}

function cookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

// ---------- Outside checks (cron) ----------

async function timed(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, Object.assign({ redirect: 'follow', headers: { 'User-Agent': 'lions-ops-monitor', Accept: 'application/json, text/html' }, signal: AbortSignal.timeout(opts.timeout || 10000) }, opts.fetch));
    const ms = Date.now() - t0;
    const body = opts.body ? await res.text() : (await res.arrayBuffer(), '');
    // Cloudflare refuses some Worker-to-Worker fetches in the same zone (error 1042): not a real outage.
    const unknown = res.status === 403 && /error code: 1042/.test(body || '');
    return { ok: res.ok, status: res.status, ms, body, unknown };
  } catch (e) {
    const msg = String(e && e.message || e);
    const error = e && e.name === 'TimeoutError' ? 'Timed out after ' + ((opts.timeout || 10000) / 1000) + ' s'
      : /internal error|network|connect|dns/i.test(msg) ? 'Network error' : msg.slice(0, 80);
    return { ok: false, status: 0, ms: Date.now() - t0, error };
  }
}

export async function runChecks(env, when = new Date()) {
  const now = when.getTime();
  const minute = when.getUTCMinutes();
  const jobs = { bc_api: timed(BC_PING), bc_site: timed(BC_SITE) };
  for (const [name, url] of Object.entries(SITES)) jobs['site:' + name] = timed(url, { body: url.includes('portal') || url.includes('fouls') });
  const doSchema = minute % 15 === 0 || !(await getLatest(env, 'schema'));
  if (doSchema) jobs.schema = timed(BC_SCHEMA, { body: true, timeout: 20000 });

  const names = Object.keys(jobs);
  const results = await Promise.all(names.map((n) => jobs[n]));
  const stmts = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i], r = results[i];
    if (n === 'schema') continue;
    stmts.push(env.DB.prepare('INSERT INTO samples (ts, kind, ok, ms, data) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(now, n, r.ok ? 1 : 0, r.ms, JSON.stringify({ status: r.status, error: r.error || undefined, unknown: r.unknown || undefined })));
  }
  if (doSchema) {
    const r = results[names.indexOf('schema')];
    let schema;
    if (!r.ok) schema = { checkedAt: now, ok: false, error: r.error || 'HTTP ' + r.status, missing: [] };
    else {
      try {
        const d = JSON.parse(r.body);
        const round = (d.rounds || []).find((x) => (x.matches || []).length);
        const missing = !round ? ['rounds'] : missingFields(round, ROUND_FIELDS).map((f) => 'round.' + f)
          .concat(missingFields(round.matches[0], MATCH_FIELDS).map((f) => 'match.' + f));
        schema = { checkedAt: now, ok: !missing.length, missing, ms: r.ms, bytes: r.body.length };
      } catch (e) { schema = { checkedAt: now, ok: false, error: 'Not JSON any more', missing: ['(whole response)'] }; }
    }
    // A failed request is a BC outage (caught by bc_api), not a schema change: keep the last good result.
    if (r.ok) stmts.push(putLatest(env, 'schema', now, schema));
  }
  if (minute === 7) stmts.push(env.DB.prepare('DELETE FROM samples WHERE ts < ?1').bind(now - KEEP_DAYS * 86400000));
  if (minute === 7) stmts.push(env.DB.prepare('DELETE FROM events WHERE ts < ?1').bind(now - 90 * 86400000));
  await env.DB.batch(stmts);
  await updateAlerts(env, now);
}

function putLatest(env, k, ts, data) {
  return env.DB.prepare('INSERT INTO latest (k, ts, data) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET ts = ?2, data = ?3').bind(k, ts, JSON.stringify(data));
}
async function getLatest(env, k) {
  const row = await env.DB.prepare('SELECT ts, data FROM latest WHERE k = ?1').bind(k).first();
  return row ? { ts: row.ts, data: JSON.parse(row.data) } : null;
}

// Every check kind the cron writes. Naming them lets SQLite use the (kind, ts) index and read only
// the last few minutes; "kind != 'agent'" made it read the whole 30-day table every minute.
const CHECK_KINDS = ['bc_api', 'bc_site'].concat(Object.keys(SITES).map((n) => 'site:' + n));

async function recentChecks(env, since) {
  const marks = CHECK_KINDS.map((_, i) => '?' + (i + 2)).join(', ');
  const { results } = await env.DB.prepare('SELECT ts, kind, ok, ms, data FROM samples WHERE kind IN (' + marks + ') AND ts >= ?1 ORDER BY ts DESC').bind(since, ...CHECK_KINDS).all();
  const out = {};
  for (const r of results) {
    const d = r.data ? JSON.parse(r.data) : {};
    (out[r.kind] = out[r.kind] || []).push({ ts: r.ts, ok: !!r.ok, ms: r.ms, status: d.status, error: d.error, unknown: d.unknown });
  }
  return out;
}

async function currentState(env, now) {
  const [agent, schema, checks] = await Promise.all([getLatest(env, 'agent'), getLatest(env, 'schema'), recentChecks(env, now - 15 * 60000)]);
  const problems = evaluate({ now, agent, checks, schema: schema && schema.data });
  return { agent, schema, checks, problems };
}

// ---------- Alerts ----------

async function updateAlerts(env, now) {
  const { problems } = await currentState(env, now);
  const { results: rows } = await env.DB.prepare('SELECT * FROM alerts').all();
  const known = Object.fromEntries(rows.map((r) => [r.k, r]));
  const firing = new Set(problems.map((p) => p.k));
  const stmts = [];
  const sends = [];
  for (const p of problems) {
    const row = known[p.k];
    if (!row || !row.firing) {
      stmts.push(env.DB.prepare('INSERT INTO alerts (k, firing, since, count, message, notified) VALUES (?1, 1, ?2, 1, ?3, 1) ON CONFLICT(k) DO UPDATE SET firing = 1, since = ?2, count = 1, message = ?3, notified = 1').bind(p.k, now, p.title));
      stmts.push(env.DB.prepare('INSERT INTO events (ts, k, level, message) VALUES (?1, ?2, ?3, ?4)').bind(now, p.k, p.level, p.title + (p.detail ? '. ' + p.detail : '')));
      sends.push(notify(env, p.title, p.detail, p.level === 'bad' ? 'high' : 'default'));
    } else {
      stmts.push(env.DB.prepare('UPDATE alerts SET count = count + 1, message = ?2 WHERE k = ?1').bind(p.k, p.title));
    }
  }
  for (const row of rows) {
    if (row.firing && !firing.has(row.k)) {
      const mins = Math.max(1, Math.round((now - row.since) / 60000));
      stmts.push(env.DB.prepare('UPDATE alerts SET firing = 0 WHERE k = ?1').bind(row.k));
      stmts.push(env.DB.prepare('INSERT INTO events (ts, k, level, message) VALUES (?1, ?2, ?3, ?4)').bind(now, row.k, 'ok', 'Cleared: ' + row.message + ' (' + mins + ' min)'));
      sends.push(notify(env, 'Fixed: ' + row.message, 'Lasted ' + mins + ' min.', 'low'));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  await Promise.all(sends);
}

async function notify(env, title, message, priority) {
  if (!env.NTFY_TOPIC) return false;
  try {
    const res = await fetch('https://ntfy.sh/' + encodeURIComponent(env.NTFY_TOPIC), {
      method: 'POST',
      body: message || title,
      headers: { Title: asciiHeader(title), Priority: priority || 'default', Tags: priority === 'low' ? 'white_check_mark' : 'basketball', Click: env.DASHBOARD_URL || '' },
    });
    return res.ok;
  } catch (e) { console.error('ntfy', e); return false; }
}
// HTTP header values must be plain ASCII.
function asciiHeader(s) { return String(s).replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, ''); }

// ---------- Status for the page ----------

async function status(env) {
  const now = Date.now();
  const st = await currentState(env, now);
  const [series, events] = await Promise.all([
    env.DB.prepare("SELECT ts, kind, ok, ms, data FROM samples WHERE ts >= ?1 AND kind IN ('agent', 'bc_api') ORDER BY ts").bind(now - 3 * 3600000).all(),
    env.DB.prepare('SELECT ts, k, level, message FROM events ORDER BY ts DESC LIMIT 20').all(),
  ]);
  const bcSeries = [], agentSeries = [];
  for (const r of series.results) {
    if (r.kind === 'bc_api') bcSeries.push([r.ts, r.ok ? r.ms : null]);
    else { const d = JSON.parse(r.data || '{}'); agentSeries.push([r.ts, d.cpu, d.mem, d.live]); }
  }
  const latestChecks = {};
  for (const [k, rows] of Object.entries(st.checks)) latestChecks[k] = rows[0];
  return {
    now,
    overall: overall(st.problems),
    problems: st.problems,
    agent: st.agent ? { ts: st.agent.ts, ageSec: Math.round((now - st.agent.ts) / 1000), data: st.agent.data } : null,
    checks: latestChecks,
    schema: st.schema ? st.schema.data : null,
    bcSeries, agentSeries,
    events: events.results,
    limits: LIMITS,
    alertsOn: !!env.NTFY_TOPIC,
  };
}
