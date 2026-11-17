// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "@/ui/copy";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/scenarios" }));
const { ThemeProvider } = await import("@/ui/ThemeProvider");
const { TestnetPaymentCard, basescanLink, shortHash } = await import("./TestnetPaymentCard");

afterEach(cleanup);

const HASH = `0x${"ab".repeat(32)}`;
const TX_URL = `https://sepolia.basescan.org/tx/${HASH}`;
const settled = { decision: "allow", reasons: [], rail_status: "settled", rail_ref: HASH, explorer_url: TX_URL, event_seq: 7, vendor: "nimbus-weather", amount_micros: "1500" };

function mount(response: Response | Error, theme: "default" | "kiroween" = "default") {
  const fetcher = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  render(
    <ThemeProvider initial={theme}>
      <TestnetPaymentCard fetcher={fetcher as unknown as typeof fetch} />
    </ThemeProvider>,
  );
  return fetcher;
}

describe("TestnetPaymentCard", () => {
  it("TN-2, TN-3: a press sends an empty body, then shows the decision, the audit seq, and a BaseScan link for the transaction", async () => {
    const fetcher = mount(Response.json(settled));
    fireEvent.click(screen.getByRole("button", { name: "Make a real testnet payment" }));
    await waitFor(() => expect(screen.getByText("Settled on Base Sepolia")).toBeTruthy());
    expect(fetcher).toHaveBeenCalledWith("/api/v1/testnet/pay", expect.objectContaining({ method: "POST", body: "{}", credentials: "same-origin" }));
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText("Audit event #7")).toBeTruthy();
    const link = screen.getByRole("link", { name: /View the transaction on BaseScan/ });
    expect(link.getAttribute("href")).toBe(TX_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain(shortHash(HASH));
  });

  it("TN-3: shows no link unless the explorer URL is a Base Sepolia transaction on BaseScan", () => {
    expect(basescanLink(TX_URL)).toBe(TX_URL);
    for (const url of [
      `https://basescan.org/tx/${HASH}`,
      `https://sepolia.basescan.org/tx/${HASH}?x=1`,
      `https://sepolia.basescan.org.evil.example/tx/${HASH}`,
      `javascript:alert(1)//https://sepolia.basescan.org/tx/${HASH}`,
      "https://sepolia.basescan.org/tx/0x12",
      42,
      null,
    ]) {
      expect(basescanLink(url)).toBeNull();
    }
  });

  it("TN-3: an unknown outcome says the amount stays counted, and a denial shows its reasons in plain language", async () => {
    mount(Response.json({ ...settled, rail_status: "unknown", rail_ref: undefined, explorer_url: undefined }));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(copy.default["testnet.unknown"])).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
    cleanup();
    mount(Response.json({ decision: "deny", reasons: [{ code: "OVER_WINDOW_CAP" }], event_seq: 9 }));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText("Denied")).toBeTruthy());
    expect(screen.getByText(copy.default.OVER_WINDOW_CAP)).toBeTruthy();
  });

  it.each([
    ["the per-visitor limit", Response.json({ error: "RATE_LIMITED" }, { status: 429 }), "testnet.rateLimited"],
    ["the daily quota", Response.json({ error: "TESTNET_QUOTA_USED" }, { status: 429 }), "testnet.quotaUsed"],
    ["a 503", Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 }), "testnet.error"],
    ["a network error", new TypeError("failed to fetch"), "testnet.error"],
  ] as const)("TN-5: says so for %s", async (_name, response, key) => {
    mount(response);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(copy.default[key])).toBeTruthy());
  });

  it("TN-4: states that it's test USDC with no real value and the limits, in both themes", () => {
    for (const theme of ["default", "kiroween"] as const) {
      mount(Response.json(settled), theme);
      expect(screen.getByText(copy[theme]["testnet.limits"])).toBeTruthy();
      expect(copy[theme]["testnet.limits"]).toMatch(/test USDC has no real value/);
      expect(copy[theme]["testnet.limits"]).toMatch(/2 .* an hour, and 20 a day/);
      expect(screen.getByRole("heading", { name: copy[theme]["testnet.title"] })).toBeTruthy();
      cleanup();
    }
  });
});
