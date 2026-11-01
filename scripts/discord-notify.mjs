const env = process.env;
const API = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const REPO = env.GITHUB_REPOSITORY || "conscherry/status";
const TOKEN = env.GITHUB_TOKEN || "";
const HOOK = (env.DISCORD_WEBHOOK_URL || "").trim();
const STATUS_URL = (env.STATUS_URL || "https://status.conscherry.com").replace(/\/$/, "");
const ROLE_ID = (env.DISCORD_ROLE_ID || "").trim();
const LOOKBACK_HOURS = Number(env.LOOKBACK_HOURS || 6);
const DRY_RUN = env.DRY_RUN === "1";

const COLORS = { bad: 0xff5750, warn: 0xf5a524, ok: 0x38c65c, info: 0x5559ff };
const MARKER = /<!--\s*discord:(\d+)(?::([a-f0-9]+))?\s*-->/;
const REGION = /\(([^)]+)\)\s*(?:is down|has degraded)/i;

if (!HOOK && !DRY_RUN) {
  console.log("No Discord webhook configured. Nothing to do.");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "conscherry-status-notifier",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

async function discord(method, url, body, attempt = 0) {
  if (DRY_RUN) {
    console.log(method, url.replace(HOOK, "<webhook>"), JSON.stringify(body, null, 2));
    return { id: "0" };
  }
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 429 && attempt < 3) {
    const info = await res.json().catch(() => ({}));
    await sleep(Math.ceil((info.retry_after ?? 1) * 1000) + 100);
    return discord(method, url, body, attempt + 1);
  }
  if (res.status === 404 && method === "PATCH") return null;
  if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

function clean(title) {
  return String(title || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function unix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function duration(from, to) {
  const mins = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

function cut(text, max) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function labelsOf(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

function humanComments(comments) {
  return comments.filter((c) => c.user && c.user.type !== "Bot" && !/\[bot\]$/.test(c.user.login || "") && !/^\*\*Resolved:\*\*/i.test(c.body || ""));
}

function build(issue, comments) {
  const labels = labelsOf(issue);
  const body = issue.body || "";
  const maintenance = labels.includes("maintenance");
  const title = clean(issue.title);
  const open = issue.state === "open";
  const code = /HTTP code:\s*`?(\d+)`?/i.exec(body)?.[1];
  const ms = /Response time:\s*`?(\d+)`?\s*ms/i.exec(body)?.[1];
  const degraded = /degraded/i.test(issue.title);
  const regionName = REGION.exec(issue.title)?.[1] || null;
  const url = issue.html_url;
  const latest = humanComments(comments).slice(-1)[0];

  const fields = [];
  let kind;
  let heading;
  let text;

  if (maintenance) {
    const start = /start:\s*(\S+)/i.exec(body)?.[1] || issue.created_at;
    const end = /end:\s*(\S+)/i.exec(body)?.[1];
    const now = Date.now();
    const running = open && new Date(start).getTime() <= now && (!end || new Date(end).getTime() > now);
    kind = open ? "info" : "ok";
    heading = open ? (running ? "Maintenance in progress" : "Scheduled maintenance") : "Maintenance completed";
    text = cut(body.replace(/<!--[\s\S]*?-->/g, ""), 600) || "Planned work on our services.";
    fields.push({ name: "Window", value: `<t:${unix(start)}:f>${end ? ` to <t:${unix(end)}:t>` : ""}`, inline: false });
  } else if (open) {
    kind = degraded ? "warn" : "bad";
    heading = degraded ? "Degraded performance" : regionName ? "Check failing" : "Service down";
    text = degraded
      ? "Responses are slower than normal. We are looking into it."
      : "Our monitoring can't reach this service. We are investigating.";
    fields.push({ name: "Started", value: `<t:${unix(issue.created_at)}:R>`, inline: true });
  } else {
    kind = "ok";
    heading = "Resolved";
    text = `Back to normal after ${duration(issue.created_at, issue.closed_at)}.`;
    fields.push({ name: "Duration", value: duration(issue.created_at, issue.closed_at), inline: true });
  }

  if (!maintenance) {
    fields.push({ name: "Checked from", value: regionName || "United States", inline: true });
    if (code) fields.push({ name: "HTTP", value: code === "0" ? "No response" : code, inline: true });
    if (ms && ms !== "0") fields.push({ name: "Response", value: `${ms} ms`, inline: true });
  }

  const note = [];
  if (open && (code === "403" || code === "1020") && regionName) {
    note.push("A 403 that fast usually means a firewall or bot rule is blocking the monitoring check, not that the site is down for everyone.");
  }
  if (latest) note.push(`**Update:** ${cut(latest.body, 700)}`);
  if (note.length) fields.push({ name: "Details", value: cut(note.join("\n\n"), 1000), inline: false });

  const links = [`[Status page](${STATUS_URL})`, `[Incident #${issue.number}](${url})`];
  const embed = {
    title: cut(`${{ bad: "🔴", warn: "🟠", ok: "🟢", info: "🔧" }[kind]} ${!maintenance && !open ? title.replace(/\s+(is down|has degraded performance)$/i, " recovered") : title}`, 250),
    url,
    description: cut(`**${heading}**\n${text}\n\n${links.join("  ·  ")}`, 1800),
    color: COLORS[kind],
    fields: fields.slice(0, 10),
    footer: { text: "Conscherry Status" },
    timestamp: new Date((issue.closed_at && !open ? issue.closed_at : issue.updated_at) || issue.created_at).toISOString(),
  };

  const mention = ROLE_ID && open && kind === "bad" && !regionName && !maintenance;
  return {
    payload: {
      username: "Conscherry Status",
      avatar_url: `${STATUS_URL}/logo.png`,
      content: mention ? `<@&${ROLE_ID}>` : "",
      embeds: [embed],
      allowed_mentions: mention ? { roles: [ROLE_ID] } : { parse: [] },
    },
    fingerprint: hash(JSON.stringify([embed.title, embed.description, embed.fields, open, latest?.id])),
  };
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

async function loadIssues() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const seen = new Map();
  for (const label of ["status", "maintenance"]) {
    const list = await gh(`/repos/${REPO}/issues?state=all&labels=${label}&since=${encodeURIComponent(since)}&per_page=50&sort=updated&direction=asc`);
    for (const issue of list) if (!issue.pull_request) seen.set(issue.number, issue);
  }
  return [...seen.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function setMarker(issue, id, fingerprint) {
  const body = (issue.body || "").replace(MARKER, "").trimEnd();
  if (DRY_RUN) return;
  await gh(`/repos/${REPO}/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body: `${body}\n\n<!-- discord:${id}:${fingerprint} -->` }),
    headers: { "Content-Type": "application/json" },
  });
}

const issues = await loadIssues();
let posted = 0;
let edited = 0;

for (const issue of issues) {
  const comments = issue.comments > 0 ? await gh(`/repos/${REPO}/issues/${issue.number}/comments?per_page=50`) : [];
  const { payload, fingerprint } = build(issue, comments);
  const marker = MARKER.exec(issue.body || "");

  if (marker && marker[2] === fingerprint) continue;

  const base = HOOK.split("?")[0];
  let messageId = null;
  if (marker) {
    const { content, ...editBody } = payload;
    const res = await discord("PATCH", `${base}/messages/${marker[1]}`, { ...editBody, content: content || "" });
    if (res) {
      messageId = marker[1];
      edited += 1;
    }
  }
  if (!messageId) {
    const res = await discord("POST", `${base}?wait=true`, payload);
    messageId = res.id;
    posted += 1;
  }
  await setMarker(issue, messageId, fingerprint);
  await sleep(400);
}

console.log(`Discord sync done: ${posted} posted, ${edited} edited, ${issues.length} incidents checked.`);
