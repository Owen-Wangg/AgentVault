import { handleCreateAgent } from "@/server/agents/handlers";

// Create an agent in the signed-in user's workspace (telemetry-dashboard
// UI-7). The response holds the API key, shown once. Logic in src/server/agents.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCreateAgent(request);
}
