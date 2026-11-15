"use client";

import { Check, Copy, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/ui/components/primitives";
import { t } from "@/ui/copy";

export type CreateAgent = (name: string) => Promise<{ status: number; body: unknown }>;

export const postCreateAgent: CreateAgent = async (name) => {
  const response = await fetch("/api/v1/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

/**
 * Create an agent (UI-7). The API key is shown once, in this dialog, with
 * a copy button; it lives only in this component's state and is dropped
 * when the dialog closes. A native <dialog> handles focus, Escape, and
 * the inert background.
 */
export function CreateAgentDialog({ create = postCreateAgent, copy = (text: string) => navigator.clipboard.writeText(text) }: { create?: CreateAgent; copy?: (text: string) => Promise<void> }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nameId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = () => {
    setName("");
    setError("");
    setKey(null);
    setCopied(false);
    dialog.current?.showModal();
  };
  const close = () => dialog.current?.close();
  const onClose = () => {
    if (key) router.refresh();
    setKey(null);
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Give the agent a name");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await create(name.trim());
      const apiKey = (result.body as { api_key?: unknown } | null)?.api_key;
      if (result.status === 201 && typeof apiKey === "string") setKey(apiKey);
      else setError(result.status === 401 ? t("error.unauthorized") : t("error.generic"));
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={open}>
        <Plus aria-hidden="true" className="size-4" />
        {t("agents.create")}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={onClose}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-border bg-surface p-6 text-text backdrop:bg-black/40"
      >
        <h2 id={titleId} className="mb-4 text-lg font-semibold">
          {t("agents.create")}
        </h2>
        {key ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm" role="alert">
              {t("agents.keyOnce")}
            </p>
            <code className="block break-all rounded-card border border-border bg-surface-muted p-3 font-mono text-sm">{key}</code>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void copy(key).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                {copied ? t("agents.copied") : t("agents.copyKey")}
              </Button>
              <Button onClick={close}>{t("agents.close")}</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" noValidate>
            <label htmlFor={nameId} className="text-sm">
              {t("agents.name")}
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              className="min-h-10 rounded-card border border-border bg-surface px-2"
            />
            <p role="status" aria-live="polite" className="text-sm text-deny">
              {error}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close}>
                {t("agents.close")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("agents.create")}
              </Button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
