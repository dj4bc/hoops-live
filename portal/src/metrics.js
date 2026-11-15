// Starter metric list for the team stat tracker. Every club gets these; change this file to change what can be recorded.
// tap: 'count' (one +1 button) or 'made_missed' (two buttons). goal: 'under' N, 'atleast' N, 'pct' made, or 'none'.
export const METRICS = [
 {
  "id": "our_turnovers",
  "name": "Our turnovers",
  "group": "Ball security",
  "tap": "count",
  "goal": "under",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "We lose the ball without a shot: bad pass, travel, double dribble, stepping out, offensive foul, or a 3/5/8/24-second call."
 },
 {
  "id": "forced_turnovers",
  "name": "Forced turnovers",
  "group": "Ball security",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U14-U18",
   "Seniors"
  ],
  "def": "They lose the ball because of our defence: steal, charge, travel under pressure, shot-clock call. Not their own unforced mistakes."
 },
 {
  "id": "off_rebounds",
  "name": "Offensive rebounds",
  "group": "Rebounding",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "We get the ball back after our own missed shot. Tip-outs count."
 },
 {
  "id": "def_rebounds",
  "name": "Defensive rebounds",
  "group": "Rebounding",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U14-U18",
   "Seniors"
  ],
  "def": "We get the ball after their missed shot."
 },
 {
  "id": "free_throws",
  "name": "Free throws",
  "group": "Shooting",
  "tap": "made_missed",
  "goal": "pct",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "Each free throw we take: made or missed."
 },
 {
  "id": "three_pt",
  "name": "3-point attempts",
  "group": "Shooting",
  "tap": "made_missed",
  "goal": "none",
  "ages": [
   "U14-U18",
   "Seniors"
  ],
  "def": "Each 3-point shot we take: made or missed."
 },
 {
  "id": "paint_touches",
  "name": "Paint touches",
  "group": "Shooting",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U14-U18",
   "Seniors"
  ],
  "def": "We catch or dribble the ball inside the key on offence. One per possession at most."
 },
 {
  "id": "key_shots",
  "name": "Shots in the key",
  "group": "Shooting",
  "tap": "made_missed",
  "goal": "pct",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "Any shot we take from inside the key (layups, post shots): made or missed."
 },
 {
  "id": "deflections",
  "name": "Deflections",
  "group": "Effort",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "One of our players touches a pass or dribble and changes where the ball goes. A steal is also a deflection."
 },
 {
  "id": "loose_balls",
  "name": "Loose balls won",
  "group": "Effort",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12",
   "U14-U18",
   "Seniors"
  ],
  "def": "We win the ball when nobody has it (on the floor or bouncing free)."
 },
 {
  "id": "charges",
  "name": "Charges taken",
  "group": "Effort",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U14-U18",
   "Seniors"
  ],
  "def": "We draw an offensive foul by standing our ground."
 },
 {
  "id": "sprint_backs",
  "name": "Sprint-backs",
  "group": "Effort",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12",
   "U14-U18"
  ],
  "def": "All five of us are back past halfway before they cross it after a change of possession."
 },
 {
  "id": "three_passes",
  "name": "Passes before a shot (3+)",
  "group": "Team play",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12",
   "U14-U18"
  ],
  "def": "We take a shot after three or more passes in the possession."
 },
 {
  "id": "all_touched",
  "name": "Everyone touched the ball",
  "group": "Team play",
  "tap": "count",
  "goal": "atleast",
  "ages": [
   "U8-U12"
  ],
  "def": "At the end of a quarter, tap once if all five on court touched the ball in a possession. Once per quarter at most."
 }
];
export const PRESETS = {
 "U8-U12 basics": [
  "our_turnovers",
  "deflections",
  "all_touched",
  "key_shots"
 ],
 "U14-U18": [
  "our_turnovers",
  "off_rebounds",
  "free_throws",
  "forced_turnovers"
 ],
 "Effort only": [
  "deflections",
  "loose_balls",
  "sprint_backs",
  "charges"
 ],
 "Seniors / social": [
  "our_turnovers",
  "off_rebounds",
  "def_rebounds",
  "free_throws"
 ]
};
export const CLUB_CORE = ["our_turnovers", "deflections"];
export const MAX_FOCUS = 4;
