import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { env } from "@/server/env";
import { type FetchDeps, defaultFetchDeps, handleFetch } from "@/server/fetch/fetch-handler";
import { type PayDeps, defaultPayDeps, handlePay } from "@/server/payments/pay-handler";
import { handleTool } from "@/server/tools/tool-handler";
import { createAgentVaultMcpServer } from "@/mcp/tools";

/**
 * /api/mcp, the Streamable HTTP MCP server (mcp-server MCP-6 to MCP-9).
 * Stateless: each HTTP request gets its own server and transport, and
 * answers with JSON, so nothing is shared between Vercel instances.
 *
 * The caller's bearer key is the agent key. Each tool call becomes a
 * request to the pay, tool, or fetch route handler in this process, with
 * that key, so an MCP call gets the same authentication, validation,
 * checks, audit, and idempotency as the HTTP API, through the same code
 * (MCP-2, MCP-9). A missing or bad key fails each tool call with an
 * authentication error and does nothing (MCP-7).
 */

export interface McpRouteDeps {
  pay: PayDeps;
  fetch: FetchDeps;
  /** APP_ORIGIN, for the dashboard link in held results. */
  baseUrl: () => string;
}

export function defaultMcpRouteDeps(): McpRouteDeps {
  return { pay: defaultPayDeps(), fetch: defaultFetchDeps(), baseUrl: env.appOrigin };
}

/** Tool calls carry small JSON bodies. */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/i;

/** The bearer token, or undefined if there isn't a well-formed one. */
export function bearerKeyOf(request: Request): string | undefined {
  return BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
}

/** A fetch that sends the agent API's requests to their route handlers in this process. */
export function inProcessApi(deps: Pick<McpRouteDeps, "pay" | "fetch">): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === "/api/v1/pay") return handlePay(request, deps.pay);
    if (pathname === "/api/v1/tool") return handleTool(request, deps.pay);
    if (pathname === "/api/v1/fetch") return handleFetch(request, deps.fetch);
    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export async function handleMcp(request: Request, deps: McpRouteDeps = defaultMcpRouteDeps()): Promise<Response> {
  // Stateless, so there is no server-to-client stream (GET) or session to end (DELETE). The SDK
  // would answer GET with an open event stream, holding a function until its time limit for nothing.
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
      status: 405,
      headers: { allow: "POST", "content-type": "application/json" },
    });
  }
  const baseUrl = deps.baseUrl();
  const server = createAgentVaultMcpServer({ baseUrl, apiKey: bearerKeyOf(request), fetch: inProcessApi(deps) });
  // No sessionIdGenerator: stateless mode.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MCP_MAX_BODY_BYTES });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error("mcp request failed:", error instanceof Error ? error.message : "unknown error");
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    await server.close();
  }
}
