import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getAgentEnvelope } from "@/server/agents/manage";
import { defaultDashboardDeps, withDashboardDb } from "@/server/dashboard/context";
import { EnvelopeEditorForAgent } from "@/ui/agents/EnvelopeEditorForAgent";
import { PageTitle } from "@/ui/components/primitives";
import { getCopy } from "@/ui/server-copy";
import { getDashboardContext } from "../../dashboard-context";

export const metadata: Metadata = { title: "Envelope" };

export default async function AgentEnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspace, user } = await getDashboardContext();
  if (!workspace || !z.uuid().safeParse(id).success) notFound();
  // Only agents in the workspace this reader sees; anything else is a 404, not a 403, so IDs don't leak.
  const agent = await withDashboardDb(defaultDashboardDeps(), "agent envelope", (db) => getAgentEnvelope(db, workspace.id, id));
  if (!agent) notFound();
  const { t } = await getCopy();
  return (
    <>
      <Link href="/agents" className="text-sm text-accent underline-offset-2 hover:underline">
        ← {t("agents.title")}
      </Link>
      <PageTitle>
        {t("envelope.title")}: {agent.name}
      </PageTitle>
      <EnvelopeEditorForAgent agentId={agent.agentId} initial={agent.envelope} version={agent.version} readOnly={workspace.isSandbox || user === null} />
    </>
  );
}
