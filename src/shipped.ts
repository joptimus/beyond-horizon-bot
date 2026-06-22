// Pure logic for the "your idea/bug shipped" announcement feature.
//
// Kept free of Octokit / discord.js imports so it can be unit-tested without
// the GitHub env guards in github.ts firing at import time (mirrors how
// pending.ts isolates testable logic).

// Issue labels we originated from the Discord pipeline. Only issues carrying
// one of these are eligible for a "shipped" announcement.
export const TRACKED_LABELS = ["idea", "bug", "feature", "feedback"] as const;

// Label stamped on an issue once its announcement has gone out, so polling
// never double-announces. State lives on GitHub, surviving bot restarts.
export const ANNOUNCED_LABEL = "announced";

// Minimal shape of a GitHub issue as returned by the REST list endpoint —
// only the fields this feature reasons about.
export interface GhIssueLite {
  number: number;
  title: string;
  html_url: string;
  state: string; // "open" | "closed"
  state_reason: string | null; // "completed" | "not_planned" | "reopened" | null
  body: string | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown; // present => it's a PR, not an issue
}

// Discord IDs are written into every bot-created issue body as
// "(Discord ID: <snowflake>)" (see ai.ts). Pull it back out to know who to ping.
export function parseDiscordId(body: string | null): string | null {
  if (!body) return null;
  const m = body.match(/Discord ID:\s*(\d+)/);
  return m ? m[1] : null;
}

function labelNames(issue: GhIssueLite): string[] {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

// Should this issue trigger a "shipped" announcement? True only when it is a
// closed-as-completed issue (not a PR) from our pipeline, with a submitter we
// can notify, that hasn't already been announced.
export function isAnnounceable(issue: GhIssueLite): boolean {
  if (issue.pull_request) return false;
  if (issue.state !== "closed") return false;
  if (issue.state_reason !== "completed") return false;

  const names = labelNames(issue);
  if (names.includes(ANNOUNCED_LABEL)) return false;
  if (!names.some((n) => (TRACKED_LABELS as readonly string[]).includes(n))) return false;

  return parseDiscordId(issue.body) !== null;
}

// Build the Voran-themed "shipped" message. Returns plain strings; the caller
// wraps them in an EmbedBuilder so this stays pure/testable.
export function renderShippedMessage(opts: {
  issueTitle: string;
  issueNumber: number;
  memberId: string;
}): { title: string; description: string } {
  return {
    title: "Directive Resolved · Incoming From Command",
    description:
      `<@${opts.memberId}>, your report has been actioned by the fleet engineers.\n\n` +
      `**${opts.issueTitle}** is now resolved and slated for an upcoming release.\n\n` +
      `Status: Github issue #${opts.issueNumber} has been closed.\n\n` +
      `The horizon advances because commanders like you chart the way.`,
  };
}
