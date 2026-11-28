// Health rules: turn the latest readings into a list of problems.
// Pure functions (no Cloudflare APIs) so they can be tested with plain Node.

export const LIMITS = {
  agentSilentSec: 180,      // Linode has not reported for 3 minutes
  bcSlowMs: 2000,           // BasketballConnect slower than 2 s ...
  bcSlowRuns: 3,            // ... three checks in a row
  bcDownRuns: 2,            // two failed checks in a row
  siteDownRuns: 2,
  gameStaleSec: 180,        // a live game's fouls file not updated for 3 minutes (scraper loops every 45 s, 3 games at a time)
  gameStaleMaxSec: 4 * 3600,// the scraper's own 4-hour stale-game rule takes over after this
  diskPct: 85,
  memPct: 92,
  chromiumMb: 700,          // the scraper's cap is 800 MB
  scraperErrors10m: 10,
  certDays: 14,
};

// The fields the sites rely on in BasketballConnect's matches response.
export const MATCH_FIELDS = ['id', 'startTime', 'team1', 'team2', 'team1Score', 'team2Score', 'matchStatus', 'venueCourt', 'divisionId'];
export const ROUND_FIELDS = ['id', 'name', 'matches'];

export function missingFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return fields.slice();
  return fields.filter((f) => !(f in obj));
}

// Problems are { k, level: 'warn'|'bad', title, detail }.
// `s` = { now, agent: {ts, data} | null, checks: { name: [latest..older results] }, schema }
export function evaluate(s) {
  const out = [];
  const now = s.now;
  const add = (k, level, title, detail) => out.push({ k, level, title, detail: detail || '' });

  // Linode heartbeat
  if (!s.agent) add('agent_silent', 'bad', 'Linode has never reported', 'Install the ops agent on the Linode.');
  else {
    const age = Math.round((now - s.agent.ts) / 1000);
    if (age > LIMITS.agentSilentSec) add('agent_silent', 'bad', 'Linode has gone quiet', 'No report for ' + fmtAge(age) + '. The server, its network or the agent may be down.');
  }

  // BasketballConnect
  const bc = s.checks.bc_api || [];
  if (bc.length >= LIMITS.bcDownRuns && bc.slice(0, LIMITS.bcDownRuns).every((r) => !r.ok)) {
    add('bc_down', 'bad', 'BasketballConnect is not answering', bc[0].error || ('HTTP ' + bc[0].status));
  } else if (bc.length >= LIMITS.bcSlowRuns && bc.slice(0, LIMITS.bcSlowRuns).every((r) => r.ok && r.ms > LIMITS.bcSlowMs)) {
    add('bc_slow', 'warn', 'BasketballConnect is slow', (bc[0].ms / 1000).toFixed(1) + ' s per request (normal is under 1 s).');
  }
  const page = s.checks.bc_site || [];
  if (page.length >= LIMITS.bcDownRuns && page.slice(0, LIMITS.bcDownRuns).every((r) => !r.ok)) {
    add('bc_site_down', 'bad', 'BasketballConnect website is down', 'The scraper reads its match pages. ' + (page[0].error || 'HTTP ' + page[0].status));
  }
  if (s.schema && s.schema.missing && s.schema.missing.length) {
    add('bc_schema', 'bad', 'BasketballConnect data has changed', 'Missing: ' + s.schema.missing.join(', ') + '. The sites may show gaps.');
  }

  // Websites
  for (const [name, rows] of Object.entries(s.checks)) {
    if (!name.startsWith('site:')) continue;
    if (rows.length >= LIMITS.siteDownRuns && rows.slice(0, LIMITS.siteDownRuns).every((r) => !r.ok && !r.unknown)) {
      add('site_down:' + name.slice(5), 'bad', name.slice(5) + ' is down', rows[0].error || ('HTTP ' + rows[0].status));
    }
  }

  // Everything below needs a fresh Linode report
  const d = s.agent && (now - s.agent.ts) / 1000 <= LIMITS.agentSilentSec ? s.agent.data : null;
  if (d) {
    if (d.disk && d.disk.pct >= LIMITS.diskPct) add('disk', 'warn', 'Linode disk is ' + d.disk.pct + '% full', fmtBytes(d.disk.free) + ' free.');
    if (d.mem && d.mem.pct >= LIMITS.memPct) add('mem', 'warn', 'Linode memory is ' + d.mem.pct + '% used', 'Chromium ' + (d.chromiumMb || 0) + ' MB.');
    if (d.chromiumMb >= LIMITS.chromiumMb) add('chromium', 'warn', 'Chromium is using ' + d.chromiumMb + ' MB', 'The scraper restarts at 800 MB.');
    for (const sv of d.services || []) {
      if (sv.active !== 'active') add('svc:' + sv.unit, 'bad', sv.unit + ' is ' + (sv.active || 'missing'), sv.sub || '');
      else if (sv.restarts10m >= 3) add('svc_flap:' + sv.unit, 'warn', sv.unit + ' keeps restarting', sv.restarts10m + ' restarts in 10 minutes.');
    }
    const scraper = (d.services || []).find((x) => x.unit === 'foul-scraper.service');
    if (scraper && scraper.active === 'active' && d.logs && !d.logs.scraperLastLoop && scraper.since && now - scraper.since > 15 * 60000) {
      add('scraper_stalled', 'warn', 'Foul scraper has gone quiet', 'Running, but no "matches list" log line for 10 minutes. It may be stuck.');
    }
    if (d.logs && d.logs.errors10m >= LIMITS.scraperErrors10m) add('scraper_errors', 'warn', 'Scraper is logging errors', d.logs.errors10m + ' in the last 10 minutes. Latest: ' + ((d.logs.recent || [])[0] || ''));
    for (const g of (d.games || [])) {
      if (!g.live) continue;
      const age = g.updatedAt ? (now - Date.parse(g.updatedAt)) / 1000 : Infinity;
      if (age > LIMITS.gameStaleSec && age < LIMITS.gameStaleMaxSec) add('game_stale:' + g.id, 'warn', 'Fouls not updating for ' + gameName(g), 'Last update ' + fmtAge(Math.round(age)) + ' ago.');
    }
    for (const c of (d.certs || [])) {
      if (c.error) continue;
      const days = Math.floor((Date.parse(c.validTo) - now) / 86400000);
      if (days < LIMITS.certDays) add('cert:' + c.host, days < 3 ? 'bad' : 'warn', 'Certificate for ' + c.host + ' expires in ' + days + ' days', 'It should renew on its own; check it has.');
    }
    if (d.os && d.os.rebootRequired) add('reboot', 'warn', 'Linode needs a reboot', 'Security updates are waiting for one. Pick a time with no games.');
  }
  return out;
}

export function overall(problems) {
  if (problems.some((p) => p.level === 'bad')) return 'bad';
  if (problems.length) return 'warn';
  return 'ok';
}

export function gameName(g) {
  if (g.team1 && g.team2) return g.team1 + ' v ' + g.team2;
  return 'game ' + g.id;
}
export function fmtAge(sec) {
  if (sec < 90) return sec + ' s';
  if (sec < 5400) return Math.round(sec / 60) + ' min';
  if (sec < 172800) return Math.round(sec / 3600) + ' h';
  return Math.round(sec / 86400) + ' days';
}
export function fmtBytes(b) {
  if (!b && b !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(i >= 3 ? 1 : 0) + ' ' + u[i];
}
