import { describe, expect, it } from "vitest";
import { fromDecimalString } from "@/core/money";
import { parseToolCall } from "./tools";

const ORIGIN = "https://agentvault.example";

describe("parseToolCall", () => {
  it("AGT-13: pay parses a dollar string exactly into micros", () => {
    expect(parseToolCall("pay", { vendor: "nimbus-weather", amount_usd: "0.0015" }, ORIGIN)).toEqual({
      ok: true,
      call: { name: "pay", vendor: "nimbus-weather", amountMicros: fromDecimalString("0.0015") },
    });
  });

  it.each(["1e3", "0x10", " 1", "1.", ".5", "1,000", "$480", "4800000000"])("AGT-13: pay rejects the amount %j", (amount) => {
    expect(parseToolCall("pay", { vendor: "nimbus-weather", amount_usd: amount }, ORIGIN).ok).toBe(false);
  });

  it("AGT-13: request_tool maps stripe.refund to the tool route's arguments", () => {
    expect(parseToolCall("request_tool", { tool: "stripe.refund", vendor: "nimbus-weather", amount_usd: "480", payment_ref: "pi_1" }, ORIGIN)).toEqual({
      ok: true,
      call: {
        name: "request_tool",
        tool: "stripe.refund",
        vendor: "nimbus-weather",
        amountMicros: fromDecimalString("480"),
        args: { vendor: "nimbus-weather", amount_micros: "480000000", payment_ref: "pi_1" },
      },
    });
  });

  it("AGT-13: payee.update sends a payee reference and no amount", () => {
    const r = parseToolCall("request_tool", { tool: "payee.update", vendor: "nimbus-weather", amount_usd: "0", payee_ref: "acct_9" }, ORIGIN);
    expect(r.ok && r.call.name === "request_tool" ? r.call.args : null).toEqual({ vendor: "nimbus-weather", payee_ref: "acct_9" });
  });

  it("AGT-13: fetch_url resolves a path against the deployment and refuses other hosts and credentials", () => {
    const ok = parseToolCall("fetch_url", { url: "/vendor/docs/integration" }, ORIGIN);
    expect(ok.ok && ok.call.name === "fetch_url" ? ok.call.url.toString() : null).toBe(`${ORIGIN}/vendor/docs/integration`);
    for (const url of ["https://agentvault.example.evil.com/", "http://agentvault.example/", "https://user:pw@agentvault.example/", "file:///etc/passwd", "http://169.254.169.254/"]) {
      expect(parseToolCall("fetch_url", { url }, ORIGIN).ok).toBe(false);
    }
  });

  it("AGT-13: a reference with other characters is rejected", () => {
    expect(parseToolCall("request_tool", { tool: "stripe.refund", vendor: "nimbus-weather", amount_usd: "1", payment_ref: "pi 1; drop" }, ORIGIN).ok).toBe(false);
  });
});
