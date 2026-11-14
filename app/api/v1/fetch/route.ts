import { handleFetch } from "@/server/fetch/fetch-handler";

// Proxied fetch with origin labels and session taint (taint-and-intent
// TAINT-1 to TAINT-4). The logic lives in src/server/fetch.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleFetch(request);
}
