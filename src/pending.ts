// src/pending.ts
export type PendingIdea = {
  id: string;
  authorId: string;
  rawText: string;
  title: string;     // will be updated after re-enrich
  body: string;      // will be updated after re-enrich
  createdAt: number;
  // NEW for Q&A
  openQuestions?: string[];
  answersText?: string; // concatenated "Q1: ...\nA1: ...", etc.
  phase?: "awaiting_answers" | "awaiting_approval";
};

const PENDING = new Map<string, PendingIdea>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function putPending(p: PendingIdea) { PENDING.set(p.id, p); }
export function getPending(id: string) { return PENDING.get(id); }
export function delPending(id: string) { PENDING.delete(id); }

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of PENDING.entries()) {
    if (now - p.createdAt > TTL_MS) PENDING.delete(id);
  }
}, 60_000);
