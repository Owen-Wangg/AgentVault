import { handleVerifyChain } from "@/server/audit/handlers";

// Verify a workspace's audit hash chain (audit-and-approvals AUD-4, AUD-6).
// Human-only: any bearer header is rejected with 403. Logic in src/server/audit.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleVerifyChain(request);
}
