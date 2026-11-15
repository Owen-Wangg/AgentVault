/** An agent's name, or the start of its ID for an agent created after the page loaded. */
export function agentLabel(names: Record<string, string>, agentId: string): string {
  return Object.hasOwn(names, agentId) ? names[agentId]! : `agent ${agentId.slice(0, 8)}`;
}
