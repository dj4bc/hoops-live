# Lions Ops (ops.adamforb.es)

Private health dashboard for everything Lions Live, Settlers Live and Hoops Live need to run.
It runs on Cloudflare, not the Linode, so it stays up and keeps alerting when the Linode is down.

| Part | Where | What it does |
|---|---|---|
| Worker + D1 (`src/`, `public/`) | Cloudflare, `hoops-ops` | Dashboard page, stores readings 30 days, checks BasketballConnect and the sites every minute, sends alerts |
| Agent (`agent/`) | Linode, `ops-agent.timer` | Every minute sends CPU, RAM, disk, services, scraper games, push stats, certificates. Read-only |

Nothing in the scraper, push-alerts or Caddy is changed: the agent reads the fouls files in
`/var/www/fouls`, the services' journal and systemd status.

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
then `DRY_RUN=1 node agent/ops-agent.mjs` prints what the agent would send. `npm test` runs the rules tests.
