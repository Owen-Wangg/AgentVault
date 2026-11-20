import { type Page, expect, test } from "@playwright/test";

const ATTACKER = "acct_1AttackerSandbox";

/** Decide the run's held request for `tool` in the inbox, so later tests start with an empty one. */
async function decide(page: Page, supplier: string, tool: string, action: "Approve" | "Deny") {
  const card = page.getByRole("region", { name: new RegExp(`${tool.replace(".", "\\.")}.*${supplier}`) });
  await card.getByRole("button", { name: new RegExp(`^${action}`) }).click();
  await expect(card).toHaveCount(0);
}

/**
 * A judge's first visit, signed out (telemetry-dashboard UI-23, UI-24,
 * UI-25, UI-26, UI-27, demo-agents AGT-17): the tagline and the "Start
 * here" tour on the overview, the Kiroween switch in the header, the
 * Payee hijack's decision path and requested account, and the audit
 * page's tamper simulation breaking the chain at the event it rewrote.
 */
test("UI-23, UI-24, UI-27: the overview says what AgentVault is, starts the tour, and switches theme from the header", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("A security proxy that checks every payment an AI agent makes before any money moves.")).toBeVisible();
  const tour = page.getByRole("region", { name: /Start here/ });
  const steps = tour.getByRole("listitem");
  await expect(steps.nth(0)).toContainText("Run Payee hijack");
  await expect(steps.nth(0).getByRole("link")).toHaveAttribute("href", "/scenarios");
  await expect(steps.nth(1).getByRole("link")).toHaveAttribute("href", "/approvals");
  await expect(steps.nth(2).getByRole("link")).toHaveAttribute("href", "/audit");

  const toggle = page.locator("header").getByRole("switch", { name: "Kiroween mode" });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "kiroween");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
});

test("AGT-17, UI-25, UI-26: the hijack's path and requested account, then a rewritten event breaks the chain in the browser", async ({ page }) => {
  await page.goto("/scenarios");
  await page.getByRole("button", { name: "Run: Payee hijack" }).click();
  const log = page.getByRole("log", { name: "Steps" });
  await expect(log.getByRole("listitem")).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByRole("region", { name: "Summary" })).toContainText("$900.00", { timeout: 90_000 });

  // UI-25: the held payee change shows where the agent tried to send the money.
  await expect(log.getByRole("listitem").nth(1).getByTestId("requested-payee")).toHaveText(`Requested payout account: ${ATTACKER}`);
  // AGT-17: the $900 payout, held at spend limits (approval threshold) and untrusted input, never sent.
  const path = page.getByRole("region", { name: "How AgentVault decided" });
  await expect(path).toContainText("payout.create");
  await expect(path.getByTestId("path-state")).toHaveText(["Passed", "Held", "Passed", "Held", "Not sent"]);

  const supplier = /acme-supplies-[0-9a-f]{16}/.exec((await log.getByRole("listitem").nth(2).textContent()) ?? "")?.[0];
  if (!supplier) throw new Error("the payout step names no per-run supplier");

  // UI-26: rewrite the held payout in a browser copy; the chain breaks at that seq, and the stored log is untouched.
  await page.goto("/audit");
  const card = page.getByRole("region", { name: "Try to tamper with it" });
  await card.getByRole("button", { name: "Rewrite an event" }).click();
  const result = card.getByTestId("tamper-result");
  await expect(result).toContainText("Untouched, the events on this page verify in your browser.");
  await expect(result).toContainText("(decision): hold to allow.");
  const rewrote = /Rewrote seq (\d+)/.exec((await result.textContent()) ?? "")?.[1];
  expect(rewrote).toBeDefined();
  await expect(card.getByTestId("tamper-broken")).toHaveText(`Chain broken at seq ${rewrote}. That event's hash doesn't match its contents.`);
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText("Chain verified.")).toBeVisible();

  await page.goto("/approvals");
  await decide(page, supplier, "payee.update", "Deny");
  await decide(page, supplier, "payout.create", "Deny");
});
