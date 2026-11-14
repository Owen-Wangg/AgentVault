import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FETCH_MAX_BYTES, FetchError, type SafeFetchOptions, safeFetch } from "./fetcher";

/**
 * The fetcher against a real local HTTP server. "localhost" is allowed
 * only through the development exception, and it resolves to 127.0.0.1
 * through an injected resolver, so these tests never touch the network.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const hits: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const handler = routes.get(req.url ?? "");
    if (handler) handler(req, res);
    else res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const local = (resolveTo = "127.0.0.1"): SafeFetchOptions => ({
  allowLocalhost: true,
  resolve: async () => [{ address: resolveTo, family: resolveTo.includes(":") ? 6 : 4 }],
});

async function fetchError(url: string, options: SafeFetchOptions): Promise<FetchError> {
  try {
    await safeFetch(url, options);
  } catch (error) {
    if (error instanceof FetchError) return error;
    throw error;
  }
  throw new Error("expected the fetch to fail");
}

describe("TAINT-1, TAINT-3: fetching", () => {
  it("TAINT-3: returns the body as text with the final URL", async () => {
    routes.set("/page", (_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>héllo</p>"));
    const page = await safeFetch(`${base}/page`, local());
    expect(page).toEqual({ url: `${base}/page`, hops: [`${base}/page`], status: 200, contentType: "text/html; charset=utf-8", body: "<p>héllo</p>" });
  });

  it("TAINT-1: a non-2xx response is still content the agent sees", async () => {
    const page = await safeFetch(`${base}/missing`, local());
    expect(page).toMatchObject({ status: 404, body: "not found" });
  });

  it("TAINT-3: decompresses gzip bodies", async () => {
    routes.set("/gz", (_req, res) => res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("compressed text")));
    expect((await safeFetch(`${base}/gz`, local())).body).toBe("compressed text");
  });

  it("TAINT-2: follows up to 3 redirects, including relative ones", async () => {
    routes.set("/r1", (_req, res) => res.writeHead(302, { location: "/r2" }).end());
    routes.set("/r2", (_req, res) => res.writeHead(301, { location: `${base}/r3` }).end());
    routes.set("/r3", (_req, res) => res.writeHead(307, { location: "page" }).end());
    const page = await safeFetch(`${base}/r1`, local());
    expect(page.hops).toEqual([`${base}/r1`, `${base}/r2`, `${base}/r3`, `${base}/page`]);
    expect(page.url).toBe(`${base}/page`);
  });

  it("TAINT-2: refuses a fourth redirect", async () => {
    routes.set("/loop", (_req, res) => res.writeHead(302, { location: "/loop" }).end());
    expect(await fetchError(`${base}/loop`, local())).toMatchObject({ code: "FETCH_BLOCKED" });
  });
});

describe("TAINT-2: blocked destinations", () => {
  it.each([
    ["plain http to a public host", "http://example.com/"],
    ["an ftp URL", "ftp://example.com/"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL", "example.com/docs"],
    ["the metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["IPv4 loopback", "https://127.0.0.1/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["an IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["a private address", "https://10.0.0.5/"],
    ["a decimal-encoded loopback", "https://2130706433/"],
    ["an octal-encoded loopback", "https://0177.0.0.1/"],
    ["credentials in the URL", "https://user:pw@example.com/"],
  ])("TAINT-2: refuses %s without connecting", async (_name, url) => {
    let resolved = 0;
    const error = await fetchError(url, { resolve: async () => ((resolved += 1), [{ address: "93.184.215.14", family: 4 }]) });
    expect(error.code).toBe("FETCH_BLOCKED");
    if (url.includes("@")) expect(resolved).toBe(0);
  });

  it.each([
    ["a private address", "10.0.0.5"],
    ["the metadata address", "169.254.169.254"],
    ["IPv6 ULA", "fd00::1"],
    ["loopback", "127.0.0.1"],
  ])("TAINT-2: refuses a hostname that resolves to %s", async (_name, address) => {
    const error = await fetchError("https://vendor.example/docs", { resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
    expect(error.code).toBe("FETCH_BLOCKED");
  });

  it("TAINT-2: refuses a hostname if any of its addresses is blocked", async () => {
    const error = await fetchError("https://vendor.example/docs", {
      resolve: async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    expect(error.code).toBe("FETCH_BLOCKED");
  });

  it("TAINT-2: localhost is refused unless the development exception is on", async () => {
    expect(await fetchError(`${base}/page`, { resolve: local().resolve! })).toMatchObject({ code: "FETCH_BLOCKED" });
  });

  it("TAINT-2: the development exception covers only loopback addresses for the name localhost", async () => {
    expect(await fetchError(`${base}/page`, local("10.0.0.5"))).toMatchObject({ code: "FETCH_BLOCKED" });
  });

  it("TAINT-2: a redirect to the metadata address is refused before it is requested", async () => {
    routes.set("/to-metadata", (_req, res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end());
    expect(await fetchError(`${base}/to-metadata`, local())).toMatchObject({ code: "FETCH_BLOCKED" });
  });

  it("TAINT-2: a redirect to a loopback IP is refused even in development", async () => {
    const port = (server.address() as AddressInfo).port;
    routes.set("/to-ip", (_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/page` }).end());
    hits.length = 0;
    expect(await fetchError(`${base}/to-ip`, local())).toMatchObject({ code: "FETCH_BLOCKED" });
    expect(hits).toEqual(["/to-ip"]);
  });

  it("TAINT-2: a redirect to a host that resolves privately is refused", async () => {
    routes.set("/to-internal", (_req, res) => res.writeHead(302, { location: "https://internal.example/" }).end());
    const options: SafeFetchOptions = {
      allowLocalhost: true,
      resolve: async (host) => [{ address: host === "localhost" ? "127.0.0.1" : "192.168.0.10", family: 4 }],
    };
    expect(await fetchError(`${base}/to-internal`, options)).toMatchObject({ code: "FETCH_BLOCKED" });
  });
});

describe("TAINT-3: size and time limits", () => {
  it("TAINT-3: a body of exactly 1 MB is returned", async () => {
    routes.set("/max", (_req, res) => res.writeHead(200).end("a".repeat(FETCH_MAX_BYTES)));
    expect((await safeFetch(`${base}/max`, local())).body).toHaveLength(FETCH_MAX_BYTES);
  });

  it("TAINT-3: a body over 1 MB is refused", async () => {
    routes.set("/big", (_req, res) => {
      res.writeHead(200);
      res.write("a".repeat(FETCH_MAX_BYTES));
      res.end("b");
    });
    expect(await fetchError(`${base}/big`, local())).toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("TAINT-3: a body sent without a length is cut off at the limit", async () => {
    routes.set("/stream", (_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      const timer = setInterval(() => res.write("x".repeat(64 * 1024)), 1);
      res.on("close", () => clearInterval(timer));
    });
    expect(await fetchError(`${base}/stream`, local())).toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("TAINT-3: a declared length over the limit is refused before reading", async () => {
    routes.set("/declared", (_req, res) => {
      res.writeHead(200, { "content-length": String(FETCH_MAX_BYTES + 1) });
      res.write("a");
    });
    expect(await fetchError(`${base}/declared`, local())).toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("TAINT-3: the limit applies after decompression, so a gzip bomb is refused", async () => {
    const bomb = gzipSync(Buffer.alloc(4 * FETCH_MAX_BYTES));
    expect(bomb.length).toBeLessThan(FETCH_MAX_BYTES);
    routes.set("/bomb", (_req, res) => res.writeHead(200, { "content-encoding": "gzip" }).end(bomb));
    expect(await fetchError(`${base}/bomb`, local())).toMatchObject({ code: "FETCH_TOO_LARGE" });
  });

  it("TAINT-3: a server that never answers times out", async () => {
    routes.set("/hang", () => {});
    expect(await fetchError(`${base}/hang`, { ...local(), timeoutMs: 200 })).toMatchObject({ code: "FETCH_TIMEOUT" });
  });

  it("TAINT-3: a body that stalls halfway times out", async () => {
    routes.set("/stall", (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
    });
    expect(await fetchError(`${base}/stall`, { ...local(), timeoutMs: 200 })).toMatchObject({ code: "FETCH_TIMEOUT" });
  });

  it("TAINT-3: the time limit covers the whole redirect chain", async () => {
    routes.set("/slow-redirect", (_req, res) => {
      setTimeout(() => res.writeHead(302, { location: "/hang" }).end(), 120);
    });
    expect(await fetchError(`${base}/slow-redirect`, { ...local(), timeoutMs: 200 })).toMatchObject({ code: "FETCH_TIMEOUT" });
  });
});

describe("TAINT-2: DNS pinning", () => {
  it("TAINT-2: connects to the address that was checked, not to a second DNS answer", async () => {
    // The server listens only on 127.0.0.2. The system resolver maps
    // "localhost" to 127.0.0.1 or ::1, so this fetch succeeds only if the
    // connection uses the checked answer from the injected resolver.
    const pinned = createServer((_req, res) => res.writeHead(200).end("pinned"));
    await new Promise<void>((resolve, reject) => pinned.once("error", reject).listen(0, "127.0.0.2", resolve));
    const port = (pinned.address() as AddressInfo).port;
    try {
      expect((await safeFetch(`http://localhost:${port}/`, local("127.0.0.2"))).body).toBe("pinned");
    } finally {
      pinned.closeAllConnections();
      await new Promise((resolve) => pinned.close(resolve));
    }
  });
});

describe("fetch failures", () => {
  it("a DNS failure is FETCH_FAILED", async () => {
    const error = await fetchError("https://no-such-host.example/", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(error.code).toBe("FETCH_FAILED");
  });

  it("a refused connection is FETCH_FAILED", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await fetchError(`http://localhost:${port}/`, local())).toMatchObject({ code: "FETCH_FAILED" });
  });
});
