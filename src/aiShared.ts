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

// Per-request sampling fields for the plain JSON Chat Completions calls (idea/
// bug enrichment, dupe-check, release notes), model-aware. Classic models get
// the requested `temperature` (unchanged behavior). Reasoning models reject a
// custom `temperature` (the request 400s), so we drop it and let them run at
// their default reasoning effort.
//
// NOTE: this is only for tool-FREE calls. Reasoning models (gpt-5.4+) can't do
// function tool calls in Chat Completions at all, so the repowise tool loop uses
// the Responses API instead — see aiCodeContext.ts.
export function samplingFor(opts: { temperature?: number; model?: string } = {}): Record<string, unknown> {
  if (isReasoningModel(opts.model)) return {};
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
