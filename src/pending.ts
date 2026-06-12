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
 * Sweep expired drafts. For each one past TTL: invoke onExpire (auto-file),
 * retry once on failure, then delete regardless (so the map never grows
 * unbounded). Drafts within TTL are untouched.
 */
export async function sweepExpired(now: number, onExpire?: OnExpire) {
  const cb = onExpire ?? onExpireCb;
  for (const [id, p] of PENDING.entries()) {
    if (now - p.createdAt <= TTL_MS) continue;
    if (cb) {
      try {
        await cb(p);
      } catch (err1) {
        console.warn(`[pending] onExpire failed for ${id}, retrying once:`, err1);
        try {
          await cb(p);
        } catch (err2) {
          console.warn(`[pending] onExpire retry failed for ${id}, dropping draft:`, err2);
        }
      }
    }
    PENDING.delete(id);
  }
}

// Periodic cleanup (no-ops gracefully if no callback registered).
setInterval(() => {
  void sweepExpired(Date.now());
}, 60_000);
