import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TEST_HEAD_KEY } from "@/core/testing/audit-fixtures";
import type { Db } from "@/server/db/client";
import type { FetchDeps } from "@/server/fetch/fetch-handler";
import type { PayDeps } from "@/server/payments/pay-handler";
import { type FakeClock, testDeps } from "@/server/payments/test-fixtures";
import { resetSandbox } from "@/server/sandbox/sandbox";
import { GET as poisonedDocs } from "../../../app/vendor/docs/integration/route";
import { type McpRouteDeps, handleMcp } from "./handler";
import { type McpPreset, createMcpAgent } from "./provision";

/** Test-only helpers for the MCP server. */

export const BASE_URL = "https://agentvault.example";
export const DOCS_URL = `${BASE_URL}/vendor/docs/integration`;

/** Route deps on a test database, with mock rails and the poisoned docs page as the only fetchable URL. */
export function mcpRouteDeps(db: Db, clock?: FakeClock) {
  const { deps: guarded, mocks, clock: c } = testDeps(db, clock ? { clock } : {});
  const open = () => ({ db, close: async () => {} });
  const pay: PayDeps = { openDb: open, key: () => guarded.key, now: guarded.now, railFor: guarded.railFor };
  const fetch: FetchDeps = {
    openDb: open,
    key: () => guarded.key,
    now: guarded.now,
    fetchPage: async (url) => {
      if (url !== DOCS_URL) throw new Error(`unexpected fetch of ${url}`);
      return { url, hops: [url], status: 200, contentType: "text/html", body: await poisonedDocs().text() };
    },
  };
  const deps: McpRouteDeps = { pay, fetch, baseUrl: () => BASE_URL };
  return { deps, mocks, clock: c };
}

/** A fresh sandbox and an MCP agent in it, as `pnpm mcp:agent` makes. */
export async function mcpScene(db: Db, clock: FakeClock, preset: McpPreset = "billing") {
  const sandboxId = (await resetSandbox(db, { key: TEST_HEAD_KEY, appOrigin: BASE_URL, now: clock.now() })).workspaceId;
  const agent = await createMcpAgent(db, { workspaceId: sandboxId, name: `mcp-${preset}-agent`, preset, actor: "cli" }, { key: TEST_HEAD_KEY, now: clock.now() });
  return { sandboxId, agent };
}

/** An MCP client connected to handleMcp over Streamable HTTP, without a network. */
export async function httpClient(deps: McpRouteDeps, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/api/mcp`), {
    fetch: (url, init) => handleMcp(new Request(url, init), deps),
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, close: () => client.close() };
}

export const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
