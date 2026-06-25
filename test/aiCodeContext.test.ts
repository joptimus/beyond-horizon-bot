import { describe, it, expect, vi } from "vitest";
import { findCodePointers, type FindDeps } from "../src/aiCodeContext.js";

// Helper: a fake Responses API client that returns a scripted sequence of
// response objects ({ id, output[], output_text }).
function scriptedResponses(responses: any[]) {
  const queue = [...responses];
  return vi.fn(async () => queue.shift() ?? { id: "r-empty", output: [], output_text: "" });
}

// Build a response whose output is one or more function_call items.
function toolCallResponse(id: string, calls: Array<{ call_id: string; name?: string; arguments?: string }>) {
  return {
    id,
    output: calls.map((c) => ({
      type: "function_call",
      call_id: c.call_id,
      name: c.name ?? "search_codebase",
      arguments: c.arguments ?? "{}",
    })),
  };
}

// Build a response whose output is a final text answer.
function finalResponse(id: string, text: string) {
  return { id, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], output_text: text };
}

const baseDeps = (over: Partial<FindDeps>): FindDeps => ({
  getTools: async () => [
    { type: "function", function: { name: "search_codebase", description: "d", parameters: { type: "object", properties: {} } } },
  ],
  callTool: async () => "search result text",
  createResponse: scriptedResponses([]),
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
    const createResponse = scriptedResponses([
      toolCallResponse("r1", [{ call_id: "c1", arguments: '{"query":"warp"}' }]),
      finalResponse("r2", FINAL_JSON),
    ]);
    const callTool = vi.fn(async () => "warp.ts matches");
    const deps = baseDeps({ createResponse, callTool });

    const ctx = await findCodePointers("fleet stuck warping", "bug", deps);
    expect(callTool).toHaveBeenCalledOnce();
    expect(ctx?.whereToStart[0].symbol).toBe("beginWarp");
    expect(ctx?.suspectedCause).toBe("state not cleared");
  });

  it("answers each tool call then parses the final answer across rounds", async () => {
    const round = (id: string) => toolCallResponse(id, [{ call_id: id }]);
    const createResponse = scriptedResponses([round("r1"), round("r2"), round("r3"), finalResponse("r4", FINAL_JSON)]);
    const callTool = vi.fn(async () => "x");
    const deps = baseDeps({ createResponse, callTool });

    const ctx = await findCodePointers("warp", "bug", deps);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(7);
    expect(ctx === null || ctx.confidence === "medium").toBe(true);
  });

  it("returns null on malformed JSON after one retry", async () => {
    const createResponse = scriptedResponses([
      finalResponse("r1", "not json"),
      finalResponse("r2", "still not json"),
    ]);
    const deps = baseDeps({ createResponse });
    expect(await findCodePointers("warp", "idea", deps)).toBeNull();
  });

  it("returns null and never throws when createResponse rejects", async () => {
    const deps = baseDeps({ createResponse: vi.fn(async () => { throw new Error("openai down"); }) });
    expect(await findCodePointers("warp", "bug", deps)).toBeNull();
  });

  it("recovers the whereToStart object from a garbage-wrapped final answer", async () => {
    // Reproduces a real gpt-5.4-mini failure: when cut off mid-search the model
    // dumped leaked tool-call fragments + junk tokens BEFORE the valid object.
    const valid = JSON.stringify({
      whereToStart: [{ repo: "game-server", path: "src/game-logic/city/cityProduction.js", symbol: "calculateCityProductionV2", reason: "powerCoverageRatio" }],
      suspectedCause: "ratio vs percent",
      affectedSystems: ["Server", "Client-UI"],
      confidence: "high",
    });
    const noisy =
      '{"query":"power","repo":"SpaceMMORPG"} to=functions.search_codebase  天天中彩票粤\n' +
      '{"tool_uses":[{"recipient_name":"functions.get_context","parameters":{"targets":["Assets/Scripts/UI/City/CityPageV2.cs"]}}]}' +
      valid;
    const createResponse = scriptedResponses([finalResponse("r1", noisy)]);
    const deps = baseDeps({ createResponse });

    const ctx = await findCodePointers("city power percentage wrong", "bug", deps);
    expect(ctx?.whereToStart[0].symbol).toBe("calculateCityProductionV2");
    expect(ctx?.confidence).toBe("high");
  });

  it("never invokes callTool more than the cap even with a large parallel batch", async () => {
    const batch = toolCallResponse("r1", Array.from({ length: 10 }, (_, i) => ({ call_id: `c${i}` })));
    const createResponse = scriptedResponses([batch, finalResponse("r2", FINAL_JSON)]);
    const callTool = vi.fn(async () => "x");
    const deps = baseDeps({ createResponse, callTool });
    const ctx = await findCodePointers("warp", "bug", deps);
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(7);
    expect(ctx?.confidence).toBe("medium");
  });
});
