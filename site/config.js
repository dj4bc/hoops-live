// Site settings for the multi-club site. The club list here is the fallback: when the
// club portal is reachable, its live settings (branding, sponsors, Plus) replace these.
window.HOOPS_CONFIG = {
  siteName: 'Barossa Hoops Live',
  shortName: 'Hoops Live',
  assocName: 'Barossa Valley Basketball',
  seasonLabel: 'Summer Season 2026/27',
  apiBase: 'https://api-basketball.squadi.com',
  // Club portal API. Leave empty to use only the clubs below.
  portalBase: 'https://portal.adamforb.es',
  // Live fouls (Linode scraper) and game alerts. Only used for clubs with Plus.
  foulsBase: 'https://fouls.adamforb.es',
  pushBase: 'https://fouls.adamforb.es/push',
  // Clubs whose team pages show the team stat tracker button. Empty while it is tested on Lions Den.
  trackerClubs: [],
  timeZone: 'Australia/Adelaide',
  liveRefreshMs: 60000,
  // Competitions. The whole competition is loaded once and filtered by club in the browser.
  competitions: [
    {
      id: 2861, label: '', key: '0a2ff4f2-c35d-41ed-8495-9473080b64c6',
      sourceUrl: 'https://registration.basketballconnect.com/livescoreSeasonFixture?organisationKey=c5f5cbe6-a575-4514-a3a6-f37128456e37&yearId=9&competitionUniqueKey=0a2ff4f2-c35d-41ed-8495-9473080b64c6&divisionId=All'
    }
  ],
  // Clubs. `match` is a regular expression for the club's team names in BasketballConnect.
  // Only clubs with `plus: true` get their logo, colours, sponsors, live fouls and alerts.
  clubs: [
    { slug: 'angaston', name: 'Angaston Panthers', short: 'Panthers', match: '^Panthers\\b', plus: true,
      logo: 'clubs/angaston.png', colours: { primary: '#14309A', dark: '#071648', accent: '#F2C14E' } },
    { slug: 'echoes', name: 'Echoes', short: 'Echoes', match: '^Echoes\\b',
      colours: { primary: '#121A5A', dark: '#0B1140', accent: '#28C4F4' } },
    { slug: 'tbc', name: 'TBC', short: 'TBC', match: '^TBC\\b',
      colours: { primary: '#0E7A3A', dark: '#084C36', accent: '#F7C206' } },
    { slug: 'bulldogs', name: 'Bulldogs', short: 'Bulldogs', match: '^Bulldogs\\b',
      colours: { primary: '#123981', dark: '#0A2152', accent: '#D82E2D' } },
    { slug: 'magic', name: 'Magic', short: 'Magic', match: '^Magic\\b',
      colours: { primary: '#21924A', dark: '#201E1E', accent: '#F16935' } },
    { slug: 'tigers', name: 'Tigers', short: 'Tigers', match: '^Tigers',
      colours: { primary: '#1A1A1A', dark: '#040401', accent: '#FCEE06' } }
  ],
  // Club subdomains, e.g. panthers.adamforb.es opens Angaston Panthers.
  hosts: { panthers: 'angaston', angaston: 'angaston' }
};
