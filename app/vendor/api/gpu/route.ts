import { GPU_CATALOG } from "@/server/vendor/pages";

// The "GPU compute" demo vendor for the intent drift scenario
// (taint-and-intent task 6). In the sandbox, payments to it run on the
// mock rail, so this endpoint only describes what it sells.
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(GPU_CATALOG, { headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
}
