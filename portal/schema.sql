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
