import { describe, expect, it } from "vitest";
import { toDisplay } from "@/core/money";
import { REPORT_PATH, REPORT_PRICE } from "@/server/vendor/report";
import { GET } from "./route";

describe("GET /llms.txt", () => {
  it("RAIL-26: is plain text naming the agent endpoints, the MCP server, and the paid report at its real price", async () => {
    const response = GET();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const path of ["/api/v1/pay", "/api/v1/tool", "/api/v1/fetch", "/api/mcp", "/openapi.json", REPORT_PATH]) expect(text).toContain(`(${path})`);
    expect(text).toContain(`${toDisplay(REPORT_PRICE)} per call`);
    expect(text).toMatch(/testnets, test mode, sandboxes, or mock rails/);
  });

  it("RAIL-26: names no secret, key, account, wallet address, or email address", async () => {
    const text = await GET().text();
    expect(text).not.toMatch(/\b(sk|rk|pk)_(test|live)_\w+/);
    expect(text).not.toMatch(/\bav_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/\bacct_[A-Za-z0-9]+/);
    expect(text).not.toMatch(/\b0x[0-9a-fA-F]{40}\b/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
