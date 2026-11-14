import { handleUnfreeze } from "@/server/approvals/handlers";

// Unfreeze an agent (audit-and-approvals HITL-9). Human-only: any bearer
// header is rejected with 403.
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return handleUnfreeze(request, id);
}