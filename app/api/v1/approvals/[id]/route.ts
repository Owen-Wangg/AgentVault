import { handleApprovalAction } from "@/server/approvals/handlers";

// Approve or deny a held request (audit-and-approvals HITL-2 to HITL-11).
// Human-only: any bearer header is rejected with 403.
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return handleApprovalAction(request, id);
}