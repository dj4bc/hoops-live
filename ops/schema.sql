-- Latest value per key (agent snapshot, latest check results)
CREATE TABLE IF NOT EXISTS latest (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL);
-- Time series for charts and history (pruned after 30 days)
CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, kind TEXT NOT NULL, ok INTEGER, ms INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS samples_kind_ts ON samples (kind, ts);
-- For the hourly prune (DELETE ... WHERE ts < ?), which otherwise reads the whole table.
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
-- Alert state, so each problem notifies once when it starts and once when it clears
CREATE TABLE IF NOT EXISTS alerts (k TEXT PRIMARY KEY, firing INTEGER NOT NULL, since INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, message TEXT, notified INTEGER NOT NULL DEFAULT 0);
-- Incident log
CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, k TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
