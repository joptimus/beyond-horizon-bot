import { Octokit } from "octokit";
import type { Env, IdeaIssue } from "./types.js";

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
