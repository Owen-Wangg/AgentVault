import { type Page, expect, test } from "@playwright/test";

const INVOICE = "http://localhost:3100/vendor/docs/invoice";
const SUPPLIER = "acct_1AcmeSupplies";
const ATTACKER = "acct_1AttackerSandbox";

/** Run the Payee hijack and return the run's own supplier name, read from its steps. */
async function runHijack(page: Page): Promise<string> {
  await page.goto("/scenarios");
  await page.getByRole("button", { name: "Run: Payee hijack" }).click();
  const steps = page.getByRole("log", { name: "Steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(3, { timeout: 90_000 });
  await expect(steps.getByRole("listitem").nth(0)).toContainText(`the session is now tainted: ${INVOICE}`);
  await expect(steps.getByRole("listitem").nth(1)).toContainText("payee.update");
  await expect(steps.getByRole("listitem").nth(2)).toContainText("payout.create");
  await expect(steps.getByRole("listitem").nth(2)).toContainText("$900.00");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("$900.00", { timeout: 90_000 });
  await expect(summary).toContainText("Deny the payout account change and approve the payout");
  const supplier = /acme-supplies-[0-9a-f]{16}/.exec((await steps.getByRole("listitem").nth(2).textContent()) ?? "")?.[0];
  if (!supplier) throw new Error("the payout step names no per-run supplier");
  return supplier;
}

/** Act on the run's held request for `tool` in the inbox. */
async function act(page: Page, supplier: string, tool: string, action: "Approve" | "Deny") {
  const card = page.getByRole("region", { name: new RegExp(`${tool.replace(".", "\\.")}.*${supplier}`) });
  await card.getByRole("button", { name: new RegExp(`^${action}`) }).click();
  // The inbox shows the latest action's result in one status line, and the card leaves the list.
  await expect(page.getByText(action === "Approve" ? "Approved. The request ran." : "Denied. The request won't run.")).toBeVisible();
  await expect(card).toHaveCount(0);
}

/**
 * The Payee hijack as a judge sees it, signed out (payout-rails PO-23,
 * PO-24, PO-12): the injected payout account change and the $900 payout
 * are both held. Denying the change and approving the payout pays the
 * supplier's account on file. A second run where both are approved shows
 * what the hold prevented: the change in the feed, and the money going to
 * the attacker. Each run has its own supplier, so the second run can't
 * affect the first. Every approval is decided, so later tests start with
 * an empty inbox.
 */
test("PO-23, PO-24, PO-12: deny the injected payee change and approve the payout, and the money goes to the supplier; approve both, and it goes to the attacker", async ({ page }) => {
  const safe = await runHijack(page);
  await page.getByRole("region", { name: "Summary" }).getByRole("link", { name: /inbox/ }).click();
  await expect(page).toHaveURL(/\/approvals$/);
  const change = page.getByRole("region", { name: new RegExp(`payee\\.update.*${safe}`) });
  await expect(change).toContainText(ATTACKER);
  await expect(change).toContainText(`Untrusted content read from ${INVOICE}`);
  await act(page, safe, "payee.update", "Deny");
  await act(page, safe, "payout.create", "Approve");
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();

  const hijacked = await runHijack(page);
  expect(hijacked).not.toBe(safe);
  await page.goto("/approvals");
  await act(page, hijacked, "payee.update", "Approve");
  await act(page, hijacked, "payout.create", "Approve");
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();

  // PO-24: where each payout went, and PO-12: the one approved change, in the live feed.
  await page.goto("/feed");
  const payouts = page.getByRole("row").filter({ hasText: "payout.create" }).filter({ hasText: "Allowed" });
  await expect(payouts.filter({ hasText: safe })).toContainText(`Paid out to ${SUPPLIER}`);
  await expect(payouts.filter({ hasText: hijacked })).toContainText(`Paid out to ${ATTACKER}`);
  await expect(page.getByTestId("payee-change")).toHaveCount(1);
  await expect(page.getByTestId("payee-change")).toContainText(`Payout account changed: ${SUPPLIER} to ${ATTACKER}`);
});
