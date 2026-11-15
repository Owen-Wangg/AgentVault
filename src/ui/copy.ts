import type { ReasonCode } from "@/core/policy";
import type { Theme } from "./theme";

/**
 * Every user-facing string, per theme (structure.md, "Copy and theme").
 * `satisfies` makes a string missing from either theme a compile error.
 * Reason codes map to a plain-language sentence (UI-6, UI-9).
 */

type UiKey =
  | "app.name"
  | "app.tagline"
  | "nav.label"
  | "nav.overview"
  | "nav.feed"
  | "nav.agents"
  | "nav.approvals"
  | "skip.content"
  | "state.loading"
  | "state.error"
  | "state.retry"
  | "state.reconnecting"
  | "state.live"
  | "workspace.sandbox"
  | "workspace.sandboxNote"
  | "workspace.personal"
  | "workspace.none"
  | "auth.signIn"
  | "auth.signOut"
  | "auth.notConfigured"
  | "auth.signedInAs"
  | "overview.title"
  | "overview.spend"
  | "overview.blocked"
  | "overview.held"
  | "overview.frozen"
  | "overview.spendOverTime"
  | "overview.decisions"
  | "overview.alerts"
  | "overview.noAlerts"
  | "overview.range"
  | "range.hour"
  | "range.day"
  | "range.week"
  | "range.all"
  | "decision.allow"
  | "decision.hold"
  | "decision.deny"
  | "feed.title"
  | "feed.empty"
  | "feed.filterAgent"
  | "feed.filterDecision"
  | "feed.filterReason"
  | "feed.any"
  | "feed.time"
  | "feed.agent"
  | "feed.vendor"
  | "feed.amount"
  | "feed.decision"
  | "feed.reasons"
  | "feed.noReasons"
  | "agents.title"
  | "agents.empty"
  | "agents.create"
  | "agents.name"
  | "agents.created"
  | "agents.status"
  | "agents.frozen"
  | "agents.tainted"
  | "agents.active"
  | "agents.unfreeze"
  | "agents.keyOnce"
  | "agents.copyKey"
  | "agents.copied"
  | "agents.close"
  | "agents.editEnvelope"
  | "agents.signInToEdit"
  | "envelope.title"
  | "envelope.agentLimits"
  | "envelope.txMax"
  | "envelope.capMinute"
  | "envelope.capHour"
  | "envelope.capDay"
  | "envelope.callsPerMinute"
  | "envelope.approvalThreshold"
  | "envelope.allowedVendors"
  | "envelope.allowedTools"
  | "envelope.allowAll"
  | "envelope.listHint"
  | "envelope.vendorLimits"
  | "envelope.toolLimits"
  | "envelope.addVendorLimit"
  | "envelope.addToolLimit"
  | "envelope.limitName"
  | "envelope.remove"
  | "envelope.noLimit"
  | "envelope.save"
  | "envelope.saved"
  | "envelope.readOnly"
  | "approvals.title"
  | "approvals.empty"
  | "approvals.approve"
  | "approvals.deny"
  | "approvals.timeLeft"
  | "approvals.expired"
  | "approvals.taintSource"
  | "approvals.request"
  | "approvals.result"
  | "error.generic"
  | "error.rateLimited"
  | "error.unauthorized";

type CopyTable = Record<ReasonCode | UiKey, string>;

const defaultCopy: CopyTable = {
  INVALID_REQUEST: "Denied: the request was malformed or didn't match the agent's records.",
  AGENT_FROZEN: "Denied: this agent is frozen until a person unfreezes it.",
  OVER_TX_MAX: "Denied: the amount is over the agent's per-transaction limit.",
  OVER_WINDOW_CAP: "Denied: this would go over a spending cap for the minute, hour, or day.",
  VELOCITY_EXCEEDED: "Denied: the agent made too many calls in the last minute, so it was frozen.",
  VENDOR_NOT_ALLOWED: "Denied: this vendor isn't on the agent's allow-list.",
  TOOL_NOT_ALLOWED: "Denied: this tool isn't on the agent's allow-list.",
  DENY_INTENT_DRIFT: "Denied: this is outside the task the agent was given.",
  OVER_TASK_BUDGET: "Denied: this would go over the task's budget.",
  NEEDS_APPROVAL: "Held: the amount is over the approval threshold, so a person must approve it.",
  HELD_TAINTED: "Held: this session read untrusted content, so refunds and payouts need approval.",
  ADVISORY_DRIFT: "Held: the drift check thinks this may be off-task, so a person should look.",
  "app.name": "AgentVault",
  "app.tagline": "Spend limits, taint tracking, and approvals for AI agents that pay.",
  "nav.label": "Main",
  "nav.overview": "Overview",
  "nav.feed": "Live feed",
  "nav.agents": "Agents",
  "nav.approvals": "Approvals",
  "skip.content": "Skip to content",
  "state.loading": "Loading…",
  "state.error": "Something went wrong loading this. Try again in a moment.",
  "state.retry": "Try again",
  "state.reconnecting": "Reconnecting…",
  "state.live": "Live",
  "workspace.sandbox": "Sandbox",
  "workspace.sandboxNote": "Sandbox: mock rails only. Anyone can approve, deny, and unfreeze here, and no real money moves.",
  "workspace.personal": "Your workspace",
  "workspace.none": "There's no workspace to show yet. Run pnpm db:seed to create the sandbox.",
  "auth.signIn": "Sign in with GitHub",
  "auth.signOut": "Sign out",
  "auth.notConfigured": "GitHub sign-in isn't set up on this deployment.",
  "auth.signedInAs": "Signed in as",
  "overview.title": "Overview",
  "overview.spend": "Total spend",
  "overview.blocked": "Blocked spend",
  "overview.held": "Held for approval",
  "overview.frozen": "Agents frozen",
  "overview.spendOverTime": "Spend over time",
  "overview.decisions": "Decisions by outcome",
  "overview.alerts": "Recent alerts",
  "overview.noAlerts": "No denials, holds, or freezes in this range.",
  "overview.range": "Range",
  "range.hour": "Last hour",
  "range.day": "Last 24 hours",
  "range.week": "Last 7 days",
  "range.all": "All time",
  "decision.allow": "Allowed",
  "decision.hold": "Held",
  "decision.deny": "Denied",
  "feed.title": "Live feed",
  "feed.empty": "No decisions yet. Run a scenario or send a request with an agent key.",
  "feed.filterAgent": "Agent",
  "feed.filterDecision": "Decision",
  "feed.filterReason": "Reason",
  "feed.any": "Any",
  "feed.time": "Time",
  "feed.agent": "Agent",
  "feed.vendor": "Vendor",
  "feed.amount": "Amount",
  "feed.decision": "Decision",
  "feed.reasons": "Reasons",
  "feed.noReasons": "All checks passed.",
  "agents.title": "Agents",
  "agents.empty": "No agents yet.",
  "agents.create": "Create agent",
  "agents.name": "Name",
  "agents.created": "Created",
  "agents.status": "Status",
  "agents.frozen": "Frozen",
  "agents.tainted": "Tainted session",
  "agents.active": "Active",
  "agents.unfreeze": "Unfreeze",
  "agents.keyOnce": "Copy this API key now. It's shown once and can't be recovered.",
  "agents.copyKey": "Copy key",
  "agents.copied": "Copied",
  "agents.close": "Close",
  "agents.editEnvelope": "Envelope",
  "agents.signInToEdit": "Sign in to create agents and edit envelopes in your own workspace.",
  "envelope.title": "Spending envelope",
  "envelope.agentLimits": "Agent limits",
  "envelope.txMax": "Per-transaction maximum ($)",
  "envelope.capMinute": "Cap per minute ($)",
  "envelope.capHour": "Cap per hour ($)",
  "envelope.capDay": "Cap per day ($)",
  "envelope.callsPerMinute": "Calls per minute",
  "envelope.approvalThreshold": "Approval threshold ($)",
  "envelope.allowedVendors": "Allowed vendors",
  "envelope.allowedTools": "Allowed tools",
  "envelope.allowAll": "Allow all",
  "envelope.listHint": "One per line.",
  "envelope.vendorLimits": "Per-vendor limits",
  "envelope.toolLimits": "Per-tool limits",
  "envelope.addVendorLimit": "Add vendor limit",
  "envelope.addToolLimit": "Add tool limit",
  "envelope.limitName": "Name",
  "envelope.remove": "Remove",
  "envelope.noLimit": "Leave empty for no limit.",
  "envelope.save": "Save envelope",
  "envelope.saved": "Saved.",
  "envelope.readOnly": "Envelopes in the sandbox are read-only. Sign in to edit your own.",
  "approvals.title": "Approvals",
  "approvals.empty": "Nothing is waiting for approval.",
  "approvals.approve": "Approve",
  "approvals.deny": "Deny",
  "approvals.timeLeft": "Time left",
  "approvals.expired": "Expired",
  "approvals.taintSource": "Untrusted content read from",
  "approvals.request": "Request",
  "approvals.result": "Result",
  "error.generic": "That didn't work. Try again.",
  "error.rateLimited": "Too many actions from your address. Wait a minute and try again.",
  "error.unauthorized": "Sign in to do that.",
};

const kiroweenCopy: CopyTable = {
  ...defaultCopy,
  AGENT_FROZEN: "Denied: this agent is sealed in The Crypt until a person sets it free.",
  VELOCITY_EXCEEDED: "Denied: the agent ran wild, so it was sealed in The Crypt.",
  HELD_TAINTED: "Sealed in The Crypt: this session is Haunted by an untrusted page.",
  NEEDS_APPROVAL: "Held: a sum this large needs a living person's blessing.",
  "agents.frozen": "The Crypt",
  "agents.tainted": "Haunted",
  "agents.unfreeze": "Release from The Crypt",
  "workspace.sandbox": "Haunted sandbox",
};

export const copy = { default: defaultCopy, kiroween: kiroweenCopy } satisfies Record<Theme, CopyTable>;

/** The theme the UI renders until the Kiroween toggle (telemetry-dashboard task 8) chooses one. */
export const DEFAULT_THEME: Theme = "default";

export function t(key: ReasonCode | UiKey, theme: Theme = DEFAULT_THEME): string {
  return copy[theme][key];
}

/** The plain-language sentence for a reason code, or the code itself if it's unknown. */
export function reasonText(code: string, theme: Theme = DEFAULT_THEME): string {
  return Object.hasOwn(copy[theme], code) ? copy[theme][code as ReasonCode] : code;
}

export type { UiKey };
