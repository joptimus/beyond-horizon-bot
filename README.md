# Beyond Horizon Bot

A Discord bot for the Beyond Horizon space-MMO/RTS community. It handles player idea and bug report submissions through an AI-enrichment pipeline that posts structured GitHub issues, syncs votes, verifies player enlistment designations, and exposes a REST API for external integrations.

---

## What It Does

### Idea Submission Pipeline
Players submit ideas via `/idea` or `!idea`. The bot:
1. Creates a dedicated thread to keep channels clean
2. Sends the raw text through OpenAI to generate a structured draft (title, summary, gameplay impact, implementation notes, tags, risks)
3. If the AI has clarifying questions, prompts the submitter to answer or skip
4. Presents a preview embed with Approve / Cancel buttons
5. On approval, creates a GitHub issue and posts a vote embed in the parent channel
6. Syncs 👍 reaction counts back to the GitHub issue as a comment in real time

### Bug Report Pipeline
Same flow as ideas via `/bug` or `!bug`, with a bug-specific AI enrichment (steps to reproduce, expected vs actual behavior, frequency) and a separate GitHub label.

### Player Verification
New members are prompted to link their enlistment designation from beyondhorizononline.com. The bot calls the game server API to validate the designation, grants the Verified role, sets their nickname to their callsign, and posts a welcome message to the enlistment log channel.

### REST API
An Express server runs alongside the bot (default port `3847`) for external integrations. All routes require a `Bearer` token (`API_KEY` env var).

| Route | Purpose |
|---|---|
| `GET /status` | Bot health / uptime |
| `GET /channels` | List guild channels |
| `GET/POST /messages` | Read or send messages |
| `POST /moderate` | Moderation actions |
| `GET /roles` | List guild roles |
| `GET /stats` | Message activity stats |
| `GET /leaderboard` | Member leaderboard |
| `GET /schedules` | Scheduled posts |
| `GET /activity` | Activity log |

---

## Commands

### Slash Commands

| Command | Description |
|---|---|
| `/idea <text>` | Submit a game idea |
| `/bug <text>` | Submit a bug report |
| `/ideas top [count]` | List top ideas by vote count |
| `/priority <issue> <level>` | Set P1–P5 priority on a GitHub issue (requires Manage Guild) |
| `/verify` | Link an enlistment designation to your Discord account |
| `/invite` | Get a server invite link |

### Prefix Commands (`!`)

| Command | Description |
|---|---|
| `!idea <text>` | Submit a game idea |
| `!bug <text>` | Submit a bug report |
| `!ideas [count]` | List top ideas by vote count |
| `!explain <issue#>` | Show the summary for a GitHub issue |

---

## Project Structure

```
src/
  bot.ts                     # Main entry — slash/prefix routing, button/modal flows, reaction sync, member join
  ai.ts                      # OpenAI enrichment for ideas (enrichIdea, toIssueBody)
  aiBug.ts                   # OpenAI enrichment for bug reports (enrichBug, toBugIssueBody)
  github.ts                  # Octokit wrapper — create issues, upsert vote comments, list/fetch issues
  gameServer.ts              # Game server API client — verifyDesignation, checkDiscordVerified
  pending.ts                 # In-memory store for draft ideas/bugs (10-min TTL)
  votes.ts                   # messageId <-> GitHub issue number map for vote syncing
  ranking.ts                 # Sort ideas by Discord votes + priority weight
  register.ts                # Slash command registration script
  types.ts                   # Shared TypeScript types
  api.ts                     # Express server setup
  commands/
    idea.ts                  # /idea slash command
    bug.ts                   # /bug slash command
    ideasTop.ts              # /ideas top slash command
    priority.ts              # /priority slash command
    verify.ts                # /verify slash command
    invite.ts                # /invite slash command
  routes/
    status.ts                # GET /status
    channels.ts              # GET /channels
    messages.ts              # GET/POST /messages
    moderate.ts              # POST /moderate
    roles.ts                 # GET /roles
    stats.ts                 # GET /stats
    leaderboard.ts           # GET /leaderboard
    schedules.ts             # GET /schedules
    activity.ts              # GET /activity
  middleware/
    auth.ts                  # Bearer token auth for the REST API
    logger.ts                # Request logging
  services/
    activityLog.ts           # Activity tracking service
```

---

## Requirements

- **Node.js 22+**
- **Discord Bot** with:
  - Scopes: `bot`, `applications.commands`
  - Privileged intents: Message Content, Guild Members
  - Permissions: Send Messages, Create Public Threads, Add Reactions, Read Message History, Manage Nicknames, Manage Roles
- **GitHub Personal Access Token** with `repo` scope
- **OpenAI API Key**
- **Game server** running the Beyond Horizon API (for `/verify`)

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```env
# Discord
DISCORD_TOKEN=
DISCORD_APP_ID=
DISCORD_GUILD_ID=

# GitHub
GITHUB_TOKEN=
GITHUB_OWNER=
GITHUB_REPO=

# OpenAI
OPENAI_API_KEY=

# Game server
GAME_SERVER_URL=
GAME_SERVER_API_KEY=

# Discord role/channel IDs
VERIFIED_ROLE_ID=
VERIFY_CHANNEL_ID=
ENLISTMENT_LOG_CHANNEL_ID=

# REST API
API_KEY=               # Bearer token required by all API routes
API_PORT=3847          # Optional, defaults to 3847

# Optional tuning
MIN_REACTIONS_FOR_IDEA=0
```

---

## Running

```bash
npm install

# Development (hot reload)
npm run dev

# Production
npm run build
npm run start
```

For persistent hosting, use a process manager:

```bash
npm install -g pm2
npm run build
pm2 start dist/bot.js --name beyond-horizon-bot
pm2 save
pm2 startup
```

### Register Slash Commands

Run once after adding or changing slash commands:

```bash
node dist/register.js
```

---

## Notes

- **In-memory state**: Draft ideas/bugs (`pending.ts`) and vote mappings (`votes.ts`) are stored in memory and are lost on restart. Any in-flight submissions will expire.
- **Vote sync**: The bot seeds each vote embed with a 👍 reaction. Vote counts in GitHub reflect non-bot reactions only.
- **Priority weights**: P1=50, P2=25, P3=10, P4=5, P5=1 — added to Discord vote count when ranking ideas.

---

## License

MIT
