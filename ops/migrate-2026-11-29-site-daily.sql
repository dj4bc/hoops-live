-- Run once on the live database (29 Nov 2026): table for the Traffic tab's season history.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS site_daily (day TEXT NOT NULL, host TEXT NOT NULL, visits INTEGER NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, host)) WITHOUT ROWID;
