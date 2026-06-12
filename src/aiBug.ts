// src/aiBug.ts
import OpenAI from "openai";
import type { CodeContext } from "./codeContextTypes.js";
import { renderWhereToStart } from "./codeContextTypes.js";
import { getOpenAiClient, OPENAI_MODEL, stripFences, codeContextBlock } from "./aiShared.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionCreateParams["messages"][number];

const SYSTEM_PREFACE = `
You are assisting a small team building a persistent, space-based MMO/RTS in Unity with a Node.js backend.
Your task is to structure player bug reports into a clear, actionable format for developers.
Use any provided code context to focus on what's unknown; do not nag players for exact repro steps the code already localizes.
`;

const JSON_SHAPE = `
Return ONLY valid JSON with this exact shape:
{
  "title": "Short, clear bug title (<= 80 chars)",
  "summary": "1-2 sentence description of the bug",
  "stepsToReproduce": ["Step 1", "Step 2", "..."] or [] if unknown,
  "expectedBehavior": "What should happen",
  "actualBehavior": "What actually happens",
  "frequency": "always" | "sometimes" | "once" | null,
  "openQuestions": ["Up to 3 clarifying questions about reproduction"]
}
Rules:
- Ask only what neither the report nor the code context reveals: in-game conditions, player intent, expected outcome.
- Do NOT demand exact reproduction steps when code context narrows the area; prefer discriminating questions.
- Phrase questions in player terms, never code terms (no file/function names).
- Keep openQuestions to at most 3; ask none if the report + code suffice.
- Output only JSON
`;

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

export type EnrichedBug = {
  title: string;
  summary: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  frequency: string | null;
  openQuestions: string[];
};

function toArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter(Boolean).map(String) : [];
}

function sanitize(e: Partial<EnrichedBug>, raw: string): EnrichedBug {
  return {
    title: (e.title && String(e.title).trim()) || raw.slice(0, 80),
    summary: (e.summary && String(e.summary).trim()) || raw,
    stepsToReproduce: toArray(e.stepsToReproduce),
    expectedBehavior: (e.expectedBehavior && String(e.expectedBehavior).trim()) || "Not specified",
    actualBehavior: (e.actualBehavior && String(e.actualBehavior).trim()) || "Not specified",
    frequency: e.frequency ? String(e.frequency).trim() : null,
    openQuestions: toArray(e.openQuestions).slice(0, 3),
  };
}

async function callOnce(messages: ChatMessage[]) {
  const res = await getOpenAiClient().chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" } as any,
    messages,
  });
  return res.choices[0]?.message?.content || "{}";
}

export type EnrichBugOpts = {
  answersText?: string;
  previous?: EnrichedBug;
  codeContext?: CodeContext | null;
};

export async function enrichBug(
  rawText: string,
  author: string,
  opts: EnrichBugOpts = {}
): Promise<EnrichedBug> {
  const { answersText, previous, codeContext } = opts;
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

export type BugIssueBodyOpts = {
  raw?: string;
  qa?: string;
  codeContext?: CodeContext | null;
};

export function toBugIssueBody(
  bug: EnrichedBug,
  userTag: string,
  opts: BugIssueBodyOpts = {}
): string {
  const { raw, qa, codeContext } = opts;
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
