-- Club portal database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS clubs (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short TEXT NOT NULL,
  match TEXT NOT NULL,
  plus INTEGER NOT NULL DEFAULT 0,
  plus_until TEXT,
  plus_note TEXT,
  logo TEXT,
  colours TEXT,
  sponsors TEXT,
  link TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT,
  club TEXT,            -- NULL = site admin (every club)
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stats (
  day TEXT NOT NULL,
  club TEXT NOT NULL,
  sponsor TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  taps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, club, sponsor)
);
CREATE TABLE IF NOT EXISTS visits (
  day TEXT NOT NULL,
  club TEXT NOT NULL,
  phones INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, club)
);

-- Team stat tracker (Plus). One 4-digit PIN per team, set by the club in the portal.
-- Teams are keyed by the site's team heading, e.g. "U14 Boys Panthers 1" (same as team sponsors).
CREATE TABLE IF NOT EXISTS tracker_teams (
  club TEXT NOT NULL,
  team TEXT NOT NULL,
  salt TEXT NOT NULL,
  pin TEXT NOT NULL,          -- PBKDF2 hash of the PIN
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (club, team)
);
CREATE TABLE IF NOT EXISTS tracker_sessions (
  token TEXT PRIMARY KEY,
  club TEXT NOT NULL,
  team TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_games (
  id TEXT PRIMARY KEY,
  club TEXT NOT NULL,
  team TEXT NOT NULL,
  opponent TEXT,
  game_date TEXT,
  metrics TEXT NOT NULL,      -- JSON [{ id, goal }]
  scorer_key TEXT NOT NULL,   -- in the scorer's link; no account needed
  status TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS tracker_games_team ON tracker_games (club, team, created_at);
CREATE TABLE IF NOT EXISTS tracker_taps (
  game TEXT NOT NULL,
  id TEXT NOT NULL,           -- made on the phone, so a tap sent twice is only counted once
  metric TEXT NOT NULL,
  val TEXT NOT NULL,          -- '+' for counts, 'made' or 'missed'
  q INTEGER NOT NULL,
  ts INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game, id)
);
