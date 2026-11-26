#!/usr/bin/env node
// Lions Ops agent for the Linode. Runs once a minute (systemd timer), reads the server's health
// and the foul scraper's output, and sends it to the ops dashboard Worker.
// Read-only: it changes nothing on the server. No npm packages needed (Node 20).
//
// Env (from /etc/ops-agent.env): OPS_URL (https://ops.adamforb.es/api/heartbeat), OPS_TOKEN.
// Optional: FOULS_DIR (/var/www/fouls), STATE_DIR (/var/lib/ops-agent), DRY_RUN=1 (print, don't send).

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync, spawnSync } from 'node:child_process';

const FOULS_DIR = process.env.FOULS_DIR || '/var/www/fouls';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/ops-agent';
const SERVICES = ['foul-scraper.service', 'push-alerts.service', 'caddy.service', 'foul-discover.timer'];
const CERT_HOSTS = ['fouls.adamforb.es', 'lions.adamforb.es', 'settlers.adamforb.es', 'hoops.adamforb.es', 'portal.adamforb.es', 'ops.adamforb.es'];
const LIVE_MAX_AGE = 4 * 3600 * 1000; // same 4-hour rule as the scraper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeout = 8000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function readState(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch { return fallback; }
}
function writeState(name, data) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(data)); } catch {}
}

function cpuTimes() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + (line[4] || 0);
  return { idle, total: line.reduce((a, b) => a + b, 0) };
}
// Average CPU since the last run (about a minute), so the agent's own start-up doesn't count.
// First run, or after a gap: a 1-second sample taken before anything else starts.
async function cpuPct() {
  const prev = readState('cpu.json', null);
  let a = prev && Date.now() - prev.at < 5 * 60000 ? prev : null;
  if (!a) { a = cpuTimes(); await sleep(1000); }
  const b = cpuTimes();
  writeState('cpu.json', Object.assign({ at: Date.now() }, b));
  const dt = b.total - a.total;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (b.idle - a.idle) / dt)))) : 0;
}

function memInfo() {
  const m = {};
  for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const x = l.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  const used = m.MemTotal - m.MemAvailable;
  return { total: m.MemTotal, used, pct: Math.round(100 * used / m.MemTotal), swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree };
}

function diskInfo() {
  const s = fs.statfsSync('/');
  const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
  return { total, free, used: total - free, pct: Math.round(100 * (total - free) / total) };
}

function chromiumMb() {
  let kb = 0;
  for (const l of run('ps', ['-eo', 'rss=,comm=']).split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    if (m && /chrom|headless_shell/i.test(m[2])) kb += Number(m[1]);
  }
  return Math.round(kb / 1024);
}

function services() {
  const hist = readState('restarts.json', {});
  const now = Date.now();
  const out = SERVICES.map((unit) => {
    const props = {};
    for (const l of run('systemctl', ['show', unit, '-p', 'ActiveState,SubState,NRestarts,ActiveEnterTimestamp,MemoryCurrent,LastTriggerUSec,Result']).split('\n')) {
      const i = l.indexOf('='); if (i > 0) props[l.slice(0, i)] = l.slice(i + 1);
    }
    const restarts = Number(props.NRestarts || 0);
    // Keep 10 minutes of restart counts to spot a service that keeps crashing
    const h = (hist[unit] || []).filter((x) => now - x[0] < 10 * 60000);
    h.push([now, restarts]);
    hist[unit] = h;
    const mem = Number(props.MemoryCurrent);
    return {
      unit,
      active: props.ActiveState || 'unknown',
      sub: props.SubState || '',
      restarts,
      restarts10m: Math.max(0, restarts - h[0][1]),
      since: props.ActiveEnterTimestamp ? Date.parse(props.ActiveEnterTimestamp) || null : null,
      memMb: Number.isFinite(mem) && mem < 1e15 ? Math.round(mem / 1048576) : null,
      lastRun: props.LastTriggerUSec && props.LastTriggerUSec !== 'n/a' ? Date.parse(props.LastTriggerUSec) || null : null,
      result: props.Result || '',
    };
  });
  writeState('restarts.json', hist);
  return out;
}

// The scraper writes /var/www/fouls/match-<id>.json for each game it follows.
function games() {
  const now = Date.now();
  let files = [];
  try { files = fs.readdirSync(FOULS_DIR).filter((f) => /^match-\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(FOULS_DIR, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (now - st.mtimeMs > 12 * 3600 * 1000) continue; // only today's games
    let d; try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const fouls = ['team1', 'team2'].map((t) => ((d.players || {})[t] || []).reduce((a, x) => a + (Number(x.fouls) || 0), 0));
    const updated = Date.parse(d.updatedAt) || st.mtimeMs;
    const status = String(d.status || '').toLowerCase();
    out.push({
      id: d.matchId || Number(f.match(/\d+/)[0]),
      status,
      quarter: d.quarter || null,
      score: Array.isArray(d.score) ? d.score : null,
      fouls,
      plays: Array.isArray(d.plays) ? d.plays.length : 0,
      updatedAt: new Date(updated).toISOString(),
      changedAt: d.changedAt || null,
      live: !['final', 'ended', 'finished'].includes(status) && now - updated < LIVE_MAX_AGE,
    });
  }
  return out.sort((a, b) => (b.live - a.live) || (Date.parse(b.updatedAt) - Date.parse(a.updatedAt))).slice(0, 40);
}

function journal(unit, since) {
  return run('journalctl', ['-u', unit, '--since', since, '-o', 'short-iso', '--no-pager', '-q']).split('\n').filter(Boolean);
}

// Scraper and push-alerts log "[info] ..." to stdout and "[error] ..." to stderr.
function logs() {
  const scr = journal('foul-scraper', '-10min');
  const push = journal('push-alerts', '-10min');
  const isErr = (l) => /\[error\]/i.test(l);
  const errs = scr.concat(push).filter(isErr);
  let lastLoop = null, liveOfOurs = null, staleIgnored = [];
  for (const l of scr) {
    const m = l.match(/^(\S+)\s.*matches list:\s*(\d+) live/);
    if (m) { lastLoop = Date.parse(m[1]) || lastLoop; liveOfOurs = Number(m[2]); }
    const s = l.match(/ignoring stale games[^:]*:\s*([\d, ]+)/);
    if (s) staleIgnored = s[1].split(/[ ,]+/).filter(Boolean).map(Number);
  }
  const trim = (l) => l.replace(/^\S+\s+\S+\s+/, '').slice(0, 240);
  return { errors10m: errs.length, recent: errs.slice(-5).reverse().map(trim), scraperLastLoop: lastLoop, liveOfOurs, staleIgnored };
}

// Push alerts: today's start/final notifications ("...: sent 3/3") and subscriber count ("total=N").
function pushStats() {
  const today = journal('push-alerts', 'today');
  let sent = 0, tried = 0, notices = 0;
  for (const l of today) {
    const m = l.match(/sent (\d+)\/(\d+)/);
    if (m) { sent += Number(m[1]); tried += Number(m[2]); notices++; }
  }
  const quiet = (() => {
    for (let i = today.length - 1; i >= 0; i--) {
      if (/quiet hours over/.test(today[i])) return false;
      if (/quiet hours: sleeping/.test(today[i])) return true;
    }
    return null;
  })();
  let subscribers = readState('subscribers.json', null);
  const last = run('journalctl', ['-u', 'push-alerts', '--grep', 'total=', '-n', '1', '-o', 'cat', '--no-pager', '-q']).match(/total=(\d+)/);
  if (last) { subscribers = Number(last[1]); writeState('subscribers.json', subscribers); }
  return { notices, sent, tried, failed: tried - sent, subscribers, quiet };
}

// Slow-changing things are refreshed every 15 minutes and cached.
async function slow() {
  const cache = readState('slow.json', null);
  if (cache && Date.now() - cache.at < 15 * 60000) return cache.data;
  // apt-check prints "updates;security" on stderr
  const ac = spawnSync('/usr/lib/update-notifier/apt-check', [], { encoding: 'utf8', timeout: 30000 });
  const updates = String((ac.stderr || '') + (ac.stdout || '')).trim().match(/(\d+);(\d+)/);
  const sshFails = run('journalctl', ['-u', 'ssh', '--since', '-24h', '-o', 'cat', '--no-pager', '-q', '--grep', 'Failed password|Invalid user|authentication failure']).split('\n').filter(Boolean).length;
  const journalUse = (run('journalctl', ['--disk-usage']).match(/take up ([\d.]+\s*\w+)/) || [])[1] || null;
  const data = {
    os: {
      updates: updates ? Number(updates[1]) : null,
      securityUpdates: updates ? Number(updates[2]) : null,
      rebootRequired: fs.existsSync('/var/run/reboot-required'),
      sshFails24h: sshFails,
      journalUse,
    },
    certs: await Promise.all(CERT_HOSTS.map(certInfo)),
  };
  writeState('slow.json', { at: Date.now(), data });
  return data;
}

function certInfo(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 6000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve({ host, validTo: c && c.valid_to ? new Date(c.valid_to).toISOString() : null, issuer: c && c.issuer ? (c.issuer.O || c.issuer.CN || '') : '' });
    });
    sock.on('error', (e) => resolve({ host, error: e.code || e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ host, error: 'timeout' }); });
  });
}

function netTotals() {
  let rx = 0, tx = 0;
  for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const m = l.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const f = m[2].split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}

async function collect() {
  const cpu = await cpuPct(); // first, before the other work adds load
  const slowData = await slow();
  const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number);
  const uptimeSec = Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]));
  return Object.assign({
    v: 1,
    at: new Date().toISOString(),
    host: run('hostname', []).trim(),
    cpu, load, cores: (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/mg) || []).length,
    uptimeSec,
    mem: memInfo(),
    disk: diskInfo(),
    net: netTotals(),
    chromiumMb: chromiumMb(),
    services: services(),
    games: games(),
    logs: logs(),
    push: pushStats(),
  }, slowData);
}

async function main() {
  const data = await collect();
  if (process.env.DRY_RUN === '1' || !process.env.OPS_URL) { console.log(JSON.stringify(data, null, 2)); return; }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(process.env.OPS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPS_TOKEN },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return;
      console.error('[error] heartbeat HTTP ' + res.status);
      if (res.status === 401 || res.status === 413) return;
    } catch (e) { console.error('[error] heartbeat ' + (e.message || e)); }
    await sleep(3000 * (i + 1));
  }
  process.exitCode = 1;
}

main();
