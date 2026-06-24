// src/aiShared.ts
// Bits shared by the three OpenAI-calling modules (ai.ts, aiBug.ts,
// aiCodeContext.ts) so client config, model choice, and prompt/parse helpers
// can't drift apart.

import OpenAI from "openai";
import type { CodeContext } from "./codeContextTypes.js";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

// Reasoning models (o-series and gpt-5+) reject a custom `temperature`/`top_p`
// (the request 400s) and steer behavior with `reasoning_effort` instead. Classic
// chat models (gpt-4o, gpt-4o-mini) take `temperature` and have no reasoning knob.
export function isReasoningModel(model: string = OPENAI_MODEL): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

// Per-request sampling fields, model-aware. Classic models get the requested
// `temperature` (unchanged behavior). Reasoning models drop `temperature`
// entirely and, ONLY on the tool-calling path, pin `reasoning_effort: "low"`:
// gpt-5.4+ disables tool calling in Chat Completions when effort is "none" (the
// reasoning default), so the repowise loop would silently make zero tool calls.
// Non-tool calls leave effort at the model default to stay cheap/fast.
export function samplingFor(opts: { temperature?: number; usesTools?: boolean; model?: string } = {}): Record<string, unknown> {
  if (isReasoningModel(opts.model)) {
    return opts.usesTools ? { reasoning_effort: "low" } : {};
  }
  return { temperature: opts.temperature ?? 0.2 };
}

let client: OpenAI | null = null;
export function getOpenAiClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: API_KEY });
  return client;
}

// Remove a ```json ... ``` (or bare ```) wrapper. Only strips fences at the
// start/end of the content — backticks inside string values are left alone.
export function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// Prompt block injecting code-search results into enrichment prompts.
export function codeContextBlock(codeContext?: CodeContext | null): string {
  if (!codeContext || !codeContext.whereToStart?.length) return "";
  return `\n<codeContext>\n${JSON.stringify(codeContext, null, 2)}\n</codeContext>\nUse this to avoid asking what the code already reveals.\n`;
}
