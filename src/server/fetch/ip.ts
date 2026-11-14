import { isIPv4, isIPv6 } from "node:net";

/**
 * Address checks for the SSRF-safe fetcher (TAINT-2). An address is
 * allowed only if it is ordinary public unicast. Anything that doesn't
 * parse is blocked.
 *
 * IPv4: the special-purpose ranges below are blocked.
 * IPv6: only global unicast (2000::/3) is allowed, minus its
 * special-purpose blocks. Everything outside 2000::/3 is blocked, which
 * covers loopback, unspecified, IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible, NAT64 (64:ff9b::/96), ULA (fc00::/7), link-local
 * (fe80::/10), site-local, discard, and multicast.
 */

interface Range {
  cidr: string;
  why: string;
}

/** Blocked IPv4 ranges (RFC 6890 and successors). */
export const BLOCKED_IPV4: readonly Range[] = [
  { cidr: "0.0.0.0/8", why: "this network" },
  { cidr: "10.0.0.0/8", why: "private (RFC 1918)" },
  { cidr: "100.64.0.0/10", why: "carrier-grade NAT" },
  { cidr: "127.0.0.0/8", why: "loopback" },
  { cidr: "169.254.0.0/16", why: "link-local, including cloud metadata at 169.254.169.254" },
  { cidr: "172.16.0.0/12", why: "private (RFC 1918)" },
  { cidr: "192.0.0.0/24", why: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", why: "documentation" },
  { cidr: "192.88.99.0/24", why: "6to4 relay anycast" },
  { cidr: "192.168.0.0/16", why: "private (RFC 1918)" },
  { cidr: "198.18.0.0/15", why: "benchmarking" },
  { cidr: "198.51.100.0/24", why: "documentation" },
  { cidr: "203.0.113.0/24", why: "documentation" },
  { cidr: "224.0.0.0/4", why: "multicast" },
  { cidr: "240.0.0.0/4", why: "reserved, including broadcast" },
];

/** Blocked blocks inside 2000::/3. */
export const BLOCKED_IPV6_GLOBAL: readonly Range[] = [
  { cidr: "2001::/23", why: "IETF protocol assignments, including Teredo" },
  { cidr: "2001:db8::/32", why: "documentation" },
  { cidr: "2002::/16", why: "6to4, which embeds an IPv4 address" },
  { cidr: "3fff::/20", why: "documentation" },
];

const GLOBAL_UNICAST = "2000::/3";

/** 32-bit value of a dotted-quad IPv4 address, or null. */
function ipv4ToBigInt(ip: string): bigint | null {
  if (!isIPv4(ip)) return null;
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number.parseInt(part, 10)), 0n);
}

/** 128-bit value of an IPv6 address (with optional embedded IPv4), or null. Zone IDs are rejected. */
function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes("%") || !isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  // An embedded dotted quad (for example ::ffff:127.0.0.1) becomes two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: rest === undefined ? 0 : missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

function inCidr(value: bigint, cidr: string, bits: 32 | 128): boolean {
  const [base, prefixText] = cidr.split("/") as [string, string];
  const baseValue = bits === 32 ? ipv4ToBigInt(base) : ipv6ToBigInt(base);
  if (baseValue === null) throw new Error(`Bad CIDR in the block list: ${cidr}`);
  const shift = BigInt(bits - Number.parseInt(prefixText, 10));
  return value >> shift === baseValue >> shift;
}

/** Whether the fetcher must refuse to connect to this address (TAINT-2). Unparseable input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null) return BLOCKED_IPV4.some((r) => inCidr(v4, r.cidr, 32));
  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) return true;
  if (!inCidr(v6, GLOBAL_UNICAST, 128)) return true;
  return BLOCKED_IPV6_GLOBAL.some((r) => inCidr(v6, r.cidr, 128));
}

/** Whether the address is loopback (127.0.0.0/8 or ::1). Used only for the development localhost exception. */
export function isLoopback(ip: string): boolean {
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null) return inCidr(v4, "127.0.0.0/8", 32);
  return ipv6ToBigInt(ip) === 1n;
}
