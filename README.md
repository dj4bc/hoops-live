# Hoops Live (multi-club proof of concept)

One results site for every club in a competition, plus a portal where each club manages its
sponsors, branding and logins. First tenant: Barossa Valley Basketball Summer Season 2026/27
(BasketballConnect comp 2861), with Angaston Panthers as the demo club on Plus.

| Part | Folder | Runs on | Address |
|---|---|---|---|
| Results site (static) | `site/` | Cloudflare, Workers static assets (`wrangler.toml` here) | hoops.adamforb.es, panthers.adamforb.es |
| Club portal and API | `portal/` | Cloudflare Worker + D1 (database) + R2 (logos) | portal.adamforb.es |
| Live fouls, worm, alerts | not in this repo | the Linode scraper (fouls.adamforb.es) | unchanged |

## How the site works

- Opens on a club picker. Picking a club (or a link such as `?c=angaston`, `/c/angaston`
  or `panthers.adamforb.es`) shows the same pages as Lions Den, filtered to that club.
  "All games" (`?c=all`) shows every game, with club chips to narrow it.
- The phone remembers the club, so the home-screen icon opens straight to it. "⇄ Club" goes back to the picker.
- Each visitor's browser reads BasketballConnect directly (whole competition, filtered by
  club team-name patterns), the same as Lions Den.
- Club settings come from the portal's `/api/public/clubs` when it is reachable, otherwise
  from `site/config.js`.
- **Free** clubs: fixtures, live scores, results, ladders, box scores, grey initials badge,
  and a "Plus" teaser on Game day. **Plus** clubs: their logo and colours, sponsors (header
  strip, feed card, wall, team sponsors), live fouls and worm from the scraper, alerts.
- Sponsor views and taps are sent to the portal (`/api/track`) and show in the club's sponsor report.

## Portal

- Club admins sign in at portal.adamforb.es: Overview (sponsor report, CSV), Sponsors
  (logos, links, placements, team sponsors), Branding (name, colours, logo, preview),
  Plus and club link (QR code), Club logins.
- The site admin (no club) also sees every club, can switch Plus on and off, set dates,
  team-name patterns and domains, and add clubs.

## Team stat tracker (Plus, trial)

A phone page where a coach, manager or parent taps **team** stats live (turnovers, rebounds,
free throws, deflections...). No player names. Lives in the portal Worker at `/track/`.

- **Club:** portal → *Team tracker* → give each team a 4-digit PIN and send it to the coach.
  Five wrong tries locks that team for 15 minutes; a new or removed PIN signs out every phone.
- **Coach:** team page on the site → *Team stat tracker* → PIN (stays unlocked 3 days) →
  pick up to 4 metrics (presets, "same as last game", club core) with optional goals → start.
- **Scorer:** the coach shares a link/QR (game id + key). No PIN, that game only, 48 hours.
- Taps are saved on the phone first and sent in batches, so bad reception loses nothing.
  Undo removes this phone's last tap. Each tap has an id, so a resend is never double-counted.
- After *Finish*: summary (goals hit, by quarter, vs last game, copy-to-chat text), and
  season trend lines on the team's tracker home.
- **What can be recorded:** `portal/src/metrics.js` (14 metrics, presets, club core). Edit that
  file to change it; the starter list and definitions are in the project notes.
- Existing database: `cd portal && npm run db:tracker` adds the four tracker tables.

## First deploy (from a computer signed in to Cloudflare)

```sh
npx wrangler login                                  # once
cd portal && npm install
npx wrangler d1 create hoops-portal                 # paste the database_id into portal/wrangler.toml
npx wrangler r2 bucket create hoops-portal-files
npm run db:init                                     # tables + the six BVABA clubs
openssl rand -hex 24 | npx wrangler secret put ADMIN_SETUP_TOKEN   # keep the value for the next step
npx wrangler deploy                                 # portal.adamforb.es
cd .. && npx wrangler deploy                        # site: hoops.adamforb.es + panthers.adamforb.es
```

Then create the site admin once (does nothing after the first admin exists):

```sh
curl -X POST https://portal.adamforb.es/api/setup -H 'Content-Type: application/json' \
  -d '{"token":"<ADMIN_SETUP_TOKEN>","email":"you@example.com","name":"Adam","password":"<10+ characters>"}'
```

Sign in at portal.adamforb.es, open Angaston Panthers, and add club logins under "Club logins".

## Adding a club domain

Add a line to `routes` in the root `wrangler.toml` (e.g. `echoes.adamforb.es`), map it in
`site/config.js` `hosts`, add it to `SITE_ORIGINS` in `portal/wrangler.toml`, and deploy both.

## Local testing

```sh
cd portal && echo 'ADMIN_SETUP_TOKEN=local-test-token' > .dev.vars && npm run db:init:local && npx wrangler dev
cd site && python3 -m http.server 8811     # set portalBase to http://127.0.0.1:8787 in config.js while testing
```
`?mock=mock.json` makes the site read a local file instead of BasketballConnect.

## Known limits (proof of concept)

- Live fouls, worm and alerts need the Linode scraper and push service to watch comp 2861 too.
- Passwords use PBKDF2 (20k rounds) to stay inside the Worker free-tier CPU limit.
- Plus is switched on by the site admin; there is no payment flow yet.
- The data source is BasketballConnect's unofficial public API.
