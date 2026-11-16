// `pnpm gemini:probe`: check that GEMINI_API_KEY works and list the
// Flash-Lite model IDs it can call. Makes one models.list request, which
// doesn't use generate quota. With `--generate <model>` it also makes one
// tiny generateContent request (1 of the free tier's daily requests).
// Never prints the key; on failure prints only the HTTP status and
// Google's error status code.
import { loadLocalEnv } from "./lib/load-env";

const API = "https://generativelanguage.googleapis.com/v1beta";

interface ModelInfo {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

async function call(path: string, key: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}/${path}`, { ...init, headers: { "x-goog-api-key": key, "content-type": "application/json" }, redirect: "error" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function errorStatus(body: unknown): string {
  const status = (body as { error?: { status?: unknown } } | null)?.error?.status;
  return typeof status === "string" ? status : "unknown";
}

async function main() {
  loadLocalEnv();
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log("GEMINI_API_KEY is unset.");
    process.exitCode = 1;
    return;
  }
  const list = await call("models?pageSize=1000", key);
  if (list.status !== 200) {
    console.log(`models.list failed: HTTP ${list.status} ${errorStatus(list.body)}`);
    process.exitCode = 1;
    return;
  }
  const models = ((list.body as { models?: ModelInfo[] }).models ?? []).filter((m) => /flash/i.test(m.name ?? ""));
  console.log(`models.list OK. Flash models that support generateContent:`);
  for (const m of models) {
    if (m.supportedGenerationMethods?.includes("generateContent")) console.log(`  ${m.name}  (${m.displayName ?? ""})`);
  }

  const i = process.argv.indexOf("--generate");
  const model = i >= 0 ? process.argv[i + 1] : undefined;
  if (!model) return;
  if (!/^[a-z0-9.-]+$/.test(model)) {
    console.log("Model ID may only contain lowercase letters, digits, dots, and hyphens.");
    process.exitCode = 1;
    return;
  }
  const gen = await call(`models/${model}:generateContent`, key, {
    method: "POST",
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }], generationConfig: { maxOutputTokens: 8 } }),
  });
  if (gen.status !== 200) {
    console.log(`generateContent on ${model} failed: HTTP ${gen.status} ${errorStatus(gen.body)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`generateContent on ${model} OK.`);
}

main().catch((error: unknown) => {
  console.log(`probe failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
