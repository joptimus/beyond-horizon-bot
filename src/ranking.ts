import type { IdeaIssue } from "./types.js";

function priorityWeight(labels: { name?: string }[]): number {
  const p = labels.find(l => l.name && /^P[1-5]$/.test(l.name));
  if (!p?.name) return 0;
  const n = Number(p.name.replace("P", ""));
  return ({ 1: 50, 2: 30, 3: 15, 4: 5, 5: 1 } as any)[n] ?? 0;
}

export function rankIdeas(issues: IdeaIssue[]): IdeaIssue[] {
  return [...issues].sort((a, b) => {
    const va = (a.reactions["+1"] || 0) + priorityWeight(a.labels);
    const vb = (b.reactions["+1"] || 0) + priorityWeight(b.labels);
    if (vb !== va) return vb - va;
    return a.number - b.number;
  });
}
