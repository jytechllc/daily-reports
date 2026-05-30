# Slack → GitHub Daily Report (GitHub Actions Version)

No server required! GitHub Actions periodically fetches Slack daily reports and automatically generates Markdown files committed to the repository.

## How It Works

```
Daily at 18:30 (Shanghai time)
       ↓
GitHub Actions triggered
       ↓
Call Slack API to fetch today's messages
       ↓
Filter messages by keywords
       ↓
Generate Markdown and commit to repo
```

## Generated File Structure

```
daily-reports/
└── 2024/
    └── 01/
        └── 15/
            └── 2024-01-15.md   ← All team members' reports for the day
```

---

## Quick Start

### Step 1: Create a Slack App

1. Open https://api.slack.com/apps → **Create New App**
2. **OAuth & Permissions → Bot Token Scopes** add:
   - `channels:history` — Read messages
   - `users:read` — Get user names
3. **Install to Workspace**, copy the `Bot User OAuth Token` (xoxb-...)
4. Add Bot to target Channel: `/invite @YourBotName`
5. Copy target Channel ID (right-click Channel → View channel details → bottom)

### Step 2: Configure GitHub Secrets

Go to repository **Settings → Secrets and variables → Actions**:

**Secrets (sensitive information):**

| Name | Value |
|------|----|
| `SLACK_BOT_TOKEN` | xoxb-... |
| `SLACK_CHANNEL_ID` | C0XXXXXXXXX |

**Variables (non-sensitive config, optional):**

| Name | Default Value | Description |
|------|--------|------|
| `TRIGGER_KEYWORDS` | `日报,daily report,今日完成,【完成】` | Trigger keywords, comma-separated |
| `GITHUB_BASE_PATH` | `daily-reports` | Storage directory |
| `TIMEZONE` | `America/Los_Angeles` | Timezone |

### Step 3: Push Code

```bash
git add .
git commit -m "add slack daily report sync"
git push
```

Actions will run automatically every day at 18:30 (Shanghai time).

---

## Manual Trigger

In repository **Actions → Sync Slack Daily Reports → Run workflow**:
- Specify a date (e.g., to sync yesterday's reports)
- Adjust lookback hours

---

## Local Testing

```bash
# Copy environment variables
cp .env.example .env
# Fill in real values after:

export $(cat .env | xargs)
node scripts/sync.js

# Test with specific date
node scripts/sync.js --date 2024-01-15

# Lookback 48 hours (for yesterday's reports)
node scripts/sync.js --hours 48
```

---

## Adjusting Schedule

Edit the cron in `.github/workflows/sync.yml`:

```yaml
#        min  hour  day  month  dow
cron: "30 10 * * 1-5"
#     10:30
```

Common time references:

| Shanghai Time | cron (UTC) |
|----------|-------------|
| 18:00 daily | `0 10 * * *` |
| 18:30 Mon-Fri | `30 10 * * 1-5` |
| 09:00 daily (morning report) | `0 1 * * *` |
