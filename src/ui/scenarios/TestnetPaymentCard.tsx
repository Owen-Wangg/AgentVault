"use client";
import { ExternalLink, Zap } from "lucide-react";
import { useState } from "react";
import { useCopy } from "@/ui/ThemeProvider";
import { Badge, Button, Card } from "@/ui/components/primitives";

/** Only links to a Base Sepolia transaction on BaseScan are shown (testnet-demo TN-3). */
const BASESCAN_TX = /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-fA-F]{64}$/;

export function basescanLink(url: unknown): string | null {
  return typeof url === "string" && BASESCAN_TX.test(url) ? url : null;
}

/** "0x1234…cdef", so the hash fits on a phone. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

type Decision = "allow" | "hold" | "deny";

interface PaymentResult {
  decision: Decision;
  reasons: string[];
  railStatus: "settled" | "failed" | "unknown" | null;
  txHash: string | null;
  link: string | null;
  eventSeq: number | null;
}

type State =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: PaymentResult }
  | { phase: "refused"; message: "testnet.rateLimited" | "testnet.quotaUsed" | "testnet.error" };

/** The response body, read defensively: anything unexpected becomes the generic error. */
function readResult(body: unknown): PaymentResult | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.decision !== "allow" && b.decision !== "hold" && b.decision !== "deny") return null;
  const reasons = Array.isArray(b.reasons) ? b.reasons.map((r) => (typeof r === "object" && r !== null ? String((r as { code?: unknown }).code ?? "") : String(r))).filter(Boolean) : [];
  const railStatus = b.rail_status === "settled" || b.rail_status === "failed" || b.rail_status === "unknown" ? b.rail_status : null;
  const link = basescanLink(b.explorer_url);
  return {
    decision: b.decision,
    reasons,
    railStatus,
    txHash: link && typeof b.rail_ref === "string" ? b.rail_ref : null,
    link,
    eventSeq: typeof b.event_seq === "number" ? b.event_seq : null,
  };
}

const TONE: Record<Decision, "allow" | "hold" | "deny"> = { allow: "allow", hold: "hold", deny: "deny" };

/**
 * The "Real testnet payment" card on /scenarios (testnet-demo TN-1, TN-3,
 * TN-4). One button, no inputs: the server decides everything about the
 * payment. Shown only when the page found the testnet available.
 */
export function TestnetPaymentCard({ fetcher }: { fetcher?: typeof fetch }) {
  const { t, reasonText } = useCopy();
  const [state, setState] = useState<State>({ phase: "idle" });

  const pay = async () => {
    setState({ phase: "running" });
    try {
      const response = await (fetcher ?? fetch)("/api/v1/testnet/pay", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        const quota = typeof body === "object" && body !== null && (body as { error?: unknown }).error === "TESTNET_QUOTA_USED";
        setState({ phase: "refused", message: quota ? "testnet.quotaUsed" : "testnet.rateLimited" });
        return;
      }
      const result = response.ok ? readResult(body) : null;
      setState(result ? { phase: "done", result } : { phase: "refused", message: "testnet.error" });
    } catch {
      setState({ phase: "refused", message: "testnet.error" });
    }
  };

  const running = state.phase === "running";
  return (
    <Card aria-labelledby="testnet-title" className="flex flex-col gap-3 border-accent">
      <h2 id="testnet-title" className="flex items-center gap-2 text-base font-semibold">
        <Zap aria-hidden="true" className="size-4 text-accent" />
        {t("testnet.title")}
      </h2>
      <p className="text-sm">{t("testnet.description")}</p>
      <p className="text-xs text-text-muted">{t("testnet.limits")}</p>
      <div>
        <Button disabled={running} onClick={() => void pay()}>
          {running ? t("testnet.running") : t("testnet.button")}
        </Button>
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-2 text-sm">
        {state.phase === "refused" ? <p>{t(state.message)}</p> : null}
        {state.phase === "done" ? (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[state.result.decision]}>{t(`decision.${state.result.decision}`)}</Badge>
              {state.result.railStatus === "settled" ? <span>{t("testnet.settled")}</span> : null}
              {state.result.eventSeq !== null ? (
                <span className="text-text-muted">
                  {t("testnet.auditSeq")} #{state.result.eventSeq}
                </span>
              ) : null}
            </p>
            {state.result.reasons.length > 0 ? (
              <ul className="list-disc pl-5">
                {state.result.reasons.map((code) => (
                  <li key={code}>{reasonText(code)}</li>
                ))}
              </ul>
            ) : null}
            {state.result.railStatus === "unknown" ? <p>{t("testnet.unknown")}</p> : null}
            {state.result.railStatus === "failed" ? <p>{t("testnet.failed")}</p> : null}
            {state.result.link && state.result.txHash ? (
              <a href={state.result.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline">
                {t("testnet.viewTx")}: <code className="font-mono">{shortHash(state.result.txHash)}</code>
                <ExternalLink aria-hidden="true" className="size-3" />
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
