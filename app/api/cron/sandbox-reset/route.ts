import { handleSandboxReset } from "@/server/cron/sandbox-reset";

// Nightly sandbox reset (audit-and-approvals AUD-9, telemetry-dashboard
// UI-3). vercel.json schedules it at 11:00 UTC (3 a.m. Pacific in winter);
// Hobby runs it somewhere in that hour, and allows daily crons only. Open
// dashboards reload when their sandbox is retired.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleSandboxReset(request);
}
