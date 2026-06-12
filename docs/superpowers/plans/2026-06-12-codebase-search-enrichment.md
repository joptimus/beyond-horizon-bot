# Codebase-Aware Issue Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a player submits an idea or bug, search the game's codebases via repowise (hosted MCP) and use the findings to ask smarter clarifying questions and file a richer GitHub issue with a "Where to Start" section — while never silently dropping abandoned drafts.

**Architecture:** A new MCP client (`repowiseMcp.ts`) bridges repowise's hosted tools into OpenAI function definitions. A bounded tool loop (`aiCodeContext.ts`) calls those tools to produce a `CodeContext` (where-to-start pointers + suspected cause + affected systems). Enrichment prompts and issue-body formatters consume `CodeContext`. Pending drafts carry the `CodeContext` and Discord channel refs, and the TTL-expiry path auto-files the issue instead of deleting. Every external dependency degrades gracefully to today's behavior on failure or when unconfigured.

**Tech Stack:** TypeScript (NodeNext ESM), discord.js v14, OpenAI SDK (chat-completions function calling), `@modelcontextprotocol/sdk` (MCP client), Octokit, vitest (new).

**Source spec:** `docs/superpowers/specs/2026-06-12-codebase-search-enrichment-design.md`

---

## Important deviations from the spec (read first)

1. **Tool allowlist.** The spec lists `list_repos` in the allowlist, but the connected repowise server does **not** expose it. The allowlist is therefore the spec's intent (`search_codebase`, `get_symbol`, `get_context`) plus `get_overview` (repo orientation, the closest available substitute for `list_repos`). The allowlist is **intersected** with whatever `tools/list` returns, so any missing tool is silently ignored — no hard dependency on exact tool names.

2. **`CodeContext` type lives in its own module** (`src/codeContextTypes.ts`) so `ai.ts`, `aiBug.ts`, `pending.ts`, and `aiCodeContext.ts` can all import it without circular dependencies.

3. **Auto-post on expiry requires extracting the issue-posting logic** currently inlined in `bot.ts`'s approve handlers into reusable `postIdeaFromPending` / `postBugFromPending` functions, so both the Approve button and the expiry callback use one path.

4. **`findCodePointers` takes injectable dependencies** (OpenAI completion fn, tool layer, clock) so it is unit-testable without network access.

---

## File Structure

**New files:**
- `src/codeContextTypes.ts` — the `CodeContext` / `CodePointer` types + a render helper used by both formatters. One responsibility: the shared shape.
- `src/repowiseMcp.ts` — MCP client wrapper: connect lazily, list+filter tools, map MCP→OpenAI schemas, proxy `callTool`. One responsibility: the repowise transport bridge.
- `src/aiCodeContext.ts` — `findCodePointers()`: the bounded OpenAI tool loop. One responsibility: turn raw text into a `CodeContext` (or null).
- `scripts/tryCodeSearch.ts` — manual E2E harness (`npm run try:codesearch`).
- `vitest.config.ts` — test config.
- Test files: `test/repowiseMcp.test.ts`, `test/aiCodeContext.test.ts`, `test/issueBodies.test.ts`, `test/pendingExpiry.test.ts`.

**Modified files:**
- `src/ai.ts` — `enrichIdea` gains optional `codeContext`; first/second-pass prompts gain a `<codeContext>` block + new question rules; `toIssueBody` gains a "Where to Start" section.
- `src/aiBug.ts` — `enrichBug` gains optional `codeContext`; prompts revamped (drop "focus on reproduction steps"); `toBugIssueBody` full revamp (where-to-start, suspected cause, affected systems, Q&A, original text, section omission).
- `src/pending.ts` — `PendingIdea` gains `codeContext?` + channel refs already used; add `onExpire` callback + auto-post-on-TTL loop.
- `src/bot.ts` — call `findCodePointers` at submission (both prefix flows); thread `codeContext` into pending + formatters; extract `postIdeaFromPending`/`postBugFromPending`; register `setOnExpire`.
- `src/commands/idea.ts`, `src/commands/bug.ts` — call `findCodePointers` at submission; store `codeContext` on pending; pass to formatters.
- `.env.example` — add `REPOWISE_MCP_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `OPENAI_MODEL`.
- `package.json` — add deps + `test` / `try:codesearch` scripts.

---

## Task 1: Test & dependency scaffolding

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Install runtime + dev dependencies**

Run:
```bash
npm install @modelcontextprotocol/sdk
npm install -D vitest
```
Expected: both install with no error; `package.json` gains `@modelcontextprotocol/sdk` under dependencies and `vitest` under devDependencies.

- [ ] **Step 2: Add scripts to `package.json`**

In the `"scripts"` block, add `test` and `try:codesearch` (keep existing scripts):
```json
  "scripts": {
    "dev": "tsx src/bot.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/bot.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "try:codesearch": "tsx scripts/tryCodeSearch.ts"
  },
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `test/smoke.test.ts` (proves the harness runs)**

```ts
import { describe, it, expect } from "vitest";

describe("vitest harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — 1 passed (`test/smoke.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/smoke.test.ts
git commit -m "chore: add vitest + MCP SDK scaffolding"
```

---

## Task 2: Shared `CodeContext` types + render helper

**Files:**
- Create: `src/codeContextTypes.ts`
- Test: `test/issueBodies.test.ts` (created here, extended in Task 6)

- [ ] **Step 1: Write the failing test**

Create `test/issueBodies.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderWhereToStart, type CodeContext } from "../src/codeContextTypes.js";

const ctx: CodeContext = {
  whereToStart: [
    { repo: "game-server", path: "src/fleet/warp.ts", symbol: "beginWarp", reason: "handles warp state transitions" },
    { repo: "SpaceMMORPG", path: "Assets/Scripts/Fleet/WarpController.cs", reason: "client-side warp VFX/state" },
  ],
  suspectedCause: "warp state never clears on jump-gate path",
  affectedSystems: ["Server", "Fleet", "Client-UI"],
  confidence: "medium",
};

describe("renderWhereToStart", () => {
  it("renders repo/path/symbol/reason lines with a confidence footnote", () => {
    const md = renderWhereToStart(ctx);
    expect(md).toContain("_(AI-generated from code index, confidence: medium)_");
    expect(md).toContain("`game-server` — `src/fleet/warp.ts` → `beginWarp()`: handles warp state transitions");
    expect(md).toContain("`SpaceMMORPG` — `Assets/Scripts/Fleet/WarpController.cs`: client-side warp VFX/state");
  });

  it("returns empty string when there are no pointers", () => {
    expect(renderWhereToStart({ whereToStart: [], affectedSystems: [], confidence: "low" })).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- issueBodies`
Expected: FAIL — cannot resolve `../src/codeContextTypes.js`.

- [ ] **Step 3: Create `src/codeContextTypes.ts`**

```ts
// src/codeContextTypes.ts
// Shared shape for code-search results. Lives alone so ai.ts, aiBug.ts,
// pending.ts, and aiCodeContext.ts can all import it without circular deps.

export type CodePointer = {
  repo: string;
  path: string;
  symbol?: string;
  reason: string;
};

export type CodeContext = {
  whereToStart: CodePointer[];
  suspectedCause?: string | null;
  affectedSystems: string[];
  confidence: "high" | "medium" | "low";
};

/**
 * Render the "Where to Start" markdown block (pointer list + confidence
 * footnote). Returns "" when there are no pointers, so callers can omit the
 * whole section. Does NOT include the `## Where to Start` heading — callers add it.
 */
export function renderWhereToStart(ctx: CodeContext | null | undefined): string {
  if (!ctx || !ctx.whereToStart?.length) return "";
  const lines = ctx.whereToStart.map((p) => {
    const symbol = p.symbol ? ` → \`${p.symbol}()\`` : "";
    return `- \`${p.repo}\` — \`${p.path}\`${symbol}: ${p.reason}`;
  });
  return `_(AI-generated from code index, confidence: ${ctx.confidence})_\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- issueBodies`
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/codeContextTypes.ts test/issueBodies.test.ts
git commit -m "feat: add shared CodeContext type and where-to-start renderer"
```

---

## Task 3: repowise MCP client wrapper

**Files:**
- Create: `src/repowiseMcp.ts`
- Test: `test/repowiseMcp.test.ts`

This task implements three pure, unit-testable pieces (`buildAuthHeaders`, `mapMcpToolToOpenAi`, `filterAllowed`) plus the connect/list/call plumbing. Tests cover only the pure pieces (the SDK transport is not exercised in unit tests).

- [ ] **Step 1: Write the failing test**

Create `test/repowiseMcp.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  buildAuthHeaders,
  mapMcpToolToOpenAi,
  filterAllowed,
  ALLOWED_TOOLS,
} from "../src/repowiseMcp.js";

describe("buildAuthHeaders", () => {
  it("sets CF Access service-token headers when both are present", () => {
    const h = buildAuthHeaders({ CF_ACCESS_CLIENT_ID: "id-123", CF_ACCESS_CLIENT_SECRET: "secret-xyz" });
    expect(h["CF-Access-Client-Id"]).toBe("id-123");
    expect(h["CF-Access-Client-Secret"]).toBe("secret-xyz");
  });

  it("returns an empty object when credentials are missing", () => {
    expect(buildAuthHeaders({})).toEqual({});
  });
});

describe("mapMcpToolToOpenAi", () => {
  it("maps an MCP tool to an OpenAI function definition", () => {
    const mcpTool = {
      name: "search_codebase",
      description: "semantic + FTS search",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const fn = mapMcpToolToOpenAi(mcpTool);
    expect(fn.type).toBe("function");
    expect(fn.function.name).toBe("search_codebase");
    expect(fn.function.description).toBe("semantic + FTS search");
    expect(fn.function.parameters).toEqual(mcpTool.inputSchema);
  });

  it("substitutes an empty-object schema when inputSchema is absent", () => {
    const fn = mapMcpToolToOpenAi({ name: "x", description: "d" } as any);
    expect(fn.function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("filterAllowed", () => {
  it("keeps only allowlisted tools and ignores unknown ones", () => {
    const tools = [
      { name: "search_codebase" },
      { name: "get_symbol" },
      { name: "get_health" }, // not allowlisted
      { name: "list_repos" }, // allowlisted-by-spec but not served here -> simply absent
    ] as any[];
    const kept = filterAllowed(tools, ALLOWED_TOOLS).map((t) => t.name);
    expect(kept).toContain("search_codebase");
    expect(kept).toContain("get_symbol");
    expect(kept).not.toContain("get_health");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- repowiseMcp`
Expected: FAIL — cannot resolve `../src/repowiseMcp.js`.

- [ ] **Step 3: Create `src/repowiseMcp.ts`**

```ts
// src/repowiseMcp.ts
// Thin MCP client over repowise's hosted server. Connects lazily on first use,
// lists tools, filters to an allowlist, and bridges MCP tool schemas into
// OpenAI function definitions. If REPOWISE_MCP_URL is unset, the feature is
// disabled and every accessor returns an empty/no-op result.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Intersected with whatever tools/list actually returns. `list_repos` (in the
// design) is not served by the current repowise; `get_overview` is the closest
// available repo-orientation tool, so it stands in.
export const ALLOWED_TOOLS = ["search_codebase", "get_symbol", "get_context", "get_overview"] as const;

export type OpenAiToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

export function buildAuthHeaders(env: {
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}): Record<string, string> {
  const { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = env;
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) return {};
  return {
    "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
  };
}

export function mapMcpToolToOpenAi(tool: McpTool): OpenAiToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: (tool.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
    },
  };
}

export function filterAllowed(tools: McpTool[], allow: readonly string[]): McpTool[] {
  const set = new Set(allow);
  return tools.filter((t) => set.has(t.name));
}

export function isRepowiseEnabled(): boolean {
  return Boolean(process.env.REPOWISE_MCP_URL);
}

// ---- Lazy connection ----
let clientPromise: Promise<Client> | null = null;
let cachedTools: McpTool[] | null = null;

function makeTransport() {
  const url = new URL(process.env.REPOWISE_MCP_URL as string);
  const headers = buildAuthHeaders(process.env);
  const requestInit = { headers };
  if (url.pathname.endsWith("/sse")) {
    return new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: undefined } as any });
  }
  return new StreamableHTTPClientTransport(url, { requestInit });
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "beyond-horizon-bot", version: "0.1.0" }, { capabilities: {} });
      await client.connect(makeTransport());
      return client;
    })();
  }
  return clientPromise;
}

/** Reset connection state so the next call reconnects (used after a dropped session). */
function resetConnection() {
  clientPromise = null;
  cachedTools = null;
}

async function listAllowedTools(): Promise<McpTool[]> {
  if (cachedTools) return cachedTools;
  const client = await getClient();
  const res = await client.listTools();
  cachedTools = filterAllowed((res.tools as McpTool[]) || [], ALLOWED_TOOLS);
  return cachedTools;
}

/** OpenAI function definitions for the allowlisted repowise tools, or [] if disabled/unreachable. */
export async function getOpenAiTools(): Promise<OpenAiToolDef[]> {
  if (!isRepowiseEnabled()) return [];
  try {
    const tools = await listAllowedTools();
    return tools.map(mapMcpToolToOpenAi);
  } catch (err) {
    console.warn("[repowise] getOpenAiTools failed:", err);
    resetConnection();
    return [];
  }
}

/** Call a repowise tool and return its text content (joined). Throws on failure. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getClient();
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const content = (res?.content || []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } catch (err) {
    resetConnection(); // drop a stale session so the next call reconnects
    throw err;
  }
}
```

> Note on SDK import paths: if `npm test`/`build` reports an unresolved subpath for `sse.js` or `streamableHttp.js`, run `node -e "console.log(require.resolve('@modelcontextprotocol/sdk/package.json'))"` and inspect the installed `dist/esm/client/` directory to confirm the exact filenames, then adjust the three `import` paths. The class names (`Client`, `SSEClientTransport`, `StreamableHTTPClientTransport`) are stable.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- repowiseMcp`
Expected: PASS — all `buildAuthHeaders` / `mapMcpToolToOpenAi` / `filterAllowed` tests pass.

- [ ] **Step 5: Typecheck the new module**

Run: `npm run build`
Expected: no TypeScript errors. (If SDK subpath imports fail to resolve, fix per the note above before continuing.)

- [ ] **Step 6: Commit**

```bash
git add src/repowiseMcp.ts test/repowiseMcp.test.ts
git commit -m "feat: add repowise MCP client wrapper with tool allowlist"
```

---

## Task 4: `findCodePointers` bounded tool loop

**Files:**
- Create: `src/aiCodeContext.ts`
- Test: `test/aiCodeContext.test.ts`

`findCodePointers` accepts an optional `deps` object so tests run without network. Hard caps: 5 tool calls, 15 s wall-clock. Any failure → `null`.

- [ ] **Step 1: Write the failing test**

Create `test/aiCodeContext.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { findCodePointers, type FindDeps } from "../src/aiCodeContext.js";

// Helper: a fake OpenAI completion that returns a scripted sequence of messages.
function scriptedCompletions(messages: any[]) {
  const queue = [...messages];
  return vi.fn(async () => ({ choices: [{ message: queue.shift() }] }));
}

const baseDeps = (over: Partial<FindDeps>): FindDeps => ({
  getTools: async () => [
    { type: "function", function: { name: "search_codebase", description: "d", parameters: { type: "object", properties: {} } } },
  ],
  callTool: async () => "search result text",
  createCompletion: scriptedCompletions([]),
  now: (() => { let t = 0; return () => (t += 1000); })(), // +1s per call
  enabled: true,
  ...over,
});

const FINAL_JSON = JSON.stringify({
  whereToStart: [{ repo: "game-server", path: "src/fleet/warp.ts", symbol: "beginWarp", reason: "warp transitions" }],
  suspectedCause: "state not cleared",
  affectedSystems: ["Server", "Fleet"],
  confidence: "medium",
});

describe("findCodePointers", () => {
  it("returns null immediately when the feature is disabled", async () => {
    const deps = baseDeps({ enabled: false });
    expect(await findCodePointers("fleet stuck warping", "bug", deps)).toBeNull();
  });

  it("runs one tool call then parses the final JSON answer", async () => {
    const createCompletion = scriptedCompletions([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_codebase", arguments: '{"query":"warp"}' } }] },
      { role: "assistant", content: FINAL_JSON },
    ]);
    const callTool = vi.fn(async () => "warp.ts matches");
    const deps = baseDeps({ createCompletion, callTool });

    const ctx = await findCodePointers("fleet stuck warping", "bug", deps);
    expect(callTool).toHaveBeenCalledOnce();
    expect(ctx?.whereToStart[0].symbol).toBe("beginWarp");
    expect(ctx?.suspectedCause).toBe("state not cleared");
  });

  it("stops after the tool-call cap and forces a final answer", async () => {
    // 6 tool-call rounds scripted, but cap is 5; the 6th would never be reached.
    const toolMsg = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "search_codebase", arguments: "{}" } }] };
    const createCompletion = scriptedCompletions([toolMsg, toolMsg, toolMsg, toolMsg, toolMsg, { role: "assistant", content: FINAL_JSON }]);
    const callTool = vi.fn(async () => "x");
    const deps = baseDeps({ createCompletion, callTool });

    const ctx = await findCodePointers("warp", "bug", deps);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(5);
    // Either it forced a final answer (ctx set) or gave up (null) — never throws.
    expect(ctx === null || ctx.confidence === "medium").toBe(true);
  });

  it("returns null on malformed JSON after one retry", async () => {
    const createCompletion = scriptedCompletions([
      { role: "assistant", content: "not json" },
      { role: "assistant", content: "still not json" },
    ]);
    const deps = baseDeps({ createCompletion });
    expect(await findCodePointers("warp", "idea", deps)).toBeNull();
  });

  it("returns null and never throws when createCompletion rejects", async () => {
    const deps = baseDeps({ createCompletion: vi.fn(async () => { throw new Error("openai down"); }) });
    expect(await findCodePointers("warp", "bug", deps)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- aiCodeContext`
Expected: FAIL — cannot resolve `../src/aiCodeContext.js`.

- [ ] **Step 3: Create `src/aiCodeContext.ts`**

```ts
// src/aiCodeContext.ts
// Bounded OpenAI function-calling loop that uses repowise tools to locate the
// code relevant to a player's idea/bug. Returns a CodeContext or null. Never
// throws: any failure (disabled, unreachable, timeout, bad JSON) -> null, and
// enrichment proceeds without code context.

import OpenAI from "openai";
import type { CodeContext } from "./codeContextTypes.js";
import { getOpenAiTools, callTool, isRepowiseEnabled, type OpenAiToolDef } from "./repowiseMcp.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TOOL_CALLS = 5;
const TIME_BUDGET_MS = 15_000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Injectable dependencies so the loop is unit-testable without network access.
export type FindDeps = {
  getTools: () => Promise<OpenAiToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  createCompletion: (params: any) => Promise<{ choices: Array<{ message: any }> }>;
  now: () => number;
  enabled: boolean;
};

let defaultClient: OpenAI | null = null;
function getDefaultDeps(): FindDeps {
  if (!defaultClient) defaultClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return {
    getTools: getOpenAiTools,
    callTool,
    createCompletion: (params) => defaultClient!.chat.completions.create(params) as any,
    now: () => Date.now(),
    enabled: isRepowiseEnabled(),
  };
}

const SYSTEM_PROMPT = `
You are a senior engineer on a persistent, space-based MMO/RTS.
Client: Unity (UI, rendering, input, game logic). Server: Node/TS (REST/WS, jobs, economy, state). Data: Postgres/Redis.
The code is spread across multiple repositories indexed by a search service exposed as tools.
Your job: given a player's idea or bug report, locate the most relevant code and produce a concise pointer list a developer can start from.
Use the tools to search; refine queries based on results. Be efficient — a few targeted searches, not exhaustive crawling.
When done, STOP calling tools and reply with ONLY a JSON object of this exact shape (no prose, no code fences):
{
  "whereToStart": [ { "repo": "...", "path": "...", "symbol": "optional", "reason": "why a dev starts here" } ],
  "suspectedCause": "hypothesis for bugs based on code + report; null for ideas",
  "affectedSystems": ["Server","Fleet","Client-UI"],
  "confidence": "high" | "medium" | "low"
}
Rules: at most 6 pointers; omit "symbol" if not applicable; if you found nothing useful, return whereToStart: [] with confidence "low".
`;

function parseFinal(content: string): CodeContext | null {
  const cleaned = content.replace(/```(?:json)?\s*|```/gi, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj || !Array.isArray(obj.whereToStart)) return null;
    return {
      whereToStart: obj.whereToStart.slice(0, 6).map((p: any) => ({
        repo: String(p.repo || ""),
        path: String(p.path || ""),
        symbol: p.symbol ? String(p.symbol) : undefined,
        reason: String(p.reason || ""),
      })),
      suspectedCause: obj.suspectedCause ? String(obj.suspectedCause) : null,
      affectedSystems: Array.isArray(obj.affectedSystems) ? obj.affectedSystems.map(String) : [],
      confidence: ["high", "medium", "low"].includes(obj.confidence) ? obj.confidence : "low",
    };
  } catch {
    return null;
  }
}

export async function findCodePointers(
  rawText: string,
  kind: "idea" | "bug",
  injected?: FindDeps
): Promise<CodeContext | null> {
  const deps = injected || getDefaultDeps();
  if (!deps.enabled) return null;

  try {
    const tools = await deps.getTools();
    if (!tools.length) return null; // nothing to search with

    const start = deps.now();
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Kind: ${kind}\nPlayer report:\n"""${rawText}"""` },
    ];

    let toolCalls = 0;
    let forceFinal = false;

    while (true) {
      const outOfTime = deps.now() - start > TIME_BUDGET_MS;
      const outOfCalls = toolCalls >= MAX_TOOL_CALLS;
      forceFinal = forceFinal || outOfTime || outOfCalls;

      const res = await deps.createCompletion({
        model: MODEL,
        temperature: 0.1,
        messages,
        // Withholding tools forces the model to answer with prose/JSON.
        tools: forceFinal ? undefined : tools,
        tool_choice: forceFinal ? undefined : "auto",
      });

      const msg = res.choices[0]?.message;
      if (!msg) return null;

      const calls = msg.tool_calls || [];
      if (!forceFinal && calls.length) {
        messages.push(msg);
        for (const call of calls) {
          toolCalls++;
          let toolText = "";
          try {
            const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
            toolText = await deps.callTool(call.function.name, args);
          } catch (err) {
            toolText = `tool error: ${(err as Error).message}`;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: toolText || "(no result)" });
        }
        continue; // let the model react to tool output
      }

      // Final answer expected here.
      const parsed = parseFinal(msg.content || "");
      if (parsed) return parsed;

      // One retry: nudge for valid JSON, force final.
      messages.push(msg as ChatMessage);
      messages.push({ role: "user", content: "Your previous reply was not valid JSON. Reply with ONLY the JSON object described, nothing else." });
      const retry = await deps.createCompletion({ model: MODEL, temperature: 0, messages });
      return parseFinal(retry.choices[0]?.message?.content || "");
    }
  } catch (err) {
    console.warn("[aiCodeContext] findCodePointers failed:", err);
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- aiCodeContext`
Expected: PASS — all 5 cases pass.

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/aiCodeContext.ts test/aiCodeContext.test.ts
git commit -m "feat: add findCodePointers bounded tool loop"
```

---

## Task 5: Manual E2E harness

**Files:**
- Create: `scripts/tryCodeSearch.ts`

- [ ] **Step 1: Create `scripts/tryCodeSearch.ts`**

```ts
// scripts/tryCodeSearch.ts
// Manual end-to-end check against the live repowise instance.
// Usage: npm run try:codesearch -- "fleet gets stuck warping"
import "dotenv/config";
import { findCodePointers } from "../src/aiCodeContext.js";

async function main() {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    console.error('Usage: npm run try:codesearch -- "your idea or bug text"');
    process.exit(1);
  }
  if (!process.env.REPOWISE_MCP_URL) {
    console.warn("REPOWISE_MCP_URL is not set — feature is disabled, result will be null.");
  }
  console.log(`Searching for: ${text}\n`);
  const ctx = await findCodePointers(text, "bug");
  console.log(JSON.stringify(ctx, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it runs (feature-disabled path, no network needed)**

Run: `npm run try:codesearch -- "fleet gets stuck warping"`
Expected: prints the warning about `REPOWISE_MCP_URL` (assuming unset locally) and `null`. No crash. (With env configured + repowise reachable, it prints a populated `CodeContext`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/tryCodeSearch.ts
git commit -m "chore: add manual code-search E2E harness"
```

---

## Task 6: Issue-body formatters (idea + bug)

**Files:**
- Modify: `src/ai.ts` (`toIssueBody`)
- Modify: `src/aiBug.ts` (`toBugIssueBody` full revamp + `EnrichedBug` unchanged shape)
- Test: `test/issueBodies.test.ts` (extend from Task 2)

- [ ] **Step 1: Extend the failing test**

Append to `test/issueBodies.test.ts`:
```ts
import { toIssueBody, type Enriched } from "../src/ai.js";
import { toBugIssueBody, type EnrichedBug } from "../src/aiBug.js";

const idea: Enriched = {
  title: "Fleet warp queue",
  summary: "Let players queue warp jumps.",
  gameplayImpact: "Smoother fleet movement.",
  scope: { client: ["Add queue UI"], server: ["POST /warp/queue"], database: ["No changes"] },
  implementationNotes: ["note"], risks: ["risk"], telemetry: [], antiCheat: [], dependencies: [],
  openQuestions: [], tags: ["Fleet"],
};

describe("toIssueBody (idea)", () => {
  it("inserts Where to Start after Scope when codeContext is present", () => {
    const body = toIssueBody(idea, "user#1", "123", "raw idea", undefined, ctx);
    expect(body).toContain("**Where to Start**");
    expect(body).toContain("`game-server`");
    // Where to Start appears after the Database scope block and before Implementation Notes
    expect(body.indexOf("**Where to Start**")).toBeGreaterThan(body.indexOf("**Database**"));
    expect(body.indexOf("**Where to Start**")).toBeLessThan(body.indexOf("**Implementation Notes**"));
  });

  it("omits Where to Start when no codeContext", () => {
    const body = toIssueBody(idea, "user#1", "123", "raw idea");
    expect(body).not.toContain("**Where to Start**");
  });
});

const bug: EnrichedBug = {
  title: "Warp hangs",
  summary: "Fleet gets stuck warping.",
  stepsToReproduce: ["Start a jump-gate warp"],
  expectedBehavior: "Warp completes.",
  actualBehavior: "Fleet stuck mid-warp.",
  frequency: "sometimes",
  openQuestions: [],
};

describe("toBugIssueBody (revamp)", () => {
  it("renders Where to Start, Suspected cause and Affected Systems when codeContext present", () => {
    const body = toBugIssueBody(bug, "user#1", "raw bug text", "Q: in-system or jump-gate?\nA: jump gate", ctx);
    expect(body).toContain("## Where to Start");
    expect(body).toContain("**Suspected cause:** warp state never clears on jump-gate path");
    expect(body).toContain("## Affected Systems");
    expect(body).toContain("`Server`");
    expect(body).toContain("## Player Clarifications");
    expect(body).toContain("Q: in-system or jump-gate?");
    expect(body).toContain("> raw bug text");
    expect(body).toContain("*Reported via Discord by user#1*");
  });

  it("omits code sections and clarifications when absent (no 'Not specified' noise)", () => {
    const body = toBugIssueBody(bug, "user#1", "raw bug text");
    expect(body).not.toContain("## Where to Start");
    expect(body).not.toContain("Suspected cause");
    expect(body).not.toContain("## Affected Systems");
    expect(body).not.toContain("## Player Clarifications");
    expect(body).toContain("## Summary");
    expect(body).toContain("> raw bug text");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- issueBodies`
Expected: FAIL — `toIssueBody` has wrong arity / no Where to Start; `toBugIssueBody` has wrong arity and old template.

- [ ] **Step 3: Update `toIssueBody` in `src/ai.ts`**

Add the import at the top of `src/ai.ts` (after the OpenAI import):
```ts
import type { CodeContext } from "./codeContextTypes.js";
import { renderWhereToStart } from "./codeContextTypes.js";
```

Replace the `toIssueBody` signature and body (the whole function starting at `export function toIssueBody(`) with:
```ts
export function toIssueBody(
  e: Enriched,
  userTag: string,
  userId: string,
  raw: string,
  qa?: string,
  codeContext?: CodeContext | null
) {
  const scope = [
    `**Client (Unity)**\n${linesOrNone(e.scope?.client)}`,
    `\n**Server (Node)**\n${linesOrNone(e.scope?.server)}`,
    `\n**Database**\n${linesOrNone(e.scope?.database)}`,
  ].join("\n");

  const whereToStart = renderWhereToStart(codeContext);
  const whereBlock = whereToStart ? `\n**Where to Start**\n${whereToStart}\n` : "";

  const tags =
    Array.isArray(e.tags) && e.tags.length
      ? `\n**Tags**\n${e.tags.map((t) => `\`${t}\``).join(" ")}`
      : "";

  return `Submitted by **${userTag}** (Discord ID: ${userId})

**Summary**
${e.summary || "(missing)"}

**Gameplay Impact**
${e.gameplayImpact || "(unspecified)"}

${scope}
${whereBlock}
**Implementation Notes**
${linesOrNone(e.implementationNotes)}

**Risks**
${linesOrNone(e.risks)}

**Telemetry**
${linesOrNone(e.telemetry)}

**Anti-Cheat / Validation**
${linesOrNone(e.antiCheat)}

**Dependencies**
${linesOrNone(e.dependencies)}
${tags}
${qa ? `\n**Player Clarifications**\n${qa}\n` : ""}---

**Original Player Text**
> ${raw}
`;
}
```

- [ ] **Step 4: Replace `toBugIssueBody` in `src/aiBug.ts`**

Add imports at the top of `src/aiBug.ts` (after the OpenAI import):
```ts
import type { CodeContext } from "./codeContextTypes.js";
import { renderWhereToStart } from "./codeContextTypes.js";
```

Replace the entire `toBugIssueBody` function with:
```ts
export function toBugIssueBody(
  bug: EnrichedBug,
  userTag: string,
  raw?: string,
  qa?: string,
  codeContext?: CodeContext | null
): string {
  const parts: string[] = [];

  parts.push(`## Summary\n${bug.summary}`);

  const whereToStart = renderWhereToStart(codeContext);
  if (whereToStart) {
    let where = `## Where to Start\n${whereToStart}`;
    if (codeContext?.suspectedCause) where += `\n\n**Suspected cause:** ${codeContext.suspectedCause}`;
    parts.push(where);
  }

  if (codeContext?.affectedSystems?.length) {
    parts.push(`## Affected Systems\n${codeContext.affectedSystems.map((s) => `\`${s}\``).join(" ")}`);
  }

  // Reproduction — only the sub-parts that have content (no forced "Not specified").
  const repro: string[] = [];
  if (bug.actualBehavior && bug.actualBehavior !== "Not specified") {
    repro.push(`**Conditions:** ${bug.actualBehavior}`);
  }
  if (bug.stepsToReproduce.length) {
    repro.push(`**Steps (if known):**\n${bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }
  if (bug.frequency) repro.push(`**Frequency:** ${bug.frequency}`);
  if (repro.length) parts.push(`## Reproduction\n${repro.join("\n")}`);

  // Expected vs Actual — only when at least one is specified.
  const hasExpected = bug.expectedBehavior && bug.expectedBehavior !== "Not specified";
  const hasActual = bug.actualBehavior && bug.actualBehavior !== "Not specified";
  if (hasExpected || hasActual) {
    parts.push(
      `## Expected vs Actual\n**Expected:** ${hasExpected ? bug.expectedBehavior : "(unspecified)"}\n**Actual:** ${hasActual ? bug.actualBehavior : "(unspecified)"}`
    );
  }

  if (qa && qa.trim()) parts.push(`## Player Clarifications\n${qa.trim()}`);

  let body = parts.join("\n\n");
  if (raw && raw.trim()) body += `\n\n---\n**Original Report**\n> ${raw.trim()}`;
  body += `\n\n*Reported via Discord by ${userTag}*\n`;
  return body;
}
```

> Note: `actualBehavior` is intentionally used for **Conditions** in Reproduction *and* **Actual** in Expected-vs-Actual — this matches the spec's flexible-repro template where the narrative of what happens doubles as the condition description. If a future enriched field for conditions is added, split them then (out of scope now).

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- issueBodies`
Expected: PASS — all idea + bug body tests pass.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: FAIL with errors in `bot.ts`/`commands` — `toBugIssueBody` now called with old 2-arg signature is still type-compatible (extra params optional), so build should actually PASS. If any call site breaks, it is fixed in Tasks 8–9. Confirm errors (if any) are only about the not-yet-updated `enrichIdea`/`enrichBug` code-context param, which is added in Task 7.
Expected here: PASS (all new params are optional).

- [ ] **Step 7: Commit**

```bash
git add src/ai.ts src/aiBug.ts test/issueBodies.test.ts
git commit -m "feat: add Where to Start to issue bodies and revamp bug template"
```

---

## Task 7: Code-informed question generation (`enrichIdea` / `enrichBug`)

**Files:**
- Modify: `src/ai.ts` (prompts + `enrichIdea` signature)
- Modify: `src/aiBug.ts` (prompts + `enrichBug` signature)

No new test file (prompt wording isn't unit-tested); the contract change is the optional `codeContext` param, verified by typecheck + existing call sites. Keep changes minimal and backwards-compatible.

- [ ] **Step 1: Add a shared question-quality rules block + codeContext block to `src/ai.ts`**

In `src/ai.ts`, add this constant after `JSON_SHAPE`:
```ts
const QUESTION_RULES = `
Question quality rules:
- Ask ONLY what neither the report nor the code context can answer: player intent,
  in-game conditions (ship class, fleet size, location type, economy state), expected outcomes.
- Never ask for exact reproduction steps when the code context already narrows the area;
  ask discriminating questions instead (e.g. "in-system or jump-gate warp?").
- Phrase questions in player terms (game concepts) — never code terms (no file names,
  function names, or jargon).
- Cap at 2-3 questions; ask none if the report + code context suffice.
`;

function codeContextBlock(codeContext?: { whereToStart: unknown[]; suspectedCause?: string | null; affectedSystems: string[]; confidence: string } | null): string {
  if (!codeContext || !codeContext.whereToStart?.length) return "";
  return `\n<codeContext>\n${JSON.stringify(codeContext, null, 2)}\n</codeContext>\nUse this to avoid asking what the code already reveals.\n`;
}
```

- [ ] **Step 2: Thread `codeContext` into the prompt builders in `src/ai.ts`**

Change `firstPassPrompt` to accept and embed the code context + rules:
```ts
function firstPassPrompt(raw: string, author: string, codeCtxBlock: string) {
  return `
Given the raw player idea below, produce a concise, developer-ready design note as JSON.
- Fill "scope.client" / "scope.server" with concrete work items (or ["None"]).
- Set "scope.database" to specific changes or ["No changes"].
- Ask at most 2 openQuestions only if helpful; otherwise [].
${codeCtxBlock}
<author>${author}</author>

${JSON_SHAPE}
${QUESTION_RULES}

Raw player idea:
"""${raw}"""
`;
}
```

Change `secondPassPrompt` to also accept and embed it (insert `${codeCtxBlock}` right before the `<author>`-equivalent section and add `${QUESTION_RULES}` after `${JSON_SHAPE}`):
```ts
function secondPassPrompt(raw: string, answers: string, author: string, previousJSON: string, codeCtxBlock: string) {
  return `
Your task is to refine the existing design note based on player clarifications.
Keep **openQuestions** to **at most 2**, and remove any that are now answered.
${codeCtxBlock}
Here is the existing structured design note JSON:
\`\`\`json
${previousJSON}
\`\`\`

Here are the player's clarifications (Q/A):
\`\`\`
${answers}
\`\`\`

Update and improve the design note to reflect the clarifications.

CRITICAL REQUIREMENTS:
- Return ONLY valid JSON
- Keep the same overall structure and fields
- Fill in missing gameplayImpact, scope, implementationNotes, and risks
- Remove any openQuestions that are now answered
- Do NOT add new sections not requested
- Do NOT remove required fields

Return JSON in this shape:

${JSON_SHAPE}
${QUESTION_RULES}

Original raw idea:
"""${raw}"""
Submitted by: ${author}
`;
}
```

- [ ] **Step 3: Update `enrichIdea` signature in `src/ai.ts`**

```ts
export async function enrichIdea(
  rawText: string,
  author: string,
  answersText?: string,
  previous?: Enriched,
  codeContext?: CodeContext | null
): Promise<Enriched> {
  const previousJSON = previous ? JSON.stringify(previous, null, 2) : "{}";
  const codeCtxBlock = codeContextBlock(codeContext);
  const userPrompt = answersText
    ? secondPassPrompt(rawText, answersText, author, previousJSON, codeCtxBlock)
    : firstPassPrompt(rawText, author, codeCtxBlock);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PREFACE },
    { role: "user", content: userPrompt },
  ];

  // Try 1
  let content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err1) {
    console.error("[AI] JSON parse failed (try 1). Raw content:", content);
  }

  // Try 2
  content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err2) {
    console.error("[AI] JSON parse failed (try 2). Raw content:", content);
    return sanitize(previous ?? {}, rawText);
  }
}
```

- [ ] **Step 4: Apply the equivalent changes to `src/aiBug.ts`**

Replace the bug `SYSTEM_PREFACE` and `JSON_SHAPE` rules to drop the "focus on reproduction steps" mandate:
```ts
const SYSTEM_PREFACE = `
You are assisting a small team building a persistent, space-based MMO/RTS in Unity with a Node.js backend.
Your task is to structure player bug reports into a clear, actionable format for developers.
Use any provided code context to focus on what's unknown; do not nag players for exact repro steps the code already localizes.
`;
```

Replace the `Rules:` portion of `JSON_SHAPE` with:
```ts
Rules:
- Ask only what neither the report nor the code context reveals: in-game conditions, player intent, expected outcome.
- Do NOT demand exact reproduction steps when code context narrows the area; prefer discriminating questions.
- Phrase questions in player terms, never code terms (no file/function names).
- Keep openQuestions to at most 3; ask none if the report + code suffice.
- Output only JSON
```

Add after `JSON_SHAPE` the same helper:
```ts
function codeContextBlock(codeContext?: { whereToStart: unknown[]; suspectedCause?: string | null; affectedSystems: string[]; confidence: string } | null): string {
  if (!codeContext || !codeContext.whereToStart?.length) return "";
  return `\n<codeContext>\n${JSON.stringify(codeContext, null, 2)}\n</codeContext>\nUse this to avoid asking what the code already reveals.\n`;
}
```

Thread `codeCtxBlock` through both prompt builders (insert `${codeCtxBlock}` after the intro instructions in each) and update `enrichBug`:
```ts
function firstPassPrompt(raw: string, author: string, codeCtxBlock: string) {
  return `
Given the bug report below, produce a structured bug report as JSON.
- Extract any reproduction steps the player actually mentioned (do not invent).
- Identify expected vs actual behavior (may be implicit).
- Note frequency if mentioned.
${codeCtxBlock}
<author>${author}</author>

${JSON_SHAPE}

Bug report:
"""${raw}"""
`;
}

function secondPassPrompt(raw: string, answers: string, author: string, previousJSON: string, codeCtxBlock: string) {
  return `
Refine the bug report based on player clarifications.
Remove any openQuestions that are now answered.
${codeCtxBlock}
Existing bug report JSON:
\`\`\`json
${previousJSON}
\`\`\`

Player clarifications:
\`\`\`
${answers}
\`\`\`

Update the bug report to reflect the clarifications.
Return JSON in this shape:

${JSON_SHAPE}

Original bug report:
"""${raw}"""
Submitted by: ${author}
`;
}

export async function enrichBug(
  rawText: string,
  author: string,
  answersText?: string,
  previous?: EnrichedBug,
  codeContext?: CodeContext | null
): Promise<EnrichedBug> {
  const previousJSON = previous ? JSON.stringify(previous, null, 2) : "{}";
  const codeCtxBlock = codeContextBlock(codeContext);
  const userPrompt = answersText
    ? secondPassPrompt(rawText, answersText, author, previousJSON, codeCtxBlock)
    : firstPassPrompt(rawText, author, codeCtxBlock);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PREFACE },
    { role: "user", content: userPrompt },
  ];

  // Try 1
  let content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err1) {
    console.error("[AI Bug] JSON parse failed (try 1). Raw content:", content);
  }

  // Try 2
  content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err2) {
    console.error("[AI Bug] JSON parse failed (try 2). Raw content:", content);
    return sanitize(previous ?? {}, rawText);
  }
}
```

- [ ] **Step 5: Typecheck + run full test suite**

Run: `npm run build && npm test`
Expected: build PASSES; all tests PASS. (Call sites in `bot.ts`/`commands` still compile because the new params are optional.)

- [ ] **Step 6: Commit**

```bash
git add src/ai.ts src/aiBug.ts
git commit -m "feat: code-informed clarifying questions in enrichment prompts"
```

---

## Task 8: Pending drafts — `codeContext` field + auto-post on TTL expiry

**Files:**
- Modify: `src/pending.ts`
- Test: `test/pendingExpiry.test.ts`

The expiry loop must call a registered `onExpire(draft)` callback instead of silently deleting, and only drop the draft after the callback resolves (success) or its one retry fails. To keep timing testable, extract the sweep into an exported `sweepExpired(now, onExpire)` pure-ish function and keep the `setInterval` calling it.

- [ ] **Step 1: Write the failing test**

Create `test/pendingExpiry.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { putPending, getPending, delPending, setOnExpire, sweepExpired, type PendingIdea } from "../src/pending.js";

function draft(id: string, createdAt: number): PendingIdea {
  return { type: "idea", id, authorId: "u1", rawText: "raw", title: "[IDEA] t", body: "b", createdAt, phase: "awaiting_approval" };
}

describe("sweepExpired", () => {
  beforeEach(() => {
    // clear any leftovers
    ["a", "b", "c"].forEach(delPending);
    setOnExpire(undefined as any);
  });

  it("does not touch drafts younger than the TTL", async () => {
    putPending(draft("a", 1_000));
    const onExpire = vi.fn(async () => {});
    await sweepExpired(1_000 + 5 * 60_000, onExpire); // 5 min < 10 min TTL
    expect(onExpire).not.toHaveBeenCalled();
    expect(getPending("a")).toBeTruthy();
  });

  it("calls onExpire then deletes an expired draft", async () => {
    putPending(draft("b", 0));
    const onExpire = vi.fn(async () => {});
    setOnExpire(onExpire);
    await sweepExpired(11 * 60_000, onExpire); // 11 min > 10 min TTL
    expect(onExpire).toHaveBeenCalledOnce();
    expect(getPending("b")).toBeUndefined();
  });

  it("retries once and keeps the draft if both attempts fail", async () => {
    putPending(draft("c", 0));
    const onExpire = vi.fn(async () => { throw new Error("github down"); });
    await sweepExpired(11 * 60_000, onExpire);
    expect(onExpire).toHaveBeenCalledTimes(2); // initial + one retry
    expect(getPending("c")).toBeUndefined(); // dropped after failed retry (no infinite growth)
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- pendingExpiry`
Expected: FAIL — `setOnExpire` / `sweepExpired` not exported.

- [ ] **Step 3: Rewrite `src/pending.ts`**

```ts
// src/pending.ts
import type { CodeContext } from "./codeContextTypes.js";

export type PendingIdea = {
  type: 'idea' | 'bug';
  id: string;
  authorId: string;
  rawText: string;
  title: string;     // will be updated after re-enrich
  body: string;      // will be updated after re-enrich
  createdAt: number;
  // Q&A
  openQuestions?: string[];
  answersText?: string; // concatenated "Q1: ...\nA1: ...", etc.
  phase?: "awaiting_answers" | "awaiting_approval";
  // Code search result, cached so the Q&A round-trip and expiry reuse it.
  codeContext?: CodeContext | null;
  // Discord refs (set by bot.ts / commands) — kept loosely typed via index signature.
  [key: string]: unknown;
};

const PENDING = new Map<string, PendingIdea>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function putPending(p: PendingIdea) { PENDING.set(p.id, p); }
export function getPending(id: string) { return PENDING.get(id); }
export function delPending(id: string) { PENDING.delete(id); }

// Callback registered by bot.ts to file the issue when a draft expires.
export type OnExpire = (draft: PendingIdea) => Promise<void>;
let onExpireCb: OnExpire | undefined;
export function setOnExpire(cb: OnExpire | undefined) { onExpireCb = cb; }

/**
 * Sweep expired drafts. For each one past TTL: invoke onExpire (auto-file),
 * retry once on failure, then delete regardless (so the map never grows
 * unbounded). Drafts within TTL are untouched.
 */
export async function sweepExpired(now: number, onExpire?: OnExpire) {
  const cb = onExpire ?? onExpireCb;
  for (const [id, p] of PENDING.entries()) {
    if (now - p.createdAt <= TTL_MS) continue;
    if (cb) {
      try {
        await cb(p);
      } catch (err1) {
        console.warn(`[pending] onExpire failed for ${id}, retrying once:`, err1);
        try {
          await cb(p);
        } catch (err2) {
          console.warn(`[pending] onExpire retry failed for ${id}, dropping draft:`, err2);
        }
      }
    }
    PENDING.delete(id);
  }
}

// Periodic cleanup (no-ops gracefully if no callback registered).
setInterval(() => {
  void sweepExpired(Date.now());
}, 60_000);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- pendingExpiry`
Expected: PASS — 3 passed.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pending.ts test/pendingExpiry.test.ts
git commit -m "feat: auto-post pending drafts on TTL expiry instead of dropping"
```

---

## Task 9: Wire code search + expiry auto-post into `bot.ts`

**Files:**
- Modify: `src/bot.ts`

This task: (a) imports `findCodePointers` + `setOnExpire`; (b) calls `findCodePointers` at submission in the prefix `!idea` / `!bug` flows and stores `codeContext` on the pending draft + passes it to the formatters; (c) extracts the issue-posting logic from the Approve handlers into reusable functions; (d) registers `setOnExpire` to auto-file on expiry with an "Open Questions (unanswered)" appendix and a thread notice.

- [ ] **Step 1: Add imports**

In `src/bot.ts`, update the AI/pending imports:
```ts
import { enrichIdea, toIssueBody } from './ai.js';
import { enrichBug, toBugIssueBody } from './aiBug.js';
import { getPending, putPending, delPending, setOnExpire, type PendingIdea } from './pending.js';
import { findCodePointers } from './aiCodeContext.js';
import type { CodeContext } from './codeContextTypes.js';
```

- [ ] **Step 2: Call `findCodePointers` in the prefix `!idea` flow**

In the `if (command === 'idea')` block, immediately after `const submitterTag = ...` and before `const enriched = await enrichIdea(rawText, submitterTag);`, insert:
```ts
				const codeContext = await findCodePointers(rawText, 'idea');
```
Then change the enrich call to pass it:
```ts
				const enriched = await enrichIdea(rawText, submitterTag, undefined, undefined, codeContext);
```
In **both** `putPending({...})` calls in this block, add `codeContext` to the object and pass `codeContext` to `toIssueBody`:
```ts
					body: toIssueBody(enriched, submitterTag, message.author.id, rawText, undefined, codeContext),
					...
					codeContext,
```

- [ ] **Step 3: Call `findCodePointers` in the prefix `!bug` flow**

In the `if (command === 'bug')` block, after `const submitterTag = message.author.tag;`, insert:
```ts
				const codeContext = await findCodePointers(rawText, 'bug');
```
Change the enrich call:
```ts
				const enriched = await enrichBug(rawText, submitterTag, undefined, undefined, codeContext);
```
In **both** `putPending({...})` calls, add `codeContext,` and update the body builder:
```ts
					body: toBugIssueBody(enriched, submitterTag, rawText, undefined, codeContext),
					...
					codeContext,
```

- [ ] **Step 4: Thread `codeContext` through the modal re-enrich handlers**

In the `ns === 'idea' && action === 'answers'` modal handler, change the re-enrich + body lines to reuse the cached context:
```ts
				const codeContext = ((pending as any).codeContext as CodeContext | null) || null;
				const enriched2 = await enrichIdea((pending as any).rawText, submitterTag, answersText, previous, codeContext);
				const finalTitle = `[IDEA] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
				const finalBody = toIssueBody(enriched2, submitterTag, i.user.id, (pending as any).rawText, answersText, codeContext);
```

In the `ns === 'bug' && action === 'answers'` modal handler:
```ts
				const codeContext = ((pending as any).codeContext as CodeContext | null) || null;
				const enriched2 = await enrichBug((pending as any).rawText, submitterTag, answersText, previous, codeContext);
				const finalTitle = `[BUG] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
				const finalBody = toBugIssueBody(enriched2, submitterTag, (pending as any).rawText, answersText, codeContext);
```

- [ ] **Step 5: Extract reusable issue-posting functions**

Add these functions near `clearOldPromptComponents` in `src/bot.ts`. They contain the logic currently inlined in the idea/bug `approve` handlers, generalized to accept an optional appendix (used by expiry) and to resolve channels from the pending refs.

```ts
// Build an "Open Questions (unanswered)" appendix from a draft still carrying questions.
function unansweredAppendix(pending: any): string {
  const qs: string[] = (pending?.openQuestions as string[]) || [];
  // If the draft was answered, answersText exists and we skip the appendix.
  if (pending?.answersText || !qs.length) return '';
  const lines = qs.map((q) => `- ${q}`).join('\n');
  return `\n\n## Open Questions (unanswered)\n${lines}`;
}

// File an idea issue from a pending draft. Posts the vote embed + reaction sync,
// and a thread notice. `auto` toggles wording for the TTL-expiry path.
async function postIdeaFromPending(pending: any, auto: boolean) {
  const body = (pending.body as string) + (auto ? unansweredAppendix(pending) : '');
  const issue = await createIdeaIssue({ title: pending.title, body });

  const summary = extractSummaryFromIssueBody(issue.body || '');
  const desc = summary
    ? `**Summary**\n${summary}\n\nReact with 👍 to vote.`
    : `**Summary**\n_(no summary found in issue body)_\n\nReact with 👍 to vote.`;

  const threadId = pending.threadId || pending.sourceChannelId;
  const thread = threadId ? await client.channels.fetch(threadId as string).catch(() => null) : null;

  let parentChannel: any = null;
  try {
    if (thread && (thread as any).isThread?.()) {
      const parentId = (thread as any).parentId;
      if (parentId) parentChannel = await client.channels.fetch(parentId);
    }
    if (!parentChannel && pending.parentChannelId) {
      parentChannel = await client.channels.fetch(pending.parentChannelId as string);
    }
  } catch {}

  const voteEmbed = new EmbedBuilder()
    .setTitle(`Idea #${issue.number}: ${issue.title}`)
    .setURL(issue.html_url)
    .setDescription(desc)
    .setColor(0x00ae86);

  let voteMsg: Message | null = null;
  if (parentChannel && (parentChannel as any).isTextBased?.()) {
    voteMsg = await (parentChannel as any).send({ embeds: [voteEmbed] });
  } else if (thread && (thread as any).isTextBased?.()) {
    voteMsg = await (thread as any).send({ embeds: [voteEmbed] });
  }
  if (voteMsg && typeof (voteMsg as any).react === 'function') {
    await (voteMsg as any).react('👍');
    linkVoteMessage(voteMsg.id, issue.number);
  }
  await upsertDiscordVoteComment(issue.number, 0);

  if (thread && (thread as any).isTextBased?.()) {
    const notice = auto
      ? `⏱️ Draft timed out — filed idea **#${issue.number}** with the info we had. ${issue.html_url}`
      : `✅ Created idea **#${issue.number}** - ${issue.title}`;
    await (thread as any).send(notice);
  }
  return issue;
}

// File a bug issue from a pending draft + thread notice.
async function postBugFromPending(pending: any, auto: boolean) {
  const body = (pending.body as string) + (auto ? unansweredAppendix(pending) : '');
  const issue = await createBugIssue({ title: pending.title, body });

  const threadId = pending.threadId || pending.sourceChannelId;
  const thread = threadId ? await client.channels.fetch(threadId as string).catch(() => null) : null;
  if (thread && (thread as any).isTextBased?.()) {
    const notice = auto
      ? `⏱️ Draft timed out — filed bug **#${issue.number}** with the info we had. ${issue.html_url}`
      : `✅ Bug report posted to GitHub as issue **#${issue.number}**`;
    await (thread as any).send(notice);
  }
  return issue;
}
```

- [ ] **Step 6: Use the extracted function in the idea `approve` handler**

Replace the body of the idea `if (action === 'approve')` block (everything between `await i.update({ content: 'Posting your idea…'...})` and `delPending(id);`) with a call to the helper:
```ts
			if (action === 'approve') {
				await clearOldPromptComponents(pending);
				await i.update({ content: 'Posting your idea…', components: [], embeds: [] });

				const issue = await postIdeaFromPending(pending, false);

				delPending(id);
				return i.followUp({ content: `Done. Idea #${issue.number} posted.`, ephemeral: true });
			}
```

- [ ] **Step 7: Use the extracted function in the bug `approve` handler**

Replace the bug `if (action === 'approve')` block body similarly:
```ts
				if (action === 'approve') {
					await clearOldPromptComponents(pending);
					await i.update({ content: 'Posting your bug report…', components: [], embeds: [] });

					const issue = await postBugFromPending(pending, false);

					delPending(id);
					return i.followUp({ content: `Done. Bug #${issue.number} posted.`, ephemeral: true });
				}
```

- [ ] **Step 8: Register the expiry callback at startup**

Inside the `client.once(Events.ClientReady, ...)` handler, after `startApi(client);`, add:
```ts
		setOnExpire(async (draft: PendingIdea) => {
			// Only auto-file drafts that reached a usable state. Both phases qualify per spec.
			if (draft.type === 'bug') {
				await postBugFromPending(draft, true);
			} else {
				await postIdeaFromPending(draft, true);
			}
		});
```

- [ ] **Step 9: Typecheck + full suite**

Run: `npm run build && npm test`
Expected: build PASSES (no type errors); all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/bot.ts
git commit -m "feat: wire code search into prefix flows and auto-file drafts on expiry"
```

---

## Task 10: Wire code search into slash commands

**Files:**
- Modify: `src/commands/idea.ts`
- Modify: `src/commands/bug.ts`

- [ ] **Step 1: Update `src/commands/idea.ts`**

Add import:
```ts
import { findCodePointers } from "../aiCodeContext.js";
```
After `const submitterTag = ...` and `await interaction.deferReply({ ephemeral: true });`, before `const enriched = await enrichIdea(rawText, submitterTag);`, insert:
```ts
  const codeContext = await findCodePointers(rawText, "idea");
```
Change the enrich call:
```ts
  const enriched = await enrichIdea(rawText, submitterTag, undefined, undefined, codeContext);
```
In **both** `putPending({...})` calls, update the body line and add `codeContext`:
```ts
      body: toIssueBody(enriched, submitterTag, interaction.user.id, rawText, undefined, codeContext),
      ...
      codeContext,
```

- [ ] **Step 2: Update `src/commands/bug.ts`**

Add import:
```ts
import { findCodePointers } from "../aiCodeContext.js";
```
After `await interaction.deferReply({ ephemeral: true });`, before `const enriched = await enrichBug(rawText, submitterTag);`, insert:
```ts
  const codeContext = await findCodePointers(rawText, "bug");
```
Change the enrich call:
```ts
  const enriched = await enrichBug(rawText, submitterTag, undefined, undefined, codeContext);
```
In **both** `putPending({...})` calls, update the body line and add `codeContext`:
```ts
      body: toBugIssueBody(enriched, submitterTag, rawText, undefined, codeContext),
      ...
      codeContext,
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run build && npm test`
Expected: build PASSES; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/idea.ts src/commands/bug.ts
git commit -m "feat: wire code search into /idea and /bug slash commands"
```

---

## Task 11: Environment documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the new vars to `.env.example`**

```
# Codebase-aware enrichment (optional — feature is disabled if REPOWISE_MCP_URL is unset)
REPOWISE_MCP_URL=https://repowise-mcp.thunderducky.com/sse
CF_ACCESS_CLIENT_ID=your-cf-access-service-token-id
CF_ACCESS_CLIENT_SECRET=your-cf-access-service-token-secret
# Optional model override (defaults to gpt-4o-mini)
OPENAI_MODEL=gpt-4o-mini
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document repowise + CF Access env vars"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full build + test**

Run: `npm run build && npm test`
Expected: build PASSES with no errors; all test files green (`smoke`, `repowiseMcp`, `aiCodeContext`, `issueBodies`, `pendingExpiry`).

- [ ] **Step 2: Confirm graceful-degradation path**

Run: `npm run try:codesearch -- "fleet gets stuck warping"`
Expected (no `REPOWISE_MCP_URL` locally): warning + `null`, no crash. This confirms the feature is a no-op when unconfigured.

- [ ] **Step 3: Complete development**

Announce and use **superpowers:finishing-a-development-branch** to verify tests, present integration options, and execute the chosen path.

---

## Self-Review

**Spec coverage:**
- Smarter code-informed questions → Task 7 (both ai.ts + aiBug.ts prompt rules, codeContext block). ✅
- repowise via MCP client, lazy connect, allowlist, transport-by-path, CF headers → Task 3. ✅ (allowlist deviation documented; `list_repos`→`get_overview`.)
- Bounded tool loop (5 calls / 15 s), JSON output, retry-once, null on failure → Task 4. ✅
- Runs at submission, cached on pending, reused at approval/Q&A → Tasks 8–10. ✅
- Output to GitHub issue body only; idea "Where to Start" after Scope; bug full revamp with suspected cause / affected systems / Q&A / original text / section omission → Tasks 2 + 6. ✅
- Both ideas and bugs → Tasks 6–10. ✅
- Auto-post on TTL expiry, both phases, unanswered-questions appendix, thread notice, one retry → Tasks 8–9. ✅
- Bot stays on Railway; new env vars; `.env.example`; CF Access service-token auth → Task 11 + Task 3 headers. ✅
- Testing: vitest scoped to repowiseMcp (mapping/allowlist/headers), aiCodeContext (loop termination/parsing), issue formatters (with/without context, omission, idea insertion) → Tasks 1, 3, 4, 6, 8. ✅
- Manual `npm run try:codesearch` harness → Task 5. ✅
- Error-handling matrix (disabled/unreachable/over-budget/malformed/openai-error) → Task 4 (loop) + Task 3 (connection). ✅

**Out of scope (correctly omitted):** Discord-side pointer display, re-running search post-creation, index management, OpenAI Responses-API native MCP, fixing the Cloudflare ingress 421. The 421 means live E2E (`try:codesearch` against the server) cannot succeed until the user fixes server-side ingress — unit tests and graceful-degradation are unaffected.

**Type consistency:** `CodeContext`/`CodePointer` defined once in `codeContextTypes.ts`; `renderWhereToStart` used by both formatters; `findCodePointers(rawText, kind, deps?)` signature consistent across all call sites; `enrichIdea`/`enrichBug` 5th param `codeContext?: CodeContext | null` consistent; `toIssueBody(e, userTag, userId, raw, qa?, codeContext?)` and `toBugIssueBody(bug, userTag, raw?, qa?, codeContext?)` consistent across bot.ts + commands.

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"add error handling" placeholders — all steps contain concrete code or exact commands.
