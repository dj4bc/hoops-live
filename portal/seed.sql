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
