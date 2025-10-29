// src/ai.ts
import OpenAI from "openai";

// ---- Env & client ----
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

const client = new OpenAI({ apiKey: API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Convenience type that always matches the SDK
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionCreateParams["messages"][number];

// ---- System preface & JSON shape ----
const SYSTEM_PREFACE = `
You are assisting a small team building a persistent, space-based MMO/RTS in Unity with a Node.js backend.
Pillars: persistent galaxy; player-built economy; territory control; fleets; tech/progression; strategic UI; server authority.
Client: Unity (UI, rendering, input, game logic). Server: Node/TS (REST/WS, jobs, economy, state). Data: Postgres/Redis.
Return practical, implementable design notes; concise; no lore; no code unless asked.
`;

const JSON_SHAPE = `
Return ONLY valid JSON with this exact shape:
{
  "title": "Short, descriptive (<= 80 chars)",
  "summary": "2-4 sentences explaining the idea & player value",
  "gameplayImpact": "How this changes gameplay or player experience",
  "scope": {
    "client": ["Replace with concrete client work items (e.g., 'Add fleet tab in UI', 'Click handler for assign'). If none, use [\\"None\\"]"],
    "server": ["Replace with concrete server work items (e.g., 'POST /fleets/assign', 'validate ownership'). If none, use [\\"None\\"]"],
    "database": ["Describe DB impact (e.g., 'Add table fleet_assignment') or [\\"No changes\\"]"]
  },
  "implementationNotes": ["task 1","task 2","task 3"],
  "risks": ["risk 1","risk 2"],
  "telemetry": ["what to log/measure"],
  "antiCheat": ["server-authority validations"],
  "dependencies": ["systems/configs impacted"],
  "openQuestions": ["clear questions for the player (max 3)"],
  "tags": ["UI","Economy","Fleet","Territory","PvP","PvE","Server","DB","QoL","Balance"]
}
Rules:
- Do NOT copy example labels like "UI", "3D assets", "API/WS endpoint", etc. Replace them with concrete items or use ["None"] / ["No changes"].
- If a section is N/A, use ["None"] or ["No changes"] (for database) instead of empty arrays.
- Keep openQuestions to at most 3.
- Output only JSON.
`;

// ---- Prompt builders ----
function firstPassPrompt(raw: string, author: string) {
  return `
Given the raw player idea below, produce a concise, developer-ready design note as JSON.
- Fill "scope.client" / "scope.server" with concrete work items (or ["None"]).
- Set "scope.database" to specific changes or ["No changes"].
- Ask at most 3 openQuestions only if truly needed; otherwise [].

<author>${author}</author>

${JSON_SHAPE}

Raw player idea:
"""${raw}"""
`;
}

function secondPassPrompt(raw: string, answers: string, author: string, previousJSON: string) {
  return `
Your task is to refine the existing design note based on player clarifications.
Keep **openQuestions** to **at most 3**, and remove any that are now answered.

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

Original raw idea:
"""${raw}"""
Submitted by: ${author}
`;
}

// ---- Types ----
export type Enriched = {
  title: string;
  summary: string;
  gameplayImpact?: string;
  scope?: { client?: string[]; server?: string[]; database?: string[] };
  implementationNotes?: string[];
  risks?: string[];
  telemetry?: string[];
  antiCheat?: string[];
  dependencies?: string[];
  openQuestions?: string[];
  tags?: string[];
};

// ---- Helpers ----
function stripFences(s: string) {
  // Remove ```json ... ``` or ``` ... ```
  return s.replace(/```(?:json)?\s*|```/gi, "").trim();
}
function toArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter(Boolean).map(String) : [];
}
function sanitize(e: Partial<Enriched>, raw: string): Enriched {
  const title = (e.title && String(e.title).trim()) || raw.slice(0, 80);
  const summary = (e.summary && String(e.summary).trim()) || raw;
  const gameplayImpact =
    (e.gameplayImpact && String(e.gameplayImpact).trim()) ||
    "Quality-of-life or feature addition.";

  const scope = {
    client: scrubScopeList(e.scope?.client as unknown[], "client"),
    server: scrubScopeList(e.scope?.server as unknown[], "server"),
    database: scrubScopeList(e.scope?.database as unknown[], "database"),
  };

  const implementationNotes = toArray(e.implementationNotes);
  const risks = toArray(e.risks);
  const telemetry = toArray(e.telemetry);
  const antiCheat = toArray(e.antiCheat);
  const dependencies = toArray(e.dependencies);
  const openQuestions = toArray(e.openQuestions).slice(0, 3); // cap at 3 here, too
  const tags = toArray(e.tags);

  return {
    title,
    summary,
    gameplayImpact,
    scope,
    implementationNotes,
    risks,
    telemetry,
    antiCheat,
    dependencies,
    openQuestions,
    tags,
  };
}
const PLACEHOLDER_TOKENS = new Set([
  "UI","3D assets","Animation","FX","Input","Game Logic",
  "API/WS endpoint","Jobs/queues","State sync","Economy logic",
  "Schema change?","New entities/fields?","No changes?"
]);

function scrubScopeList(list?: unknown[], kind: "client" | "server" | "database" = "client"): string[] {
  const arr = Array.isArray(list) ? list.map(x => String(x).trim()).filter(Boolean) : [];
  // Drop known placeholders
  const cleaned = arr.filter(x => !PLACEHOLDER_TOKENS.has(x));
  if (kind === "database") {
    // If DB ended up empty, prefer ["No changes"] (clearer than None for DB)
    return cleaned.length ? cleaned : ["No changes"];
  }
  // For client/server, default to ["None"] if empty
  return cleaned.length ? cleaned : ["None"];
}

async function callOnce(messages: ChatMessage[]) {
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    // Some SDK versions don't expose response_format in types; cast to any to use JSON mode.
    response_format: { type: "json_object" } as any,
    messages,
  });
  return res.choices[0]?.message?.content || "{}";
}

// ---- Main API ----
export async function enrichIdea(
  rawText: string,
  author: string,
  answersText?: string,
  previous?: Enriched
): Promise<Enriched> {
  const previousJSON = previous ? JSON.stringify(previous, null, 2) : "{}";
  const userPrompt = answersText
    ? secondPassPrompt(rawText, answersText, author, previousJSON)
    : firstPassPrompt(rawText, author);

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
    // Fallback: keep prior draft if provided; otherwise minimal from raw
    return sanitize(previous ?? {}, rawText);
  }
}

// ---- Issue body formatter ----
function linesOrNone(arr?: string[]) {
  return Array.isArray(arr) && arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- (none)";
}

export function toIssueBody(
  e: Enriched,
  userTag: string,
  userId: string,
  raw: string,
  qa?: string
) {
  const scope = [
    `**Client (Unity)**\n${linesOrNone(e.scope?.client)}`,
    `\n**Server (Node)**\n${linesOrNone(e.scope?.server)}`,
    `\n**Database**\n${linesOrNone(e.scope?.database)}`,
  ].join("\n");

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
