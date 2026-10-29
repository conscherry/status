import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const repo = process.env.GITHUB_REPOSITORY || "conscherry/status";
const token = process.env.GITHUB_TOKEN || process.env.GH_PAT;
const out = "dist";

await rm(out, { recursive: true, force: true });
await cp("web", out, { recursive: true });
await cp("assets/logo.png", `${out}/logo.png`);
await mkdir(`${out}/data`, { recursive: true });

await cp("history/summary.json", `${out}/data/summary.json`);

const meta = {};
for (const file of await readdir("history")) {
  if (!file.endsWith(".yml")) continue;
  const text = await readFile(`history/${file}`, "utf8");
  const start = /^startTime:\s*(.+)$/m.exec(text);
  if (start) meta[file.replace(/\.yml$/, "")] = { startTime: start[1].trim() };
}
await writeFile(`${out}/data/meta.json`, JSON.stringify(meta));

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
