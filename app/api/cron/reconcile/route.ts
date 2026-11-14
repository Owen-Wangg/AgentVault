import { handleReconcileCron } from "@/server/cron/reconcile";

// Daily reconciler run (audit-and-approvals RES-6). Vercel Hobby allows
// daily cron jobs only; each pay or tool request also reconciles its
// agent's backlog with after(). The schedule is in vercel.json.
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleReconcileCron(request);
}