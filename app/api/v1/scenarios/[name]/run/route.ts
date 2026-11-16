import { handleRunScenario } from "@/server/scenarios/handler";

// Run a demo scenario in the public sandbox (demo-agents AGT-1 to AGT-10).
// The runner waits for every step, so it gets the same 60 s as the event
// stream; the longest scenario makes 36 requests, and a live Gemini run
// stops itself after 45 s. Logic in src/server/scenarios.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await context.params;
  return handleRunScenario(request, name);
}
