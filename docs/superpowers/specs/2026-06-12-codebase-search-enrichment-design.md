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
| Bot hosting | **Stay on Railway** | repowise's MCP endpoint is already exposed via Cloudflare Tunnel + Cloudflare Access (`https://repowise-mcp.thunderducky.com`); the bot authenticates with its own CF Access service token, so no migration is needed |

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

- Env: `REPOWISE_MCP_URL` (e.g. `https://repowise-mcp.thunderducky.com/sse`),
  `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` (Cloudflare Access service-token
  headers, sent on every request), optional `REPOWISE_API_KEY` (`Authorization:
  Bearer` header if repowise itself also requires auth). **If `REPOWISE_MCP_URL` is
  unset, the feature is disabled and the bot behaves exactly as today.**
- Transport chosen by URL path: `/sse` → `SSEClientTransport`, otherwise
  `StreamableHTTPClientTransport` (both from `@modelcontextprotocol/sdk`; both accept
  custom headers). Connects lazily (first use); reconnects on dropped sessions.
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

## Deployment (bot stays on Railway)

- No Dockerfile or migration. The bot keeps running on Railway and reaches repowise
  over the internet through Cloudflare Tunnel + Cloudflare Access.
- New Railway env vars: `REPOWISE_MCP_URL`, `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET` (and `REPOWISE_API_KEY` if used).
- **`.env.example`** — add the same vars for local dev.
- Security: create a **dedicated CF Access service token for the bot** (separate from
  the personal one used by Claude Code) so it can be revoked independently.
- Prerequisite (server-side, user-owned): the tunnel ingress route for
  `repowise-mcp.thunderducky.com` must point at the running `repowise mcp` process —
  as of 2026-06-12 the hostname returns 421 (missing ingress rule), which must be
  fixed before the feature can work end-to-end.

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

- Fixing the Cloudflare Tunnel ingress for `repowise-mcp.thunderducky.com` — server-side prerequisite owned by the user, not part of this codebase.
- OpenAI Responses API native MCP integration — possible later upgrade once the MCP
  endpoint is public.
- Showing pointers in Discord, re-running search after issue creation, index
  management (repowise owns freshness via its own sync/webhooks).
