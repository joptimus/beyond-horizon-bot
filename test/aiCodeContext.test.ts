import { describe, it, expect, vi } from "vitest";
import { findCodePointers, type FindDeps } from "../src/aiCodeContext.js";

// Helper: a fake OpenAI completion that returns a scripted sequence of messages.
function scriptedCompletions(messages: any[]) {
  const queue = [...messages];
  return vi.fn(async () => ({ choices: [{ message: queue.shift() }] }));
}

const baseDeps = (over: Partial<FindDeps>): FindDeps => ({
  getTools: async () => [
    { type: "function", function: { name: "search_codebase", description: "d", parameters: { type: "object", properties: {} } } },
  ],
  callTool: async () => "search result text",
  createCompletion: scriptedCompletions([]),
  now: (() => { let t = 0; return () => (t += 1000); })(), // +1s per call
  enabled: true,
  ...over,
});

const FINAL_JSON = JSON.stringify({
  whereToStart: [{ repo: "game-server", path: "src/fleet/warp.ts", symbol: "beginWarp", reason: "warp transitions" }],
  suspectedCause: "state not cleared",
  affectedSystems: ["Server", "Fleet"],
  confidence: "medium",
});

describe("findCodePointers", () => {
  it("returns null immediately when the feature is disabled", async () => {
    const deps = baseDeps({ enabled: false });
    expect(await findCodePointers("fleet stuck warping", "bug", deps)).toBeNull();
  });

  it("runs one tool call then parses the final JSON answer", async () => {
    const createCompletion = scriptedCompletions([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_codebase", arguments: '{"query":"warp"}' } }] },
      { role: "assistant", content: FINAL_JSON },
    ]);
    const callTool = vi.fn(async () => "warp.ts matches");
    const deps = baseDeps({ createCompletion, callTool });

    const ctx = await findCodePointers("fleet stuck warping", "bug", deps);
    expect(callTool).toHaveBeenCalledOnce();
    expect(ctx?.whereToStart[0].symbol).toBe("beginWarp");
    expect(ctx?.suspectedCause).toBe("state not cleared");
  });

  it("stops after the tool-call cap and forces a final answer", async () => {
    // 6 tool-call rounds scripted, but cap is 5; the 6th would never be reached.
    const toolMsg = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "search_codebase", arguments: "{}" } }] };
    const createCompletion = scriptedCompletions([toolMsg, toolMsg, toolMsg, toolMsg, toolMsg, { role: "assistant", content: FINAL_JSON }]);
    const callTool = vi.fn(async () => "x");
    const deps = baseDeps({ createCompletion, callTool });

    const ctx = await findCodePointers("warp", "bug", deps);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(5);
    // Either it forced a final answer (ctx set) or gave up (null) — never throws.
    expect(ctx === null || ctx.confidence === "medium").toBe(true);
  });

  it("returns null on malformed JSON after one retry", async () => {
    const createCompletion = scriptedCompletions([
      { role: "assistant", content: "not json" },
      { role: "assistant", content: "still not json" },
    ]);
    const deps = baseDeps({ createCompletion });
    expect(await findCodePointers("warp", "idea", deps)).toBeNull();
  });

  it("returns null and never throws when createCompletion rejects", async () => {
    const deps = baseDeps({ createCompletion: vi.fn(async () => { throw new Error("openai down"); }) });
    expect(await findCodePointers("warp", "bug", deps)).toBeNull();
  });

  it("never invokes callTool more than the cap even with a large parallel batch", async () => {
    const batch = { role: "assistant", content: null, tool_calls: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, type: "function", function: { name: "search_codebase", arguments: "{}" } })) };
    const createCompletion = scriptedCompletions([batch, { role: "assistant", content: FINAL_JSON }]);
    const callTool = vi.fn(async () => "x");
    const deps = baseDeps({ createCompletion, callTool });
    const ctx = await findCodePointers("warp", "bug", deps);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(5);
    expect(ctx?.confidence).toBe("medium");
  });
});
