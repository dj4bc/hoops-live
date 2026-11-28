-- Run once on the live database (28 Nov 2026): lets the hourly prune use an index instead of
-- reading every row. Safe to run more than once.
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
