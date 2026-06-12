// src/aiShared.ts
// Bits shared by the three OpenAI-calling modules (ai.ts, aiBug.ts,
// aiCodeContext.ts) so client config, model choice, and prompt/parse helpers
// can't drift apart.

import OpenAI from "openai";
import type { CodeContext } from "./codeContextTypes.js";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
