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
              const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
              toolText = await withTimeout(
                deps.callTool(call.function.name, args),
                PER_CALL_TIMEOUT_MS,
                `tool ${call.function.name}`
              );
            } catch (err) {
              toolText = `tool error: ${(err as Error).message}`;
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: toolText || "(no result)" });
        }
        continue; // let the model react to tool output
      }

      // Final answer expected here.
      const parsed = parseFinal(msg.content || "");
      if (parsed) return parsed;

      // Out of budget: don't spend another round trip nudging for valid JSON.
      if (deps.now() - start > TIME_BUDGET_MS) return null;

      // One retry: nudge for valid JSON, force final.
      messages.push(msg as ChatMessage);
      messages.push({ role: "user", content: "Your previous reply was not valid JSON. Reply with ONLY the JSON object described, nothing else." });
      const retry = await withTimeout(
        deps.createCompletion({ model: OPENAI_MODEL, temperature: 0, messages }),
        PER_CALL_TIMEOUT_MS,
        "completion (json retry)"
      );
      return parseFinal(retry.choices[0]?.message?.content || "");
    }
  } catch (err) {
    console.warn("[aiCodeContext] findCodePointers failed:", err);
    return null;
  }
}
