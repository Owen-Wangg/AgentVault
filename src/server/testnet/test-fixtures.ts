import { count, eq } from "drizzle-orm";
import type { RailContext, RailRequest, RailResult } from "@/rails/types";
import { MockRail } from "@/rails/mock";
import type { Db } from "@/server/db/client";
import { auditEvents, sessions } from "@/server/db/schema";
import type { FakeClock } from "@/server/payments/test-fixtures";
import type { TestnetLimits, TestnetPayDeps } from "./handler";

export const ORIGIN = "https://agentvault.example";
export const PAY_URL = `${ORIGIN}/api/v1/testnet/pay`;

/** A stand-in for the x402 adapter: the mock rail, plus a record of every request it was asked to pay. */
export class RecordingX402 extends MockRail {
  readonly requests: RailRequest[] = [];
  constructor() {
    super("x402", 1000n);
  }
  override async execute(req: RailRequest, ctx?: RailContext): Promise<RailResult> {
    this.requests.push(req);
    return super.execute(req, ctx);
  }
}

export function testnetDeps(db: Db, clock: FakeClock, rail: RecordingX402, overrides: Partial<TestnetPayDeps> & { limits?: TestnetLimits } = {}): TestnetPayDeps {
  return {
    openDb: () => ({ db, close: async () => {} }),
    key: () => Uint8Array.from({ length: 32 }, (_, i) => i),
    now: clock.now,
    // The testnet workspace isn't a sandbox, so every rail goes to the recording adapter.
    railFor: () => rail,
    railReady: () => true,
    ...overrides,
  };
}

export function press(init: { ip?: string; body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(PAY_URL, {
    method: "POST",
    body: init.body ?? "{}",
    headers: { "content-type": "application/json", "x-real-ip": init.ip ?? "203.0.113.7", ...init.headers },
  });
}

/** Sessions and audit events in the testnet workspace, so a test can check a refused press created neither. */
export async function footprint(db: Db, workspaceId: string, agentId: string): Promise<{ sessions: number; events: number }> {
  const [s] = await db.select({ n: count() }).from(sessions).where(eq(sessions.agentId, agentId));
  const [e] = await db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
  return { sessions: s?.n ?? 0, events: e?.n ?? 0 };
}
