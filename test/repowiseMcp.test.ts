import { describe, it, expect } from "vitest";
import {
  buildAuthHeaders,
  mapMcpToolToOpenAi,
  filterAllowed,
  ALLOWED_TOOLS,
} from "../src/repowiseMcp.js";

describe("buildAuthHeaders", () => {
  it("sets CF Access service-token headers when both are present", () => {
    const h = buildAuthHeaders({ CF_ACCESS_CLIENT_ID: "id-123", CF_ACCESS_CLIENT_SECRET: "secret-xyz" });
    expect(h["CF-Access-Client-Id"]).toBe("id-123");
    expect(h["CF-Access-Client-Secret"]).toBe("secret-xyz");
  });

  it("returns an empty object when credentials are missing", () => {
    expect(buildAuthHeaders({})).toEqual({});
  });
});

describe("mapMcpToolToOpenAi", () => {
  it("maps an MCP tool to an OpenAI function definition", () => {
    const mcpTool = {
      name: "search_codebase",
      description: "semantic + FTS search",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    };
    const fn = mapMcpToolToOpenAi(mcpTool);
    expect(fn.type).toBe("function");
    expect(fn.function.name).toBe("search_codebase");
    expect(fn.function.description).toBe("semantic + FTS search");
    expect(fn.function.parameters).toEqual(mcpTool.inputSchema);
  });

  it("substitutes an empty-object schema when inputSchema is absent", () => {
    const fn = mapMcpToolToOpenAi({ name: "x", description: "d" } as any);
    expect(fn.function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("filterAllowed", () => {
  it("keeps only allowlisted tools and ignores unknown ones", () => {
    const tools = [
      { name: "search_codebase" },
      { name: "get_symbol" },
      { name: "get_health" }, // not allowlisted
      { name: "list_repos" }, // allowlisted-by-spec but not served here -> simply absent
    ] as any[];
    const kept = filterAllowed(tools, ALLOWED_TOOLS).map((t) => t.name);
    expect(kept).toContain("search_codebase");
    expect(kept).toContain("get_symbol");
    expect(kept).not.toContain("get_health");
  });
});
