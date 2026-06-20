import { Octokit } from "octokit";
import type { Env, IdeaIssue } from "./types.js";
import { ANNOUNCED_LABEL, type GhIssueLite } from "./shipped.js";

const REQUIRED = [
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
] as const;

function assertEnv(obj: any): asserts obj is Env {
  for (const k of REQUIRED) {
    if (!process.env[k]) throw new Error(`Missing env ${k}`);
  }
}

assertEnv(process.env);

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;

export async function createIdeaIssue({ title, body }: { title: string; body: string }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
    labels: ["idea"]
  });
  return res.data;
}

export async function setPriorityLabel(issueNumber: number, priority: 1|2|3|4|5) {
  const label = `P${priority}`;
  // Ensure label exists (idempotent)
  try {
    await octokit.request("POST /repos/{owner}/{repo}/labels", {
      owner,
      repo,
      name: label,
      color: priority === 1 ? "e11d48" : priority === 2 ? "f97316" : priority === 3 ? "eab308" : priority === 4 ? "22c55e" : "3b82f6",
      description: `Priority ${priority}`,
    });
  } catch (_) { /* already exists */ }

  // Fetch current labels
  const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner,
    repo,
    issue_number: issueNumber
  });

  const other = (issue.labels || []).filter((l: any) => typeof l.name === 'string' && !/^P[1-5]$/.test(l.name));
  const labels = [...other.map((l:any) => l.name), label];

  await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: issueNumber,
    labels,
  });
}

export async function listTopIdeas(limit: number) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    state: "open",
    labels: "idea",
    per_page: 100,
  });
  const issues = res.data as any[];
  return issues.map((i) => ({
    number: i.number,
    title: i.title,
    html_url: i.html_url,
    reactions: i.reactions || { "+1": 0 },
    labels: i.labels || [],
  }));
}

// --- "Shipped" announcement support ---

// List closed issues (most-recently-updated first), shaped for shipped.ts to
// filter. The issues endpoint also returns PRs; isAnnounceable() drops those.
// A few pages is plenty given how rarely issues close.
export async function listClosedTrackedIssues(): Promise<GhIssueLite[]> {
  const out: GhIssueLite[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await octokit.request("GET /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });
    const batch = res.data as any[];
    out.push(...(batch as GhIssueLite[]));
    if (batch.length < 100) break;
  }
  return out;
}

// Create the `announced` label if it doesn't exist (idempotent).
export async function ensureAnnouncedLabel(): Promise<void> {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/labels", {
      owner,
      repo,
      name: ANNOUNCED_LABEL,
      color: "8b5cf6",
      description: "Shipped — submitter has been notified",
    });
  } catch (_) {
    /* already exists */
  }
}

// Whether the `announced` label exists in the repo — used to detect first run
// so we can silently seed the backlog instead of announcing it.
export async function repoHasAnnouncedLabel(): Promise<boolean> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner,
      repo,
      name: ANNOUNCED_LABEL,
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Stamp the `announced` label on an issue, preserving its other labels.
export async function markIssueAnnounced(issueNumber: number): Promise<void> {
  await ensureAnnouncedLabel();
  const { data: issue } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}",
    { owner, repo, issue_number: issueNumber }
  );
  const names = (issue.labels || []).map((l: any) =>
    typeof l === "string" ? l : l.name
  );
  if (names.includes(ANNOUNCED_LABEL)) return;
  await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner,
    repo,
    issue_number: issueNumber,
    labels: [...names, ANNOUNCED_LABEL],
  });
}

// --- Discord vote comment management ---
const VOTE_MARKER_PREFIX = "Discord votes:"; // we will manage a single bot comment with this prefix

export async function upsertDiscordVoteComment(issueNumber: number, votes: number) {
  // Find existing bot comment
  const comments = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner, repo, issue_number: issueNumber, per_page: 100
  });

  const me = await octokit.request("GET /user"); // who am I (token owner/bot)
  const myLogin = (me.data as any).login;

  const existing = (comments.data as any[]).find(c =>
    c.user?.login === myLogin && typeof c.body === 'string' && c.body.startsWith(VOTE_MARKER_PREFIX)
  );

  const body = `${VOTE_MARKER_PREFIX} ${votes}`;

  if (existing) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner, repo, comment_id: existing.id, body
    });
  } else {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: issueNumber, body
    });
  }
}

export async function readDiscordVoteCount(issueNumber: number): Promise<number> {
  const comments = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner, repo, issue_number: issueNumber, per_page: 100
  });

  const me = await octokit.request("GET /user");
  const myLogin = (me.data as any).login;

  const existing = (comments.data as any[]).find(c =>
    c.user?.login === myLogin && typeof c.body === 'string' && c.body.startsWith(VOTE_MARKER_PREFIX)
  );
  if (!existing) return 0;

  const m = String(existing.body).match(/^Discord votes:\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

export async function fetchIssue(issueNumber: number) {
  
  const { data } = await octokit.rest.issues.get({
    owner: owner,
    repo: repo,
    issue_number: issueNumber,
  });
  return data; // { title, body, html_url, number, ... }
}

// Pull the **Summary** block from your standardized issue body
export function extractSummaryFromIssueBody(body: string | null | undefined): string {
  if (!body) return "";
  // Capture text after **Summary** until the next **Section** or end
  const m = body.match(/\*\*Summary\*\*\s*\n([\s\S]*?)(?:\n\s*\*\*|$)/i);
  const raw = (m?.[1] || "").trim();
  // Tidy: collapse extra blank lines
  return raw.replace(/\n{3,}/g, "\n\n").trim();
}

export async function listOpenIssuesByLabel(label: string) {
  const res = await octokit.request("GET /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    state: "open",
    labels: label,
    per_page: 100,
  });
  // The issues endpoint also returns PRs — exclude them.
  return (res.data as any[])
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number as number, title: String(i.title), html_url: String(i.html_url) }));
}

export async function createBugIssue({ title, body }: { title: string; body: string }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
    labels: ["bug"]
  });
  return res.data;
}

export async function createFeatureIssue({ title, body }: { title: string; body: string }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
    labels: ["feature"]
  });
  return res.data;
}

export async function createFeedbackIssue({ title, body }: { title: string; body: string }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
    labels: ["feedback"]
  });
  return res.data;
}
