// src/dupeCheck.ts
import { getOpenAiClient, OPENAI_MODEL, stripFences, samplingFor } from "./aiShared.js";
import { listOpenIssuesByLabel } from "./github.js";

export type DuplicateCandidate = { number: number; title: string; html_url: string };

const SYSTEM = `
You deduplicate player-submitted reports for a game development team.
Given a new report and a list of existing open issues, identify which existing issues (if any) describe the same underlying problem or request.
Be conservative: only flag an issue when it plausibly covers the same thing, not merely the same game system or feature area.
`;

function buildPrompt(rawText: string, candidates: DuplicateCandidate[]) {
  const list = candidates.map((c) => `#${c.number}: ${c.title}`).join("\n");
  return `
New report:
"""${rawText}"""

Existing open issues:
${list}

Return ONLY valid JSON: {"duplicates": [<issue numbers that likely describe the same problem>]}
Use {"duplicates": []} if none match.
`;
}

/**
 * Compare a new report against open GitHub issues with the given label.
 * Returns the issues that likely describe the same thing.
 * Never throws — on any failure the check degrades to "no duplicates found".
 */
export async function findPossibleDuplicates(
  rawText: string,
  label: "bug" | "idea"
): Promise<DuplicateCandidate[]> {
  try {
    const candidates = await listOpenIssuesByLabel(label);
    if (!candidates.length) return [];

    const res = await getOpenAiClient().chat.completions.create({
      model: OPENAI_MODEL,
      ...samplingFor({ temperature: 0 }),
      response_format: { type: "json_object" } as any,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(rawText, candidates) },
      ],
    } as any);

    const content = res.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(stripFences(content));
    const nums = new Set(
      (Array.isArray(parsed.duplicates) ? parsed.duplicates : []).map(Number)
    );
    return candidates.filter((c) => nums.has(c.number));
  } catch (e) {
    console.error("[DUPE] duplicate check failed:", e);
    return [];
  }
}

/** Markdown block for Discord embeds; empty string when there are no matches. */
export function renderDuplicatesBlock(dupes: DuplicateCandidate[]): string {
  if (!dupes.length) return "";
  const lines = dupes
    .slice(0, 5)
    .map((d) => `• [#${d.number}](${d.html_url}) ${d.title}`)
    .join("\n");
  return `\n\n🔗 **Related issues found** — the GitHub issue will reference them:\n${lines}`;
}

/**
 * GitHub-markdown section appended to the new issue body. The bare `#N`
 * mentions make GitHub show a cross-reference on each related issue, so the
 * link is visible from both sides.
 */
export function renderRelatedIssuesSection(related?: DuplicateCandidate[] | null): string {
  if (!Array.isArray(related) || !related.length) return "";
  const lines = related.slice(0, 5).map((d) => `- #${d.number} ${d.title}`).join("\n");
  return `\n\n## Related Issues\n${lines}`;
}
