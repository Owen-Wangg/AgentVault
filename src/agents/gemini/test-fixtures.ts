import { createGeminiModel } from "./model";

/**
 * Test-only: recorded Gemini API responses and a fetch that replays them
 * to the real @google/genai SDK, so tests cover the SDK's parsing without
 * calling Gemini (testing-standards: tests use recorded responses).
 *
 * The bodies follow the REST GenerateContentResponse shape the Gemini API
 * returned to `pnpm gemini:probe` and the @live test: candidates[0].content
 * with role "model" and parts, plus finishReason, usageMetadata,
 * modelVersion, and responseId. Function-call parts carry a
 * thoughtSignature, as Gemini 3 models return them.
 */

export const TEST_GEMINI_KEY = `AIza${"T".repeat(35)}`;
export const TEST_MODEL = "gemini-3.5-flash-lite";

export interface Recorded {
  status: number;
  body: unknown;
}

let responseId = 0;

function envelope(parts: unknown[]): unknown {
  responseId += 1;
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 412, candidatesTokenCount: 24, totalTokenCount: 436 },
    modelVersion: TEST_MODEL,
    responseId: `rec-${responseId}`,
  };
}

/** A turn in which the model calls one or more functions. */
export const functionCalls = (...calls: { name: string; args: Record<string, unknown> }[]): Recorded => ({
  status: 200,
  body: envelope(calls.map((c, i) => ({ functionCall: { name: c.name, args: c.args }, ...(i === 0 ? { thoughtSignature: "c2lnbmF0dXJlLXJlY29yZGVk" } : {}) }))),
});

/** A final text turn. */
export const text = (t: string): Recorded => ({ status: 200, body: envelope([{ text: t }]) });

/** The scorer's reply: the bare integer it is asked for. */
export const score = (n: number): Recorded => text(String(n));

/** The free tier's rate limit, as the Gemini API reports it. */
export const rateLimited = (): Recorded => ({
  status: 429,
  body: {
    error: {
      code: 429,
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
    },
  },
});

export const serverError = (): Recorded => ({ status: 500, body: { error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } } });

/** Gemini's "model overloaded" answer. */
export const overloaded = (): Recorded => ({ status: 503, body: { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } } });

/** No response at all: the connection fails, as fetch reports it. */
export const NETWORK_ERROR = 0;
export const networkError = (): Recorded => ({ status: NETWORK_ERROR, body: null });

export interface SentRequest {
  url: string;
  headers: Headers;
  body: { contents?: { role?: string; parts?: Record<string, unknown>[] }[]; systemInstruction?: unknown; tools?: unknown; generationConfig?: Record<string, unknown> };
}

/** A fetch that answers each request with the next recorded response and keeps what was sent. */
export function replay(...responses: Recorded[]) {
  const sent: SentRequest[] = [];
  const queue = [...responses];
  const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) as SentRequest["body"] });
    const next = queue.shift();
    if (!next) throw new Error("no more recorded Gemini responses");
    if (next.status === NETWORK_ERROR) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { send, sent, remaining: () => queue.length };
}

/** The real SDK-backed model, talking to `replay` instead of Gemini. */
export function recordedModel(...responses: Recorded[]) {
  const r = replay(...responses);
  return { model: createGeminiModel({ apiKey: TEST_GEMINI_KEY, model: TEST_MODEL, fetch: r.send, retryDelayMs: 0 }), ...r };
}
