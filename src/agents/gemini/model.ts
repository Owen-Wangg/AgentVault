import { ApiError, type Content, type FunctionDeclaration, GoogleGenAI } from "@google/genai";

/**
 * The one place the live agent talks to Gemini (demo-agents AGT-11 to
 * AGT-16), through the official @google/genai SDK (tech.md). Everything
 * else in src/agents/gemini goes through the GeminiModel interface, so
 * tests replace the network with recorded responses and never call Gemini.
 *
 * - No retries: the SDK retries only when retryOptions is set, and this
 *   never sets it. A 429 stops the run at once (AGT-14) instead of
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
}

export interface GeminiModel {
  readonly id: string;
  generate(request: GeminiRequest): Promise<GeminiReply>;
}

export type GeminiErrorKind = "rate_limited" | "failed";

/** A Gemini call that didn't produce a reply. Carries only the kind and HTTP status, never the request. */
export class GeminiError extends Error {
  constructor(
    readonly kind: GeminiErrorKind,
    readonly status: number,
  ) {
    super(kind === "rate_limited" ? "Gemini rate limit reached" : `Gemini request failed${status ? ` (HTTP ${status})` : ""}`);
    this.name = "GeminiError";
  }
}

/** Map anything the SDK throws to a GeminiError. 429 is the free tier's rate limit (AGT-14). */
export function toGeminiError(error: unknown): GeminiError {
  if (error instanceof GeminiError) return error;
  if (error instanceof ApiError) return new GeminiError(error.status === 429 ? "rate_limited" : "failed", error.status);
  return new GeminiError("failed", 0);
}

export interface GeminiModelOptions {
  apiKey: string;
  model: string;
  /** Per request. Defaults to 20 s. */
  timeoutMs?: number;
  /** Tests pass a fetch that answers with recorded responses. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createGeminiModel(options: GeminiModelOptions): GeminiModel {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(options.fetch ? { fetch: options.fetch } : {}) },
  });
  return {
    id: options.model,
    async generate(request) {
      try {
        const response = await ai.models.generateContent({
          model: options.model,
          contents: request.contents,
          config: {
            systemInstruction: request.system,
            temperature: 0,
            maxOutputTokens: request.maxOutputTokens ?? 1024,
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
    },
  };
}
