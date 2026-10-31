(function () {
  "use strict";

  var REPO = "conscherry/status";
  var BRANCH = "master";
  var RAW = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/history/summary.json";
  var API = "https://api.github.com/repos/" + REPO;
  var DAYS = 90;
  var REFRESH_MS = 60000;
  var SERIES_MS = 600000;
  var PAGE_SIZE = 15;
  var REGION_RE = /^(.*) \(([^)]+)\)$/;
  var STATE_LABEL = { ok: "Operational", warn: "Degraded", bad: "Outage" };
  var BADGE_COLOR = { ok: "#38c65c", warn: "#f5a524", bad: "#ff5750" };

  var GROUPS = [
    { name: "Conscherry", slugs: ["conscherry", "api-services", "conscherry-dashboard", "helpdesk"] },
    { name: "Projects", slugs: ["labs-project", "labs-api-services", "kind-bot-health", "the-gobble-project", "indenti-project"] },
    { name: "Infrastructure", slugs: ["project-host"] }
  ];

  var ICONS = {
    chev: '<path d="M6 9l6 6 6-6"/>',
    ext: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>'
  };

  var app = document.getElementById("app");
  var tip = document.getElementById("tip");
  var state = {
    summary: null, meta: {}, config: {}, series: null, seriesAt: 0, incidents: null, incidentsFailed: false,
    fetchedAt: null, historyShown: PAGE_SIZE, comments: {}, range: {}, model: null, loading: false,
    cal: null, openSvc: {}, openInc: {}, logo: null
  };
  var themePref = "dark";

  function svg(name, cls) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : "") + ">" + ICONS[name] + "</svg>";
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function timeout(ms) {
    return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
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

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dayKey(ms) { var d = new Date(ms); return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }

  function fmtDay(key) {
    return new Date(key + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }

  function fmtUtc(iso) {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
  }

  function fmtLocal(iso) {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
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
    if (s < 15) return "just now";
    if (s < 60) return s + " seconds ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    var h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour ago" : " hours ago");
    return Math.round(h / 24) + " days ago";
  }

  function fmtPct(v) { return v == null ? "n/a" : (v >= 99.995 ? 100 : v).toFixed(2) + "%"; }
  function pctNum(s) { var n = parseFloat(String(s).replace("%", "")); return isNaN(n) ? null : n; }
  function cleanTitle(t) { return String(t || "").replace(/^[^\p{L}\p{N}]+/u, "").trim(); }

  function shortRegion(label) {
    return label;
  }

  function buildModel() {
    var list = state.summary || [];
    var byName = {};
    list.forEach(function (s) { byName[s.name] = s; });
    var parents = [];
    var regs = {};
    list.forEach(function (s) {
      var m = REGION_RE.exec(s.name);
      if (m && byName[m[1]]) (regs[m[1]] = regs[m[1]] || []).push({ site: s, label: m[2] });
      else parents.push(s);
    });
    state.model = { list: list, parents: parents, regs: regs };
  }

  function siteState(site) {
    return site.status === "down" ? "bad" : site.status === "degraded" ? "warn" : "ok";
  }

  function parentState(p) {
    var regs = state.model.regs[p.name] || [];
    if (p.status === "down") return { s: "bad", flag: "Outage" };
    if (p.status === "degraded") return { s: "warn", flag: "Degraded" };
    var bad = regs.filter(function (r) { return r.site.status === "down"; });
    var slow = regs.filter(function (r) { return r.site.status === "degraded"; });
    if (bad.length) return { s: "warn", flag: "Down in " + bad.map(function (r) { return r.label; }).join(", "), regional: bad.map(function (r) { return r.label; }) };
    if (slow.length) return { s: "warn", flag: "Slow in " + slow.map(function (r) { return r.label; }).join(", ") };
    return { s: "ok", flag: "" };
  }

  function overall() {
    var P = state.model.parents;
    var st = P.map(parentState);
    var down = st.filter(function (x) { return x.s === "bad"; }).length;
    var warn = st.filter(function (x) { return x.s === "warn"; }).length;
    if (P.length && down === P.length) return { s: "bad", title: "Major outage", text: "All services are down" };
    if (down) return { s: "bad", title: "Partial outage", text: down + (down === 1 ? " service is down" : " services are down") };
    if (warn) return { s: "warn", title: "Degraded performance", text: warn + (warn === 1 ? " service is affected" : " services are affected") };
    return { s: "ok", title: "All systems operational", text: "" };
  }

  function issueCount() {
    return state.model.parents.filter(function (p) { return parentState(p).s !== "ok"; }).length;
  }

  function evalDay(site, ds, nowMs) {
    var meta = state.meta[site.slug] || {};
    var start = meta.startTime ? new Date(meta.startTime).getTime() : null;
    var from = start ? Math.max(ds, start) : ds;
    var to = Math.min(ds + 86400000, nowMs);
    var valid = Math.max(0, (to - from) / 60000);
    if (valid <= 0) return { key: dayKey(ds), s: "none", mins: 0, valid: 0 };
    var mins = Math.min((site.dailyMinutesDown || {})[dayKey(ds)] || 0, valid);
    return { key: dayKey(ds), s: mins <= 0 ? "ok" : mins < 60 ? "warn" : "bad", mins: mins, valid: valid };
  }

  function sumUptime(days) {
    var down = 0;
    var valid = 0;
    days.forEach(function (d) { down += d.mins; valid += d.valid; });
    return valid > 0 ? (1 - down / valid) * 100 : null;
  }

  function lastDays(site, n) {
    var now = Date.now();
    var today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(evalDay(site, today - i * 86400000, now));
    return out;
  }

  function monthDays(site, y, m) {
    var now = Date.now();
    var dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var out = [];
    for (var d = 1; d <= dim; d++) out.push(evalDay(site, Date.UTC(y, m, d), now));
    return out;
  }

  function runsOf(days) {
    var runs = [];
    days.forEach(function (d) {
      var r = runs[runs.length - 1];
      if (r && r.s === d.s) { r.len++; r.to = d.key; r.mins += d.mins; }
      else runs.push({ s: d.s, len: 1, from: d.key, to: d.key, mins: d.mins });
    });
    return runs;
  }

  function barHtml(days) {
    return '<div class="bar">' + runsOf(days).map(function (r) {
      return '<i class="seg" data-s="' + (r.s === "ok" ? "" : r.s) + '" style="flex-grow:' + r.len + '" data-from="' + r.from + '" data-to="' + r.to + '" data-m="' + Math.round(r.mins) + '"></i>';
    }).join("") + "</div>";
  }

  function normalizeIncident(issue) {
    var labels = (issue.labels || []).map(function (l) { return typeof l === "string" ? l : l.name; });
    var slugMap = {};
    (state.summary || []).forEach(function (s) { slugMap[s.slug] = s; });
    var body = issue.body || "";
    var maintenance = labels.indexOf("maintenance") !== -1;
    var inc = {
      id: issue.number,
      title: cleanTitle(issue.title),
      url: issue.html_url,
      open: issue.state === "open",
      created: issue.created_at,
      closed: issue.closed_at,
      services: labels.filter(function (l) { return slugMap[l]; }).map(function (l) { return slugMap[l].name; }),
      maintenance: maintenance,
      degraded: /degraded/i.test(issue.title || ""),
      commentsUrl: issue.comments_url,
      commentsCount: issue.comments || 0,
      snapshotComments: issue.snapshot_comments || null
    };
    if (maintenance) {
      var s = /start:\s*(\S+)/i.exec(body);
      var e = /end:\s*(\S+)/i.exec(body);
      inc.start = s ? s[1] : issue.created_at;
      inc.end = e ? e[1] : null;
      inc.description = body.replace(/<!--[\s\S]*?-->/g, "").trim();
      [/expectedDown:\s*([^\n\r]+)/i.exec(body), /expectedDegraded:\s*([^\n\r]+)/i.exec(body)].forEach(function (m) {
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

  function maintItems() {
    return incidentList().filter(function (i) { return i.maintenance; }).map(function (i) {
      var start = new Date(i.start);
      if (isNaN(start.getTime())) start = new Date(i.created);
      var end = i.end ? new Date(i.end) : null;
      if (!end || isNaN(end.getTime())) end = new Date(start.getTime() + 3600000);
      return { inc: i, start: start, end: end };
    }).sort(function (a, b) { return a.start - b.start; });
  }

  function isBot(c) {
    var u = c.user || {};
    return u.type === "Bot" || /upptime|bot/i.test(u.login || "");
  }

  function updatesFor(inc, comments) {
    var items = [];
    var who = inc.services.length ? inc.services.join(", ") : "A service";
    if (inc.maintenance) {
      items.push({ t: "info", label: "Scheduled", time: inc.created, text: "Planned maintenance from " + fmtUtc(inc.start) + (inc.end ? " to " + fmtUtc(inc.end) : "") + "." });
    } else {
      var detail = [];
      if (inc.httpCode) detail.push("HTTP " + inc.httpCode);
      if (inc.responseTime) detail.push(inc.responseTime + " ms");
      items.push({
        t: inc.degraded ? "warn" : "bad",
        label: "Investigating",
        time: inc.created,
        text: who + (inc.degraded ? " is responding slowly" : " is not responding") + (detail.length ? " (" + detail.join(", ") + ")" : "") + ". Detected by automated monitoring."
      });
    }
    (comments || []).forEach(function (c) {
      if (isBot(c)) {
        if (/resolved|back online|is back/i.test(c.body || "")) items.push({ t: "ok", label: "Resolved", time: c.created_at, text: who + " is back online." });
        return;
      }
      items.push({ t: "info", label: "Update", time: c.created_at, text: String(c.body || "").trim() });
    });
    if (!inc.open && !items.some(function (i) { return i.label === "Resolved"; })) {
      items.push({ t: "ok", label: inc.maintenance ? "Completed" : "Resolved", time: inc.closed, text: inc.maintenance ? "Maintenance has finished." : who + " is back online." });
    }
    return items.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
  }

  function updatesHtml(items) {
    var first = items[0];
    function block(i, latest) {
      return '<div class="upd" data-t="' + i.t + '"><div class="upd-title">' + esc(i.label) + (latest ? ' <span class="tag-latest">LATEST</span>' : "") + '</div><p class="upd-text">' + esc(i.text) + '</p><div class="upd-time">' + esc(fmtUtc(i.time)) + "</div></div>";
    }
    var out = block(first, true);
    if (items.length > 1) out += '<div class="earlier">EARLIER UPDATES</div>' + items.slice(1).map(function (i) { return block(i, false); }).join("");
    return out;
  }

  function loadComments(inc) {
    if (state.comments[inc.id]) return Promise.resolve(state.comments[inc.id]);
    if (inc.snapshotComments && !inc.open) return Promise.resolve((state.comments[inc.id] = inc.snapshotComments));
    if (!inc.commentsUrl || !inc.commentsCount) return Promise.resolve((state.comments[inc.id] = inc.snapshotComments || []));
    return getJson(inc.commentsUrl + "?per_page=100").then(function (c) { return (state.comments[inc.id] = c); }).catch(function () {
      return (state.comments[inc.id] = inc.snapshotComments || []);
    });
  }

  function seriesRange(slug, range) {
    var s = state.series && state.series.sites && state.series.sites[slug];
    if (!s) return null;
    var pts = s[range === "24h" ? "h24" : range === "7d" ? "d7" : "d90"];
    return pts && pts.length ? pts : null;
  }

  function chartItems(slug) {
    var base = state.model.list.filter(function (s) { return s.slug === slug; })[0];
    if (!base) return [];
    var items = [{ label: "United States", cls: "s0", slug: slug }];
    (state.model.regs[base.name] || []).forEach(function (r, i) {
      items.push({ label: r.label, cls: "s" + ((i + 1) % 4), slug: r.site.slug });
    });
    return items;
  }

  function niceMax(v) {
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var step = mag / 2;
    return Math.ceil(v / step) * step;
  }

  function fmtAxis(t, range) {
    var d = new Date(t * 1000);
    if (range === "24h") return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function renderChart(slug) {
    var box = app.querySelector('.svc[data-slug="' + slug + '"] .chart-wrap');
    if (!box) return;
    var range = state.range[slug] || "24h";
    box.querySelectorAll("[data-range]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-range") === range)); });
    var items = chartItems(slug).map(function (it) {
      it.pts = seriesRange(it.slug, range) || [];
      return it;
    }).filter(function (it) { return it.pts.length; });
    var chart = box.querySelector(".chart");
    var foot = box.querySelector(".chart-foot");
    var all = [];
    var t0 = Infinity;
    var t1 = -Infinity;
    items.forEach(function (it) {
      it.pts.forEach(function (p) {
        if (p[0] < t0) t0 = p[0];
        if (p[0] > t1) t1 = p[0];
        if (p[1] != null) all.push(p[1]);
      });
    });
    if (all.length < 2) {
      chart.innerHTML = '<p class="chart-empty">Not enough data for this range yet.</p>';
      foot.innerHTML = "";
      chart._data = null;
      return;
    }
    var threshold = (state.config[slug] || {}).maxResponseTime || null;
    var yMax = Math.max.apply(null, all);
    if (threshold && yMax * 2 > threshold) yMax = Math.max(yMax, threshold * 1.05);
    yMax = niceMax(yMax || 100);
    var W = 640, H = 170, pl = 44, pr = 6, pt = 8, pb = 22;
    function X(t) { return pl + (t - t0) / (t1 - t0 || 1) * (W - pl - pr); }
    function Y(v) { return pt + (1 - v / yMax) * (H - pt - pb); }
    var out = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Response time">';
    [0, 0.5, 1].forEach(function (f) {
      var y = Y(yMax * f);
      out += '<line class="gl" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (pl - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + Math.round(yMax * f) + (f === 1 ? " ms" : "") + "</text>";
    });
    out += '<text class="ax" x="' + pl + '" y="' + (H - 5) + '">' + esc(fmtAxis(t0, range)) + '</text><text class="ax" x="' + (W - pr) + '" y="' + (H - 5) + '" text-anchor="end">' + esc(fmtAxis(t1, range)) + "</text>";
    if (threshold && threshold <= yMax) {
      var ty = Y(threshold);
      out += '<line class="th" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + ty + '" y2="' + ty + '"/><text class="ax ax-warn" x="' + (W - pr - 2) + '" y="' + (ty - 4) + '" text-anchor="end">degraded above ' + threshold + " ms</text>";
    }
    items.forEach(function (it, idx) {
      var d = "";
      var pen = false;
      var first = null;
      var last = null;
      it.pts.forEach(function (p) {
        if (p[1] == null) { pen = false; return; }
        var x = X(p[0]);
        d += (pen ? "L" : "M") + x.toFixed(1) + " " + Y(p[1]).toFixed(1);
        pen = true;
        if (first == null) first = x;
        last = x;
      });
      var color = "var(--" + it.cls + ")";
      if (items.length === 1 && first != null) {
        out += '<path d="' + d + "L" + last.toFixed(1) + " " + Y(0) + "L" + first.toFixed(1) + " " + Y(0) + 'Z" fill="' + color + '" opacity="0.1"/>';
      }
      out += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + (idx === 0 ? 1.8 : 1.4) + '" stroke-linecap="round" stroke-linejoin="round"/>';
    });
    chart.innerHTML = out + '</svg><div class="cursor" hidden></div>';
    chart._data = { items: items, t0: t0, t1: t1, W: W, pl: pl, pr: pr, range: range };
    var vals = items[0].pts.filter(function (p) { return p[1] != null; }).map(function (p) { return p[1]; });
    var legend = items.length > 1 ? items.map(function (it) { return '<span class="key"><i style="background:var(--' + it.cls + ')"></i>' + esc(it.label) + "</span>"; }).join("") : "";
    var stats = "";
    if (vals.length) {
      stats = "<span>Average <strong>" + Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) + " ms</strong></span><span>Fastest <strong>" + Math.min.apply(null, vals) + " ms</strong></span><span>Slowest <strong>" + Math.max.apply(null, vals) + " ms</strong></span>";
    }
    foot.innerHTML = legend + stats;
  }

  function chartHover(chart, clientX) {
    var data = chart._data;
    if (!data) return;
    var rect = chart.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    var frac = Math.min(1, Math.max(0, (ratio * data.W - data.pl) / (data.W - data.pl - data.pr)));
    var t = data.t0 + frac * (data.t1 - data.t0);
    var lines = [];
    var stamp = null;
    data.items.forEach(function (it) {
      var best = null;
      it.pts.forEach(function (p) { if (best == null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; });
      if (!best) return;
      if (stamp == null) stamp = best[0];
      lines.push('<span><i class="dot" style="background:var(--' + it.cls + ')"></i>' + esc(it.label) + ": " + (best[1] == null ? "down" : best[1] + " ms") + "</span>");
    });
    var cur = chart.querySelector(".cursor");
    cur.hidden = false;
    cur.style.left = rect.width * ((data.pl + (stamp - data.t0) / (data.t1 - data.t0 || 1) * (data.W - data.pl - data.pr)) / data.W) + "px";
    var when = new Date(stamp * 1000).toLocaleString(undefined, data.range === "90d" ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    tip.innerHTML = "<strong>" + esc(when) + "</strong>" + lines.join("<br>");
    placeTip(clientX - tip.offsetWidth / 2, rect);
  }

  function placeTip(x, rect) {
    tip.hidden = false;
    var w = tip.offsetWidth;
    var left = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    var top = rect.top - tip.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function isOpen(p) {
    return state.openSvc[p.slug] !== undefined ? state.openSvc[p.slug] : parentState(p).s !== "ok";
  }

  function serviceRow(p) {
    var ps = parentState(p);
    var regs = state.model.regs[p.name] || [];
    var days = lastDays(p, DAYS);
    var up = sumUptime(days);
    var open = isOpen(p);
    var now = new Date();
    var months = "";
    for (var i = 3; i >= 0; i--) {
      var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      var md = monthDays(p, d.getUTCFullYear(), d.getUTCMonth());
      months += '<div class="month"><span>' + d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) + "</span><span>" + (sumUptime(md) == null ? "No data" : fmtPct(sumUptime(md))) + "</span></div>" + barHtml(md);
    }
    var regionHtml = "";
    if (regs.length) {
      regionHtml = '<div class="sub">Checked from</div><div class="regions">' + [{ label: "United States", site: p }].concat(regs).map(function (x) {
        var s = siteState(x.site);
        var u = pctNum(x.site.uptimeDay);
        return '<div class="region"><span>' + esc(x.label) + '</span><span class="st" data-s="' + s + '">' + STATE_LABEL[s] + '</span><span class="num">' + fmtPct(u) + ' today</span><span class="num">' + (x.site.timeDay ? x.site.timeDay + " ms" : "n/a") + "</span></div>";
      }).join("") + "</div>";
    }
    var hasSeries = seriesRange(p.slug, "24h") || seriesRange(p.slug, "7d") || seriesRange(p.slug, "90d");
    var chart = hasSeries ? '<div class="chart-wrap"><div class="chart-top"><div class="sub">Response time</div><div class="range" role="group" aria-label="Range"><button type="button" data-range="24h" aria-pressed="true">24h</button><button type="button" data-range="7d" aria-pressed="false">7d</button><button type="button" data-range="90d" aria-pressed="false">90d</button></div></div><div class="chart"></div><div class="chart-foot"></div></div>' : "";
    var cfg = state.config[p.slug] || {};
    var up2 = function (v) { return fmtPct(pctNum(v)); };
    var facts = '<div class="sub">Uptime</div><dl class="facts"><div class="fact"><dt>Last 24 hours</dt><dd>' + up2(p.uptimeDay) + '</dd></div><div class="fact"><dt>Last 7 days</dt><dd>' + up2(p.uptimeWeek) + '</dd></div><div class="fact"><dt>Last 30 days</dt><dd>' + up2(p.uptimeMonth) + '</dd></div><div class="fact"><dt>Last year</dt><dd>' + up2(p.uptimeYear) + "</dd></div></dl>";
    return '<article class="svc" data-slug="' + esc(p.slug) + '" data-s="' + ps.s + '">' +
      '<button class="svc-head" type="button" aria-expanded="' + open + '" aria-controls="b-' + esc(p.slug) + '">' + svg("chev", "chev") +
      '<span class="svc-name">' + esc(p.name) + "</span>" + (ps.flag ? '<span class="svc-flag">' + esc(ps.flag) + "</span>" : "") +
      '<span class="svc-up">' + (up == null ? "No data" : fmtPct(up) + " uptime") + "</span></button>" +
      '<div class="svc-bar">' + barHtml(days) + '<div class="bar-labels"><span>90 days ago</span><span>Today</span></div></div>' +
      '<div class="svc-body" id="b-' + esc(p.slug) + '"' + (open ? "" : " hidden") + ">" + months + regionHtml + chart + facts +
      (cfg.maxResponseTime ? '<p class="note">Counted as degraded when a response takes longer than ' + cfg.maxResponseTime + " ms.</p>" : "") + "</div></article>";
  }

  function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsEsc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }

  function icsEvent(m) {
    return ["BEGIN:VEVENT", "UID:maintenance-" + m.inc.id + "@" + location.host, "DTSTAMP:" + icsDate(new Date()), "DTSTART:" + icsDate(m.start), "DTEND:" + icsDate(m.end),
      "SUMMARY:" + icsEsc(m.inc.title), "DESCRIPTION:" + icsEsc(m.inc.description || ""), "URL:" + m.inc.url, "END:VEVENT"].join("\r\n");
  }

  function icsFile(items) {
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conscherry//Status//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Conscherry maintenance"]
      .concat(items.map(icsEvent), ["END:VCALENDAR", ""]).join("\r\n");
  }

  function googleCalUrl(m) {
    return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(m.inc.title) +
      "&dates=" + icsDate(m.start) + "/" + icsDate(m.end) +
      "&details=" + encodeURIComponent((m.inc.description ? m.inc.description + "\n\n" : "") + m.inc.url);
  }

  function countdown(m) {
    var now = Date.now();
    if (now < m.start.getTime()) return "starts in " + fmtDuration((m.start - now) / 60000);
    if (now < m.end.getTime()) return "ends in " + fmtDuration((m.end - now) / 60000);
    return "completed";
  }

  function calActions(m) {
    return '<div class="inc-actions"><a class="btn btn-sm" href="' + esc(googleCalUrl(m)) + '" target="_blank" rel="noopener">' + svg("cal") + 'Google Calendar</a><button class="btn btn-sm" type="button" data-action="ics" data-id="' + m.inc.id + '">' + svg("cal") + "Download .ics</button></div>";
  }

  function incBlock(inc, comments, open) {
    var kind = inc.maintenance ? "info" : inc.degraded ? "warn" : "bad";
    var m = inc.maintenance ? maintItems().filter(function (x) { return x.inc.id === inc.id; })[0] : null;
    var label = inc.maintenance ? "Maintenance" : inc.degraded ? "Degraded Performance" : "Outage";
    var isOpen = state.openInc[inc.id] !== undefined ? state.openInc[inc.id] : open;
    return '<article class="inc" data-k="' + kind + '" data-id="' + inc.id + '" id="inc-' + inc.id + '">' +
      '<button class="inc-head" type="button" aria-expanded="' + isOpen + '" aria-controls="ib-' + inc.id + '" data-action="inc">' + svg("chev", "chev") + '<span class="inc-title">' + esc(inc.title) + '</span><span class="inc-state">' + esc(label) +
      '<a href="' + esc(inc.url) + '" target="_blank" rel="noopener" aria-label="Open on GitHub" data-stop="1">' + svg("ext") + "</a></span></button>" +
      '<div class="inc-body" id="ib-' + inc.id + '"' + (isOpen ? "" : " hidden") + ">" +
      (inc.services.length ? '<div class="chips">' + inc.services.map(function (n) { return '<span class="chip">' + esc(n) + "</span>"; }).join("") + "</div>" : "") +
      '<div class="inc-updates">' + updatesHtml(updatesFor(inc, comments)) + "</div>" +
      (m && inc.description ? '<p class="upd-text" style="margin-top:1rem">' + esc(inc.description) + "</p>" : "") +
      (m ? '<p class="upd-time" style="margin-top:.75rem">Local time: ' + esc(fmtLocal(m.start)) + " to " + esc(fmtLocal(m.end)) + " &middot; <span data-countdown=\"" + inc.id + '">' + esc(countdown(m)) + "</span></p>" + calActions(m) : "") +
      "</div></article>";
  }

  function renderOverview() {
    var M = state.model;
    var ov = overall();
    var incs = incidentList();
    var active = incs.filter(function (i) { return i.open && !i.maintenance; });
    var now = Date.now();
    var maint = maintItems().filter(function (m) { return m.inc.open && m.end.getTime() > now && m.start.getTime() < now + 7 * 86400000; });

    var html = '<div class="view"><div class="summary" data-s="' + ov.s + '"><span class="summary-dot"></span><div><h1>' + esc(ov.title) + '</h1><p class="summary-meta">' + (ov.text ? esc(ov.text) + '<span class="sep">&middot;</span>' : "") + '<span id="updated">Updated ' + esc(ago(state.fetchedAt)) + '</span><span class="sep">&middot;</span><button class="link-btn" type="button" data-action="refresh">Refresh</button></p></div></div>';

    if (state.incidentsFailed && !state.incidents) {
      html += '<p class="notice block">Incident details are unavailable right now. Check <a href="https://github.com/' + REPO + '/issues">GitHub</a> for updates.</p>';
    }
    if (maint.length || active.length) {
      html += '<div class="block stack" id="incidents">' + maint.map(function (m) { return incBlock(m.inc, [], true); }).join("") + active.map(function (i) { return incBlock(i, state.comments[i.id] || [], true); }).join("") + "</div>";
    }

    var used = {};
    GROUPS.forEach(function (g) {
      var sites = g.slugs.map(function (slug) { return M.parents.filter(function (s) { return s.slug === slug; })[0]; }).filter(Boolean);
      sites.forEach(function (s) { used[s.slug] = true; });
      if (sites.length) html += '<h2 class="group-title">' + esc(g.name) + '</h2><div class="rows">' + sites.map(serviceRow).join("") + "</div>";
    });
    var rest = M.parents.filter(function (s) { return !used[s.slug]; });
    if (rest.length) html += '<h2 class="group-title">Other</h2><div class="rows">' + rest.map(serviceRow).join("") + "</div>";
    html += '<div class="legend"><span class="key"><i style="background:var(--ok)"></i>No downtime</span><span class="key"><i style="background:var(--warn)"></i>Under 1 hour down</span><span class="key"><i style="background:var(--bad)"></i>1 hour or more down</span><span class="key"><i style="background:var(--nodata)"></i>No data</span></div></div>';

    app.innerHTML = html;
    M.parents.forEach(function (p) { if (isOpen(p)) renderChart(p.slug); });
    active.forEach(function (inc) {
      loadComments(inc).then(function (c) {
        var el = app.querySelector('.inc[data-id="' + inc.id + '"] .inc-updates');
        if (el) el.innerHTML = updatesHtml(updatesFor(inc, c));
      });
    });
  }

  function historyRow(inc) {
    var dur = inc.closed ? fmtDuration((new Date(inc.closed) - new Date(inc.created)) / 60000) : null;
    var end = inc.maintenance ? { t: "Maintenance", s: "info" } : inc.open ? { t: "Ongoing", s: "bad" } : { t: "Resolved", s: "ok" };
    var affected = inc.services.length ? " &middot; " + esc(inc.services.join(", ")) : "";
    return '<article class="hist" data-id="' + inc.id + '"><button class="hist-head" type="button" aria-expanded="false" aria-controls="h-' + inc.id + '" data-action="hist">' + svg("chev", "chev") +
      '<div class="hist-main"><div class="hist-title">' + esc(inc.title) + '</div><div class="hist-sub">' + esc(fmtUtc(inc.created)) + (dur ? " &middot; " + esc(dur) : "") + affected + '</div></div><span class="hist-end" data-s="' + end.s + '">' + end.t + '</span></button>' +
      '<div class="hist-body" id="h-' + inc.id + '" hidden><div class="hist-updates"></div></div></article>';
  }

  function renderHistory() {
    var incs = incidentList();
    var html = '<div class="view"><div class="page-head"><h1>Incident history</h1><p>Past outages and maintenance, newest first.</p></div>';
    if (state.incidentsFailed && !state.incidents) {
      html += '<p class="notice block">History is unavailable right now. You can still read it on <a href="https://github.com/' + REPO + '/issues?q=is%3Aissue">GitHub</a>.</p>';
    } else if (!incs.length) {
      html += '<div class="empty block"><strong>No incidents</strong>Nothing has gone wrong since monitoring started.</div>';
    } else {
      var shown = incs.slice(0, state.historyShown);
      var last = "";
      var open = false;
      shown.forEach(function (inc) {
        var m = new Date(inc.created).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        if (m !== last) {
          if (open) html += "</div>";
          html += '<h2 class="month-title">' + esc(m) + '</h2><div class="rows">';
          open = true;
          last = m;
        }
        html += historyRow(inc);
      });
      if (open) html += "</div>";
      if (incs.length > shown.length) html += '<div class="more"><button class="btn" type="button" data-action="more">Show older</button></div>';
    }
    app.innerHTML = html + "</div>";
  }

  function feedUrl(proto) {
    return proto + "//" + location.host + location.pathname.replace(/[^/]*$/, "") + "data/maintenance.ics";
  }

  function subscribeMenu(id, cls, label) {
    return '<details class="popover' + (cls ? " " + cls : "") + '" id="' + id + '"><summary class="btn' + (cls ? " btn-primary" : "") + '">' + (cls ? svg("cal") : "") + label + '</summary><div class="popover-panel">' +
      '<a class="popover-link" href="https://conscherry.com/discord" rel="noopener"><strong>Discord</strong><span>Incident posts in our community server</span></a>' +
      '<a class="popover-link" href="https://github.com/' + REPO + '" rel="noopener"><strong>GitHub</strong><span>Watch the repository for email updates</span></a>' +
      '<a class="popover-link" href="' + esc(feedUrl("webcal:")) + '"><strong>Maintenance calendar</strong><span>Add planned work to your calendar app</span></a></div></details>';
  }

  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

  function renderMaintenance() {
    var items = maintItems();
    var now = new Date();
    if (!state.cal) state.cal = { y: now.getFullYear(), m: now.getMonth() };
    var first = new Date(state.cal.y, state.cal.m, 1);
    var offset = (first.getDay() + 6) % 7;
    var daysIn = new Date(state.cal.y, state.cal.m + 1, 0).getDate();
    var cells = [];
    var i;
    for (i = 0; i < offset; i++) cells.push(new Date(state.cal.y, state.cal.m, 1 - offset + i));
    for (i = 1; i <= daysIn; i++) cells.push(new Date(state.cal.y, state.cal.m, i));
    var tail = 1;
    while (cells.length % 7) cells.push(new Date(state.cal.y, state.cal.m + 1, tail++));

    var head = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (n) { return '<div class="cal-dow">' + n + "</div>"; }).join("");
    var grid = cells.map(function (day) {
      var ds = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
      var evs = items.filter(function (m) { return m.start.getTime() < ds + 86400000 && m.end.getTime() > ds; });
      return '<div class="cal-cell' + (day.getMonth() !== state.cal.m ? " other" : "") + (sameDay(day, now) ? " today" : "") + '" role="gridcell"><span class="cal-num">' + day.getDate() + "</span>" +
        evs.slice(0, 2).map(function (m) { return '<button type="button" class="cal-ev" data-action="goto" data-id="' + m.inc.id + '" title="' + esc(m.inc.title) + '">' + esc(m.inc.title) + "</button>"; }).join("") +
        (evs.length > 2 ? '<span class="cal-more">+' + (evs.length - 2) + " more</span>" : "") + "</div>";
    }).join("");

    var upcoming = items.filter(function (m) { return m.inc.open && m.end.getTime() > now.getTime(); });
    var past = items.filter(function (m) { return !(m.inc.open && m.end.getTime() > now.getTime()); }).reverse().slice(0, 10);

    var html = '<div class="view"><div class="page-head"><h1>Maintenance</h1><p>Planned work that may affect our services.</p><div class="row">' + subscribeMenu("subscribe-page", "popover-left", "Subscribe") + '</div></div>';
    if (state.incidentsFailed && !state.incidents) {
      html += '<p class="notice block">Maintenance details are unavailable right now. Check <a href="https://github.com/' + REPO + '/issues?q=label%3Amaintenance">GitHub</a>.</p>';
    } else {
      html += '<section class="cal" aria-label="Calendar"><div class="cal-bar"><button class="icon-btn" type="button" data-action="cal-prev" aria-label="Previous month">' + svg("chev", "rot-l") + "</button><h2>" + esc(first.toLocaleDateString(undefined, { month: "long", year: "numeric" })) + '</h2><button class="icon-btn" type="button" data-action="cal-next" aria-label="Next month">' + svg("chev", "rot-r") + '</button><button class="btn btn-sm" type="button" data-action="cal-today">Today</button></div><div class="cal-grid" role="grid">' + head + grid + "</div></section>";
      html += '<h2 class="month-title">Upcoming</h2>' + (upcoming.length ? '<div class="rows">' + upcoming.map(function (m) { return incBlock(m.inc, [], true); }).join("") + "</div>" : '<div class="empty">Nothing is planned right now.</div>');
      if (past.length) html += '<h2 class="month-title">Past</h2><div class="rows">' + past.map(function (m) { return incBlock(m.inc, [], false); }).join("") + "</div>";
    }
    app.innerHTML = html + "</div>";
  }

  function route() {
    if (/^#\/history/.test(location.hash)) return "history";
    if (/^#\/maintenance/.test(location.hash)) return "maintenance";
    return "overview";
  }

  function paintFavicon(s, img) {
    var link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    try {
      var c = document.createElement("canvas");
      c.width = c.height = 64;
      var g = c.getContext("2d");
      if (img) g.drawImage(img, 0, 0, 64, 64);
      if (s !== "ok" || !img) {
        g.beginPath();
        g.arc(47, 47, 15, 0, Math.PI * 2);
        g.fillStyle = BADGE_COLOR[s];
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = "#0d0d14";
        g.stroke();
      }
      link.type = "image/png";
      link.href = c.toDataURL("image/png");
    } catch (e) {}
  }

  function setFavicon(s) {
    if (state.logo === false) return paintFavicon(s, null);
    if (state.logo) return paintFavicon(s, state.logo);
    var img = new Image();
    img.onload = function () { state.logo = img; paintFavicon(s, img); };
    img.onerror = function () { state.logo = false; paintFavicon(s, null); };
    img.src = "logo.png";
  }

  function updateChrome() {
    var r = route();
    document.querySelectorAll(".tabs a[data-route]").forEach(function (a) {
      if (a.getAttribute("data-route") === r) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    var title = r === "history" ? "Incident history" : r === "maintenance" ? "Maintenance" : state.model ? overall().title : "Status";
    var n = state.model ? issueCount() : 0;
    document.title = (n > 0 ? "(" + n + ") " : "") + title + " | Conscherry Status";
    if (state.model) setFavicon(overall().s);
  }

  function render() {
    updateChrome();
    if (!state.summary) return;
    var r = route();
    if (r === "history") renderHistory();
    else if (r === "maintenance") renderMaintenance();
    else renderOverview();
  }

  function showError() {
    app.innerHTML = '<div class="view"><div class="empty"><strong>We couldn\'t load the status data</strong>Try again in a moment, or check <a href="https://github.com/' + REPO + '">the status repository</a>.<div class="more"><button class="btn btn-primary" type="button" data-action="retry">Try again</button></div></div></div>';
  }

  function loadAll(initial) {
    state.loading = true;
    var tasks = [getJson([RAW, "data/summary.json"]).then(function (s) { state.summary = s; state.fetchedAt = Date.now(); })];
    if (initial) {
      tasks.push(getJson("data/meta.json").then(function (m) { state.meta = m; }).catch(function () {}));
      tasks.push(getJson("data/config.json").then(function (c) { state.config = c; }).catch(function () {}));
    }
    if (!state.seriesAt || Date.now() - state.seriesAt > SERIES_MS) {
      tasks.push(getJson("data/response.json").then(function (r) { state.series = r; state.seriesAt = Date.now(); }).catch(function () { state.seriesAt = Date.now(); }));
    }
    tasks.push(getJson([API + "/issues?state=all&per_page=100&sort=created&direction=desc", "data/incidents.json"]).then(function (i) {
      state.incidents = i;
      state.incidentsFailed = false;
    }).catch(function () { state.incidentsFailed = true; }));
    return Promise.all(tasks).then(function () {
      buildModel();
      render();
    }).catch(function () {
      if (!state.summary) showError();
    }).then(function () { state.loading = false; });
  }

  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function toggle(btn, bodyId) {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    var body = document.getElementById(bodyId);
    if (body) body.hidden = open;
    return !open;
  }

  app.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (t.closest("[data-stop]")) return;
    var svcHead = t.closest(".svc-head");
    if (svcHead) {
      var slug = svcHead.parentNode.getAttribute("data-slug");
      var nowOpen = toggle(svcHead, svcHead.getAttribute("aria-controls"));
      state.openSvc[slug] = nowOpen;
      if (nowOpen) renderChart(slug);
      return;
    }
    var rng = t.closest("[data-range]");
    if (rng) {
      var s2 = rng.closest(".svc").getAttribute("data-slug");
      state.range[s2] = rng.getAttribute("data-range");
      renderChart(s2);
      return;
    }
    var a = t.closest("[data-action]");
    if (!a) return;
    var act = a.getAttribute("data-action");
    if (act === "inc") {
      var inc = a.closest(".inc");
      state.openInc[inc.getAttribute("data-id")] = toggle(a, a.getAttribute("aria-controls"));
    } else if (act === "hist") {
      var open = toggle(a, a.getAttribute("aria-controls"));
      if (!open) return;
      var row = a.closest(".hist");
      var id = Number(row.getAttribute("data-id"));
      var item = incidentList().filter(function (i) { return i.id === id; })[0];
      var target = row.querySelector(".hist-updates");
      if (!item || target.dataset.done) return;
      target.innerHTML = updatesHtml(updatesFor(item, []));
      loadComments(item).then(function (c) {
        target.innerHTML = updatesHtml(updatesFor(item, c));
        target.dataset.done = "1";
      });
    } else if (act === "more") {
      state.historyShown += PAGE_SIZE;
      renderHistory();
    } else if (act === "refresh") {
      if (!state.loading) loadAll(false);
    } else if (act === "retry") {
      app.innerHTML = '<div class="skeleton" style="height:6rem;border-radius:.75rem"></div>';
      loadAll(true);
    } else if (act === "ics") {
      var m = maintItems().filter(function (x) { return String(x.inc.id) === a.getAttribute("data-id"); })[0];
      if (m) download("maintenance-" + m.inc.id + ".ics", icsFile([m]), "text/calendar");
    } else if (act === "cal-prev" || act === "cal-next") {
      var d = new Date(state.cal.y, state.cal.m + (act === "cal-next" ? 1 : -1), 1);
      state.cal = { y: d.getFullYear(), m: d.getMonth() };
      renderMaintenance();
    } else if (act === "cal-today") {
      state.cal = null;
      renderMaintenance();
    } else if (act === "goto") {
      var el = document.getElementById("inc-" + a.getAttribute("data-id"));
      if (el) {
        var head = el.querySelector(".inc-head");
        if (head.getAttribute("aria-expanded") !== "true") { state.openInc[a.getAttribute("data-id")] = toggle(head, head.getAttribute("aria-controls")); }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        setTimeout(function () { el.classList.remove("flash"); }, 1500);
      }
    }
  });

  function segTip(el) {
    var from = el.getAttribute("data-from");
    var to = el.getAttribute("data-to");
    var mins = Number(el.getAttribute("data-m"));
    var s = el.getAttribute("data-s");
    var range = from === to ? fmtDay(from) : fmtDay(from) + " to " + fmtDay(to);
    var detail = s === "none" ? "No data" : mins <= 0 ? "No downtime" : fmtDuration(mins) + " of downtime";
    tip.innerHTML = "<strong>" + esc(range) + "</strong><span>" + esc(detail) + "</span>";
    var r = el.getBoundingClientRect();
    placeTip(r.left + r.width / 2 - tip.offsetWidth / 2, r);
  }

  function hideTip() {
    tip.hidden = true;
    app.querySelectorAll(".cursor").forEach(function (c) { c.hidden = true; });
  }

  app.addEventListener("pointermove", function (e) {
    var chart = e.target.closest && e.target.closest(".chart");
    if (chart) return chartHover(chart, e.clientX);
    if (e.target.classList && e.target.classList.contains("seg")) segTip(e.target);
    else hideTip();
  });
  app.addEventListener("pointerleave", hideTip);
  app.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "touch") return;
    var chart = e.target.closest && e.target.closest(".chart");
    if (chart) chartHover(chart, e.clientX);
    else if (e.target.classList && e.target.classList.contains("seg")) segTip(e.target);
  });
  document.addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("pointerdown", function (e) {
    document.querySelectorAll(".popover[open]").forEach(function (p) { if (!p.contains(e.target)) p.open = false; });
    if (!e.target.closest || !(e.target.closest(".chart") || e.target.closest(".seg"))) hideTip();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".popover[open]").forEach(function (p) { p.open = false; });
    hideTip();
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
    var map = { system: ["System", "monitor"], light: ["Light", "sun"], dark: ["Dark", "moon"] };
    var btn = document.getElementById("theme-cycle");
    btn.innerHTML = svg(map[themePref][1]);
    btn.setAttribute("aria-label", "Theme: " + map[themePref][0] + ". Change theme");
    btn.title = "Theme: " + map[themePref][0];
  }

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
    if (state.incidents) {
      var items = maintItems();
      app.querySelectorAll("[data-countdown]").forEach(function (n) {
        var m = items.filter(function (x) { return String(x.inc.id) === n.getAttribute("data-countdown"); })[0];
        if (m) n.textContent = countdown(m);
      });
    }
  }, 15000);

  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
  var headMenu = document.getElementById("subscribe");
  if (headMenu) headMenu.outerHTML = subscribeMenu("subscribe", "", "Subscribe");
  themePref = readTheme();
  paintTheme();
  loadAll(true);
  setInterval(function () { if (!document.hidden) loadAll(false); }, REFRESH_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.fetchedAt && Date.now() - state.fetchedAt > REFRESH_MS) loadAll(false);
  });
})();
