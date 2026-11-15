-- Central Districts Lions (Lions Den, lions.adamforb.es) use the portal only for the team stat tracker.
-- Their teams are not in comp 2861, so they never show in this site's club picker.
INSERT OR IGNORE INTO clubs (slug, name, short, match, plus, plus_until, plus_note, colours, sponsors, link, sort, updated_at) VALUES
 ('lions', 'Central Districts Lions', 'Lions', 'Central Districts Lions', 1, '2027-09-30', 'Lions Den: team stat tracker trial',
  '{"primary":"#163A80","dark":"#0E2A5E","accent":"#BE1823"}', NULL, 'lions.adamforb.es', 90, datetime('now'));
