import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const repo = process.env.GITHUB_REPOSITORY || "conscherry/status";
const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const host = process.env.STATUS_HOST || "status.conscherry.com";
const out = "dist";

await rm(out, { recursive: true, force: true });
await cp("web", out, { recursive: true });
await cp("assets/logo.png", `${out}/logo.png`);
await mkdir(`${out}/data`, { recursive: true });

await cp("history/summary.json", `${out}/data/summary.json`);
const summary = JSON.parse(await readFile("history/summary.json", "utf8"));
const slugByName = Object.fromEntries(summary.map((s) => [s.name, s.slug]));

const meta = {};
for (const file of await readdir("history")) {
  if (!file.endsWith(".yml")) continue;
  const text = await readFile(`history/${file}`, "utf8");
  const start = /^startTime:\s*(.+)$/m.exec(text);
  if (start) meta[file.replace(/\.yml$/, "")] = { startTime: start[1].trim() };
}
await writeFile(`${out}/data/meta.json`, JSON.stringify(meta));

function parseSites(yml) {
  const sites = [];
  let inSites = false;
  let current = null;
  for (const line of yml.split(/\r?\n/)) {
    if (/^sites:\s*$/.test(line)) {
      inSites = true;
      continue;
    }
    if (inSites && /^\S/.test(line)) break;
    if (!inSites) continue;
    const item = /^\s{2}-\s+name:\s*(.+?)\s*$/.exec(line);
    if (item) {
      current = { name: item[1].replace(/^["']|["']$/g, "") };
      sites.push(current);
      continue;
    }
    const prop = /^\s{4}([\w]+):\s*(.*?)\s*$/.exec(line);
    if (prop && current) current[prop[1]] = prop[2].replace(/^["']|["']$/g, "");
  }
  return sites;
}

const config = {};
for (const site of parseSites(await readFile(".upptimerc.yml", "utf8"))) {
  const slug = site.slug || slugByName[site.name];
  if (!slug) continue;
  config[slug] = {
    name: site.name,
    maxResponseTime: site.maxResponseTime ? Number(site.maxResponseTime) : null,
    location: site.type === "globalping" ? site.location || "world" : null,
  };
}
await writeFile(`${out}/data/config.json`, JSON.stringify(config));

function commitLog(slug) {
  try {
    return execFileSync("git", ["log", "--since=90 days ago", "--format=%ct%x09%s", "--", `history/${slug}.yml`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function average(values) {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function bucket(points, size) {
  const map = new Map();
  for (const [t, v] of points) {
    const key = Math.floor(t / size) * size;
    if (!map.has(key)) map.set(key, []);
    if (v != null) map.get(key).push(v);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, vals]) => [t, average(vals)]);
}

const nowSec = Math.floor(Date.now() / 1000);
const sites = {};
for (const site of summary) {
  const points = commitLog(site.slug)
    .map((line) => {
      const [ts, subject] = line.split("\t");
      const m = /\(\s*\d+ in (\d+) ms\)/.exec(subject || "");
      if (!m) return null;
      return [Number(ts), /is down/.test(subject) ? null : Number(m[1])];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  sites[site.slug] = {
    h24: points.filter(([t]) => t >= nowSec - 86400),
    d7: bucket(points.filter(([t]) => t >= nowSec - 7 * 86400), 3600),
    d90: bucket(points, 86400),
  };
}
await writeFile(`${out}/data/response.json`, JSON.stringify({ generated: new Date().toISOString(), sites }));

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

let incidents = [];
try {
  const issues = (await gh("/issues?state=all&per_page=100&sort=created&direction=desc")).filter((i) => !i.pull_request);
  incidents = await Promise.all(
    issues.map(async (issue) => {
      const labels = issue.labels.map((l) => l.name);
      const isMaintenance = labels.includes("maintenance");
      let comments = [];
      if (issue.comments > 0 && issue.state === "closed") {
        comments = (await gh(`/issues/${issue.number}/comments?per_page=100`)).map((c) => ({
          user: { login: c.user?.login, type: c.user?.type },
          body: c.body,
          created_at: c.created_at,
        }));
      }
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: labels.map((name) => ({ name })),
        created_at: issue.created_at,
        closed_at: issue.closed_at,
        html_url: issue.html_url,
        comments_url: issue.comments_url,
        comments: issue.comments,
        body: isMaintenance ? issue.body : "",
        snapshot_comments: issue.state === "closed" ? comments : null,
      };
    }),
  );
} catch (error) {
  console.warn(`Incident snapshot skipped: ${error.message}`);
}
await writeFile(`${out}/data/incidents.json`, JSON.stringify(incidents));

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

const events = incidents
  .filter((i) => i.labels.some((l) => l.name === "maintenance"))
  .map((i) => {
    const s = /start:\s*(\S+)/i.exec(i.body || "");
    const e = /end:\s*(\S+)/i.exec(i.body || "");
    const start = new Date(s ? s[1] : i.created_at);
    if (Number.isNaN(start.getTime())) return null;
    let end = e ? new Date(e[1]) : new Date(start.getTime() + 3600000);
    if (Number.isNaN(end.getTime())) end = new Date(start.getTime() + 3600000);
    const description = (i.body || "").replace(/<!--[\s\S]*?-->/g, "").trim();
    return [
      "BEGIN:VEVENT",
      `UID:maintenance-${i.number}@${host}`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(i.title.replace(/^[^\p{L}\p{N}]+/u, ""))}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `URL:${i.html_url}`,
      "END:VEVENT",
    ].join("\r\n");
  })
  .filter(Boolean);

await writeFile(
  `${out}/data/maintenance.ics`,
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conscherry//Status//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Conscherry maintenance", ...events, "END:VCALENDAR", ""].join("\r\n"),
);
