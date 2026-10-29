(function () {
  "use strict";

  var REPO = "conscherry/status";
  var BRANCH = "master";
  var RAW = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/history/summary.json";
  var API = "https://api.github.com/repos/" + REPO;
  var DAYS = 90;
  var REFRESH_MS = 60000;
  var PAGE_SIZE = 15;

  var GROUPS = [
    { name: "Conscherry", slugs: ["conscherry", "api-services", "conscherry-dashboard", "helpdesk"] },
    { name: "Projects", slugs: ["labs-project", "labs-api-services", "kind-bot-health", "the-gobble-project", "indenti-project"] },
    { name: "Infrastructure", slugs: ["project-host"] }
  ];

  var ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L3 17.7 6.3 21l6.3-6.3a4 4 0 0 0 5.1-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'
  };

  var app = document.getElementById("app");
  var tip = document.getElementById("tip");
  var state = { summary: null, meta: {}, incidents: null, incidentsFailed: false, fetchedAt: null, historyShown: PAGE_SIZE, comments: {} };
  var themePref = "dark";
  var timer = null;

  function svg(name, cls) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : "") + ">" + ICONS[name] + "</svg>";
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function timeout(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    return undefined;
  }

  function getJson(urls, ms) {
    var list = Array.isArray(urls) ? urls : [urls];
    return list.reduce(function (p, url) {
      return p.catch(function () {
        return fetch(url, { cache: "no-cache", signal: timeout(ms || 8000), headers: { Accept: "application/json" } }).then(function (r) {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        });
      });
    }, Promise.reject(new Error("start")));
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function dayKey(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  function fmtDay(key) {
    var d = new Date(key + "T12:00:00Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function fmtDateTime(iso) {
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function fmtDuration(mins) {
    mins = Math.round(mins);
    if (mins < 1) return "under a minute";
    if (mins < 60) return mins + " min";
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h < 48) return h + " h" + (m ? " " + m + " min" : "");
    var d = Math.floor(h / 24);
    return d + " d" + (h % 24 ? " " + (h % 24) + " h" : "");
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " seconds ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }

  function fmtPct(v) {
    if (v >= 99.995) return "100%";
    if (v >= 99.9) return v.toFixed(2) + "%";
    return v.toFixed(v < 10 ? 2 : 1) + "%";
  }

  function pctNum(s) {
    var n = parseFloat(String(s).replace("%", ""));
    return isNaN(n) ? null : n;
  }

  function cleanTitle(t) {
    return String(t || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  }

  function siteByName(name) {
    var list = (state.summary || []);
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }

  function dayStatus(mins) {
    if (mins <= 0) return "ok";
    if (mins < 60) return "warn";
    return "bad";
  }

  function computeSite(site) {
    var meta = state.meta[site.slug] || {};
    var start = meta.startTime ? new Date(meta.startTime) : null;
    var now = new Date();
    var todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    var down = site.dailyMinutesDown || {};
    var days = [];
    var totalDown = 0;
    var totalValid = 0;
    for (var i = DAYS - 1; i >= 0; i--) {
      var ds = todayStart - i * 86400000;
      var key = dayKey(new Date(ds));
      var from = start ? Math.max(ds, start.getTime()) : ds;
      var to = Math.min(ds + 86400000, now.getTime());
      var valid = Math.max(0, (to - from) / 60000);
      if (valid <= 0) {
        days.push({ key: key, s: "none", mins: 0 });
        continue;
      }
      var mins = Math.min(down[key] || 0, valid);
      totalDown += mins;
      totalValid += valid;
      days.push({ key: key, s: dayStatus(mins), mins: mins });
    }
    var uptime = totalValid > 0 ? (1 - totalDown / totalValid) * 100 : null;
    return { days: days, uptime: uptime, totalDown: totalDown };
  }

  function siteState(site) {
    if (site.status === "down") return "bad";
    if (site.status === "degraded") return "warn";
    return "ok";
  }

  var STATE_LABEL = { ok: "Operational", warn: "Degraded", bad: "Outage" };

  function overall(list) {
    var down = list.filter(function (s) { return s.status === "down"; }).length;
    var deg = list.filter(function (s) { return s.status === "degraded"; }).length;
    if (list.length && down === list.length) return { s: "bad", icon: "x", title: "Major outage", text: "All services are currently unreachable. We're working on it." };
    if (down) return { s: "bad", icon: "x", title: "Partial outage", text: down + (down === 1 ? " service is" : " services are") + " currently down. Everything else is working normally." };
    if (deg) return { s: "warn", icon: "alert", title: "Degraded performance", text: deg + (deg === 1 ? " service is" : " services are") + " running slower than usual." };
    return { s: "ok", icon: "check", title: "All systems operational", text: "Every Conscherry service is up and responding normally." };
  }

  function normalizeIncident(issue) {
    var labels = (issue.labels || []).map(function (l) { return typeof l === "string" ? l : l.name; });
    var slugMap = {};
    (state.summary || []).forEach(function (s) { slugMap[s.slug] = s; });
    var services = labels.filter(function (l) { return slugMap[l]; }).map(function (l) { return slugMap[l].name; });
    var body = issue.body || "";
    var maintenance = labels.indexOf("maintenance") !== -1;
    var title = cleanTitle(issue.title);
    var inc = {
      id: issue.number,
      title: title,
      url: issue.html_url,
      open: issue.state === "open",
      created: issue.created_at,
      closed: issue.closed_at,
      services: services,
      maintenance: maintenance,
      degraded: /degraded/i.test(issue.title || ""),
      commentsUrl: issue.comments_url,
      commentsCount: issue.comments || 0,
      snapshotComments: issue.snapshot_comments || null,
      body: body
    };
    if (maintenance) {
      var s = /start:\s*(\S+)/i.exec(body);
      var e = /end:\s*(\S+)/i.exec(body);
      inc.start = s ? s[1] : issue.created_at;
      inc.end = e ? e[1] : null;
      var ed = /expectedDown:\s*([^\n\r]+)/i.exec(body);
      var eg = /expectedDegraded:\s*([^\n\r]+)/i.exec(body);
      [ed, eg].forEach(function (m) {
        if (!m) return;
        m[1].split(",").forEach(function (x) {
          var slug = x.replace(/-->/g, "").trim();
          if (slugMap[slug] && inc.services.indexOf(slugMap[slug].name) === -1) inc.services.push(slugMap[slug].name);
        });
      });
    }
    var code = /HTTP code:\s*`?(\d+)`?/i.exec(body);
    var rt = /Response time:\s*`?(\d+)`?\s*ms/i.exec(body);
    inc.httpCode = code ? code[1] : null;
    inc.responseTime = rt ? rt[1] : null;
    return inc;
  }

  function incidentList() {
    return (state.incidents || [])
      .filter(function (i) { return !i.pull_request; })
      .filter(function (i) {
        var labels = (i.labels || []).map(function (l) { return typeof l === "string" ? l : l.name; });
        return labels.indexOf("status") !== -1 || labels.indexOf("maintenance") !== -1;
      })
      .map(normalizeIncident)
      .sort(function (a, b) { return new Date(b.created) - new Date(a.created); });
  }

  function isBot(c) {
    var u = c.user || {};
    return u.type === "Bot" || /upptime|bot/i.test(u.login || "");
  }

  function timelineFor(inc, comments) {
    var items = [];
    var who = inc.services.length ? inc.services.join(", ") : "A service";
    if (inc.maintenance) {
      items.push({ t: "info", label: "Scheduled", time: inc.created, text: "Maintenance is planned" + (inc.start ? " from " + fmtDateTime(inc.start) : "") + (inc.end ? " until " + fmtDateTime(inc.end) : "") + "." });
    } else {
      var detail = [];
      if (inc.httpCode) detail.push("HTTP " + inc.httpCode);
      if (inc.responseTime) detail.push(inc.responseTime + " ms response");
      items.push({
        t: inc.degraded ? "warn" : "bad",
        label: inc.degraded ? "Degraded" : "Investigating",
        time: inc.created,
        text: "Automated monitoring detected a problem with " + who + (detail.length ? " (" + detail.join(", ") + ")." : ".")
      });
    }
    (comments || []).forEach(function (c) {
      if (isBot(c)) {
        if (/resolved|back online|is back/i.test(c.body || "")) {
          items.push({ t: "ok", label: "Resolved", time: c.created_at, text: who + " is back online and responding normally." });
        }
        return;
      }
      items.push({ t: "info", label: "Update", time: c.created_at, text: String(c.body || "").trim() });
    });
    if (!inc.open && !items.some(function (i) { return i.label === "Resolved"; })) {
      items.push({ t: "ok", label: inc.maintenance ? "Completed" : "Resolved", time: inc.closed, text: inc.maintenance ? "Maintenance has finished." : who + " is back online and responding normally." });
    }
    return items.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
  }

  function timelineHtml(items) {
    return '<ol class="timeline">' + items.map(function (i) {
      return '<li data-t="' + (i.t === "info" ? "" : i.t) + '"><div class="tl-head"><strong>' + esc(i.label) + "</strong><time datetime=\"" + esc(i.time) + '">' + esc(fmtDateTime(i.time)) + '</time></div><p class="tl-body">' + esc(i.text) + "</p></li>";
    }).join("") + "</ol>";
  }

  function loadComments(inc) {
    if (state.comments[inc.id]) return Promise.resolve(state.comments[inc.id]);
    if (inc.snapshotComments && !inc.open) {
      state.comments[inc.id] = inc.snapshotComments;
      return Promise.resolve(inc.snapshotComments);
    }
    if (!inc.commentsUrl || !inc.commentsCount) {
      state.comments[inc.id] = inc.snapshotComments || [];
      return Promise.resolve(state.comments[inc.id]);
    }
    return getJson(inc.commentsUrl + "?per_page=100").then(function (c) {
      state.comments[inc.id] = c;
      return c;
    }).catch(function () {
      state.comments[inc.id] = inc.snapshotComments || [];
      return state.comments[inc.id];
    });
  }

  function serviceRow(site) {
    var calc = computeSite(site);
    var st = siteState(site);
    var bars = calc.days.map(function (d) {
      return '<i class="bar" data-s="' + (d.s === "ok" ? "" : d.s) + '" data-day="' + d.key + '" data-m="' + Math.round(d.mins) + '" data-n="' + (d.s === "none" ? 1 : 0) + '" tabindex="-1"></i>';
    }).join("");
    var icon = site.icon
      ? '<img class="svc-icon" src="' + esc(site.icon) + '" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=&quot;svc-icon-fallback&quot; aria-hidden=&quot;true&quot;>' + esc(site.name.charAt(0)) + '</span>\'">'
      : '<span class="svc-icon-fallback" aria-hidden="true">' + esc(site.name.charAt(0)) + "</span>";
    var uptimeText = calc.uptime == null ? "No data" : fmtPct(calc.uptime);
    var rt = function (v) { return v ? v + " ms" : "n/a"; };
    var up = function (v) { var n = pctNum(v); return n == null ? "n/a" : fmtPct(n); };
    return '<article class="svc" data-slug="' + esc(site.slug) + '">' +
      '<button class="svc-toggle" type="button" aria-expanded="false" aria-controls="d-' + esc(site.slug) + '">' +
      icon +
      '<span class="svc-name">' + esc(site.name) + "</span>" +
      '<span class="svc-uptime">' + esc(uptimeText) + "</span>" +
      '<span class="pill pill-' + st + '">' + STATE_LABEL[st] + "</span>" +
      svg("chev", "chev") +
      "</button>" +
      '<div class="bars" role="img" aria-label="' + esc(site.name + ": " + uptimeText + " uptime over the last 90 days") + '">' + bars + "</div>" +
      '<div class="bars-legend"><span>90 days ago</span><span class="rule"></span><span>' + esc(uptimeText) + ' uptime</span><span class="rule"></span><span>Today</span></div>' +
      '<dl class="svc-detail" id="d-' + esc(site.slug) + '" hidden>' +
      '<div class="metric"><dt>Uptime 24h</dt><dd>' + up(site.uptimeDay) + "</dd></div>" +
      '<div class="metric"><dt>Uptime 7d</dt><dd>' + up(site.uptimeWeek) + "</dd></div>" +
      '<div class="metric"><dt>Uptime 30d</dt><dd>' + up(site.uptimeMonth) + "</dd></div>" +
      '<div class="metric"><dt>Uptime 1y</dt><dd>' + up(site.uptimeYear) + "</dd></div>" +
      '<div class="metric"><dt>Response 24h</dt><dd>' + rt(site.timeDay) + "</dd></div>" +
      '<div class="metric"><dt>Response 7d</dt><dd>' + rt(site.timeWeek) + "</dd></div>" +
      '<div class="metric"><dt>Response 30d</dt><dd>' + rt(site.timeMonth) + "</dd></div>" +
      '<div class="metric"><dt>Response 1y</dt><dd>' + rt(site.timeYear) + "</dd></div>" +
      "</dl></article>";
  }

  function groupHtml(group, sites) {
    var worst = "ok";
    sites.forEach(function (s) {
      var st = siteState(s);
      if (st === "bad" || (st === "warn" && worst === "ok")) worst = st;
    });
    return '<section class="card group" aria-label="' + esc(group.name) + '">' +
      '<div class="group-head"><h3>' + esc(group.name) + '</h3><div style="display:flex;align-items:center;gap:.75rem"><span class="group-count">' + sites.length + (sites.length === 1 ? " service" : " services") + '</span><span class="pill pill-' + worst + '">' + STATE_LABEL[worst] + "</span></div></div>" +
      sites.map(serviceRow).join("") + "</section>";
  }

  function incidentCard(inc, comments) {
    var kind = inc.maintenance ? "info" : inc.degraded ? "warn" : "bad";
    var pill = inc.maintenance
      ? (inc.start && new Date(inc.start) > new Date() ? '<span class="pill pill-info">Scheduled</span>' : '<span class="pill pill-info">In progress</span>')
      : inc.degraded ? '<span class="pill pill-warn">Degraded</span>' : '<span class="pill pill-bad">Outage</span>';
    var since = inc.maintenance && inc.start
      ? "Window: " + fmtDateTime(inc.start) + (inc.end ? " to " + fmtDateTime(inc.end) : "")
      : "Started " + fmtDateTime(inc.created) + " (" + ago(new Date(inc.created).getTime()) + ")";
    return '<article class="card incident" data-kind="' + kind + '" data-id="' + inc.id + '">' +
      '<div class="incident-top">' + pill + '<h3 class="incident-title">' + esc(inc.title) + "</h3></div>" +
      '<p class="incident-meta">' + esc(since) + ' &middot; <a href="' + esc(inc.url) + '" rel="noopener">View on GitHub</a></p>' +
      (inc.services.length ? '<div class="chips">' + inc.services.map(function (n) { return '<span class="chip">' + esc(n) + "</span>"; }).join("") + "</div>" : "") +
      '<div class="incident-timeline">' + timelineHtml(timelineFor(inc, comments)) + "</div></article>";
  }

  function renderOverview() {
    var list = state.summary || [];
    var ov = overall(list);
    var incs = incidentList();
    var active = incs.filter(function (i) { return i.open && !i.maintenance; });
    var maint = incs.filter(function (i) { return i.maintenance && i.open && (!i.end || new Date(i.end) > new Date()); });
    var computed = list.map(computeSite);
    var withData = computed.filter(function (c) { return c.uptime != null; });
    var avgUptime = withData.length ? withData.reduce(function (a, c) { return a + c.uptime; }, 0) / withData.length : null;
    var rts = list.filter(function (s) { return s.timeDay > 0; });
    var avgRt = rts.length ? Math.round(rts.reduce(function (a, s) { return a + s.timeDay; }, 0) / rts.length) : null;
    var upCount = list.filter(function (s) { return s.status === "up"; }).length;

    var html = '<div class="view">';
    html += '<section class="card hero" data-state="' + ov.s + '" aria-live="polite"><div class="orb">' + svg(ov.icon) + '</div><div><p class="eyebrow" style="margin:0 0 .35rem">Conscherry status</p><h1>' + esc(ov.title) + "</h1><p>" + esc(ov.text) + '</p><div class="hero-meta"><span class="live" id="updated">Updated ' + esc(ago(state.fetchedAt)) + '</span><span>Checked every few minutes</span></div></div><div><a class="btn btn-secondary" href="https://conscherry.com">Back to Conscherry</a></div></section>';

    html += '<div class="stats">' +
      '<div class="card stat"><div class="stat-label">Services up</div><div class="stat-value">' + upCount + " / " + list.length + '</div><div class="stat-sub">right now</div></div>' +
      '<div class="card stat"><div class="stat-label">90-day uptime</div><div class="stat-value">' + (avgUptime == null ? "n/a" : fmtPct(avgUptime)) + '</div><div class="stat-sub">across all services</div></div>' +
      '<div class="card stat"><div class="stat-label">Avg response</div><div class="stat-value">' + (avgRt == null ? "n/a" : avgRt + " ms") + '</div><div class="stat-sub">last 24 hours</div></div>' +
      "</div>";

    if (maint.length) {
      html += '<section class="section" aria-label="Scheduled maintenance"><div class="section-head"><div><h2>Scheduled maintenance</h2></div></div>' + maint.map(function (i) { return incidentCard(i, []); }).join("") + "</section>";
    }

    html += '<section class="section" aria-label="Active incidents"><div class="section-head"><div><h2>Active incidents</h2></div></div>';
    if (state.incidentsFailed && !state.incidents) {
      html += '<div class="card notice">Incident details are unavailable right now. Check <a href="https://github.com/' + REPO + '/issues">GitHub</a> for the latest updates.</div>';
    } else if (active.length) {
      html += '<div id="active-list">' + active.map(function (i) { return incidentCard(i, state.comments[i.id] || []); }).join("") + "</div>";
    } else {
      html += '<div class="card empty-ok">' + svg("check") + "<p>No incidents are being investigated right now.</p></div>";
    }
    html += "</section>";

    html += '<section class="section" aria-label="Services"><div class="section-head"><div><h2>Services</h2><p>Daily uptime for the last 90 days. Select a service for more detail.</p></div></div>';
    var used = {};
    GROUPS.forEach(function (g) {
      var sites = g.slugs.map(function (slug) { return list.filter(function (s) { return s.slug === slug; })[0]; }).filter(Boolean);
      sites.forEach(function (s) { used[s.slug] = true; });
      if (sites.length) html += groupHtml(g, sites);
    });
    var rest = list.filter(function (s) { return !used[s.slug]; });
    if (rest.length) html += groupHtml({ name: "Other" }, rest);
    html += '<div class="legend-key"><span><i></i>No downtime</span><span><i data-s="warn"></i>Under 1 hour down</span><span><i data-s="bad"></i>1 hour or more down</span><span><i data-s="none"></i>No data</span></div></section></div>';

    app.innerHTML = html;
    active.forEach(function (inc) {
      loadComments(inc).then(function (c) {
        var el = app.querySelector('.incident[data-id="' + inc.id + '"] .incident-timeline');
        if (el) el.innerHTML = timelineHtml(timelineFor(inc, c));
      });
    });
  }

  function historyItem(inc) {
    var dur = inc.closed ? fmtDuration((new Date(inc.closed) - new Date(inc.created)) / 60000) : null;
    var pill = inc.maintenance ? '<span class="pill pill-info">Maintenance</span>' : !inc.open ? '<span class="pill pill-ok">Resolved</span>' : inc.degraded ? '<span class="pill pill-warn">Degraded</span>' : '<span class="pill pill-bad">Ongoing</span>';
    return '<article class="card hist" data-id="' + inc.id + '"><button class="hist-toggle" type="button" aria-expanded="false" aria-controls="h-' + inc.id + '"><div><div class="hist-title">' + esc(inc.title) + '</div><div class="hist-sub">' + esc(fmtDateTime(inc.created)) + (dur ? " &middot; lasted " + esc(dur) : "") + "</div></div>" + pill + svg("chev", "chev") + '</button><div class="hist-body" id="h-' + inc.id + '" hidden>' +
      (inc.services.length ? '<div class="chips" style="margin:0 0 .5rem">' + inc.services.map(function (n) { return '<span class="chip">' + esc(n) + "</span>"; }).join("") + "</div>" : "") +
      '<div class="hist-timeline"></div><p class="incident-meta"><a href="' + esc(inc.url) + '" rel="noopener">View on GitHub</a></p></div></article>';
  }

  function renderHistory() {
    var incs = incidentList();
    var html = '<div class="view"><div class="section-head" style="margin-top:0"><div><p class="eyebrow">History</p><h2>Past incidents</h2><p>Every outage and maintenance window, newest first.</p></div></div>';
    if (state.incidentsFailed && !state.incidents) {
      html += '<div class="card notice">Incident history is unavailable right now. You can still read it on <a href="https://github.com/' + REPO + '/issues?q=is%3Aissue">GitHub</a>.</div>';
    } else if (!incs.length) {
      html += '<div class="card empty"><strong>No incidents yet</strong><p>Nothing has gone wrong since monitoring started.</p></div>';
    } else {
      var shown = incs.slice(0, state.historyShown);
      var lastMonth = "";
      shown.forEach(function (inc) {
        var m = new Date(inc.created).toLocaleDateString(undefined, { month: "long", year: "numeric" });
        if (m !== lastMonth) {
          html += '<h3 class="month">' + esc(m) + "</h3>";
          lastMonth = m;
        }
        html += historyItem(inc);
      });
      if (incs.length > shown.length) html += '<div class="more"><button class="btn btn-secondary" type="button" id="more">Show older incidents</button></div>';
    }
    html += "</div>";
    app.innerHTML = html;
  }

  function route() {
    return /^#\/history/.test(location.hash) ? "history" : "overview";
  }

  function render() {
    var r = route();
    document.querySelectorAll(".tabs a[data-route]").forEach(function (a) {
      if (a.getAttribute("data-route") === r) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.title = (r === "history" ? "Incident history" : overallTitle()) + " | Conscherry Status";
    if (!state.summary) return;
    if (r === "history") renderHistory();
    else renderOverview();
  }

  function overallTitle() {
    return state.summary ? overall(state.summary).title : "Conscherry Status";
  }

  function showError() {
    app.innerHTML = '<div class="view"><div class="card empty"><strong>We couldn\'t load the status data</strong><p>Please try again in a moment, or check <a href="https://github.com/' + REPO + '">the status repository</a>.</p><div class="more"><button class="btn btn-primary" type="button" id="retry">Try again</button></div></div></div>';
  }

  function loadAll(initial) {
    var p1 = getJson([RAW, "data/summary.json"]).then(function (s) {
      state.summary = s;
      state.fetchedAt = Date.now();
    });
    var p2 = getJson(["data/meta.json"]).then(function (m) { state.meta = m; }).catch(function () {});
    var p3 = getJson([API + "/issues?state=all&per_page=100&sort=created&direction=desc", "data/incidents.json"]).then(function (i) {
      state.incidents = i;
      state.incidentsFailed = false;
    }).catch(function () {
      state.incidentsFailed = true;
    });
    return Promise.all([p1, p2, p3]).then(function () {
      if (!initial) {
        var open = {};
        app.querySelectorAll(".svc-toggle[aria-expanded='true']").forEach(function (b) { open[b.parentNode.getAttribute("data-slug")] = true; });
        render();
        Object.keys(open).forEach(function (slug) {
          var b = app.querySelector('.svc[data-slug="' + slug + '"] .svc-toggle');
          if (b) toggleSvc(b);
        });
      } else render();
    }).catch(function () {
      if (!state.summary) showError();
    });
  }

  function toggleSvc(btn) {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    var d = document.getElementById(btn.getAttribute("aria-controls"));
    if (d) d.hidden = open;
  }

  function toggleHist(btn) {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    var body = document.getElementById(btn.getAttribute("aria-controls"));
    body.hidden = open;
    if (open) return;
    var id = Number(btn.parentNode.getAttribute("data-id"));
    var inc = incidentList().filter(function (i) { return i.id === id; })[0];
    var target = body.querySelector(".hist-timeline");
    if (!inc || target.dataset.done) return;
    target.innerHTML = timelineHtml(timelineFor(inc, []));
    loadComments(inc).then(function (c) {
      target.innerHTML = timelineHtml(timelineFor(inc, c));
      target.dataset.done = "1";
    });
  }

  app.addEventListener("click", function (e) {
    var t = e.target;
    var svc = t.closest && t.closest(".svc-toggle");
    if (svc) return toggleSvc(svc);
    var h = t.closest && t.closest(".hist-toggle");
    if (h) return toggleHist(h);
    if (t.closest && t.closest("#more")) {
      state.historyShown += PAGE_SIZE;
      renderHistory();
      return;
    }
    if (t.closest && t.closest("#retry")) {
      app.innerHTML = '<div class="loading"><div class="skeleton" style="height:9rem;border-radius:1rem"></div></div>';
      loadAll(true);
    }
  });

  function showTip(el) {
    if (!el || !el.classList.contains("bar")) return hideTip();
    var key = el.getAttribute("data-day");
    var mins = Number(el.getAttribute("data-m"));
    var none = el.getAttribute("data-n") === "1";
    var name = el.closest(".svc").querySelector(".svc-name").textContent;
    var detail = none ? "No data" : mins <= 0 ? "No downtime recorded" : fmtDuration(mins) + " of downtime";
    tip.innerHTML = "<strong>" + esc(fmtDay(key)) + "</strong><span>" + esc(name) + " &middot; " + esc(detail) + "</span>";
    tip.hidden = false;
    var r = el.getBoundingClientRect();
    var w = tip.offsetWidth;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    var y = r.top - tip.offsetHeight - 10;
    if (y < 8) y = r.bottom + 10;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function hideTip() {
    tip.hidden = true;
  }

  app.addEventListener("pointerover", function (e) { showTip(e.target); });
  app.addEventListener("pointerout", function (e) { if (e.target.classList && e.target.classList.contains("bar")) hideTip(); });
  app.addEventListener("pointerdown", function (e) { if (e.pointerType === "touch") showTip(e.target); });
  document.addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("pointerdown", function (e) {
    if (!e.target.closest || !e.target.closest(".bars")) hideTip();
    var sub = document.getElementById("subscribe");
    if (sub && sub.open && !sub.contains(e.target)) sub.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var sub = document.getElementById("subscribe");
      if (sub) sub.open = false;
      hideTip();
    }
  });

  function readTheme() {
    try {
      var v = localStorage.getItem("theme");
      if (v === "light" || v === "dark" || v === "system") return v;
    } catch (e) {}
    return "dark";
  }

  function applyTheme(pref) {
    themePref = pref;
    var root = document.documentElement;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    try { localStorage.setItem("theme", pref); } catch (e) {}
    paintTheme();
  }

  function paintTheme() {
    var opts = [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]];
    document.getElementById("theme-seg").innerHTML = opts.map(function (o) {
      return '<button type="button" data-theme-pref="' + o[0] + '" aria-pressed="' + (themePref === o[0]) + '">' + svg(o[2]) + o[1] + "</button>";
    }).join("");
    var cur = opts.filter(function (o) { return o[0] === themePref; })[0];
    var btn = document.getElementById("theme-cycle");
    btn.innerHTML = svg(cur[2]);
    btn.setAttribute("aria-label", "Theme: " + cur[1] + ". Change theme");
    btn.title = "Theme: " + cur[1];
  }

  document.getElementById("theme-seg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-theme-pref]");
    if (b) applyTheme(b.getAttribute("data-theme-pref"));
  });

  document.getElementById("theme-cycle").addEventListener("click", function () {
    var order = ["system", "light", "dark"];
    applyTheme(order[(order.indexOf(themePref) + 1) % order.length]);
  });

  window.addEventListener("hashchange", function () {
    state.historyShown = PAGE_SIZE;
    render();
    window.scrollTo(0, 0);
  });

  setInterval(function () {
    var el = document.getElementById("updated");
    if (el && state.fetchedAt) el.textContent = "Updated " + ago(state.fetchedAt);
  }, 15000);

  document.getElementById("year").textContent = new Date().getFullYear();
  themePref = readTheme();
  paintTheme();
  loadAll(true);
  timer = setInterval(function () {
    if (document.hidden) return;
    loadAll(false);
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.fetchedAt && Date.now() - state.fetchedAt > REFRESH_MS) loadAll(false);
  });
})();
