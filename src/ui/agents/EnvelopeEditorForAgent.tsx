"use client";

import type { EnvelopeWire } from "@/core/policy";
import { EnvelopeEditor, putEnvelope } from "./EnvelopeEditor";

/** The editor wired to PUT /api/v1/agents/:id/envelope. A client component, so the save function never crosses from the server. */
export function EnvelopeEditorForAgent({ agentId, initial, version, readOnly }: { agentId: string; initial: EnvelopeWire; version: number; readOnly: boolean }) {
  return <EnvelopeEditor initial={initial} version={version} readOnly={readOnly} save={putEnvelope(agentId)} />;
}
