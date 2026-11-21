-- Team stat tracker (Plus). One 4-digit PIN per team, set by the club in the portal.
-- A club-wide PIN is stored as team '*'; teams without their own PIN use it.
-- Teams are keyed by the site's team heading, e.g. "U14 Boys Panthers 1" (same as team sponsors).
CREATE TABLE IF NOT EXISTS tracker_teams (
  club TEXT NOT NULL,
  team TEXT NOT NULL,
  salt TEXT NOT NULL,
  pin TEXT NOT NULL,          -- PBKDF2 hash of the PIN
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  inherited INTEGER NOT NULL DEFAULT 0, -- 1 = copy of the club-wide PIN (team '*')
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
  finished_at INTEGER,
  deleted_at INTEGER          -- set by Delete game; restorable for a day, then removed
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
