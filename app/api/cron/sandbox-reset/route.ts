import { handleSandboxReset } from "@/server/cron/sandbox-reset";

// Nightly sandbox reset (audit-and-approvals AUD-9). The Vercel Cron entry
// is added in telemetry-dashboard task 9. Hobby plans allow daily crons only.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleSandboxReset(request);
}
