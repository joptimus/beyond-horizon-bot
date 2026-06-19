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

/**
 * True when `err` looks like the server lost our session (SSE/Streamable HTTP
 * both surface this when the long-lived stream was dropped — e.g. by an idle
 * proxy timeout or a backend restart). The TS client wraps it as
 * `Error POSTing to endpoint (HTTP 404): Could not find session`.
 */
function isStaleSessionError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return (
    msg.includes("could not find session") || // SSE transport (mcp/server/sse.py)
    msg.includes("session not found") || // Streamable HTTP transport
    msg.includes("no valid session") ||
    msg.includes("missing session id") ||
    msg.includes("session terminated") ||
    msg.includes("(http 404)") ||
    msg.includes("(http 400)")
  );
}

/**
 * Run an operation that depends on the live MCP session, transparently
 * reconnecting once if the session was dropped. Any other failure drops the
 * client (so the next call starts clean) and is surfaced unchanged.
 */
async function withSessionRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    resetConnection();
    if (!isStaleSessionError(err)) throw err;
    console.warn(`[repowise] ${label}: session dropped, reconnecting and retrying once`);
    return op();
  }
}

async function fetchAllowedTools(): Promise<McpTool[]> {
  const client = await getClient();
  const res = await client.listTools();
  return filterAllowed((res.tools as McpTool[]) || [], ALLOWED_TOOLS);
}

async function listAllowedTools(): Promise<McpTool[]> {
  if (cachedTools) return cachedTools;
  cachedTools = await withSessionRetry("listTools", fetchAllowedTools);
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

/**
 * Startup diagnostic. Logs which repowise/CF Access env vars are present (never
 * the secret values), probes the endpoint with a raw HTTP request to surface
 * Cloudflare Access verdicts, then attempts a full MCP handshake.
 */
export async function testConnectionOnStartup(): Promise<void> {
  const rawUrl = process.env.REPOWISE_MCP_URL;
  if (!rawUrl) {
    console.log("[repowise] REPOWISE_MCP_URL not set — code-context enrichment disabled.");
    return;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.error(`[repowise] REPOWISE_MCP_URL is not a valid URL: "${rawUrl}"`);
    return;
  }

  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  const transport = url.pathname.endsWith("/sse") ? "SSE" : "StreamableHTTP";
  console.log(`[repowise] URL: ${url.origin}${url.pathname} (transport: ${transport})`);
  console.log(
    `[repowise] CF-Access-Client-Id: ${id ? `set (${id.slice(0, 8)}…, ${id.length} chars)` : "MISSING"} | ` +
      `CF-Access-Client-Secret: ${secret ? `set (${secret.length} chars)` : "MISSING"}`
  );
  if (!id || !secret) {
    console.error(
      "[repowise] CF Access service-token env vars are missing — requests reach Cloudflare Access with no credentials and will be rejected with 403."
    );
  }

  // Raw probe: a 403 here is Cloudflare Access rejecting the service token
  // before the request ever reaches repowise.
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildAuthHeaders({ CF_ACCESS_CLIENT_ID: id, CF_ACCESS_CLIENT_SECRET: secret }),
    });
    res.body?.cancel().catch(() => {});
    console.log(`[repowise] HTTP probe: ${res.status} ${res.statusText}`);
    if (res.status === 403) {
      console.error(
        "[repowise] 403 = Cloudflare Access rejected the credentials. Check: " +
          "(1) the service token exists and is not expired/revoked (Zero Trust → Access → Service Tokens), " +
          "(2) the Access application for this hostname has a policy with action 'Service Auth' that includes this token, " +
          "(3) the env values carry no surrounding quotes or whitespace."
      );
    }
  } catch (err: any) {
    console.error(`[repowise] HTTP probe failed before getting a response: ${err?.message || err}`);
  }

  // Full MCP handshake through the real client path.
  try {
    const tools = await listAllowedTools();
    console.log(
      `[repowise] MCP connect OK — allowlisted tools: ${tools.map((t) => t.name).join(", ") || "(none matched allowlist)"}`
    );
  } catch (err: any) {
    resetConnection();
    console.error(`[repowise] MCP connect FAILED: ${String(err?.message || err).slice(0, 300)}`);
  }
}

/** Call a repowise tool and return its text content (joined). Throws on failure. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return withSessionRetry(`callTool(${name})`, async () => {
    const client = await getClient();
    const res: any = await client.callTool({ name, arguments: args });
    const content = (res?.content || []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  });
}
