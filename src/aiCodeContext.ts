// src/aiCodeContext.ts
// Bounded function-calling loop that uses repowise tools to locate the code
// relevant to a player's idea/bug. Returns a CodeContext or null. Never throws:
// any failure (disabled, unreachable, timeout, bad JSON) -> null, and enrichment
// proceeds without code context.
//
// Runs on the OpenAI Responses API (/v1/responses), NOT Chat Completions:
// gpt-5.4+ reasoning models reject function tools in Chat Completions entirely
// ("use /v1/responses instead"), so tool calling for those models is only
// possible here. The model's tool calls come back as `function_call` output
// items; we answer each with a `function_call_output` and thread turns together
// with `previous_response_id` rather than resending the whole message list.

import type { CodeContext } from "./codeContextTypes.js";
import { getOpenAiTools, callTool, isRepowiseEnabled, type OpenAiToolDef } from "./repowiseMcp.js";
import { getOpenAiClient, OPENAI_MODEL, stripFences, isReasoningModel } from "./aiShared.js";

const MAX_TOOL_CALLS = 7;
// Reasoning models add per-turn latency, so the loop needs more headroom than
// the original gpt-4o-mini tuning: too tight and the budget trips mid-search,
// forcing the model to dump a half-finished (and often garbage-wrapped) answer.
const TIME_BUDGET_MS = 30_000;
const PER_CALL_TIMEOUT_MS = 15_000;

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

// Injectable dependencies so the loop is unit-testable without network access.
export type FindDeps = {
  getTools: () => Promise<OpenAiToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  createResponse: (params: any) => Promise<any>;
  now: () => number;
  enabled: boolean;
};

function getDefaultDeps(): FindDeps {
  return {
    getTools: getOpenAiTools,
    callTool,
    createResponse: (params) => getOpenAiClient().responses.create(params) as any,
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
Confidence rubric — set "confidence" by how well you VERIFIED the pointers, not by how many you list. Do NOT default to "medium":
- "high": you opened your top candidate file(s) with get_context (or get_symbol) and confirmed they actually implement the behavior in the report. If you confirmed the files, you MUST say "high".
- "medium": search surfaced plausible candidates but you did not confirm them (ran out of budget, or only some are confirmed).
- "low": you found nothing useful (return whereToStart: []), or the matches are unrelated guesses.
You have budget to confirm — spend a get_context call on your top candidate before settling for "medium".
Rules: at most 6 pointers; omit "symbol" if not applicable; if you found nothing useful, return whereToStart: [] with confidence "low".
`;

// Yield each top-level {...} substring, brace-matched and string-aware (braces
// and the escape char inside JSON strings don't count toward nesting).
function topLevelJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0 && --depth === 0 && start >= 0) {
      out.push(s.slice(start, i + 1));
      start = -1;
    }
  }
  return out;
}

// The final answer is supposed to be one JSON object, but a reasoning model that
// gets cut off mid-search can emit leaked tool-call fragments and junk tokens
// BEFORE the real object (observed with gpt-5.4-mini: stray `{"tool_uses":[...]}`
// blocks and garbage text, then the valid whereToStart object last). Pull the
// intended object out of that noise: parse the whole string if we can, else take
// the last top-level {...} that parses to an object carrying a whereToStart array.
function extractAnswerObject(text: string): any | null {
  const cleaned = stripFences(text);
  try {
    const whole = JSON.parse(cleaned);
    if (whole && typeof whole === "object") return whole;
  } catch { /* not a clean object — scan for an embedded one */ }

  let chosen: any = null;
  for (const candidate of topLevelJsonObjects(cleaned)) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && Array.isArray(obj.whereToStart)) chosen = obj;
    } catch { /* skip non-JSON fragment */ }
  }
  return chosen;
}

function parseFinal(content: string): CodeContext | null {
  const obj = extractAnswerObject(content);
  try {
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

// repowise tools arrive in Chat Completions shape ({type, function:{name,...}});
// the Responses API wants them flat ({type:"function", name, description,
// parameters}). Convert here so repowiseMcp (and its tests) stay unchanged.
function toResponsesTools(tools: OpenAiToolDef[]): any[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

// The function-call items the model emitted this turn (Responses API surfaces
// them as output items of type "function_call", each with its own call_id).
function functionCalls(res: any): Array<{ call_id: string; name: string; arguments: string }> {
  const output = Array.isArray(res?.output) ? res.output : [];
  return output
    .filter((o: any) => o?.type === "function_call")
    .map((o: any) => ({ call_id: String(o.call_id), name: String(o.name), arguments: String(o.arguments ?? "") }));
}

// The model's final text. The SDK aggregates it into `output_text`; fall back to
// concatenating the output_text parts of any message items if that's absent.
function responseText(res: any): string {
  if (typeof res?.output_text === "string") return res.output_text;
  const output = Array.isArray(res?.output) ? res.output : [];
  return output
    .filter((o: any) => o?.type === "message")
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

// Reasoning models steer with reasoning.effort (and reject temperature); classic
// models take temperature. "low" effort keeps tool calling available (the
// default "none" disables it on gpt-5.4+) while staying cheap.
function samplingParams(): Record<string, unknown> {
  return isReasoningModel() ? { reasoning: { effort: "low" } } : { temperature: 0.1 };
}

export async function findCodePointers(
  rawText: string,
  kind: "idea" | "bug",
  injected?: FindDeps
): Promise<CodeContext | null> {
  const deps = injected || getDefaultDeps();
  if (!deps.enabled) return null;

  try {
    const chatTools = await deps.getTools();
    dbg(`enabled, kind=${kind}. Tools offered to OpenAI (${chatTools.length}):`,
      chatTools.map((t) => t.function.name).join(", ") || "(none)");
    if (!chatTools.length) return null; // nothing to search with
    const tools = toResponsesTools(chatTools);

    const start = deps.now();
    // The first request sends system + user as input items; later turns thread
    // off previous_response_id and send only the new function_call_output items.
    let nextInput: any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Kind: ${kind}\nPlayer report:\n"""${rawText}"""` },
    ];
    dbg("Initial user message fed to OpenAI:", preview(nextInput[1].content as string));

    let prevId: string | undefined;
    let toolCalls = 0;
    let forceFinal = false;

    while (true) {
      const outOfTime = deps.now() - start > TIME_BUDGET_MS;
      const outOfCalls = toolCalls >= MAX_TOOL_CALLS;
      forceFinal = forceFinal || outOfTime || outOfCalls;

      dbg(`OpenAI request: forceFinal=${forceFinal}, toolCalls so far=${toolCalls}, ` +
        `input items=${nextInput.length}, tools offered=${forceFinal ? 0 : tools.length}`);

      const res = await withTimeout(
        deps.createResponse({
          model: OPENAI_MODEL,
          ...(prevId ? { previous_response_id: prevId } : {}),
          input: nextInput,
          // Withholding tools forces the model to answer with prose/JSON.
          tools: forceFinal ? undefined : tools,
          tool_choice: forceFinal ? undefined : "auto",
          ...samplingParams(),
        }),
        PER_CALL_TIMEOUT_MS,
        "response"
      );
      if (!res) return null;
      prevId = res.id;

      const calls = functionCalls(res);
      dbg(`OpenAI responded: ${calls.length} tool call(s) requested` +
        (calls.length ? `: ${calls.map((c) => c.name).join(", ")}` : ""));
      if (!forceFinal && calls.length) {
        // Every function_call MUST get a matching function_call_output, even
        // when skipped for budget — otherwise the next request errors.
        const outputs: any[] = [];
        for (const call of calls) {
          let toolText = "";
          if (toolCalls >= MAX_TOOL_CALLS) {
            toolText = "(tool call skipped: search budget reached)";
          } else if (deps.now() - start > TIME_BUDGET_MS) {
            toolText = "(tool call skipped: time budget reached)";
          } else {
            toolCalls++;
            try {
              const rawArgs = call.arguments ? JSON.parse(call.arguments) : {};
              const args = sanitizeToolArgs(call.name, rawArgs);
              dbg(`→ calling repowise tool "${call.name}" with args:`, JSON.stringify(args));
              const full = await withTimeout(
                deps.callTool(call.name, args),
                PER_CALL_TIMEOUT_MS,
                `tool ${call.name}`
              );
              toolText =
                full.length > MAX_TOOL_RESULT_CHARS
                  ? `${full.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${full.length - MAX_TOOL_RESULT_CHARS} of ${full.length} chars]`
                  : full;
              dbg(`← repowise "${call.name}" returned ${full.length} chars` +
                (full.length > MAX_TOOL_RESULT_CHARS ? ` (capped to ${MAX_TOOL_RESULT_CHARS})` : "") +
                `:`, preview(toolText));
            } catch (err) {
              toolText = `tool error: ${(err as Error).message}`;
              dbg(`← repowise "${call.name}" FAILED:`, (err as Error).message);
            }
          }
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: toolText || "(no result)" });
        }
        nextInput = outputs; // sent against previous_response_id next turn
        continue; // let the model react to tool output
      }

      // Final answer expected here.
      const finalText = responseText(res);
      dbg("OpenAI final answer (raw):", preview(finalText || "(empty)"));
      const parsed = parseFinal(finalText);
      if (parsed) {
        dbg("Parsed CodeContext:", JSON.stringify(parsed));
        return parsed;
      }

      // Out of budget: don't spend another round trip nudging for valid JSON.
      if (deps.now() - start > TIME_BUDGET_MS) {
        dbg("Final answer was not valid JSON and time budget exhausted — returning null.");
        return null;
      }

      // One retry: nudge for valid JSON (no tools), threaded off this response.
      dbg("Final answer was not valid JSON — retrying once with a JSON-only nudge.");
      const retry = await withTimeout(
        deps.createResponse({
          model: OPENAI_MODEL,
          previous_response_id: prevId,
          input: [{ role: "user", content: "Your previous reply was not valid JSON. Reply with ONLY the JSON object described, nothing else." }],
          ...samplingParams(),
        }),
        PER_CALL_TIMEOUT_MS,
        "response (json retry)"
      );
      const retryText = responseText(retry);
      dbg("OpenAI retry answer (raw):", preview(retryText || "(empty)"));
      const retryParsed = parseFinal(retryText);
      dbg("Parsed CodeContext after retry:", retryParsed ? JSON.stringify(retryParsed) : "null");
      return retryParsed;
    }
  } catch (err) {
    console.warn("[aiCodeContext] findCodePointers failed:", err);
    return null;
  }
}
