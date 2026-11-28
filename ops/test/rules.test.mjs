import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, overall } from '../src/rules.js';

const now = Date.parse('2026-11-28T00:12:00Z');
const okCheck = (ms = 500) => ({ ok: true, status: 200, ms });
const agent = (over = {}) => ({ ts: now - 30000, data: Object.assign({
  cpu: 20, mem: { pct: 50 }, disk: { pct: 59, free: 1e10 }, chromiumMb: 200,
  services: [{ unit: 'foul-scraper.service', active: 'active', restarts10m: 0, since: now - 86400000 }],
  logs: { errors10m: 0, scraperLastLoop: now - 60000 }, games: [], certs: [], os: {},
}, over) });
const base = (o = {}) => Object.assign({ now, agent: agent(), checks: { bc_api: [okCheck(), okCheck(), okCheck()], 'site:Lions Live': [okCheck(), okCheck()] }, schema: { ok: true, missing: [] } }, o);

test('all good', () => { assert.deepEqual(evaluate(base()), []); assert.equal(overall([]), 'ok'); });

test('Linode silent after 3 minutes', () => {
  const p = evaluate(base({ agent: { ts: now - 200000, data: agent().data } }));
  assert.deepEqual(p.map((x) => x.k), ['agent_silent']);
  assert.equal(overall(p), 'bad');
});

test('BC slow only after 3 slow checks', () => {
  assert.equal(evaluate(base({ checks: { bc_api: [okCheck(2500), okCheck(2500), okCheck(400)] } })).length, 0);
  assert.equal(evaluate(base({ checks: { bc_api: [okCheck(2500), okCheck(2600), okCheck(2400)] } }))[0].k, 'bc_slow');
});

test('BC down after 2 failures', () => {
  const bad = { ok: false, status: 502, ms: 100 };
  assert.equal(evaluate(base({ checks: { bc_api: [bad, bad] } }))[0].k, 'bc_down');
});

test('schema change', () => {
  assert.equal(evaluate(base({ schema: { ok: false, missing: ['match.matchStatus'] } }))[0].k, 'bc_schema');
});

test('site down needs 2 failures and ignores 1042 unknowns', () => {
  const bad = { ok: false, status: 0, error: 'Timed out' };
  assert.equal(evaluate(base({ checks: { 'site:Lions Live': [bad, okCheck()] } })).length, 0);
  assert.equal(evaluate(base({ checks: { 'site:Lions Live': [bad, bad] } }))[0].k, 'site_down:Lions Live');
  const unk = { ok: false, status: 403, unknown: true };
  assert.equal(evaluate(base({ checks: { 'site:Hoops Live': [unk, unk] } })).length, 0);
});

test('live game stale, but not past the 4-hour rule, and finals ignored', () => {
  const games = [
    { id: 1, live: true, updatedAt: new Date(now - 300000).toISOString() },
    { id: 2, live: true, updatedAt: new Date(now - 30000).toISOString() },
    { id: 3, live: true, updatedAt: new Date(now - 5 * 3600000).toISOString() },
    { id: 4, live: false, updatedAt: new Date(now - 300000).toISOString() },
  ];
  assert.deepEqual(evaluate(base({ agent: agent({ games }) })).map((x) => x.k), ['game_stale:1']);
});

test('service down, disk, reboot, cert', () => {
  const p = evaluate(base({ agent: agent({
    services: [{ unit: 'push-alerts.service', active: 'failed', sub: 'failed', restarts10m: 0 }],
    disk: { pct: 90, free: 1e9 }, os: { rebootRequired: true },
    certs: [{ host: 'fouls.adamforb.es', validTo: new Date(now + 5 * 86400000).toISOString() }],
  }) })).map((x) => x.k).sort();
  assert.deepEqual(p, ['cert:fouls.adamforb.es', 'disk', 'reboot', 'svc:push-alerts.service']);
});

test('scraper stalled when running but no loop logged', () => {
  const p = evaluate(base({ agent: agent({ logs: { errors10m: 0, scraperLastLoop: null } }) }));
  assert.deepEqual(p.map((x) => x.k), ['scraper_stalled']);
});

test('no Linode checks on stale agent data', () => {
  const p = evaluate(base({ agent: { ts: now - 600000, data: agent({ disk: { pct: 99 } }).data } }));
  assert.deepEqual(p.map((x) => x.k), ['agent_silent']);
});

test('scraper quiet is fine during overnight quiet hours', () => {
  const at = (iso) => evaluate(base({ now: Date.parse(iso), agent: { ts: Date.parse(iso) - 30000, data: agent({ logs: { errors10m: 0, scraperLastLoop: null } }).data } })).map((x) => x.k);
  assert.deepEqual(at('2026-11-28T17:34:00Z'), []);                 // 4:04am Adelaide (the false alarm)
  assert.deepEqual(at('2026-11-28T11:31:00Z'), []);                 // 10:01pm
  assert.deepEqual(at('2026-11-28T19:44:00Z'), []);                 // 6:14am, still waking
  assert.deepEqual(at('2026-11-28T19:46:00Z'), ['scraper_stalled']); // 6:16am
  assert.deepEqual(at('2026-11-28T11:29:00Z'), ['scraper_stalled']); // 9:59pm
});
