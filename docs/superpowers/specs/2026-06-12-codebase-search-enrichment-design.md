# Codebase-Aware Issue Enrichment — Design

**Date:** 2026-06-12
**Status:** Approved pending user spec review

## Problem

When a player files an idea or bug, the bot enriches it with AI and creates a GitHub
issue — but the issue says nothing about *where in the game's code* a developer should
start. Developers triaging issues have to rediscover the relevant systems every time.

## Goal

When an idea or bug is approved, the bot searches the game's codebases (4–5 repos:
Unity client, Node game server, etc.) and appends a **"Where to Start"** section to the
GitHub issue: concrete repo/file/symbol pointers with a one-line reason each.

## Decisions Made

| Decision | Choice | Why |
|---|---|---|
| Search backend | **repowise** (already running on the user's Docker server, indexing the multi-repo workspace) | Index already exists and is maintained; semantic + FTS + dependency graph; avoids running a duplicate codebase-memory-mcp index |
| Integration style | **MCP client** — bot connects to repowise's MCP server (streamable-http) via `@modelcontextprotocol/sdk` | Tool names/schemas come from repowise itself (no drift); dogfoods the user's hosted-MCP goal; ~30 lines more than REST |
| AI strategy | **Bounded tool loop** — OpenAI chat-completions function calling, max 5 tool calls | Model can refine searches based on results; capped cost/latency |
| When it runs | **At approval click**, just before issue creation | Only approved ideas pay the cost; operates on final post-Q&A content; submission latency unchanged |
| Output location | **GitHub issue body only** | Devs see it where they work; Discord embeds stay clean, no code structure leaked to players |
| Scope | **Both ideas and bugs** | Same service powers both enrichment paths |
| Bot hosting | **Migrate from Railway to the user's Windows Docker server** | Bot reaches repowise over the private Docker network; nothing exposed to the internet |

## Architecture

```
/idea or /bug submitted
    ↓
enrichIdea() / enrichBug()            (unchanged — Q&A modal flow as today)
    ↓
User clicks Approve  (bot.ts approve handlers, ~L500 idea / ~L620 bug)
    ↓
★ findCodePointers(pending)            NEW: bounded OpenAI tool loop;
    ↓                                  tools bridged from repowise MCP
appendWhereToStart(body, pointers)     NEW: markdown section appended to stored body
    ↓
createIdeaIssue() / createBugIssue()   (unchanged)
```

### New module: `src/repowiseMcp.ts`

MCP client wrapper around repowise's MCP server.

- Env: `REPOWISE_MCP_URL` (e.g. `http://repowise:7338/mcp`), `REPOWISE_API_KEY`
  (sent as `Authorization: Bearer` header if set). **If `REPOWISE_MCP_URL` is unset,
  the feature is disabled and the bot behaves exactly as today.**
- Connects lazily (first use) with `StreamableHTTPClientTransport`; reconnects on
  dropped sessions.
- On connect, calls `tools/list` and filters to an allowlist:
  `search_codebase`, `get_symbol`, `get_context`, `list_repos`
  (not all 17 repowise tools — keeps the model focused).
- Exposes:
  - `getOpenAiTools()` → MCP tool schemas mapped to OpenAI function definitions
    (MCP uses JSON Schema, so the mapping is mechanical).
  - `callTool(name, args)` → proxies to the MCP server, returns text content.

### New module: `src/aiCodeContext.ts`

`findCodePointers(input: { title, summary, body, kind: "idea" | "bug" }): Promise<CodePointers | null>`

- Builds a chat-completions conversation: system prompt describing the game's
  architecture (reuse the preface style from `ai.ts`) + instructions to locate the
  starting points; user message contains the enriched idea/bug content.
- Runs a function-calling loop with the bridged repowise tools.
  Hard caps: **5 tool calls**, **15 s total wall-clock budget**.
- Final response must be JSON:
  ```json
  {
    "whereToStart": [
      { "repo": "game-server", "path": "src/fleet/warp.ts", "symbol": "beginWarp", "reason": "..." }
    ],
    "confidence": "high" | "medium" | "low"
  }
  ```
  Max 6 pointers. Malformed JSON → one retry, then give up (return `null`).
- Any failure (repowise down, timeout, OpenAI error) → log a warning, return `null`.
  **A filed issue without pointers always beats a failed filing.**

### Changed: issue body formatting

- `appendWhereToStart(body, pointers)` (in `aiCodeContext.ts` or a small shared
  helper): appends to the already-rendered issue body:

  ```markdown
  **Where to Start** _(AI-generated from code index, confidence: medium)_
  - `game-server` — `src/fleet/warp.ts` → `beginWarp()`: handles warp initiation and state
  - ...
  ```

- Applied in the two approve handlers in `bot.ts` (idea ~L500, bug ~L620) before
  `createIdeaIssue` / `createBugIssue`. The handlers defer the Discord interaction
  reply first so the extra seconds don't time out the interaction.
- `PendingIdea` (`src/pending.ts`) already stores `title`, `body`, `rawText` — the
  search input is built from those (no schema change needed; `body` carries the full
  enriched content).

## Docker Deployment (migration off Railway)

- **`Dockerfile`** — multi-stage: `node:22-alpine`; build stage runs `npm ci` +
  `npm run build`; runtime stage copies `dist/` + production `node_modules`, runs
  `node dist/bot.js`.
- **`docker-compose.yml`** — single `bot` service, `env_file: .env`,
  `restart: unless-stopped`, joined to the repowise compose network declared as an
  **external network** so the bot reaches `http://repowise:7338`. If the network name
  differs on the server, it is a one-line change; `host.docker.internal` is the
  fallback if repowise's MCP port is published on the host instead.
- **`.env.example`** — add `REPOWISE_MCP_URL`, `REPOWISE_API_KEY`.
- Migration steps: copy Railway env vars into the server's `.env`, add the repowise
  vars, `docker compose up -d`, verify, then shut down the Railway deployment.
  (Pending drafts are in-memory with a 10-min TTL, so a quiet-moment cutover loses
  nothing.)

## Error Handling Summary

| Failure | Behavior |
|---|---|
| `REPOWISE_MCP_URL` unset | Feature off; identical to current behavior |
| repowise unreachable / MCP error | Warn-log, issue created without section |
| Loop exceeds 15 s or 5 tool calls | Force final answer with what it has; if none, skip section |
| Malformed final JSON | One retry, then skip section |
| OpenAI error | Warn-log, skip section |

## Testing

The repo has no test infrastructure today. Add **vitest** scoped to the new modules:

- `repowiseMcp` — MCP→OpenAI tool-schema mapping, allowlist filtering, auth header
  (mocked transport).
- `aiCodeContext` — loop termination (call cap, time budget), output parsing,
  `appendWhereToStart` rendering (mocked OpenAI + mocked tool layer).

Manual end-to-end validation: `npm run try:codesearch -- "fleet gets stuck warping"`
runs the real loop against the live repowise instance and prints pointers — used to
tune the system prompt and tool subset before wiring into Discord.

## Out of Scope

- Exposing repowise/MCP to the internet (the user's hosted-MCP goal) — later project.
- OpenAI Responses API native MCP integration — possible later upgrade once the MCP
  endpoint is public.
- Showing pointers in Discord, re-running search after issue creation, index
  management (repowise owns freshness via its own sync/webhooks).
