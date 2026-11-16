import { ApiError, type Content, type FunctionDeclaration, GoogleGenAI } from "@google/genai";

/**
 * The one place the live agent talks to Gemini (demo-agents AGT-11 to
 * AGT-16), through the official @google/genai SDK (tech.md). Everything
 * else in src/agents/gemini goes through the GeminiModel interface, so
 * tests replace the network with recorded responses and never call Gemini.
 *
 * - The SDK's own retries stay off (it retries only when retryOptions is
 *   set). generate() retries once itself, and only a timeout or a 5xx,
 *   which Gemini returns now and then when a model is overloaded. A 429
 *   is never retried: it stops the run at once (AGT-14) instead of
 *   spending more of the shared free-tier quota.
 * - The API key goes only to the SDK. It's never logged, returned, or put
 *   in an error message.
 */

export interface FunctionCallPart {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiReply {
  /** The model's turn exactly as returned, so it goes back into the history unchanged (Gemini 3 thought signatures). */
  content: Content | null;
  functionCalls: FunctionCallPart[];
  text: string;
}

export interface GeminiRequest {
  system: string;
  contents: Content[];
  /** Function declarations for an agent turn. */
  tools?: FunctionDeclaration[];
  /** A JSON schema for a structured reply (the drift score). */
  jsonSchema?: unknown;
  maxOutputTokens?: number;
  /** Per attempt, overriding the model's default. */
  timeoutMs?: number;
}

export interface GeminiModel {
  readonly id: string;
  generate(request: GeminiRequest): Promise<GeminiReply>;
}

export type GeminiErrorKind = "rate_limited" | "timeout" | "failed";

/** A Gemini call that didn't produce a reply. Carries only the kind and HTTP status, never the request. */
export class GeminiError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    readonly status: number,
  ) {
    super(
      kind === "rate_limited" ? "Gemini rate limit reached" : kind === "timeout" ? "Gemini request timed out" : `Gemini request failed${status ? ` (HTTP ${status})` : ""}`,
    );
    this.name = "GeminiError";
  }
}

/** Map anything the SDK throws to a GeminiError. 429 is the free tier's rate limit (AGT-14). */
export function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  if (error instanceof ApiError) return new GeminiError(error.status === 429 ? "rate_limited" : "failed", error.status);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return new GeminiError("timeout", 0);
  return new GeminiError("failed", 0);
}

/**
 * Worth one more try: a timeout, a dropped connection, or a 5xx such as
 * the 503 "model overloaded" Gemini returns now and then. Never a 429
 * (that is the shared quota, AGT-14) or another 4xx (the request itself
 * is wrong).
 */
export const isTransient = (e: GeminiError): boolean => e.kind === "timeout" || (e.kind === "failed" && (e.status === 0 || e.status >= 500));

/** The pause before the one retry. */
export const RETRY_DELAY_MS = 500;

export interface GeminiModelOptions {
  apiKey: string;
  model: string;
  /** Per request. Defaults to 20 s. */
  timeoutMs?: number;
  /** Tests pass a fetch that answers with recorded responses. */
  fetch?: typeof fetch;
  /** Tests set 0. */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createGeminiModel(options: GeminiModelOptions): GeminiModel {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(options.fetch ? { fetch: options.fetch } : {}) },
  });
  async function once(request: GeminiRequest): Promise<GeminiReply> {
    try {
      const response = await ai.models.generateContent({
        model: options.model,
        contents: request.contents,
        config: {
          systemInstruction: request.system,
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens ?? 1024,
          ...(request.timeoutMs ? { httpOptions: { timeout: request.timeoutMs } } : {}),
          ...(request.tools ? { tools: [{ functionDeclarations: request.tools }] } : {}),
          ...(request.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: request.jsonSchema } : {}),
        },
      });
      const content = response.candidates?.[0]?.content ?? null;
      const functionCalls: FunctionCallPart[] = (response.functionCalls ?? []).map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        name: c.name ?? "",
        args: c.args ?? {},
      }));
      const text = (content?.parts ?? []).map((p) => (typeof p.text === "string" && !p.thought ? p.text : "")).join("");
      return { content, functionCalls, text };
    } catch (error) {
      throw toGeminiError(error);
    }
  }

  return {
    id: options.model,
    async generate(request) {
      try {
        return await once(request);
      } catch (error) {
        const e = toGeminiError(error);
        if (!isTransient(e)) throw e;
        // One retry for a timeout or a 5xx; a second failure stops the run (AGT-14).
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? RETRY_DELAY_MS));
        return once(request);
      }
    },
  };
}
