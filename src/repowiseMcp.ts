// src/repowiseMcp.ts
// Thin MCP client over repowise's hosted server. Connects lazily on first use,
// lists tools, filters to an allowlist, and bridges MCP tool schemas into
// OpenAI function definitions. If REPOWISE_MCP_URL is unset, the feature is
// disabled and every accessor returns an empty/no-op result.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Intersected with whatever tools/list actually returns. `list_repos` (in the
// design) is not served by the current repowise; `get_overview` is the closest
// available repo-orientation tool, so it stands in.
export const ALLOWED_TOOLS = ["search_codebase", "get_symbol", "get_context", "get_overview"] as const;

export type OpenAiToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

export function buildAuthHeaders(env: {
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}): Record<string, string> {
  const { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = env;
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) return {};
  return {
    "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
  };
}

export function mapMcpToolToOpenAi(tool: McpTool): OpenAiToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: (tool.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
    },
  };
}

export function filterAllowed(tools: McpTool[], allow: readonly string[]): McpTool[] {
  const set = new Set(allow);
  return tools.filter((t) => set.has(t.name));
}

export function isRepowiseEnabled(): boolean {
  return Boolean(process.env.REPOWISE_MCP_URL);
}

// ---- Lazy connection ----
let clientPromise: Promise<Client> | null = null;
let cachedTools: McpTool[] | null = null;

function makeTransport() {
  const url = new URL(process.env.REPOWISE_MCP_URL as string);
  const headers = buildAuthHeaders({
    CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET,
  });
  const requestInit = { headers };
  if (url.pathname.endsWith("/sse")) {
    return new SSEClientTransport(url, { requestInit });
  }
  return new StreamableHTTPClientTransport(url, { requestInit });
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "beyond-horizon-bot", version: "0.1.0" }, { capabilities: {} });
      await client.connect(makeTransport());
      return client;
    })();
  }
  return clientPromise;
}

/** Reset connection state so the next call reconnects (used after a dropped session). */
function resetConnection() {
  clientPromise = null;
  cachedTools = null;
}

async function listAllowedTools(): Promise<McpTool[]> {
  if (cachedTools) return cachedTools;
  const client = await getClient();
  const res = await client.listTools();
  cachedTools = filterAllowed((res.tools as McpTool[]) || [], ALLOWED_TOOLS);
  return cachedTools;
}

/** OpenAI function definitions for the allowlisted repowise tools, or [] if disabled/unreachable. */
export async function getOpenAiTools(): Promise<OpenAiToolDef[]> {
  if (!isRepowiseEnabled()) return [];
  try {
    const tools = await listAllowedTools();
    return tools.map(mapMcpToolToOpenAi);
  } catch (err) {
    console.warn("[repowise] getOpenAiTools failed:", err);
    resetConnection();
    return [];
  }
}

/** Call a repowise tool and return its text content (joined). Throws on failure. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const client = await getClient();
    const res: any = await client.callTool({ name, arguments: args });
    const content = (res?.content || []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } catch (err) {
    resetConnection(); // drop a stale session so the next call reconnects
    throw err;
  }
}
