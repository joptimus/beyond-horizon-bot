// src/aiCodeContext.ts
// Bounded OpenAI function-calling loop that uses repowise tools to locate the
// code relevant to a player's idea/bug. Returns a CodeContext or null. Never
// throws: any failure (disabled, unreachable, timeout, bad JSON) -> null, and
// enrichment proceeds without code context.

import OpenAI from "openai";
import type { CodeContext } from "./codeContextTypes.js";
import { getOpenAiTools, callTool, isRepowiseEnabled, type OpenAiToolDef } from "./repowiseMcp.js";
import { getOpenAiClient, OPENAI_MODEL, stripFences } from "./aiShared.js";

const MAX_TOOL_CALLS = 5;
const TIME_BUDGET_MS = 15_000;
const PER_CALL_TIMEOUT_MS = 10_000;

// Hard ceiling on the text of any single tool result fed back to OpenAI. The
// useful header (overview/summary/signatures) comes first in every repowise
// payload, so truncating the tail bounds context+cost without losing the lede.
const MAX_TOOL_RESULT_CHARS = 6_000;

// get_context defaults to compact=true, which for any file over ~80 lines emits
// a "skeleton" with inlined function bodies (~8k tokens) and takes ~6s — enough
// to blow the time budget on a single call. compact=false returns the symbol-
// list card instead: just signatures + line numbers (a better "where to start"
// map anyway), ~4x faster, no bodies. These opt-in "include" blocks pile extra
// weight on top, so we strip them too.
const GET_CONTEXT_HEAVY_INCLUDE = new Set([
  "skeleton",
  "callers",
  "callees",
  "metrics",
  "community",
  "full_doc",
]);

// Force get_context into its cheap, fast shape: compact=false + no heavy include
// blocks. The model can't opt back into the expensive payload. Other tools and
// args pass through untouched.
function sanitizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "get_context") return args;
  const include = Array.isArray(args.include)
    ? (args.include as unknown[]).filter((b) => typeof b === "string" && !GET_CONTEXT_HEAVY_INCLUDE.has(b))
    : args.include;
  return { ...args, compact: false, include };
}

// Set DEBUG_CODE_CONTEXT=1 to trace the repowise<->OpenAI loop: which tools are
// offered, what the model decides to call (and with what args), what repowise
// returns, and the final answer. Off by default so normal runs stay quiet.
const DEBUG = process.env.DEBUG_CODE_CONTEXT === "1" || process.env.DEBUG_CODE_CONTEXT === "true";

// Truncate long blobs (tool output, prompts) so logs stay readable.
function preview(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated ${s.length - max} of ${s.length} chars]`;
}

function dbg(...args: unknown[]): void {
  if (DEBUG) console.log("[aiCodeContext]", ...args);
}

// The time budget is only checked between loop iterations and cannot interrupt
// an in-flight await, so every network call is individually raced against a
// timeout (the underlying request keeps running, but the submission moves on).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Injectable dependencies so the loop is unit-testable without network access.
export type FindDeps = {
  getTools: () => Promise<OpenAiToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  createCompletion: (params: any) => Promise<{ choices: Array<{ message: any }> }>;
  now: () => number;
  enabled: boolean;
};

function getDefaultDeps(): FindDeps {
  return {
    getTools: getOpenAiTools,
    callTool,
    createCompletion: (params) => getOpenAiClient().chat.completions.create(params) as any,
    now: () => Date.now(),
    enabled: isRepowiseEnabled(),
  };
}

const SYSTEM_PROMPT = `
You are a senior engineer on a persistent, space-based MMO/RTS.
The code is spread across several repositories, each indexed separately by the search tools. Pass the repo alias as the "repo" argument:
- SpaceMMORPG — Unity client (C#, under Assets/Scripts/...): all UI, screens, panels, menus, rendering, input, client-side game logic.
- game-server — Node/TS backend: REST/WS APIs, jobs, economy, build orders/construction, docking, persistent state (Postgres/Redis).
- battle-server-rust — Rust combat/battle server.
- viper-service — Rust routing engine.
- bho-website-react — React marketing/website.
Repo-scoping is critical. repo="all" fuses results across every repo and BURIES the relevant file — a UI request can rank below unrelated infra files. When you can tell which area an idea/bug touches, search that repo directly: UI / screens / menus → SpaceMMORPG; economy / build / jobs / API → game-server; combat → battle-server-rust. Use repo="all" only as a last resort when you genuinely can't tell.
Many features span repos. A UI that shows a build time = SpaceMMORPG (where to display it) + game-server (where build time is computed) — search each relevant repo with its own query rather than one "all" query.
Your job: given a player's idea or bug report, locate the most relevant code and produce a concise pointer list a developer can start from.
Use the tools to search; refine queries based on results. Be efficient — a few targeted, repo-scoped searches, not exhaustive crawling.
Tool-use rules (these matter — misusing them wastes your small search budget on empty results):
- Leave page_type and kind UNSET. They are filters that silently exclude relevant pages; an over-narrow filter (e.g. page_type="symbol_spotlight") commonly returns []. Only set one to thin out an overwhelming result set, never to find something.
- Search by concept/behavior in plain words ("error panel hidden behind builder", "ship build queue row"), NOT by a guessed class name. search_codebase is semantic — invented identifiers like "BuildStationsScreen" return nothing.
- If a search returns no results, do NOT repeat it or retry the same identifier. Broaden the query (drop filters, use plainer words) or pivot: call get_context on the most promising file you already found.
- Before answering, call get_context on your top 1-2 candidate files to confirm they actually handle the behavior (it's cheap). If you know an exact symbol name, use get_symbol.
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
  const cleaned = stripFences(content);
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
    dbg(`enabled, kind=${kind}. Tools offered to OpenAI (${tools.length}):`,
      tools.map((t) => t.function.name).join(", ") || "(none)");
    if (!tools.length) return null; // nothing to search with

    const start = deps.now();
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Kind: ${kind}\nPlayer report:\n"""${rawText}"""` },
    ];
    dbg("Initial user message fed to OpenAI:", preview(messages[1].content as string));

    let toolCalls = 0;
    let forceFinal = false;

    while (true) {
      const outOfTime = deps.now() - start > TIME_BUDGET_MS;
      const outOfCalls = toolCalls >= MAX_TOOL_CALLS;
      forceFinal = forceFinal || outOfTime || outOfCalls;

      dbg(`OpenAI request: forceFinal=${forceFinal}, toolCalls so far=${toolCalls}, ` +
        `messages=${messages.length}, tools offered=${forceFinal ? 0 : tools.length}`);

      const res = await withTimeout(
        deps.createCompletion({
          model: OPENAI_MODEL,
          temperature: 0.1,
          messages,
          // Withholding tools forces the model to answer with prose/JSON.
          tools: forceFinal ? undefined : tools,
          tool_choice: forceFinal ? undefined : "auto",
        }),
        PER_CALL_TIMEOUT_MS,
        "completion"
      );

      const msg = res.choices[0]?.message;
      if (!msg) return null;

      const calls = msg.tool_calls || [];
      dbg(`OpenAI responded: ${calls.length} tool call(s) requested` +
        (calls.length ? `: ${calls.map((c: any) => c.function?.name).join(", ")}` : ""));
      if (!forceFinal && calls.length) {
        messages.push(msg as ChatMessage);
        for (const call of calls) {
          let toolText = "";
          if (toolCalls >= MAX_TOOL_CALLS) {
            toolText = "(tool call skipped: search budget reached)";
          } else if (deps.now() - start > TIME_BUDGET_MS) {
            toolText = "(tool call skipped: time budget reached)";
          } else {
            toolCalls++;
            try {
              const rawArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
              const args = sanitizeToolArgs(call.function.name, rawArgs);
              dbg(`→ calling repowise tool "${call.function.name}" with args:`, JSON.stringify(args));
              const full = await withTimeout(
                deps.callTool(call.function.name, args),
                PER_CALL_TIMEOUT_MS,
                `tool ${call.function.name}`
              );
              toolText =
                full.length > MAX_TOOL_RESULT_CHARS
                  ? `${full.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${full.length - MAX_TOOL_RESULT_CHARS} of ${full.length} chars]`
                  : full;
              dbg(`← repowise "${call.function.name}" returned ${full.length} chars` +
                (full.length > MAX_TOOL_RESULT_CHARS ? ` (capped to ${MAX_TOOL_RESULT_CHARS})` : "") +
                `:`, preview(toolText));
            } catch (err) {
              toolText = `tool error: ${(err as Error).message}`;
              dbg(`← repowise "${call.function.name}" FAILED:`, (err as Error).message);
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: toolText || "(no result)" });
        }
        continue; // let the model react to tool output
      }

      // Final answer expected here.
      dbg("OpenAI final answer (raw):", preview(msg.content || "(empty)"));
      const parsed = parseFinal(msg.content || "");
      if (parsed) {
        dbg("Parsed CodeContext:", JSON.stringify(parsed));
        return parsed;
      }

      // Out of budget: don't spend another round trip nudging for valid JSON.
      if (deps.now() - start > TIME_BUDGET_MS) {
        dbg("Final answer was not valid JSON and time budget exhausted — returning null.");
        return null;
      }

      // One retry: nudge for valid JSON, force final.
      dbg("Final answer was not valid JSON — retrying once with a JSON-only nudge.");
      messages.push(msg as ChatMessage);
      messages.push({ role: "user", content: "Your previous reply was not valid JSON. Reply with ONLY the JSON object described, nothing else." });
      const retry = await withTimeout(
        deps.createCompletion({ model: OPENAI_MODEL, temperature: 0, messages }),
        PER_CALL_TIMEOUT_MS,
        "completion (json retry)"
      );
      const retryContent = retry.choices[0]?.message?.content || "";
      dbg("OpenAI retry answer (raw):", preview(retryContent || "(empty)"));
      const retryParsed = parseFinal(retryContent);
      dbg("Parsed CodeContext after retry:", retryParsed ? JSON.stringify(retryParsed) : "null");
      return retryParsed;
    }
  } catch (err) {
    console.warn("[aiCodeContext] findCodePointers failed:", err);
    return null;
  }
}
