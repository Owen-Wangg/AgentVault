import { handleUpdateEnvelope } from "@/server/agents/handlers";

// Save an agent's envelope (telemetry-dashboard UI-8). Owner only; the
// sandbox is read-only here. Logic in src/server/agents.
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return handleUpdateEnvelope(request, id);
}
