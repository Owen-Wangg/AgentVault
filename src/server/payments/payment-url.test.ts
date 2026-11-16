import { describe, expect, it } from "vitest";
import { findTool } from "@/server/tools/registry";
import { paymentUrl } from "./guarded";

const vendor = { x402Url: "https://v.example/x402", mppUrl: "https://v.example/mpp" };
const tool = (name: string) => {
  const t = findTool(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("paymentUrl", () => {
  it("RAIL-23: x402.pay uses the vendor's x402_url and mpp.pay its mpp_url", () => {
    expect(paymentUrl(tool("x402.pay"), vendor)).toBe("https://v.example/x402");
    expect(paymentUrl(tool("mpp.pay"), vendor)).toBe("https://v.example/mpp");
  });

  it("RAIL-24: no URL for the rail, or no vendor, gives an empty URL, which the real adapters refuse", () => {
    expect(paymentUrl(tool("x402.pay"), { x402Url: null, mppUrl: "https://v.example/mpp" })).toBe("");
    expect(paymentUrl(tool("mpp.pay"), { x402Url: "https://v.example/x402", mppUrl: null })).toBe("");
    expect(paymentUrl(tool("x402.pay"), undefined)).toBe("");
  });

  it("RAIL-23: refunds and tools on the mock or no rail never get a payment URL", () => {
    for (const name of ["stripe.refund", "wire_transfer", "payout.create", "payee.update"]) expect(paymentUrl(tool(name), vendor)).toBe("");
  });
});
