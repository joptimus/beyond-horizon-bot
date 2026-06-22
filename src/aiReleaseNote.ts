// src/aiReleaseNote.ts
// Turns an aggregated, cross-repo Conventional-Commit bundle (git-cliff --context
// from SpaceMMORPG + game-server + battle-server-rust) into ONE player-facing
// release note for the in-game launcher news feed. Reuses the shared OpenAI client.
import { getOpenAiClient, OPENAI_MODEL, stripFences } from "./aiShared.js";

export interface RepoBundle {
  repo: string;
  range: string;
  context: any;
}

export interface ReleaseBundle {
  client_tag: string;
  run_url?: string;
  repos: RepoBundle[];
}

export interface ReleaseNote {
  hasPlayerImpact: boolean;
  title: string;
  body: string;
}

interface FlatCommit {
  group: string;
  scope: string | null;
  subject: string;
}

// git-cliff --context emits an array of release objects, each with a `commits`
// array. Pull the player-relevant fields and drop anything cliff didn't group
// (noise the shared cliff.toml already filters: chore/ci/docs/style/merges).
function flattenCommits(context: any): FlatCommit[] {
  const releases = Array.isArray(context) ? context : context ? [context] : [];
  const out: FlatCommit[] = [];
  for (const rel of releases) {
    for (const c of rel?.commits ?? []) {
      const group = (c.group || "").trim();
      if (!group) continue;
      const subject = (c.message || "").split("\n")[0].trim();
      if (!subject) continue;
      out.push({ group, scope: c.scope || null, subject });
    }
  }
  return out;
}

export function bundleCommitCount(bundle: ReleaseBundle): number {
  return bundle.repos.reduce((n, r) => n + flattenCommits(r.context).length, 0);
}

const SYSTEM_PREFACE = `
You write player-facing patch notes for Beyond Horizon, a persistent space MMO/RTS.
Your audience is players, not developers. Translate technical commit messages into
plain, upbeat language about what changed in their game.
`;

const JSON_SHAPE = `
Return ONLY valid JSON with this exact shape:
{
  "hasPlayerImpact": true | false,
  "title": "Short headline for the update (<= 70 chars)",
  "body": "Markdown bullet list of the player-relevant changes"
}
Rules:
- Write in player terms. NEVER mention file names, function names, commit scopes,
  repo names, internal version numbers, or words like 'refactor'/'commit'/'server-side'.
- Group related changes; merge duplicates; omit anything with no visible player effect.
- EXCLUDE changes to the game's own update/release machinery — the launcher,
  the news / patch-notes system itself, CI, build, deploy, versioning, tests, and
  developer tooling. Players never experience these; do not mention them even as a
  benefit (e.g. never write "patch notes are now cleaner / de-duplicated").
- Keep it concise: a title plus 2-8 short bullets. No preamble, no sign-off.
- If NOTHING in the bundle affects players (only internal/tooling changes), set
  hasPlayerImpact to false and return empty strings for title and body.
- Output only JSON.
`;

function buildPrompt(bundle: ReleaseBundle): string {
  const sections = bundle.repos
    .map((r) => {
      const commits = flattenCommits(r.context);
      if (!commits.length) return "";
      const lines = commits
        .map((c) => `- [${c.group}]${c.scope ? ` (${c.scope})` : ""} ${c.subject}`)
        .join("\n");
      return `Changes from ${r.repo}:\n${lines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  return `
Write one player-facing release note for update ${bundle.client_tag} based on the
combined changes below (collected across the game client and its servers).

${sections}

${JSON_SHAPE}
`;
}

export async function generateReleaseNote(bundle: ReleaseBundle): Promise<ReleaseNote> {
  const res = await getOpenAiClient().chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" } as any,
    messages: [
      { role: "system", content: SYSTEM_PREFACE },
      { role: "user", content: buildPrompt(bundle) },
    ],
  });

  const content = res.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(stripFences(content));
  return {
    hasPlayerImpact: parsed.hasPlayerImpact !== false,
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    body: typeof parsed.body === "string" ? parsed.body.trim() : "",
  };
}

// Launcher-supported languages minus English (the base note IS English). The
// launcher resolves selected-language -> English fallback, so any language we
// fail to produce here simply falls back to the English note server-side.
const TARGET_LANGS: { code: string; name: string }[] = [
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Simplified Chinese" },
  { code: "ko", name: "Korean" },
];

export interface NoteTranslation {
  lang_code: string;
  title: string;
  body: string;
}

const TRANSLATE_RULES = `
Return ONLY valid JSON keyed by language code, each value an object with the
translated title and body:
{ "es": { "title": "...", "body": "..." }, "fr": { "title": "...", "body": "..." }, ... }
Rules:
- The body is Markdown. Preserve its structure EXACTLY: same bullet markers, line
  breaks, and bold/italic/link syntax. Do NOT translate URLs or text inside backticks.
- Translate naturally for players and keep the upbeat tone. Title stays <= 70 chars.
- Include EVERY requested language code as a top-level key. Output only JSON.
`;

// Machine-translates one English launcher note into the target languages. Reuses
// the shared OpenAI client. A partial/garbled model response is tolerated (bad JSON
// -> [], missing/malformed languages dropped; English fallback covers them), but the
// OpenAI call itself may throw on network/auth/rate-limit — the caller treats the
// whole step as best-effort and posts the English note regardless.
export async function translateReleaseNote(title: string, body: string): Promise<NoteTranslation[]> {
  const langList = TARGET_LANGS.map((l) => `${l.code} = ${l.name}`).join(", ");
  const res = await getOpenAiClient().chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" } as any,
    messages: [
      { role: "system", content: SYSTEM_PREFACE },
      { role: "user", content: `Target languages: ${langList}\n\nTitle: ${title}\n\nBody:\n${body}\n${TRANSLATE_RULES}` },
    ],
  });

  let parsed: any;
  try {
    parsed = JSON.parse(stripFences(res.choices[0]?.message?.content || "{}"));
  } catch {
    return [];
  }

  const out: NoteTranslation[] = [];
  for (const { code } of TARGET_LANGS) {
    const t = parsed?.[code];
    if (t && typeof t.title === "string" && typeof t.body === "string" && t.title.trim() && t.body.trim()) {
      out.push({ lang_code: code, title: t.title.trim(), body: t.body.trim() });
    }
  }
  return out;
}
