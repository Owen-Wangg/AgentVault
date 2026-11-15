import { handleEvents } from "@/server/events/handler";

// The live audit event stream (telemetry-dashboard TEL-1 to TEL-5). The
// logic lives in src/server/events. maxDuration must be a literal here for
// Next.js to read it; it must equal EVENTS_MAX_DURATION_S, which the stream
// uses to close 5 s early (TEL-4). A test checks they match.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  return handleEvents(request);
}
