import { describe, expect, it } from "vitest";
import { BLOCKED_IPV4, BLOCKED_IPV6_GLOBAL, isBlockedAddress, isLoopback } from "./ip";

describe("TAINT-2: blocked address ranges", () => {
  it.each([
    ["0.0.0.0", "this network"],
    ["10.0.0.5", "RFC 1918 10/8"],
    ["10.255.255.255", "RFC 1918 10/8, last address"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT, last address"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback, not .0.0.1"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["172.16.0.1", "RFC 1918 172.16/12"],
    ["172.31.255.255", "RFC 1918 172.16/12, last address"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.0.2.10", "documentation"],
    ["192.88.99.1", "6to4 relay"],
    ["192.168.1.1", "RFC 1918 192.168/16"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::", "IPv6 unspecified"],
    ["::1", "IPv6 loopback"],
    ["0:0:0:0:0:0:0:1", "IPv6 loopback, uncompressed"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:7f00:1", "IPv4-mapped loopback in hex"],
    ["::ffff:8.8.8.8", "IPv4-mapped public address (all mapped forms are blocked)"],
    ["::127.0.0.1", "IPv4-compatible"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of the metadata address"],
    ["fc00::1", "ULA"],
    ["fd12:3456::1", "ULA"],
    ["fe80::1", "IPv6 link-local"],
    ["FE80::ABCD", "IPv6 link-local, uppercase"],
    ["fec0::1", "site-local"],
    ["ff02::1", "IPv6 multicast"],
    ["100::1", "discard"],
    ["2001:db8::1", "IPv6 documentation"],
    ["2001::1", "Teredo"],
    ["2002:7f00:1::", "6to4 of loopback"],
    ["3fff::1", "IPv6 documentation (3fff::/20)"],
  ])("TAINT-2: blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.215.14", "172.32.0.1", "100.128.0.1", "169.255.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"])(
    "TAINT-2: allows the public address %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each(["", "localhost", "1.2.3", "256.1.1.1", "01.2.3.4", "fe80::1%eth0", "::ffff:999.0.0.1", "example.com"])(
    "TAINT-2: blocks input that isn't a plain address: %j",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );

  it("TAINT-2: every range in the tables parses", () => {
    for (const r of [...BLOCKED_IPV4, ...BLOCKED_IPV6_GLOBAL]) expect(() => isBlockedAddress(r.cidr.split("/")[0]!)).not.toThrow();
  });

  it("isLoopback is true only for loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("10.0.0.1")).toBe(false);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(false);
  });
});
