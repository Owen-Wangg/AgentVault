import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BLOCKED_IPV4, BLOCKED_IPV6_GLOBAL, isBlockedAddress } from "./ip";

const RUNS = { numRuns: 1000 };

const v4ToString = (v: bigint) => [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join(".");

function v4Base(cidr: string): { base: bigint; hostBits: bigint } {
  const [ip, prefix] = cidr.split("/") as [string, string];
  const base = ip.split(".").reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
  return { base, hostBits: BigInt(32 - Number(prefix)) };
}

/** Any address inside one of the blocked IPv4 ranges. */
const blockedV4 = fc
  .constantFrom(...BLOCKED_IPV4.map((r) => v4Base(r.cidr)))
  .chain(({ base, hostBits }) => fc.bigInt({ min: 0n, max: (1n << hostBits) - 1n }).map((offset) => base + offset));

const v6Full = (v: bigint) =>
  Array.from({ length: 8 }, (_, i) => ((v >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(":");

/** IPv6 prefixes outside 2000::/3 or inside its blocked blocks, as (value, prefix length). */
const BLOCKED_V6: readonly [bigint, number][] = [
  [0n, 128], // ::
  [1n, 128], // ::1
  [0xffffn << 32n, 96], // ::ffff:0:0/96, IPv4-mapped
  [0n, 96], // ::/96, IPv4-compatible
  [0x0064ff9bn << 96n, 96], // 64:ff9b::/96, NAT64
  [0x0100n << 112n, 64], // 100::/64, discard
  [0xfc00n << 112n, 7], // ULA
  [0xfe80n << 112n, 10], // link-local
  [0xfec0n << 112n, 10], // site-local
  [0xff00n << 112n, 8], // multicast
  ...BLOCKED_IPV6_GLOBAL.map(({ cidr }): [bigint, number] => {
    const [ip, prefix] = cidr.split("/") as [string, string];
    const [head] = ip.split("::") as [string];
    const groups = head.split(":").filter(Boolean);
    const value = groups.reduce((acc, g, i) => acc | (BigInt(Number.parseInt(g, 16)) << BigInt((7 - i) * 16)), 0n);
    return [value, Number(prefix)];
  }),
];

const blockedV6 = fc
  .constantFrom(...BLOCKED_V6)
  .chain(([base, prefix]) => {
    const hostBits = BigInt(128 - prefix);
    return fc.bigInt({ min: 0n, max: hostBits === 0n ? 0n : (1n << hostBits) - 1n }).map((offset) => ((base >> hostBits) << hostBits) | offset);
  });

/** The same IPv6 address written several ways: full, compressed (WHATWG serializer), and uppercase. */
const v6Spellings = (v: bigint) => {
  const full = v6Full(v);
  const compressed = new URL(`http://[${full}]/`).hostname.slice(1, -1);
  return fc.constantFrom(full, compressed, compressed.toUpperCase());
};

describe("SSRF properties", () => {
  // Property 5, SSRF (TAINT-2): for any IP in a blocked range (generated),
  // the address check rejects it.
  it("TAINT-2: every generated IPv4 address in a blocked range is rejected", () => {
    fc.assert(
      fc.property(blockedV4, (v) => {
        expect(isBlockedAddress(v4ToString(v))).toBe(true);
      }),
      RUNS,
    );
  });

  it("TAINT-2: every generated IPv6 address in a blocked range is rejected, however it is written", () => {
    fc.assert(
      fc.property(blockedV6.chain(v6Spellings), (ip) => {
        expect(isBlockedAddress(ip)).toBe(true);
      }),
      RUNS,
    );
  });

  it("TAINT-2: every IPv4 address in its IPv4-mapped IPv6 form is rejected", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 0xffffffffn }), (v) => {
        expect(isBlockedAddress(`::ffff:${v4ToString(v)}`)).toBe(true);
      }),
      RUNS,
    );
  });
});
