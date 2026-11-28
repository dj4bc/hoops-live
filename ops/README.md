# Lions Ops (ops.adamforb.es)

Private health dashboard for everything Lions Live, Settlers Live and Hoops Live need to run.
It runs on Cloudflare, not the Linode, so it stays up and keeps alerting when the Linode is down.

| Part | Where | What it does |
|---|---|---|
| Worker + D1 (`src/`, `public/`) | Cloudflare, `hoops-ops` | Dashboard page, stores readings 30 days, checks BasketballConnect and the sites every minute, sends alerts |
| Agent (`agent/`) | Linode, `ops-agent.timer` | Every minute sends CPU, RAM, disk, services, scraper games, push stats, certificates. Read-only |

Nothing in the scraper, push-alerts or Caddy is changed: the agent reads the fouls files in
`/var/www/fouls`, the services' journal and systemd status.

## Traffic tab (site visits)
The **Traffic** tab shows visits from Cloudflare Web Analytics (the beacon already on Lions Live
and Settlers Live): today vs the same day last week, visits in the last 15 minutes, today in
15-minute steps with live games shaded, 7 / 30 days / season bars, last 7 days vs the 7 before
with an 8-week line, top pages, where visitors come from, devices and a day-by-hour heat map.

- Numbers come from Cloudflare's GraphQL API, cached 10 minutes: **no D1 reads** for those.
- Cloudflare only lets us query about a month, so at 12:20 am Adelaide the Worker saves one
  total per site per day into `site_daily` (about 2 rows a day). The season view reads those by
  primary key. The shaded live games read today's agent rows (by the `(kind, ts)` index), only
  when the 10-minute cache is empty.
- The sites use `#/` links, so Cloudflare counts every screen as the home page; "Most viewed"
  can't split box scores from team pages yet.
- Optional `SEASON_START` var (YYYY-MM-DD) limits the season view; otherwise it shows all saved days.

Setup, once:
1. Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom: permission
   **Account > Account Analytics > Read**, for your account. Then `npx wrangler secret put CF_API_TOKEN`.
2. `npx wrangler secret put CF_ACCOUNT_ID` (the account ID shown on the Workers overview page).
3. `npx wrangler d1 execute hoops-ops --remote --file=migrate-2026-11-29-site-daily.sql`, then deploy.

## What raises an alert
Linode silent 3 min · BasketballConnect down (2 checks) or slower than 2 s (3 checks) ·
BC data missing a field the sites use (checked every 15 min) · a site down (2 checks) ·
a live game's fouls not updated for 3 min · a service not running or restarting · scraper quiet
10 min · disk 85% · memory 92% · Chromium over 700 MB · certificate under 14 days · reboot needed.
Each alert is sent once when it starts and once when it clears (ntfy app). Rules: `src/rules.js`.

## Who can open it
Cloudflare Access (Zero Trust) application on `ops.adamforb.es`, policy "Emails: Adam" with a
one-time code. A second Access application on `ops.adamforb.es/api/heartbeat` with a **Bypass**
policy lets the agent in; that path still needs the agent's secret token. The Worker also checks
Access's signed token itself, so the page shows nothing if Access is ever switched off.

## Deploy (from a computer signed in to Cloudflare)
```sh
cd ops && npm install
npx wrangler d1 create hoops-ops          # paste database_id into wrangler.toml
npm run db:init
# Existing database, once (28 Nov 2026): add the index the hourly prune needs
npx wrangler d1 execute hoops-ops --remote --file=migrate-2026-11-28-indexes.sql
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put AGENT_TOKEN   # keep for the agent
npx wrangler secret put NTFY_TOPIC         # a long random name, also typed into the ntfy app
npx wrangler secret put ACCESS_TEAM_DOMAIN # yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD         # from the Access application
npx wrangler deploy
```
Agent, on the Linode as root: copy `agent/` over, then `OPS_TOKEN=<AGENT_TOKEN> sh install.sh`.
Check it: `journalctl -u ops-agent -n 20`. Remove it: see the top of `install.sh`.

## Local test
`printf 'DEV_NO_AUTH=1\nAGENT_TOKEN=devtoken\n' > .dev.vars`, `npm run db:init:local`, `npm run dev`,
then `DRY_RUN=1 node agent/ops-agent.mjs` prints what the agent would send. Open
`http://localhost:8787/?mock=1#traffic` to see the Traffic tab with sample data. `npm test` runs the rules tests.
