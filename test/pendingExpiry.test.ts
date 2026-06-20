import { describe, it, expect, vi, beforeEach } from "vitest";
import { putPending, getPending, delPending, setOnExpire, sweepExpired, type PendingIdea } from "../src/pending.js";

function draft(id: string, createdAt: number): PendingIdea {
  return { type: "idea", id, authorId: "u1", rawText: "raw", title: "[IDEA] t", body: "b", createdAt, phase: "awaiting_approval" };
}

describe("sweepExpired", () => {
  beforeEach(() => {
    // clear any leftovers
    ["a", "b", "c"].forEach(delPending);
    setOnExpire(undefined as any);
  });

  it("does not touch drafts younger than the TTL", async () => {
    putPending(draft("a", 1_000));
    const onExpire = vi.fn(async () => {});
    await sweepExpired(1_000 + 5 * 60_000, onExpire); // 5 min < 10 min TTL
    expect(onExpire).not.toHaveBeenCalled();
    expect(getPending("a")).toBeTruthy();
  });

  it("calls onExpire then deletes an expired draft", async () => {
    putPending(draft("b", 0));
    const onExpire = vi.fn(async () => {});
    setOnExpire(onExpire);
    await sweepExpired(11 * 60_000, onExpire); // 11 min > 10 min TTL
    expect(onExpire).toHaveBeenCalledOnce();
    expect(getPending("b")).toBeUndefined();
  });

  it("invokes onExpire once and drops the draft even if it throws", async () => {
    putPending(draft("c", 0));
    const onExpire = vi.fn(async () => { throw new Error("github down"); });
    await sweepExpired(11 * 60_000, onExpire);
    // sweep deletes up-front and calls onExpire once; the retry-once lives in the
    // bot.ts onExpire callback now (hardened against races / duplicate issues).
    expect(onExpire).toHaveBeenCalledOnce();
    expect(getPending("c")).toBeUndefined();
  });
});
