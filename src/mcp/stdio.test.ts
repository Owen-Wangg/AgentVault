import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { copy } from "@/ui/copy";
import { optionsFromEnv } from "./stdio";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("stdio settings", () => {
  it("MCP-6: takes the origin from AGENTVAULT_URL and the key from AGENTVAULT_API_KEY", () => {
    expect(optionsFromEnv({ AGENTVAULT_URL: "https://owen-agentvault.vercel.app/some/path", AGENTVAULT_API_KEY: "av_test_1" })).toEqual({
      baseUrl: "https://owen-agentvault.vercel.app",
      apiKey: "av_test_1",
    });
    expect(optionsFromEnv({ AGENTVAULT_URL: "http://localhost:3000" })).toEqual({ baseUrl: "http://localhost:3000", apiKey: undefined });
  });

  it("MCP-6: refuses plain http to another machine, so the key never crosses a network unencrypted, and never echoes the key", () => {
    for (const url of ["http://agentvault.example", "ftp://localhost", "not a url", undefined]) {
      expect(() => optionsFromEnv({ AGENTVAULT_URL: url, AGENTVAULT_API_KEY: "av_test_secret" }), String(url)).toThrow(/AGENTVAULT_URL/);
      try {
        optionsFromEnv({ AGENTVAULT_URL: url, AGENTVAULT_API_KEY: "av_test_secret" });
      } catch (error) {
        expect((error as Error).message).not.toContain("av_test_secret");
      }
    }
  });
});

describe("pnpm --silent mcp", () => {
  it("MCP-6, MCP-7, MCP-8: speaks MCP on stdout, sends the key as a bearer token, and reports a rejected key as an authentication error", async () => {
    // A stand-in AgentVault that rejects every key.
    const seen: IncomingHttpHeaders[] = [];
    const api = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "UNAUTHORIZED" }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const { port } = api.address() as AddressInfo;

    // Only the default environment and the two settings: no database URL or other secret reaches it.
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["--silent", "mcp"],
      cwd: ROOT,
      env: { ...getDefaultEnvironment(), AGENTVAULT_URL: `http://127.0.0.1:${port}`, AGENTVAULT_API_KEY: "av_test_stdio_key" },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["agentvault_fetch", "agentvault_pay", "agentvault_request_tool"]);
      const result = (await client.callTool({
        name: "agentvault_pay",
        arguments: { vendor: "nimbus-weather", amount: "0.0015", session_id: "11111111-1111-4111-8111-111111111111" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: copy.default["mcp.authError"] }]);
      expect(seen.map((h) => h.authorization)).toEqual(["Bearer av_test_stdio_key"]);
    } finally {
      await client.close();
      await new Promise((resolve) => api.close(resolve));
    }
  }, 60_000);
});
