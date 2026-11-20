-- One-off repair (21 Nov 2026): a tracker link arrived with its "?opp=..." query inside the team
-- name, e.g. "U14 Boys Lions 4?opp=Forestville+Eagles+4&d=2026-11-21&m=1335382&r=Round+6".
-- Moves those games and sign-ins back to the real team name, keeping every tap.
-- Run: npx wrangler d1 execute hoops-portal --remote --file=fix-team-names.sql

-- Fill in the opponent from the junk where the game has none.
UPDATE tracker_games
SET opponent = replace(
  substr(team, instr(team, 'opp=') + 4,
         CASE WHEN instr(substr(team, instr(team, 'opp=') + 4), '&') > 0
              THEN instr(substr(team, instr(team, 'opp=') + 4), '&') - 1
              ELSE 60 END), '+', ' ')
WHERE instr(team, '?opp=') > 0 AND (opponent IS NULL OR opponent = '');

UPDATE tracker_games    SET team = rtrim(substr(team, 1, instr(team, '?') - 1)) WHERE instr(team, '?') > 0;
UPDATE tracker_sessions SET team = rtrim(substr(team, 1, instr(team, '?') - 1)) WHERE instr(team, '?') > 0;
-- PIN rows made for the junk name were copies of the club PIN, so they can just go.
DELETE FROM tracker_teams WHERE instr(team, '?') > 0 AND inherited = 1;

SELECT id, team, opponent, game_date, status FROM tracker_games ORDER BY created_at DESC LIMIT 5;
