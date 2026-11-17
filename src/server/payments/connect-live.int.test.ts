import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fromDecimalString } from "@/core/money";
import { loadStripeConfig } from "@/rails/config";
import { StripeMppRail } from "@/rails/stripe-mpp/adapter";
import { CONNECT_API_VERSION } from "@/rails/stripe-mpp/constants";
import { StripeConnectPayouts } from "@/rails/stripe-mpp/payouts";
import { StripeApi } from "@/rails/stripe-mpp/stripe-api";
import { spendReservations, vendors } from "@/server/db/schema";
import { createTestDb } from "@/server/db/test-db";
import { runGuardedRequest } from "./guarded";
import { OPEN_ENVELOPE, createScene, eventsOf, testDeps } from "./test-fixtures";

/**
 * Stripe Connect payouts in test mode for real (payout-rails task 5,
 * `@live`). A guarded payout.create of $1.00 sends a real test-mode
 * Transfer from the platform's USD test balance to the supplier's
 * recipient account, and lookup() finds it again. No real money moves.
 * Run `pnpm connect:check` first: both recipient accounts need
 * stripe_transfers active and the platform needs at least $1.00 USD
 * available (`pnpm connect:setup --fund 5`). The accounts are found by
 * metadata.agentvault_role, as `pnpm connect:setup` does.
 */

const LIVE_TIMEOUT = 60_000;
const Accounts = z.object({ data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()).nullish() })) });

async function recipient(api: StripeApi, role: "supplier" | "attacker"): Promise<string> {
  const list = Accounts.parse(await api.get("/v2/core/accounts", { applied_configurations: "recipient", limit: "20" }, { apiVersion: CONNECT_API_VERSION }));
  const found = list.data.find((a) => a.metadata?.agentvault_role === role);
  if (!found) throw new Error(`no ${role} recipient account: run pnpm connect:setup`);
  return found.id;
}

function live() {
  const config = loadStripeConfig();
  const api = new StripeApi({ secretKey: config.secretKey() });
  const payouts = new StripeConnectPayouts(api);
  return { api, payouts, rail: new StripeMppRail({ api, profileId: config.profileId, payouts }) };
}

let database: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterAll(async () => {
  await database?.close();
});

describe("@live Stripe Connect payouts in test mode", () => {
  it(
    "@live PO-6, PO-9: both recipient accounts pass the Accounts v2 capability check",
    async () => {
      const { api, payouts } = live();
      expect(await payouts.checkDestination(await recipient(api, "supplier"))).toEqual({ ok: true });
      expect(await payouts.checkDestination(await recipient(api, "attacker"))).toEqual({ ok: true });
    },
    LIVE_TIMEOUT,
  );

  it(
    "@live PO-4, PO-7, PO-8: a guarded $1.00 payout.create settles as a Transfer to the registered supplier, and lookup() finds it",
    async () => {
      database = await createTestDb();
      const db = database.db;
      const { api, rail } = live();
      const supplier = await recipient(api, "supplier");
      const scene = await createScene(db, {
        envelope: OPEN_ENVELOPE,
        isSandbox: false,
        task: { allowedVendorCategories: ["suppliers"], allowedTools: ["payout.create"], budgetMicros: fromDecimalString("10") },
      });
      await db.insert(vendors).values({
        workspaceId: scene.workspaceId,
        name: "acme-supplies",
        origin: "https://acme-supplies.example",
        category: "suppliers",
        trusted: false,
        stripeAccount: supplier,
      });
      const { deps } = testDeps(db, { now: () => new Date() });
      const flow = { ...deps, railFor: (r: Parameters<typeof deps.railFor>[0], w: { isSandbox: boolean }) => (r === "stripe" && !w.isSandbox ? rail : deps.railFor(r, w)) };

      const paid = await runGuardedRequest(
        { agent: scene.agent, idempotencyKey: `live-${randomUUID()}`, body: { vendor: "acme-supplies", tool: "payout.create", amountMicros: fromDecimalString("1.00"), sessionId: scene.sessionId } },
        flow,
      );
      expect(paid).toMatchObject({ status: 200, body: { decision: "allow", rail_status: "settled" } });
      const tr = paid.body.rail_ref ?? "";
      expect(tr).toMatch(/^tr_\w+$/);

      const result = (await eventsOf(db, scene.workspaceId)).find((e) => e.type === "rail_result")?.payload as { reservation_id: string };
      expect(result).toMatchObject({ status: "settled", rail_ref: tr, payout_to: supplier, settled_micros: "1000000" });
      const [reservation] = await db.select().from(spendReservations).where(eq(spendReservations.id, result.reservation_id));
      expect(reservation).toMatchObject({ status: "settled", tool: "payout.create" });
      expect(await rail.lookup(result.reservation_id)).toMatchObject({ status: "settled", ref: tr, settledMicros: 1_000_000n });
    },
    LIVE_TIMEOUT,
  );
});
