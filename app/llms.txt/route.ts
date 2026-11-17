import { llmsText } from "@/server/vendor/llms";

// A plain-text summary for agents and their developers (rail-adapters
// RAIL-26). The MPP validator suggests one next to /openapi.json.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(llmsText(), {
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "public, max-age=300" },
  });
}
