import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isBlockedAddress, isLoopback } from "./ip";

/**
 * The SSRF-safe fetcher behind /api/v1/fetch (taint-and-intent design,
 * TAINT-2, TAINT-3):
 * 1. https only, plus localhost in development. No credentials in the URL.
 * 2. Resolve DNS and refuse if any address is in a blocked range. The
 *    connection then uses exactly the checked addresses, so a second DNS
 *    answer can't swap in a private one (DNS rebinding).
 * 3. Redirects are followed by hand, up to 3, and each hop is checked again.
 * 4. The body is capped at 1 MB after decompression, and the whole fetch,
 *    redirects included, at 10 seconds.
 * 5. The result is text. Callers never render it as HTML.
 */

export type FetchErrorCode = "FETCH_BLOCKED" | "FETCH_TIMEOUT" | "FETCH_TOO_LARGE" | "FETCH_FAILED";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    /** A short reason for the server log and the audit event. Never contains fetched content. */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "FetchError";
  }
}

export interface FetchedPage {
  /** The URL the body came from, after redirects. */
  url: string;
  /** Every URL requested, in order, ending with `url`. */
  hops: readonly string[];
  status: number;
  contentType: string | null;
  body: string;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchOptions {
  /** Allow http and https to the hostname "localhost" (NODE_ENV=development only). */
  allowLocalhost?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** DNS resolution. Tests replace it. */
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function systemResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Check one hop's URL and resolve its host. Throws FETCH_BLOCKED or FETCH_FAILED. */
async function checkHop(raw: string, options: SafeFetchOptions): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("FETCH_BLOCKED", "not a valid URL");
  }
  const localhost = options.allowLocalhost === true && url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new FetchError("FETCH_BLOCKED", `scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new FetchError("FETCH_BLOCKED", "credentials in the URL");

  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const allowed = (address: string) => !isBlockedAddress(address) || (localhost && isLoopback(address));

  if (isIP(host) !== 0) {
    if (!allowed(host)) throw new FetchError("FETCH_BLOCKED", "address is in a blocked range");
    return { url, addresses: [{ address: host, family: isIP(host) === 6 ? 6 : 4 }] };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (options.resolve ?? systemResolve)(host);
  } catch {
    throw new FetchError("FETCH_FAILED", "DNS lookup failed");
  }
  if (addresses.length === 0) throw new FetchError("FETCH_FAILED", "DNS returned no addresses");
  // Every answer must pass, not just the first: the client may try any of them.
  if (!addresses.every((a) => allowed(a.address))) throw new FetchError("FETCH_BLOCKED", "host resolves to a blocked address");
  return { url, addresses };
}

/** A lookup that only ever returns the addresses already checked. */
function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return ((_hostname: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (opts?.all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as unknown as LookupFunction;
}

function send(url: URL, addresses: readonly ResolvedAddress[], signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: "GET",
      agent: false,
      lookup: pinnedLookup(addresses),
      signal,
      headers: {
        "user-agent": "AgentVault-Fetch/1.0",
        accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    req.on("response", resolve);
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: IncomingMessage): Readable {
  const encoding = (res.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(createGunzip());
  if (encoding === "deflate") return res.pipe(createInflate());
  if (encoding === "br") return res.pipe(createBrotliDecompress());
  if (encoding === "identity" || encoding === "") return res;
  throw new FetchError("FETCH_FAILED", `unsupported content encoding ${encoding}`);
}

/** Read the body as text, stopping as soon as it passes `maxBytes` after decompression. */
async function readText(res: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(res.headers["content-length"] ?? "", 10);
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    res.destroy();
    throw new FetchError("FETCH_TOO_LARGE", "declared length is over the limit");
  }
  const stream = decoded(res);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) throw new FetchError("FETCH_TOO_LARGE", "body is over the limit");
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
    res.destroy();
  }
  return textDecoder(res.headers["content-type"]).decode(Buffer.concat(chunks));
}

function textDecoder(contentType: string | undefined): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

/** Fetch a URL under the SSRF rules. Throws FetchError for every refusal or failure. */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const hops: string[] = [];
  let next = rawUrl;
  try {
    for (;;) {
      const { url, addresses } = await checkHop(next, options);
      hops.push(url.href);
      const res = await send(url, addresses, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (REDIRECTS.has(status) && location) {
        res.destroy();
        if (hops.length > maxRedirects) throw new FetchError("FETCH_BLOCKED", `more than ${maxRedirects} redirects`);
        try {
          next = new URL(location, url).href;
        } catch {
          throw new FetchError("FETCH_FAILED", "invalid redirect location");
        }
        continue;
      }
      const body = await readText(res, maxBytes);
      return { url: url.href, hops, status, contentType: res.headers["content-type"] ?? null, body };
    }
  } catch (error) {
    if (signal.aborted) throw new FetchError("FETCH_TIMEOUT", "took longer than the time limit");
    if (error instanceof FetchError) throw error;
    throw new FetchError("FETCH_FAILED", "connection or protocol error");
  }
}
