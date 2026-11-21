-- Adds the restore-for-a-day bin to tracker games. Run once, before deploying the worker that uses it.
ALTER TABLE tracker_games ADD COLUMN deleted_at INTEGER;
