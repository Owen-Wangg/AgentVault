"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { type FieldError, type UseFormRegister, useFieldArray, useForm, useWatch } from "react-hook-form";
import type { EnvelopeWire } from "@/core/policy";
import { Button, Card, CardTitle, cn } from "@/ui/components/primitives";
import { type UiKey, t } from "@/ui/copy";
import { EMPTY_LIMITS, type EnvelopeForm, EnvelopeFormSchema, formToWire, wireToForm } from "./envelope-form";

/**
 * The envelope editor (UI-8). Every limit is validated before saving,
 * amounts are typed as decimal dollars and sent as micros strings, and a
 * save against a version someone else already replaced is refused.
 */

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export type SaveEnvelope = (body: EnvelopeWire) => Promise<{ status: number; body: unknown }>;

export const putEnvelope =
  (agentId: string): SaveEnvelope =>
  async (body) => {
    const response = await fetch(`/api/v1/agents/${encodeURIComponent(agentId)}/envelope`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

const LIMIT_FIELDS: readonly { key: keyof EnvelopeForm["limits"]; label: UiKey; inputMode: "decimal" | "numeric" }[] = [
  { key: "txMax", label: "envelope.txMax", inputMode: "decimal" },
  { key: "approvalThreshold", label: "envelope.approvalThreshold", inputMode: "decimal" },
  { key: "capMinute", label: "envelope.capMinute", inputMode: "decimal" },
  { key: "capHour", label: "envelope.capHour", inputMode: "decimal" },
  { key: "capDay", label: "envelope.capDay", inputMode: "decimal" },
  { key: "callsPerMinute", label: "envelope.callsPerMinute", inputMode: "numeric" },
];

export function EnvelopeEditor({
  initial,
  version: initialVersion,
  readOnly,
  save,
}: {
  initial: EnvelopeWire;
  version: number;
  readOnly: boolean;
  save: SaveEnvelope;
}) {
  const [version, setVersion] = useState(initialVersion);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const form = useForm<EnvelopeForm>({ resolver: zodResolver(EnvelopeFormSchema), defaultValues: wireToForm(initial), mode: "onBlur" });
  const { register, handleSubmit, formState } = form;
  const allowAllVendors = useWatch({ control: form.control, name: "allowAllVendors" });
  const allowAllTools = useWatch({ control: form.control, name: "allowAllTools" });
  const vendorRows = useFieldArray({ control: form.control, name: "vendorLimits" });
  const toolRows = useFieldArray({ control: form.control, name: "toolLimits" });

  const onSubmit = handleSubmit(async (values) => {
    setState({ kind: "saving" });
    try {
      const result = await save(formToWire(values, version));
      if (result.status === 200) {
        const next = (result.body as { version?: unknown } | null)?.version;
        if (typeof next === "number") setVersion(next);
        setState({ kind: "saved" });
      } else if (result.status === 409) {
        setState({ kind: "error", message: "Someone else changed this envelope. Reload the page to see their version." });
      } else if (result.status === 401) {
        setState({ kind: "error", message: t("error.unauthorized") });
      } else {
        setState({ kind: "error", message: t("error.generic") });
      }
    } catch {
      setState({ kind: "error", message: t("error.generic") });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate aria-label={t("envelope.title")}>
      {readOnly ? (
        <p className="mb-4 rounded-card border border-border bg-surface-muted px-3 py-2 text-sm" role="note">
          {t("envelope.readOnly")}
        </p>
      ) : null}
      <fieldset disabled={readOnly || state.kind === "saving"} className="flex flex-col gap-4">
        <Card>
          <CardTitle>{t("envelope.agentLimits")}</CardTitle>
          <p className="mt-1 text-xs text-text-muted">{t("envelope.noLimit")}</p>
          <LimitsFields register={register} prefix="limits" errors={formState.errors.limits} />
        </Card>

        <Card>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <AllowList
              label={t("envelope.allowedVendors")}
              allowAll={allowAllVendors}
              checkbox={register("allowAllVendors")}
              textarea={register("vendors")}
              error={formState.errors.vendors}
            />
            <AllowList
              label={t("envelope.allowedTools")}
              allowAll={allowAllTools}
              checkbox={register("allowAllTools")}
              textarea={register("tools")}
              error={formState.errors.tools}
            />
          </div>
        </Card>

        {(
          [
            { title: "envelope.vendorLimits", add: "envelope.addVendorLimit", rows: vendorRows, name: "vendorLimits" },
            { title: "envelope.toolLimits", add: "envelope.addToolLimit", rows: toolRows, name: "toolLimits" },
          ] as const
        ).map(({ title, add, rows, name }) => (
          <Card key={name}>
            <CardTitle>{t(title)}</CardTitle>
            <ul className="mt-2 flex flex-col gap-4">
              {rows.fields.map((field, i) => (
                <li key={field.id} className="rounded-card border border-border p-3">
                  <div className="flex items-end gap-2">
                    <TextField
                      label={t("envelope.limitName")}
                      error={formState.errors[name]?.[i]?.name}
                      className="flex-1"
                      {...register(`${name}.${i}.name`)}
                    />
                    <Button variant="ghost" onClick={() => rows.remove(i)} aria-label={`${t("envelope.remove")} ${i + 1}`}>
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                  <LimitsFields register={register} prefix={`${name}.${i}.limits`} errors={formState.errors[name]?.[i]?.limits} />
                </li>
              ))}
            </ul>
            <Button variant="secondary" className="mt-3" onClick={() => rows.append({ name: "", limits: { ...EMPTY_LIMITS } })}>
              <Plus aria-hidden="true" className="size-4" />
              {t(add)}
            </Button>
          </Card>
        ))}

        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">{t("envelope.save")}</Button>
            <span role="status" aria-live="polite" className={cn("text-sm", state.kind === "error" ? "text-deny" : "text-text-muted")}>
              {state.kind === "saved" ? t("envelope.saved") : state.kind === "error" ? state.message : state.kind === "saving" ? t("state.loading") : ""}
            </span>
          </div>
        ) : null}
      </fieldset>
    </form>
  );
}

type LimitsErrors = Partial<Record<keyof EnvelopeForm["limits"], FieldError>> | undefined;

function LimitsFields({ register, prefix, errors }: { register: UseFormRegister<EnvelopeForm>; prefix: "limits" | `vendorLimits.${number}.limits` | `toolLimits.${number}.limits`; errors: LimitsErrors }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {LIMIT_FIELDS.map((f) => (
        <TextField key={f.key} label={t(f.label)} inputMode={f.inputMode} error={errors?.[f.key]} {...register(`${prefix}.${f.key}`)} />
      ))}
    </div>
  );
}

function TextField({
  label,
  error,
  className,
  ...input
}: { label: string; error: FieldError | undefined; className?: string } & React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn("min-h-10 rounded-card border bg-surface px-2 font-mono", error ? "border-deny" : "border-border")}
        {...input}
      />
      {error ? (
        <span id={`${id}-error`} className="text-xs text-deny">
          {error.message}
        </span>
      ) : null}
    </div>
  );
}

function AllowList({
  label,
  allowAll,
  checkbox,
  textarea,
  error,
}: {
  label: string;
  allowAll: boolean;
  checkbox: ReturnType<UseFormRegister<EnvelopeForm>>;
  textarea: ReturnType<UseFormRegister<EnvelopeForm>>;
  error: FieldError | undefined;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="font-medium">{label}</span>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="size-4" {...checkbox} />
        {t("envelope.allowAll")}
      </label>
      <label htmlFor={id} className="text-xs text-text-muted">
        {t("envelope.listHint")}
      </label>
      <textarea
        id={id}
        rows={4}
        // readOnly, not disabled: react-hook-form submits disabled fields as undefined.
        readOnly={allowAll}
        aria-disabled={allowAll || undefined}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn("rounded-card border bg-surface p-2 font-mono", error ? "border-deny" : "border-border", allowAll && "bg-surface-muted text-text-muted")}
        {...textarea}
      />
      {error ? (
        <span id={`${id}-error`} className="text-xs text-deny">
          {error.message}
        </span>
      ) : null}
    </div>
  );
}
