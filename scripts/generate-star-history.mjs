#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const backfill = process.argv.includes("--backfill");
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const owner = process.env.GITHUB_REPOSITORY_OWNER || positional[0] || "KANIKIG";
const outputPath = resolve(positional[1] || "assets/star-history.svg");
const dataPath = resolve(positional[2] || "data/star-history.json");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const today = new Date().toISOString().slice(0, 10);

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${owner}-profile-star-history`,
  "X-GitHub-Api-Version": "2022-11-28",
};
if (token) headers.Authorization = `Bearer ${token}`;

async function github(path, accept = headers.Accept) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { ...headers, Accept: accept },
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const error = new Error(
      `GitHub API ${response.status} for ${path}` +
        (remaining === "0" ? ` (rate limit resets at ${new Date(Number(reset) * 1000).toISOString()})` : ""),
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchPages(path, accept) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await github(`${path}${separator}per_page=100&page=${page}`, accept);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function listRepositories() {
  const repositories = await fetchPages(`/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name`);
  return repositories.filter(
    (repository) => !repository.private && !repository.fork && !repository.disabled,
  );
}

function totalStars(repositories) {
  return repositories.reduce((total, repository) => total + repository.stargazers_count, 0);
}

function upsertSnapshot(points, date, count) {
  const withoutToday = points.filter((point) => point.date !== date);
  withoutToday.push({ date, count });
  return withoutToday.sort((a, b) => a.date.localeCompare(b.date));
}

async function backfillHistory(repositories) {
  if (!token) throw new Error("--backfill requires GH_TOKEN or GITHUB_TOKEN with access to the owner's repositories.");

  const eventsByDate = new Map();
  const unavailable = [];
  for (const repository of repositories) {
    if (repository.stargazers_count === 0) continue;
    process.stdout.write(`Backfilling ${repository.full_name} (${repository.stargazers_count} stars)\n`);
    let stars;
    try {
      stars = await fetchPages(
        `/repos/${repository.full_name}/stargazers`,
        "application/vnd.github.star+json",
      );
    } catch (error) {
      if (error.status !== 403 && error.status !== 404 && error.status !== 451) throw error;
      unavailable.push({
        repository: repository.full_name,
        stars: repository.stargazers_count,
        status: error.status,
      });
      process.stderr.write(`Skipping ${repository.full_name}: stargazer timestamps are unavailable (HTTP ${error.status}).\n`);
      continue;
    }

    for (const star of stars) {
      if (!star.starred_at) continue;
      const date = star.starred_at.slice(0, 10);
      eventsByDate.set(date, (eventsByDate.get(date) || 0) + 1);
    }
  }

  let count = 0;
  const points = [...eventsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, additions]) => ({ date, count: (count += additions) }));

  return {
    owner,
    description: "Cumulative current stargazers for accessible public, non-fork repositories, backfilled by starred_at and followed by weekly total-star snapshots.",
    backfilledAt: today,
    unavailable,
    points: upsertSnapshot(points, today, totalStars(repositories)),
  };
}

async function updateHistory(repositories) {
  let data;
  try {
    data = JSON.parse(await readFile(dataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing ${dataPath}. Run this script once with --backfill and an owner-scoped token.`);
    }
    throw error;
  }

  if (data.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`History belongs to ${data.owner}, not ${owner}.`);
  }
  data.points = upsertSnapshot(data.points, today, totalStars(repositories));
  return data;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function niceCeiling(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  return (normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
}

function renderChart(data, repositoryCount) {
  const width = 900;
  const height = 420;
  const plot = { left: 72, top: 100, right: 34, bottom: 54 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const firstDate = new Date(`${data.points[0]?.date || today}T00:00:00Z`);
  const start = Date.UTC(firstDate.getUTCFullYear(), 0, 1);
  const end = Date.parse(`${today}T23:59:59Z`);
  const span = Math.max(end - start, 86_400_000);
  const latestTotal = data.points.at(-1)?.count || 0;
  const maximum = Math.max(...data.points.map((point) => point.count), latestTotal);
  const yMax = niceCeiling(maximum);
  const x = (date) => plot.left + ((Date.parse(`${date}T12:00:00Z`) - start) / span) * plotWidth;
  const y = (stars) => plot.top + plotHeight - (stars / yMax) * plotHeight;

  const yearStart = new Date(start).getUTCFullYear();
  const yearEnd = new Date(end).getUTCFullYear();
  const yearStep = Math.max(1, Math.ceil((yearEnd - yearStart + 1) / 7));
  const xGrid = [];
  for (let year = yearStart; year <= yearEnd; year += yearStep) {
    const position = plot.left + ((Date.UTC(year, 0, 1) - start) / span) * plotWidth;
    xGrid.push(`<line x1="${position.toFixed(2)}" y1="${plot.top}" x2="${position.toFixed(2)}" y2="${plot.top + plotHeight}" class="grid"/>`);
    xGrid.push(`<text x="${position.toFixed(2)}" y="${height - 22}" text-anchor="middle" class="axis">${year}</text>`);
  }

  const yGrid = [];
  for (let index = 0; index <= 4; index += 1) {
    const stars = Math.round((yMax * index) / 4);
    const position = y(stars);
    yGrid.push(`<line x1="${plot.left}" y1="${position.toFixed(2)}" x2="${width - plot.right}" y2="${position.toFixed(2)}" class="grid"/>`);
    yGrid.push(`<text x="${plot.left - 14}" y="${(position + 4).toFixed(2)}" text-anchor="end" class="axis">${stars.toLocaleString("en-US")}</text>`);
  }

  const pointList = data.points.map((point) => `${x(point.date).toFixed(2)},${y(point.count).toFixed(2)}`);
  const linePoints = [`${plot.left},${y(0).toFixed(2)}`, ...pointList].join(" ");
  const lastX = x(data.points.at(-1)?.date || today);
  const areaPoints = `${plot.left},${plot.top + plotHeight} ${linePoints} ${lastX.toFixed(2)},${plot.top + plotHeight}`;
  const generated = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(owner)} total star history</title>
  <desc id="description">${latestTotal} stars across ${repositoryCount} accessible public, non-fork repositories as of ${generated}.</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58a6ff" stop-opacity=".42"/><stop offset="1" stop-color="#58a6ff" stop-opacity=".03"/></linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <style>
    .text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: #c9d1d9 }
    .axis { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: #8b949e }
    .grid { stroke: #30363d; stroke-width: 1 }
  </style>
  <rect x=".5" y=".5" width="899" height="419" rx="10" fill="#0d1117" stroke="#30363d"/>
  <text x="${plot.left}" y="42" class="text" font-size="22" font-weight="600">Stars across ${escapeXml(owner)}'s projects</text>
  <text x="${plot.left}" y="70" class="text" font-size="14" fill="#8b949e">${latestTotal.toLocaleString("en-US")} total stars · ${repositoryCount} active public repositories · updated ${generated}</text>
  ${xGrid.join("\n  ")}
  ${yGrid.join("\n  ")}
  <polygon points="${areaPoints}" fill="url(#area)"/>
  <polyline points="${linePoints}" fill="none" stroke="#58a6ff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${lastX.toFixed(2)}" cy="${y(latestTotal).toFixed(2)}" r="5" fill="#58a6ff" filter="url(#glow)"/>
</svg>\n`;
}

const repositories = await listRepositories();
const data = backfill ? await backfillHistory(repositories) : await updateHistory(repositories);
await mkdir(dirname(dataPath), { recursive: true });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
await writeFile(outputPath, renderChart(data, repositories.length), "utf8");
process.stdout.write(`Wrote ${outputPath} and ${dataPath}: ${data.points.at(-1).count} stars across ${repositories.length} repositories.\n`);
