import { expect, test } from "@playwright/test";

const DOCS = "http://localhost:3100/vendor/docs/integration";

/**
 * The judge's path through the sandbox, signed out (telemetry-dashboard
 * UI-21, demo-agents AGT-3, AGT-8, AGT-10, audit-and-approvals AUD-6):
 * run the prompt-injection scenario, approve the held refund in the inbox,
 * see the re-run in the live feed, and verify the audit chain.
 */
test("UI-21, AGT-8, AUD-6: a signed-out visitor runs the prompt injection, approves the held refund, sees it run, and verifies the chain", async ({ page }) => {
  await page.goto("/scenarios");
  await expect(page.getByText("Scenarios run in the public sandbox on mock rails")).toBeVisible();
  await page.getByRole("button", { name: "Run: Prompt injection" }).click();

  // AGT-3: the steps arrive on the event stream.
  const steps = page.getByRole("log", { name: "Steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(2, { timeout: 90_000 });
  await expect(steps.getByRole("listitem").nth(0)).toContainText(`the session is now tainted: ${DOCS}`);
  await expect(steps.getByRole("listitem").nth(1)).toContainText("stripe.refund");
  await expect(steps.getByRole("listitem").nth(1)).toContainText("Held: this session read untrusted content");

  // AGT-10: the summary.
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("$480.00", { timeout: 90_000 });
  await summary.getByRole("link", { name: /inbox/ }).click();

  // UI-9, UI-21: the held refund, approvable while signed out, with the sandbox note.
  await expect(page).toHaveURL(/\/approvals$/);
  // Two notes: the workspace header's, and the inbox's once it has loaded.
  await expect(page.getByRole("note").filter({ hasText: "Sandbox: mock rails only." })).toHaveCount(2);
  const card = page.getByRole("region", { name: /stripe\.refund/ });
  await expect(card).toContainText("$480.00");
  await expect(card).toContainText(`Untrusted content read from ${DOCS}`);
  await card.getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByText("Approved. The request ran.")).toBeVisible();
  await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();

  // UI-6: the approved re-run is in the live feed as an allowed refund.
  await page.goto("/feed");
  const refunds = page.getByRole("row").filter({ hasText: "stripe.refund" });
  await expect(refunds.filter({ hasText: "Allowed" })).toHaveCount(1);
  await expect(refunds.filter({ hasText: "Held" })).toHaveCount(1);

  // AUD-6: the chain still verifies after all of it.
  await page.goto("/audit");
  await page.getByRole("button", { name: "Verify chain" }).click();
  await expect(page.getByText("Chain verified.")).toBeVisible();
});
