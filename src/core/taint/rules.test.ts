import { describe, expect, it } from "vitest";
import { baseInput } from "@/core/testing/policy-fixtures";
import { afterFetch } from "./session";
import { HIGH_PRIVILEGE_TOOLS, taintRules } from "./rules";
import type { ToolDef } from "./types";

const REFUND: ToolDef = { name: "stripe.refund", privileged: true, rail: "stripe" };
const PAY: ToolDef = { name: "x402.pay", privileged: false, rail: "x402" };
const SOURCE = "https://agentvault.example/vendor/docs/integration";
const AT = "2026-11-21T10:00:00.000Z";

function tainted() {
  const input = baseInput();
  input.session.taintedAt = AT;
  input.session.taintSourceUrl = SOURCE;
  return input;
}

describe("TAINT-6, TAINT-7: taintRules", () => {
  it("TAINT-6: holds a privileged tool in a tainted session and names the taint source", () => {
    expect(taintRules(tainted(), REFUND)).toEqual([
      { code: "HELD_TAINTED", detail: { tool: "stripe.refund", sourceUrl: SOURCE, taintedAt: AT } },
    ]);
  });

  it("TAINT-6: a non-privileged payment in a tainted session is not held", () => {
    expect(taintRules(tainted(), PAY)).toEqual([]);
  });

  it("TAINT-7: a privileged tool in an untainted session gets no taint reason", () => {
    expect(taintRules(baseInput(), REFUND)).toEqual([]);
  });

  it.each(HIGH_PRIVILEGE_TOOLS)("TAINT-6: %s is held even if its registry entry is missing the privileged flag", (name) => {
    expect(taintRules(tainted(), { name, privileged: false, rail: null }).map((r) => r.code)).toEqual(["HELD_TAINTED"]);
  });

  it("TAINT-6: any tool flagged privileged is held", () => {
    expect(taintRules(tainted(), { name: "custom.tool", privileged: true, rail: null }).map((r) => r.code)).toEqual(["HELD_TAINTED"]);
  });
});

describe("TAINT-4, TAINT-5: afterFetch", () => {
  const clean = { taintedAt: null, taintSourceUrl: null, taintContentSha256: null };
  const untrusted = { ok: true as const, label: "untrusted" as const, url: SOURCE, contentSha256: "ab".repeat(32), at: AT };

  it("TAINT-4: untrusted content taints the session with its URL and hash", () => {
    expect(afterFetch(clean, untrusted)).toEqual({ taintedAt: AT, taintSourceUrl: SOURCE, taintContentSha256: "ab".repeat(32) });
  });

  it("TAINT-1: trusted content leaves the session clean", () => {
    expect(afterFetch(clean, { ...untrusted, label: "trusted" })).toEqual(clean);
  });

  it("TAINT-4: a failed fetch never taints", () => {
    expect(afterFetch(clean, { ok: false })).toEqual(clean);
  });

  it("TAINT-5: a later untrusted fetch keeps the first taint source", () => {
    const first = afterFetch(clean, untrusted);
    const second = afterFetch(first, { ...untrusted, url: "https://other.example/", at: "2026-11-21T11:00:00.000Z" });
    expect(second).toEqual(first);
  });
});
