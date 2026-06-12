# Codebase-Aware Issue Enrichment — Design

**Date:** 2026-06-12
**Status:** Approved pending user spec review

## Problem

When a player files an idea or bug, the bot enriches it with AI and creates a GitHub
issue — but:

1. The issue says nothing about *where in the game's code* a developer should start;
   devs rediscover the relevant systems every time.
2. The clarifying questions the bot asks players are generic and rigid — the bug
   prompt hard-codes "focus questions on reproduction: steps, frequency, conditions,"
   so players get nagged for exact steps even when that adds nothing.
3. The bug issue template drops information: Q&A clarifications and the player's
   original text never reach GitHub, and the layout isn't triage-friendly.
4. Submissions get silently lost: if the player doesn't answer the questions or never
   clicks Approve, the draft expires after 10 minutes and nothing is filed.

## Goal

When an idea or bug is submitted, the bot searches the game's codebases (multi-repo
workspace indexed by repowise) and uses what it finds to:

- ask **smarter, code-informed clarifying questions** (about player intent and
  conditions the code can't reveal — not exact repro steps), and
- file a **richer GitHub issue** with a "Where to Start" section (repo/file/symbol
  pointers), a suspected-cause hypothesis for bugs, and a revamped triage-friendly
  template.

## Decisions Made

| Decision | Choice | Why |
|---|---|---|
| Search backend | **repowise** (running on the user's server, indexing the multi-repo workspace) | Index already exists and is maintained; semantic + FTS + dependency graph; avoids running a duplicate codebase-memory-mcp index |
| Integration style | **MCP client** — bot connects to repowise's hosted MCP endpoint via `@modelcontextprotocol/sdk` | Tool names/schemas come from repowise itself (no drift); dogfoods the user's hosted-MCP setup |
| AI strategy | **Bounded tool loop** — OpenAI chat-completions function calling, max 5 tool calls | Model can refine searches based on results; capped cost/latency |
| When it runs | **At submission**, before clarifying questions are generated | Questions can reference code findings (e.g. "in-system or jump-gate warp?"); pointers cached in the pending draft and reused at approval — no second search. Cost: every submission pays ~3–5 s + small AI cost, accepted for community-bot volume |
| Output location | **GitHub issue body only** | Devs see it where they work; Discord embeds stay clean, no code structure leaked to players |
| Scope | **Both ideas and bugs** | Same service powers both enrichment paths |
| Bug template | **Full revamp** (triage-focused) | Pointers + suspected cause up top; flexible repro section; adds the currently-missing Q&A and original player text |
| Abandoned drafts | **Auto-post on TTL expiry, both phases** | If the player ignores the questions or never clicks Approve, the issue is filed after 10 min with whatever info exists; unanswered questions are listed in the issue. No submission is silently lost |
| Bot hosting | **Stay on Railway** | repowise's MCP endpoint is exposed via Cloudflare Tunnel + Cloudflare Access (`https://repowise-mcp.thunderducky.com`); the bot authenticates with its own CF Access service token |
| Auth | **CF Access service token only** — no `REPOWISE_API_KEY` | Cloudflare Access is the auth layer; repowise-level API key is not used |

## Architecture

```
/idea or /bug submitted
    ↓
★ findCodePointers(rawText, kind)      NEW: bounded OpenAI tool loop; tools bridged
    ↓                                  from repowise MCP. Returns pointers +
    ↓                                  suspected cause + affected systems (or null)
enrichIdea() / enrichBug()             CHANGED: receives code context; generates
    ↓                                  code-informed questions, no exact-steps nagging
openQuestions? → modal Q&A → re-enrich (unchanged mechanics; code context reused)
    ↓
Awaiting approval (pointers cached on the pending draft)
    ↓
User clicks Approve
    ↓
createIdeaIssue() / createBugIssue()   issue body built from enriched + code context
```

### New module: `src/repowiseMcp.ts`

MCP client wrapper around repowise's hosted MCP server.

- Env: `REPOWISE_MCP_URL` (e.g. `https://repowise-mcp.thunderducky.com/sse`),
  `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` (Cloudflare Access service-token
  headers, sent on every request). **If `REPOWISE_MCP_URL` is unset, the feature is
  disabled and the bot behaves exactly as today.**
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

`findCodePointers(rawText: string, kind: "idea" | "bug"): Promise<CodeContext | null>`

- Builds a chat-completions conversation: system prompt describing the game's
  architecture (reuse the preface style from `ai.ts`) + instructions to locate
  relevant code; user message contains the raw player text.
- Runs a function-calling loop with the bridged repowise tools.
  Hard caps: **5 tool calls**, **15 s total wall-clock budget**.
- Final response must be JSON:
  ```json
  {
    "whereToStart": [
      { "repo": "game-server", "path": "src/fleet/warp.ts", "symbol": "beginWarp", "reason": "..." }
    ],
    "suspectedCause": "hypothesis based on code + report (bugs; null for ideas)",
    "affectedSystems": ["Server", "Fleet", "Client-UI"],
    "confidence": "high" | "medium" | "low"
  }
  ```
  Max 6 pointers. Malformed JSON → one retry, then give up (return `null`).
- Any failure (repowise down, timeout, OpenAI error) → log a warning, return `null`;
  enrichment proceeds without code context. **A filed issue without pointers always
  beats a failed filing.**

### Changed: question generation (`src/ai.ts`, `src/aiBug.ts`)

- Both first-pass prompts gain a `<codeContext>` block (the `CodeContext` JSON, when
  available) so the model knows what the code already reveals.
- New question-quality instructions replacing the "focus on reproduction
  steps" rule:
  - Ask only what **neither the report nor the code** can answer: player intent,
    in-game conditions (ship class, fleet size, location type, economy state),
    expected outcomes.
  - Never ask for exact reproduction steps when the code context already narrows the
    area; ask discriminating questions instead (e.g. "did this happen during
    jump-gate warp or in-system warp?").
  - Questions must be phrased in player terms (game concepts), never code terms
    (no file names, function names, or jargon).
  - Still capped at 2–3 questions; ask none if the report + code context suffice.
- `enrichIdea()` / `enrichBug()` signatures gain an optional `codeContext` parameter.

### Changed: pending drafts (`src/pending.ts`)

- `PendingIdea` gains `codeContext?: CodeContext` so the submission-time search
  result survives the Q&A round-trip and is reused at approval (no second search),
  plus the Discord channel/thread reference needed for expiry notifications.
- **Auto-post on expiry:** the TTL cleanup loop no longer silently deletes. `pending.ts`
  accepts an `onExpire(draft)` callback (registered by `bot.ts` at startup, keeping
  `pending.ts` free of Discord/GitHub imports). On expiry of a draft in either phase
  (`awaiting_answers` or `awaiting_approval`):
  1. The issue is created from the draft's current title/body — the same path the
     Approve button uses, including the vote embed and reaction→GitHub vote syncing.
  2. Unanswered `openQuestions` are appended to the issue under
     **"Open Questions (unanswered)"** so devs know what's unknown.
  3. The bot posts in the Discord thread that the issue was filed automatically with
     the available info, with the issue link.
  4. Failures in auto-post are warn-logged; the draft is dropped only after a
     successful filing or a failed retry (one retry).

### Changed: issue templates

**Bug template (full revamp, `toBugIssueBody`):**

```markdown
## Summary
{1–2 sentence description}

## Where to Start
_(AI-generated from code index, confidence: medium)_
- `game-server` — `src/fleet/warp.ts` → `beginWarp()`: handles warp state transitions
- `SpaceMMORPG` — `Assets/Scripts/Fleet/WarpController.cs`: client-side warp VFX/state

**Suspected cause:** {AI hypothesis based on code + report}

## Affected Systems
`Server` `Fleet` `Client-UI`

## Reproduction
**Conditions:** {when/where it happens — narrative, not forced steps}
**Steps (if known):**
1. ...
**Frequency:** sometimes

## Expected vs Actual
**Expected:** {what should happen}
**Actual:** {what happens}

## Player Clarifications
Q: Was this in-system or jump-gate warp?
A: jump gate

---
**Original Report**
> {raw player text}

*Reported via Discord by {user}*
```

Sections with no content are omitted (no "Not specified" noise). "Where to
Start"/"Suspected cause"/"Affected Systems" appear only when code context exists.

**Idea template (`toIssueBody`):** keeps its current rich structure; gains the same
"Where to Start" section (with the AI-generated footnote) after the Scope block.

## Deployment (bot stays on Railway)

- No Dockerfile or migration. The bot keeps running on Railway and reaches repowise
  over the internet through Cloudflare Tunnel + Cloudflare Access.
- New Railway env vars: `REPOWISE_MCP_URL`, `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET`.
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
| `REPOWISE_MCP_URL` unset | Feature off; questions use the improved prompts without code context; no Where to Start section |
| repowise unreachable / MCP error | Warn-log; enrichment proceeds without code context |
| Loop exceeds 15 s or 5 tool calls | Force final answer with what it has; if none, no code context |
| Malformed final JSON | One retry, then no code context |
| OpenAI error in tool loop | Warn-log; enrichment proceeds without code context |

Submission latency note: the tool loop adds ~3–5 s before the first Discord reply;
the existing flows already defer/edit replies, so no interaction-timeout risk.

## Testing

The repo has no test infrastructure today. Add **vitest** scoped to the changed
modules:

- `repowiseMcp` — MCP→OpenAI tool-schema mapping, allowlist filtering, CF Access
  headers (mocked transport).
- `aiCodeContext` — loop termination (call cap, time budget), output parsing
  (mocked OpenAI + mocked tool layer).
- Issue body formatters — bug template rendering with/without code context, section
  omission, idea template Where to Start insertion.

Manual end-to-end validation: `npm run try:codesearch -- "fleet gets stuck warping"`
runs the real loop against the live repowise instance and prints the code context —
used to tune the system prompt and tool subset before wiring into Discord.

## Out of Scope

- Showing pointers in Discord, re-running search after issue creation, index
  management (repowise owns freshness via its own sync/webhooks).
- OpenAI Responses API native MCP integration — possible later upgrade.
- Fixing the Cloudflare Tunnel ingress for `repowise-mcp.thunderducky.com` —
  server-side prerequisite owned by the user, not part of this codebase.
