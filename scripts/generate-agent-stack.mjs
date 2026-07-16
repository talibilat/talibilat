#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const username = process.env.GITHUB_USERNAME || "talibilat";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const outputPath = resolve(process.argv[2] || "assets/agent-stack.svg");
const dataPath = resolve(process.argv[3] || "assets/agent-stack.json");
const activityWindowDays = 15;

const featured = [
  {
    displayName: "vox",
    repo: "vox",
    fallback: "The voice. Wake word, spoken replies, and sub-200ms barge-in.",
    color: "#58a6ff",
  },
  {
    displayName: "zentra",
    repo: "zentra",
    fallback: "The hands. Orchestration kernel for durable events and safe integration.",
    color: "#a371f7",
  },
  {
    displayName: "agent-trail",
    repo: "agent-trail",
    fallback: "The window. Visual observability for commands moving through Zentra.",
    color: "#f7812f",
  },
  {
    displayName: "limit-bar",
    repo: "limit-bar",
    fallback: "A free macOS menu bar app for AI coding usage and rate limits.",
    color: "#3fb950",
  },
];

const languageColors = {
  Python: "#4493c8",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Jupyter: "#da5b0b",
  "Jupyter Notebook": "#da5b0b",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
};

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function github(path, { retries = 0 } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${username}-profile-readme`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`https://api.github.com${path}`, { headers });
    if (response.status === 202 && attempt < retries) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (response.status === 204) return null;
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub API ${response.status} for ${path}: ${detail.slice(0, 300)}`);
    }
    return response.json();
  }
}

async function listPublicRepos() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/users/${username}/repos?type=owner&sort=updated&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos.filter((repo) => !repo.private);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchAchievements() {
  try {
    const response = await fetch(`https://github.com/${username}`, {
      headers: { "User-Agent": `${username}-profile-readme` },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const anchorPattern = new RegExp(
      `<a href="/${username}\\?achievement=([^&]+)&amp;tab=achievements"[\\s\\S]*?<\\/a>`,
      "g",
    );
    const achievements = new Map();
    for (const match of html.matchAll(anchorPattern)) {
      const block = match[0];
      const name = block.match(/alt="Achievement: ([^"]+)"/)?.[1];
      const tier = block.match(/achievement-tier-label[^>]*>(x\d+)<\/span>/)?.[1] || "x1";
      if (name) achievements.set(match[1], { slug: match[1], name, tier });
    }
    return [...achievements.values()];
  } catch {
    return [];
  }
}

function recentDayKeys(days) {
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    keys.push(new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

async function fetchRecentActivity(repoName) {
  const cutoff = new Date(Date.now() - activityWindowDays * 86_400_000).toISOString();
  const dayKeys = recentDayKeys(activityWindowDays);
  const dailyActivity = Object.fromEntries(dayKeys.map((key) => [key, 0]));
  let pushes = 0;
  let otherEvents = 0;
  let truncated = false;

  try {
    for (let page = 1; page <= 3; page += 1) {
      const events = await github(`/repos/${username}/${repoName}/events?per_page=100&page=${page}`);
      for (const event of events) {
        if (event.created_at < cutoff) continue;
        const day = event.created_at.slice(0, 10);
        if (day in dailyActivity) dailyActivity[day] += 1;
        if (event.type === "PushEvent") pushes += 1;
        else otherEvents += 1;
      }
      const oldest = events.at(-1)?.created_at;
      if (page === 3 && events.length === 100 && oldest >= cutoff) truncated = true;
      if (events.length < 100 || !oldest || oldest < cutoff) break;
    }
  } catch {
    return {
      days: dayKeys,
      daily_activity: Array(activityWindowDays).fill(0),
      pushes: 0,
      other_events: 0,
      truncated: false,
    };
  }

  return {
    days: dayKeys,
    daily_activity: dayKeys.map((key) => dailyActivity[key]),
    pushes,
    other_events: otherEvents,
    truncated,
  };
}

function wrapText(value, limit = 57) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [""];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || `${current} ${word}`.length <= limit) {
      lines[lines.length - 1] = current ? `${current} ${word}` : word;
    } else if (lines.length < 2) {
      lines.push(word);
    } else {
      const room = Math.max(0, limit - current.length - 2);
      lines[1] = `${current}${room > 0 ? ` ${word.slice(0, room)}` : ""}…`;
      break;
    }
  }
  return [lines[0] || "No description provided.", lines[1] || ""];
}

function relativeAge(timestamp) {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function sparkline(values, x, y, width, height) {
  const data = values.length ? values : Array(activityWindowDays).fill(0);
  const maximum = Math.max(...data, 1);
  return data
    .map((value, index) => {
      const px = x + (index * width) / Math.max(1, data.length - 1);
      const py = y + height - (value / maximum) * height;
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(" ");
}

function card(repo, config, x, y) {
  const [descriptionOne, descriptionTwo] = wrapText(repo.description || config.fallback);
  const minimum = repo.activity_truncated ? "+" : "";
  const activityLabel = `${repo.pushes_15_days}${minimum} pushes / 15d  ·  ${repo.other_events_15_days}${minimum} other  ·  ${repo.open_issues} open  ·  pushed ${relativeAge(repo.pushed_at)}`;
  const active = repo.pushes_15_days > 0 || repo.other_events_15_days > 0;
  const status = active ? "▲ active" : "● quiet";
  const statusClass = active ? "active" : "quiet";
  return [
    `<rect class="card" x="${x}" y="${y}" width="384" height="155" rx="10" />`,
    `<text class="name" x="${x + 21}" y="${y + 34}">${escapeXml(config.displayName)}</text>`,
    `<text class="repo mono" x="${x + 21}" y="${y + 53}">${escapeXml(repo.full_name)}</text>`,
    `<path class="spark" stroke="${config.color}" d="${sparkline(repo.daily_activity_15_days, x + 213, y + 25, 150, 22)}" />`,
    `<text class="body" x="${x + 21}" y="${y + 79}">${escapeXml(descriptionOne)}</text>`,
    descriptionTwo ? `<text class="body" x="${x + 21}" y="${y + 98}">${escapeXml(descriptionTwo)}</text>` : null,
    `<circle cx="${x + 25}" cy="${y + 119}" r="4.5" fill="#4493c8" />`,
    `<text class="meta" x="${x + 35}" y="${y + 123}">${escapeXml(repo.language || "Mixed")}</text>`,
    `<text class="meta" x="${x + 112}" y="${y + 123}">${escapeXml(repo.visibility)}</text>`,
    `<text class="${statusClass}" x="${x + 161}" y="${y + 123}">${status}</text>`,
    `<text class="progress mono" x="${x + 21}" y="${y + 144}">${escapeXml(activityLabel)}</text>`,
  ].filter(Boolean).join("\n    ");
}

function languageSummary(languageBytes) {
  const sorted = Object.entries(languageBytes).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, bytes]) => sum + bytes, 0) || 1;
  const top = sorted.slice(0, 3).map(([name, bytes]) => ({ name, bytes, percentage: (bytes / total) * 100 }));
  const otherBytes = sorted.slice(3).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (otherBytes) top.push({ name: "Other", bytes: otherBytes, percentage: (otherBytes / total) * 100 });
  return top;
}

function languagePanel(languages) {
  let offset = 50;
  const segments = languages.map((language) => {
    const width = language.percentage * 3.33;
    const color = languageColors[language.name] || (language.name === "Other" ? "#6e7681" : "#8b949e");
    const segment = `<rect x="${offset.toFixed(1)}" y="431" width="${width.toFixed(1)}" height="11" fill="${color}" />`;
    offset += width;
    return segment;
  });
  const labels = languages
    .map((language, index) => {
      const positions = [50, 158, 242, 333];
      const displayName = language.name === "Jupyter Notebook" ? "Jupyter" : language.name;
      return `<text class="label" x="${positions[index] || 333}" y="465">${escapeXml(displayName)} ${Math.round(language.percentage)}%</text>`;
    })
    .join("\n    ");
  return { segments: segments.join("\n      "), labels };
}

function buildSvg(data) {
  const pullShark = data.achievements.find((achievement) => achievement.slug === "pull-shark");
  const language = languagePanel(data.languages);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="844" height="505" viewBox="0 0 844 505" role="img" aria-labelledby="title description">
  <title id="title">The agent stack</title>
  <desc id="description">Live GitHub data for Vox, Zentra, Agent Trail, Limit Bar, languages, repositories, followers, pull requests, and achievements.</desc>
  <defs>
    <style>
      .ui { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .heading { fill: #f0f6fc; font-size: 22px; font-weight: 700; }
      .eyebrow { fill: #7d8590; font-size: 13px; letter-spacing: .35px; }
      .name { fill: #f0f6fc; font-size: 16px; font-weight: 700; }
      .repo { fill: #7d8590; font-size: 10.5px; }
      .body { fill: #9da7b3; font-size: 12.5px; }
      .meta { fill: #9da7b3; font-size: 11.5px; text-transform: capitalize; }
      .progress { fill: #7d8590; font-size: 9.5px; }
      .active { fill: #3fb950; font-size: 11.5px; }
      .quiet { fill: #d29922; font-size: 11.5px; }
      .metric { fill: #f0f6fc; font-size: 25px; font-weight: 700; }
      .metric-hot { fill: #f7812f; font-size: 25px; font-weight: 700; }
      .label { fill: #9da7b3; font-size: 11.5px; }
      .sub-label { fill: #7d8590; font-size: 9px; }
      .card { fill: #0d1117; stroke: #30363d; }
      .spark { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    </style>
    <clipPath id="language-bar"><rect x="50" y="431" width="333" height="11" rx="5.5" /></clipPath>
  </defs>
  <rect width="844" height="505" fill="#0d1117" />
  <g class="ui">
    <text class="heading" x="24" y="28">The agent stack</text>
    <text class="eyebrow mono" x="201" y="27">15-day GitHub activity</text>
    ${card(data.featured_repositories[0], featured[0], 25, 45)}
    ${card(data.featured_repositories[1], featured[1], 423, 45)}
    ${card(data.featured_repositories[2], featured[2], 25, 212)}
    ${card(data.featured_repositories[3], featured[3], 423, 212)}
    <rect class="card" x="25" y="379" width="384" height="106" rx="10" />
    <text class="name" x="50" y="414">Languages</text>
    <g clip-path="url(#language-bar)">
      ${language.segments}
    </g>
    ${language.labels}
    <rect class="card" x="423" y="379" width="384" height="106" rx="10" />
    <text class="metric-hot" x="449" y="433">${data.profile.public_repos}</text>
    <text class="label" x="449" y="453">public repos</text>
    <text class="metric" x="545" y="433">${data.profile.followers}</text>
    <text class="label" x="545" y="453">followers</text>
    <text class="metric" x="624" y="433">${escapeXml(pullShark?.tier || "n/a")}</text>
    <text class="label" x="624" y="453">pull shark</text>
    <text class="sub-label" x="624" y="469">${data.merged_pull_requests} merged PRs</text>
    <text class="metric" x="699" y="433">${data.achievements.length}</text>
    <text class="label" x="699" y="453">achievements</text>
  </g>
</svg>\n`;
}

async function main() {
  const [profile, repos, achievements, pullRequestSearch] = await Promise.all([
    github(`/users/${username}`),
    listPublicRepos(),
    fetchAchievements(),
    github(`/search/issues?q=${encodeURIComponent(`is:pr author:${username} is:merged`)}`),
  ]);

  const repoByName = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo]));
  const featuredRepositories = await Promise.all(
    featured.map(async (config) => {
      const repo = repoByName.get(config.repo.toLowerCase()) || await github(`/repos/${username}/${config.repo}`);
      const activity = await fetchRecentActivity(repo.name);
      return {
        name: repo.name,
        full_name: repo.full_name,
        html_url: repo.html_url,
        description: repo.description,
        language: repo.language,
        visibility: repo.visibility,
        default_branch: repo.default_branch,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        open_issues: repo.open_issues_count,
        pushed_at: repo.pushed_at,
        updated_at: repo.updated_at,
        activity_window_days: activityWindowDays,
        activity_days: activity.days,
        daily_activity_15_days: activity.daily_activity,
        pushes_15_days: activity.pushes,
        other_events_15_days: activity.other_events,
        activity_truncated: activity.truncated,
      };
    }),
  );

  const languageResponses = await mapWithConcurrency(repos.filter((repo) => !repo.fork), 8, async (repo) => {
    try {
      return await github(`/repos/${username}/${repo.name}/languages`);
    } catch {
      return {};
    }
  });
  const languageBytes = {};
  for (const response of languageResponses) {
    for (const [language, bytes] of Object.entries(response)) {
      languageBytes[language] = (languageBytes[language] || 0) + bytes;
    }
  }

  const data = {
    generated_at: new Date().toISOString(),
    profile: {
      login: profile.login,
      html_url: profile.html_url,
      public_repos: profile.public_repos,
      public_gists: profile.public_gists,
      followers: profile.followers,
      following: profile.following,
    },
    merged_pull_requests: pullRequestSearch.total_count,
    achievements,
    languages: languageSummary(languageBytes),
    featured_repositories: featuredRepositories,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildSvg(data), "utf8");
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Generated ${outputPath}`);
  console.log(`Generated ${dataPath}`);
}

await main();
