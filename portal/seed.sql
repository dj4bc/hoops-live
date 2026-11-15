-- BVABA Summer Season 2026/27 clubs. Angaston Panthers is the demo club with Plus.
INSERT OR IGNORE INTO clubs (slug, name, short, match, plus, plus_until, plus_note, colours, sponsors, link, sort, updated_at) VALUES
 ('angaston', 'Angaston Panthers', 'Panthers', '^Panthers\b', 1, '2027-09-30', 'Demo club (proof of concept)',
  '{"primary":"#14309A","dark":"#071648","accent":"#F2C14E"}',
  '{"list":{},"presenting":null,"wall":[],"wallSlots":4,"feed":null,"teams":{}}', 'panthers.adamforb.es', 1, datetime('now')),
 ('echoes', 'Echoes', 'Echoes', '^Echoes\b', 0, NULL, NULL, NULL, NULL, NULL, 2, datetime('now')),
 ('tbc', 'TBC', 'TBC', '^TBC\b', 0, NULL, NULL, NULL, NULL, NULL, 3, datetime('now')),
 ('bulldogs', 'Bulldogs', 'Bulldogs', '^Bulldogs\b', 0, NULL, NULL, NULL, NULL, NULL, 4, datetime('now')),
 ('magic', 'Magic', 'Magic', '^Magic\b', 0, NULL, NULL, NULL, NULL, NULL, 5, datetime('now')),
 ('tigers', 'Tigers', 'Tigers', '^Tigers', 0, NULL, NULL, NULL, NULL, NULL, 6, datetime('now'));
-- Central Districts Lions (Lions Den, lions.adamforb.es) use the portal only for the team stat tracker.
-- Their teams are not in comp 2861, so they never show in this site's club picker.
INSERT OR IGNORE INTO clubs (slug, name, short, match, plus, plus_until, plus_note, colours, sponsors, link, sort, updated_at) VALUES
 ('lions', 'Central Districts Lions', 'Lions', 'Central Districts Lions', 1, '2027-09-30', 'Lions Den: team stat tracker trial',
  '{"primary":"#163A80","dark":"#0E2A5E","accent":"#BE1823"}', NULL, 'lions.adamforb.es', 90, datetime('now'));
