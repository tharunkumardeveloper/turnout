// The README's downloads badge: GitHub Release downloads plus unique git clones, kept in the stats branch.
// GitHub keeps clone counts for 14 days only, so each run merges them into clones.json, by day.
//   GITHUB_REPOSITORY, GITHUB_TOKEN (releases), TRAFFIC_TOKEN (clones: a token with access to the repo's traffic)
//   node .github/stats/stats.mjs <stats-dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'stats';
const repo = process.env.GITHUB_REPOSITORY;
const api = async (path, token) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'turnout-stats', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const read = (name, fallback) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : fallback);

// Every Release's attached files (what the one-line installers download).
const releases = await api('/releases?per_page=100', process.env.GITHUB_TOKEN);
const releaseDownloads = releases.reduce((sum, r) => sum + r.assets.reduce((s, a) => s + a.download_count, 0), 0);

// Unique cloners per day, merged with the days kept before.
const clones = read('clones.json', {});
if (process.env.TRAFFIC_TOKEN) {
  const t = await api('/traffic/clones?per=day', process.env.TRAFFIC_TOKEN);
  for (const day of t.clones) clones[day.timestamp.slice(0, 10)] = { count: day.count, uniques: day.uniques };
} else console.log('No TRAFFIC_TOKEN: clones not updated (Release downloads still are).');
const cloners = Object.values(clones).reduce((sum, d) => sum + d.uniques, 0);

const total = releaseDownloads + cloners;
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'clones.json'), JSON.stringify(clones, null, 2) + '\n');
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), releaseDownloads, cloners, total }, null, 2) + '\n');
// shields.io's endpoint badge: https://shields.io/badges/endpoint-badge
writeFileSync(join(dir, 'downloads.json'), JSON.stringify({ schemaVersion: 1, label: 'downloads', message: total.toLocaleString('en-US'), color: '6633ff' }) + '\n');
console.log(`Release downloads ${releaseDownloads} + unique cloners ${cloners} = ${total}`);
