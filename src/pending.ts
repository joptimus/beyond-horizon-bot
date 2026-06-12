// src/pending.ts
import type { CodeContext } from "./codeContextTypes.js";

export type PendingIdea = {
  type: 'idea' | 'bug';
  id: string;
  authorId: string;
  rawText: string;
  title: string;     // will be updated after re-enrich
  body: string;      // will be updated after re-enrich
  createdAt: number;
  // Q&A
  openQuestions?: string[];
  answersText?: string; // concatenated "Q1: ...\nA1: ...", etc.
  phase?: "awaiting_answers" | "awaiting_approval";
  // Code search result, cached so the Q&A round-trip and expiry reuse it.
  codeContext?: CodeContext | null;
  // Discord refs (set by bot.ts / commands) — kept loosely typed via index signature.
  [key: string]: unknown;
};

const PENDING = new Map<string, PendingIdea>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function putPending(p: PendingIdea) { PENDING.set(p.id, p); }
export function getPending(id: string) { return PENDING.get(id); }
export function delPending(id: string) { PENDING.delete(id); }

// Callback registered by bot.ts to file the issue when a draft expires.
export type OnExpire = (draft: PendingIdea) => Promise<void>;
let onExpireCb: OnExpire | undefined;
export function setOnExpire(cb: OnExpire | undefined) { onExpireCb = cb; }

/**
 * Sweep expired drafts. Expired entries are claimed synchronously (deleted
 * before any await) so a concurrent sweep tick — or an Approve click racing
 * the sweep — can never process the same draft twice. onExpire (auto-file)
 * then runs per claimed draft; retries and user notification on failure are
 * the callback's responsibility.
 */
export async function sweepExpired(now: number, onExpire?: OnExpire) {
  const cb = onExpire ?? onExpireCb;
  const expired: PendingIdea[] = [];
  for (const [id, p] of PENDING.entries()) {
    if (now - p.createdAt <= TTL_MS) continue;
    PENDING.delete(id);
    expired.push(p);
  }
  if (!cb) return;
  for (const p of expired) {
    try {
      await cb(p);
    } catch (err) {
      console.warn(`[pending] onExpire failed for ${p.id}, dropping draft:`, err);
    }
  }
}

// Periodic cleanup (no-ops gracefully if no callback registered).
setInterval(() => {
  void sweepExpired(Date.now());
}, 60_000);
