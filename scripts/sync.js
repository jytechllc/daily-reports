#!/usr/bin/env node
/**
 * sync.js
 * Fetch messages from Slack channel, filter by keywords, upload to GitHub Markdown
 * Usage: node scripts/sync.js [--date 2024-01-15] [--hours 24]
 */

const https = require("https");
const crypto = require("crypto");

// ── Configuration (all from environment variables) ──────────────────────────────────
const config = {
  slack: {
    token: required("SLACK_BOT_TOKEN"),
    channelId: required("SLACK_CHANNEL_ID"),
  },
  github: {
    appId: required("GH_APP_ID"),
    privateKey: required("GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    installationId: required("GH_APP_INSTALLATION_ID"),
    owner: required("GH_OWNER"),
    repo: required("GH_REPO"),
    branch: process.env.GH_BRANCH || "main",
    basePath: process.env.GH_BASE_PATH || "",
    token: null, // populated at runtime via App installation token
  },
  trigger: {
    keywords: (process.env.TRIGGER_KEYWORDS || "日报,daily report,今日完成,【完成】")
      .split(",").map(k => k.trim()),
  },
  timezone: process.env.TIMEZONE || "America/Los_Angeles",
};

// ── CLI Parameters ────────────────────────────────────────────────
const args = process.argv.slice(2);
const targetDate = getArg(args, "--date") || getTodayDate(config.timezone);
const lookbackHours = parseInt(getArg(args, "--hours") || "24", 10);

// ── Main Process ──────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Start syncing Slack → GitHub`);
  console.log(`📅 Target date: ${targetDate}`);
  console.log(`⏱  Lookback hours: ${lookbackHours} hours`);
  console.log(`🔑 Trigger keywords: ${config.trigger.keywords.join(", ")}\n`);

  // 0. Get GitHub App installation token
  console.log(`🔐 Getting GitHub App installation token...`);
  const jwt = generateJWT(config.github.appId, config.github.privateKey);
  config.github.token = await getInstallationToken(jwt, config.github.installationId);
  console.log(`✅ GitHub App token acquired\n`);

  // 1. Fetch Slack messages
  const oldest = getOldest(targetDate, lookbackHours, config.timezone);
  const latest = getLatest(targetDate, config.timezone);
  console.log(`📡 Fetch time range: ${new Date(oldest * 1000).toLocaleString("en-US", { timeZone: config.timezone })} ~ ${new Date(latest * 1000).toLocaleString("en-US", { timeZone: config.timezone })}`);

  const messages = await fetchSlackMessages(oldest, latest);
  console.log(`📨 Fetched ${messages.length} messages total`);

  // 2. Filter by keywords
  const reports = messages.filter(m => {
    if (m.subtype) return false;
    if (m.bot_id) return false;
    const text = (m.text || "").toLowerCase();
    return config.trigger.keywords.some(kw => text.includes(kw.toLowerCase()));
  });
  console.log(`✅ Reports matching keywords: ${reports.length}\n`);

  if (reports.length === 0) {
    console.log("⚠️  No daily report messages found, skipping upload");
    return;
  }

  // 3. Fetch user information
  const userMap = await fetchUserNames(reports.map(m => m.user).filter(Boolean));

  // 4. Build Markdown content
  const markdown = buildMarkdown(reports, userMap, targetDate, config.timezone);

  // 5. Upload to GitHub
  const filePath = buildFilePath(targetDate);
  const result = await uploadToGitHub(filePath, markdown, targetDate);

  console.log(`\n🎉 Upload successful!`);
  console.log(`📄 File path: ${filePath}`);
  console.log(`🔗 ${result.url}`);
}

// ── Slack API ────────────────────────────────────────────────
// Fetch messages from Slack within a time range
async function fetchSlackMessages(oldest, latest) {
  const messages = [];
  let cursor;

  do {
    const params = new URLSearchParams({
      channel: config.slack.channelId,
      oldest: String(oldest),
      latest: String(latest),
      limit: "200",
      inclusive: "true",
      ...(cursor ? { cursor } : {}),
    });

    const data = await slackGet(`conversations.history?${params}`);
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

    messages.push(...(data.messages || []));
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  return messages.reverse(); // Sort in chronological order
}

async function fetchUserNames(userIds) {
  const unique = [...new Set(userIds)];
  const map = {};

  await Promise.all(unique.map(async (uid) => {
    try {
      const data = await slackGet(`users.info?user=${uid}`);
      if (data.ok) {
        map[uid] = data.user.profile.display_name || data.user.real_name || uid;
      } else {
        console.warn(`⚠️  users.info failed for ${uid}: ${data.error}`);
        map[uid] = uid;
      }
    } catch (e) {
      console.warn(`⚠️  users.info exception for ${uid}: ${e.message}`);
      map[uid] = uid;
    }
  }));

  return map;
}

// ── Markdown Building ────────────────────────────────────────────
function buildMarkdown(messages, userMap, date, timezone) {
  const sections = messages.map(m => {
    const username = userMap[m.user] || m.user || "Unknown";
    const text = cleanSlackMarkup(m.text || "");
    return formatEntry(username, text);
  });

  return sections.join("\n\n") + "\n";
}

function formatEntry(username, text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  let planLines = [];
  let blockLines = [];
  let workLines = [];
  let section = "work";

  for (const line of lines) {
    if (/^plan[:\s]/i.test(line)) {
      section = "plan";
      const rest = line.replace(/^plan[:\s]*/i, "").trim();
      if (rest) planLines.push(rest);
    } else if (/^block[:\s]/i.test(line)) {
      section = "block";
      const rest = line.replace(/^block[:\s]*/i, "").trim();
      if (rest) blockLines.push(rest);
    } else if (section === "plan") {
      planLines.push(line.replace(/^[-•]\s*/, "").replace(/^\d+\.\s*/, ""));
    } else if (section === "block") {
      blockLines.push(line.replace(/^[-•]\s*/, "").replace(/^\d+\.\s*/, ""));
    } else {
      workLines.push(line.replace(/^[-•]\s*/, "").replace(/^\d+\.\s*/, ""));
    }
  }

  const workSection = workLines
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");

  const planSection = planLines.length
    ? "\n\nPlan:\n" + planLines.map((l, i) => `${i + 1}. ${l}`).join("\n")
    : "";

  const blockSection = blockLines.length
    ? "\n\nBlock:\n" + blockLines.map((l, i) => `${i + 1}. ${l}`).join("\n")
    : "";

  return `### ${username}\n${workSection}${planSection}${blockSection}`;
}

function cleanSlackMarkup(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

// ── GitHub App Auth ──────────────────────────────────────────
function generateJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = s => Buffer.from(s).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(appId) }));
  const data = `${header}.${payload}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(data);
  const sig = sign.sign(privateKey, "base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  return `${data}.${sig}`;
}

async function getInstallationToken(jwt, installationId) {
  const data = await request(
    "POST",
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {},
    {
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "slack-github-sync",
      Accept: "application/vnd.github+json",
    }
  );
  return data.token;
}

// ── GitHub API ───────────────────────────────────────────────
async function uploadToGitHub(filePath, content, date) {
  const { owner, repo, branch } = config.github;

  // Check if file already exists
  let sha;
  try {
    const existing = await githubGet(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`);
    sha = existing.sha;
    console.log(`📝 File exists, will update with overwrite`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`📄 Create new file`);
  }

  await githubPut(`repos/${owner}/${repo}/contents/${filePath}`, {
    message: `📝 Daily report sync: ${date} (${new Date().toISOString().slice(0, 10)})`,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });

  return { url: `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}` };
}

function buildFilePath(date) {
  const [y, m, d] = date.split("-");
  const segments = [...(config.github.basePath ? [config.github.basePath] : []), `${m}-${y}`, `${d}-${m}-${y}.md`];
  return segments.join("/");
}

// ── HTTP Tools ────────────────────────────────────────────────
function slackGet(path) {
  return request("GET", `https://slack.com/api/${path}`, null, {
    Authorization: `Bearer ${config.slack.token}`,
  });
}

function githubGet(path) {
  return request("GET", `https://api.github.com/${path}`, null, {
    Authorization: `Bearer ${config.github.token}`,
    "User-Agent": "slack-github-sync",
    Accept: "application/vnd.github+json",
  });
}

function githubPut(path, body) {
  return request("PUT", `https://api.github.com/${path}`, body, {
    Authorization: `Bearer ${config.github.token}`,
    "User-Agent": "slack-github-sync",
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  });
}

function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers,
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`);
            err.status = res.statusCode;
            reject(err);
          } else {
            resolve(json);
          }
        } catch { reject(new Error(`Invalid JSON: ${data}`)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Time Tools ─────────────────────────────────────────────────
function getTodayDate(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function getOldest(date, hours, tz) {
  const d = new Date(`${date}T12:00:00Z`);
  const offset = getTimezoneOffsetMs(tz);
  return Math.floor((d.getTime() - offset - hours * 3600000) / 1000);
}

function getLatest(date, tz) {
  const d = new Date(`${date}T12:00:00Z`);
  const offset = getTimezoneOffsetMs(tz);
  return Math.floor((d.getTime() - offset) / 1000);
}

function getTimezoneOffsetMs(tz) {
  // Returns the offset of target timezone relative to UTC (milliseconds), e.g. Asia/Shanghai returns +8h = +28800000
  const now = new Date();
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  return new Date(tzStr) - new Date(utcStr);
}

function tsToTime(ts, tz) {
  return new Date(parseFloat(ts) * 1000).toLocaleTimeString("zh-CN", {
    timeZone: tz, hour: "2-digit", minute: "2-digit",
  });
}

// ── Utility Functions ─────────────────────────────────────────────────
function required(name) {
  const val = process.env[name];
  if (!val) { console.error(`❌ Missing environment variable: ${name}`); process.exit(1); }
  return val;
}

function getArg(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

// ── Execution ─────────────────────────────────────────────────────
main().catch(err => { console.error("❌ Sync failed:", err.message); process.exit(1); });
