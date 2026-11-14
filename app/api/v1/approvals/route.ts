import { handleListApprovals } from "@/server/approvals/handlers";

// The approvals inbox (audit-and-approvals HITL-12). Human-only: any bearer
// header is rejected with 403. The logic lives in src/server/approvals.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleListApprovals(request);
}