// src/codeContextTypes.ts
// Shared shape for code-search results. Lives alone so ai.ts, aiBug.ts,
// pending.ts, and aiCodeContext.ts can all import it without circular deps.

export type CodePointer = {
  repo: string;
  path: string;
  symbol?: string;
  reason: string;
};

export type CodeContext = {
  whereToStart: CodePointer[];
  suspectedCause?: string | null;
  affectedSystems: string[];
  confidence: "high" | "medium" | "low";
};

/**
 * Render the "Where to Start" markdown block (pointer list + confidence
 * footnote). Returns "" when there are no pointers, so callers can omit the
 * whole section. Does NOT include the `## Where to Start` heading — callers add it.
 */
export function renderWhereToStart(ctx: CodeContext | null | undefined): string {
  if (!ctx || !ctx.whereToStart?.length) return "";
  const lines = ctx.whereToStart.map((p) => {
    const symbol = p.symbol ? ` → \`${p.symbol}()\`` : "";
    return `- \`${p.repo}\` — \`${p.path}\`${symbol}: ${p.reason}`;
  });
  return `_(AI-generated from code index, confidence: ${ctx.confidence})_\n${lines.join("\n")}`;
}
