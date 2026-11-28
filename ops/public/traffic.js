// Traffic tab: site visits from Cloudflare Web Analytics (via /api/traffic, cached 10 min).
(function () {
  'use strict';
  var TZ = 'Australia/Adelaide';
  var el = document.getElementById('traffic');
  var data = null, failMsg = '', range = store('range') || '7', site = store('site') || 'all', loadedAt = 0;
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem('ops.traffic.' + k); localStorage.setItem('ops.traffic.' + k, v); } catch (e) { return null; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(x) { return (x || 0).toLocaleString('en-AU'); }
  function pct(a, b) {
    if (!b) return '';
    var p = Math.round((a - b) / b * 100);
    return '<span class="' + (p >= 0 ? 'up' : 'dn') + '">' + (p >= 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%</span>';
  }
  function time(ms) { return new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: TZ }); }
  function dshort(day) { var d = new Date(day + 'T12:00:00Z'); return d.getUTCDate() + ' ' + d.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' }); }
  function dow(day) { return DOW[(new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7]; }
  function addDays(day, k) { return new Date(Date.parse(day + 'T12:00:00Z') + k * 86400000).toISOString().slice(0, 10); }
  function hostsShown() { return data.hosts.filter(function (h) { return site === 'all' || h.host === site; }); }
  function visitsOn(dayRow) {
    var t = 0; hostsShown().forEach(function (h) { var x = dayRow && dayRow.sites[h.host]; if (x) t += x.v; }); return t;
  }
  function dayMap() { var m = {}; data.days.forEach(function (d) { m[d.day] = d; }); return m; }

  // Stacked bar chart. groups = [{label, parts: {host: value}}]
  function bars(groups, opt) {
    opt = opt || {};
    var W = 600, H = opt.h || 170, top = 18, bot = 20, ch = H - top - bot, hs = hostsShown();
    var max = 1; groups.forEach(function (g) { var t = 0; hs.forEach(function (h) { t += g.parts[h.host] || 0; }); if (t > max) max = t; });
    var gap = groups.length > 40 ? 1 : groups.length > 14 ? 3 : 10, bw = (W - gap * (groups.length - 1)) / groups.length, o = '';
    for (var k = 0; k <= 2; k++) o += '<line x1="0" x2="' + W + '" y1="' + (top + ch * k / 2) + '" y2="' + (top + ch * k / 2) + '" stroke="var(--line)"/>';
    (opt.bands || []).forEach(function (b) {
      var x0 = b[0] * (bw + gap), x1 = (b[1] + 1) * (bw + gap) - gap;
      o += '<rect x="' + x0 + '" y="' + top + '" width="' + Math.max(2, x1 - x0) + '" height="' + ch + '" fill="#BE1823" opacity=".09"/>';
    });
    groups.forEach(function (g, i) {
      var x = i * (bw + gap), y = top + ch, tot = 0;
      hs.forEach(function (h) {
        var v = g.parts[h.host] || 0; if (!v) return;
        var bh = v / max * ch; y -= bh; tot += v;
        o += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + h.color + '"><title>' + esc(g.title || g.label) + ': ' + esc(h.name) + ' ' + n(v) + '</title></rect>';
      });
      if (opt.vals && tot) o += '<text x="' + (x + bw / 2) + '" y="' + (y - 4) + '" font-size="12" fill="var(--mute)" text-anchor="middle">' + n(tot) + '</text>';
      if (g.label) o += '<text x="' + (x + bw / 2) + '" y="' + (H - 4) + '" font-size="12" fill="var(--mute)" text-anchor="' + (i === 0 && opt.edge ? 'start' : i === groups.length - 1 && opt.edge ? 'end' : 'middle') + '">' + esc(g.label) + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="tchart" role="img">' + o + '</svg>';
  }
  function legend(extra) {
    return '<div class="legend">' + hostsShown().map(function (h) { return '<span><span class="sw" style="background:' + h.color + '"></span>' + esc(h.name) + '</span>'; }).join('') + (extra || '') + '</div>';
  }
  function spark(vals, color) {
    var max = Math.max.apply(null, vals.concat([1])), pts = vals.map(function (v, i) { return (i * 160 / Math.max(1, vals.length - 1)).toFixed(1) + ',' + (34 - v / max * 30).toFixed(1); }).join(' ');
    return '<svg viewBox="0 0 160 36" preserveAspectRatio="none" class="spk"><polyline fill="none" stroke="' + color + '" stroke-width="2.2" vector-effect="non-scaling-stroke" stroke-linejoin="round" points="' + pts + '"/></svg>';
  }

  // Week sums ending today: [k weeks ago..this week] of rolling 7-day blocks.
  function weekly(host, weeks) {
    var m = dayMap(), out = [];
    for (var w = weeks - 1; w >= 0; w--) {
      var t = 0;
      for (var d = 0; d < 7; d++) { var r = m[addDays(data.today, -(w * 7 + d))]; if (r && r.sites[host]) t += r.sites[host].v; }
      out.push(t);
    }
    return out;
  }

  function referrerName(host) {
    var h = (host || '').replace(/^www\./, '');
    if (!h) return 'Direct / home screen';
    if (/^(lm|l)\.facebook\.com$|messenger\.com$|^m\.me$/.test(h)) return 'Messenger';
    if (/facebook\.com$|fb\.com$/.test(h)) return 'Facebook';
    if (/instagram\.com$/.test(h)) return 'Instagram';
    if (/google\./.test(h)) return 'Google';
    if (/bing\.com$|duckduckgo\.com$|yahoo\./.test(h)) return 'Other search';
    return h;
  }
  function pageName(p) {
    var name = (data.hosts.filter(function (h) { return h.host === p.host; })[0] || { name: p.host }).name;
    var path = p.path || '/';
    var what = path === '/' ? 'Home / game day' : /^\/game\//.test(path) ? 'Box score' : /^\/team\//.test(path) ? 'Team page' : path;
    return { what: what, sub: name.toLowerCase() + ' ' + path };
  }

  function render() {
    if (!el) return;
    if (!data) { el.innerHTML = failMsg ? '<div class="err">' + esc(failMsg) + '</div>' : '<div class="empty">Loading…</div>'; return; }
    if (!data.configured) {
      el.innerHTML = '<div class="hero warn"><h2><span class="dot warn"></span>Not set up yet</h2><ul><li>Add the Worker secrets <b>CF_ACCOUNT_ID</b> and <b>CF_API_TOKEN</b> (a token with Account Analytics: Read). See the README.</li></ul></div>';
      return;
    }
    var hs = hostsShown(), h = '';
    h += '<div class="seg">' + [['7', '7 days'], ['30', '30 days'], ['season', 'Season']].map(function (r) { return '<button data-range="' + r[0] + '" class="' + (range === r[0] ? 'on' : '') + '">' + r[1] + '</button>'; }).join('') +
      '<select id="site"><option value="all">All sites</option>' + data.hosts.map(function (x) { return '<option value="' + esc(x.host) + '"' + (site === x.host ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>';
    if (data.mock) h += '<div class="empty">Sample data (local test).</div>';
    if (data.errors && data.errors.length) h += '<div class="err">Some numbers could not be loaded: ' + esc(data.errors.join(' · ')) + '</div>';

    // Today
    var tv = data.todayVs || {}, pu = data.pulse, totV = 0, totP = 0;
    h += '<div class="sec">Today</div><div class="grid">';
    hs.forEach(function (x) {
      var t = tv[x.host] || { visits: 0, views: 0, lastWeek: 0 }; totV += t.visits; totP += t.views;
      h += '<div class="tile" style="border-left-color:' + x.color + '"><div class="k">' + esc(x.name) + ' · today</div><div class="v">' + n(t.visits) + '</div><div class="s">' + (t.lastWeek ? pct(t.visits, t.lastWeek) + ' vs last ' + dow(data.today) : 'visits so far') + '</div></div>';
    });
    var nowV = 0;
    if (pu && pu.buckets.length) { var lb = pu.buckets[pu.buckets.length - 1]; hs.forEach(function (x) { nowV += lb[x.host] || 0; }); }
    h += '<div class="tile" style="border-left-color:var(--red)"><div class="k">Right now</div><div class="v" style="color:var(--red)">' + (pu ? n(nowV) : '?') + '</div><div class="s">visits since ' + (pu ? time(pu.start + (pu.buckets.length - 1) * pu.step) : '?') + '</div></div>';
    h += '<div class="tile" style="border-left-color:var(--silver)"><div class="k">Page views today</div><div class="v">' + n(totP) + '</div><div class="s">' + (totV ? (totP / totV).toFixed(1) + ' per visit' : '') + '</div></div>';
    h += '</div>';

    h += '<div class="cols"><div>';
    // Game day pulse
    h += '<div class="sec">Game day pulse</div><div class="chart">';
    if (!pu) h += '<div class="empty">Not available right now.</div>';
    else {
      var first = pu.buckets.length <= 32 ? 0 : 28; // from 7 am, or midnight before 8 am
      pu.buckets.forEach(function (b, i) { if (i < first && Object.keys(b).length && hs.some(function (x) { return b[x.host] >= 3; })) first = i; });
      var groups = [], bands = [], busiest = null, total = 0;
      for (var i = first; i < Math.max(pu.buckets.length, first + 8); i++) {
        var b = pu.buckets[i] || {}, t = pu.start + i * pu.step, lab = (t - pu.start) % 7200000 === 0 ? time(t).replace(':00', '') : '';
        groups.push({ label: lab, title: time(t), parts: b });
        var s = 0; hs.forEach(function (x) { s += b[x.host] || 0; }); total += s;
        if (!busiest || s > busiest.v) busiest = { v: s, t: t };
      }
      (data.live || []).forEach(function (r) {
        var a = Math.floor((r[0] - pu.start) / pu.step) - first, z = Math.floor((r[1] - pu.start) / pu.step) - first;
        if (z >= 0 && a < pu.buckets.length - first) bands.push([Math.max(0, a), Math.min(pu.buckets.length - 1 - first, z)]);
      });
      h += '<div class="legend" style="margin:0 0 4px"><b style="color:var(--ink)">Today · every 15 min</b><span class="r">' + n(total) + ' visits' + (busiest && busiest.v ? ' · busiest ' + time(busiest.t) + ' (' + busiest.v + ')' : '') + '</span></div>';
      h += bars(groups, { bands: bands, edge: true }) + legend(bands.length ? '<span><span class="sw" style="background:#BE1823;opacity:.25"></span>games live</span>' : '');
    }
    h += '</div>';

    h += '</div><div>';
    // History
    var m = dayMap(), groupsH = [], prev = 0, cur = 0, title;
    if (range === 'season') {
      var firstDay = data.days.length ? data.days[0].day : data.today;
      var d0 = firstDay, wd = (new Date(d0 + 'T12:00:00Z').getUTCDay() + 6) % 7; d0 = addDays(d0, -wd);
      for (var wk = d0; wk <= data.today; wk = addDays(wk, 7)) {
        var parts = {};
        for (var k = 0; k < 7; k++) { var r = m[addDays(wk, k)]; if (r) hs.forEach(function (x) { if (r.sites[x.host]) parts[x.host] = (parts[x.host] || 0) + r.sites[x.host].v; }); }
        groupsH.push({ label: (!groupsH.length || wk.slice(8) <= '07') ? dshort(wk) : String(+wk.slice(8)), title: 'Week of ' + dshort(wk), parts: parts });
        hs.forEach(function (x) { cur += parts[x.host] || 0; });
      }
      title = n(cur) + ' visits since ' + dshort(firstDay);
      h += '<div class="sec">Season so far · weekly</div>';
    } else {
      var days = +range;
      for (var j = days - 1; j >= 0; j--) {
        var dd = addDays(data.today, -j), rr = m[dd], pp = {};
        if (rr) hs.forEach(function (x) { if (rr.sites[x.host]) pp[x.host] = rr.sites[x.host].v; });
        groupsH.push({ label: days === 7 ? dow(dd) : (j % 7 === 0 ? dshort(dd) : ''), title: dow(dd) + ' ' + dshort(dd), parts: pp });
        cur += visitsOn(rr); prev += visitsOn(m[addDays(data.today, -j - days)]);
      }
      title = n(cur) + ' visits';
      h += '<div class="sec">Last ' + days + ' days</div>';
    }
    h += '<div class="chart"><div class="legend" style="margin:0 0 4px"><b style="color:var(--ink)">' + title + '</b>' + (prev ? '<span class="r">' + pct(cur, prev) + ' vs the ' + range + ' days before</span>' : '') + '</div>' +
      bars(groupsH, { vals: groupsH.length <= 12, edge: groupsH.length > 12 }) + legend() + '</div>';
    if (range === 'season') h += '<div class="note">Saved each night. History starts about a month before this was switched on.</div>';
    h += '</div></div>';

    // Week vs last
    h += '<div class="sec">Last 7 days vs the 7 before</div><div class="cmp">';
    hs.forEach(function (x) {
      var w = weekly(x.host, 8), a = w[7], b = w[6];
      h += '<div class="wk"><div class="k"><span class="sw" style="background:' + x.color + '"></span>' + esc(x.name) + '</div><div class="v">' + n(a) + '</div><div class="s">' + (b ? pct(a, b) + ' vs ' + n(b) : 'no earlier week yet') + '</div>' + spark(w, x.color) + '</div>';
    });
    h += '</div><div class="note">Lines show the last 8 weeks.</div>';

    // Pages, referrers, devices
    var span = 'last ' + data.topDays + ' days';
    h += '<div class="cols"><div><div class="sec">Most viewed · ' + span + '</div><div class="list">';
    var pages = (data.pages || []).filter(function (p) { return site === 'all' || p.host === site; });
    var paths = {}; pages.forEach(function (p) { paths[p.path] = 1; });
    if (!data.pages) h += '<div class="empty">Not available right now.</div>';
    else if (Object.keys(paths).length <= 1) {
      h += pages.map(function (p) { var nm = pageName(p); return '<div class="li"><div class="grow"><b>' + esc(nm.what) + '</b><div class="sm">' + esc(nm.sub) + '</div></div><div class="r">' + n(p.views) + '</div></div>'; }).join('');
      h += '<div class="empty">The sites use # links (like /#/game/123), and Cloudflare counts all of those as the home page, so this can\'t split out box scores or team pages yet.</div>';
    } else h += pages.map(function (p) { var nm = pageName(p); return '<div class="li"><div class="grow"><b>' + esc(nm.what) + '</b><div class="sm">' + esc(nm.sub) + '</div></div><div class="r">' + n(p.views) + '</div></div>'; }).join('');
    h += '</div></div><div><div class="sec">Where from · ' + span + '</div><div class="list">';
    if (!data.referrers) h += '<div class="empty">Not available right now.</div>';
    else {
      var own = {}; data.hosts.forEach(function (x) { own[x.host] = 1; });
      var g = {}, tot = 0;
      data.referrers.forEach(function (r) { if (own[r.host]) return; var k = referrerName(r.host); g[k] = (g[k] || 0) + r.visits; tot += r.visits; });
      var list = Object.keys(g).sort(function (a, b) { return g[b] - g[a]; }).slice(0, 6);
      if (!list.length) h += '<div class="empty">No visits yet.</div>';
      list.forEach(function (k) { var p = Math.round(g[k] / tot * 100); h += '<div class="li"><div class="grow"><b>' + esc(k) + '</b><div class="mbar"><i style="width:' + p + '%"></i></div></div><div class="r">' + p + '%</div></div>'; });
    }
    h += '</div>';
    if (data.devices && data.devices.length) {
      var dt = 0; data.devices.forEach(function (d) { dt += d.visits; });
      var names = { mobile: 'Phone', desktop: 'Desktop', tablet: 'Tablet' };
      h += '<div class="legend" style="margin-top:8px">' + data.devices.map(function (d) { return '<span>' + esc(names[d.type] || d.type) + ' ' + Math.round(d.visits / dt * 100) + '%</span>'; }).join('') + '<span>(all sites)</span></div>';
    }
    h += '</div></div>';

    // Heat map
    if (data.heat) {
      var mx = 1; data.heat.forEach(function (row) { row.forEach(function (v) { if (v > mx) mx = v; }); });
      var cols = ['var(--hm0)', '#B9C8E6', '#7D98D0', '#3F62AE', '#163A80'], peak = { v: -1 };
      var hm = '<span></span>';
      for (var hr = 7; hr <= 22; hr++) hm += '<span class="hl">' + ((hr - 7) % 3 === 0 ? (hr > 12 ? (hr - 12) + 'p' : hr === 12 ? '12p' : hr + 'a') : '') + '</span>';
      data.heat.forEach(function (row, di) {
        hm += '<span>' + DOW[di] + '</span>';
        for (var hr2 = 7; hr2 <= 22; hr2++) {
          var v = row[hr2], lvl = v <= 0 ? 0 : Math.min(4, 1 + Math.floor(v / mx * 3.999));
          if (v > peak.v) peak = { v: v, d: di, h: hr2 };
          hm += '<i style="background:' + cols[lvl] + '" title="' + DOW[di] + ' ' + hr2 + ':00 · ' + n(v) + ' visits"></i>';
        }
      });
      h += '<div class="sec">When people look · last 4 weeks</div><div class="chart"><div class="hm">' + hm + '</div><div class="legend"><span>Less</span><span style="display:inline-flex;gap:2px">' + cols.map(function (c) { return '<i class="sw" style="background:' + c + '"></i>'; }).join('') + '</span><span>More</span>' +
        (peak.v > 0 ? '<span class="r">Busiest: ' + DOW[peak.d] + ' ' + (peak.h > 12 ? peak.h - 12 + ' pm' : peak.h === 12 ? '12 pm' : peak.h + ' am') + '</span>' : '') + '</div></div><div class="note">All sites. Hours are Adelaide time.</div>';
    }
    h += '<div class="foot"><span>From Cloudflare Web Analytics · updated ' + time(data.now) + ' · refreshes every 10 min</span></div>';
    el.innerHTML = h;
    Array.prototype.forEach.call(el.querySelectorAll('[data-range]'), function (b) { b.onclick = function () { range = b.getAttribute('data-range'); store('range', range); load(); }; });
    var sel = document.getElementById('site'); if (sel) sel.onchange = function () { site = sel.value; store('site', site); render(); };
  }

  function load() {
    var mock = location.search.indexOf('mock') >= 0 ? '&' + location.search.slice(1) : '';
    fetch('api/traffic?range=' + range + mock, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (r.status === 403) throw new Error('Signed out. Reload the page to sign in again.'); if (!r.ok) throw new Error('Dashboard error ' + r.status + '.'); return r.json(); })
      .then(function (j) { data = j; failMsg = ''; loadedAt = Date.now(); render(); })
      .catch(function (e) { failMsg = e.message || "Can't reach the dashboard."; render(); });
  }
  window.opsTraffic = {
    show: function () { if (!data || Date.now() - loadedAt > 300000) load(); else render(); },
  };
  if (location.hash === '#traffic') window.opsTraffic.show();
  setInterval(function () { if (!document.hidden && location.hash === '#traffic') load(); }, 600000);
})();
