// ---------------------------------------------------------------------------
// Egress allowlist enforcement (spec §B1 egress_policy, §B3 connection open).
//
// Every persisted connection carries an `egressPolicy.allowlist` — the set of
// host:port (or CIDR:port) destinations Foundry is permitted to reach for that
// source. This module is the single choke point that asserts a connection's
// target endpoint is covered by its own allowlist BEFORE a pg.Pool is opened.
// Without this gate the allowlist is decorative; with it the policy is the
// zero-trust boundary the wizard's network step promises.
//
// Matching rules:
//   - `host` entry  : exact, case-insensitive hostname/IP match + port match.
//   - `cidr` entry  : the target host, when it is a literal IPv4 address, must
//                     fall inside the CIDR block + port match. Hostnames are
//                     never matched against CIDR entries (we do not resolve DNS
//                     here — resolution-time SSRF is covered separately).
// ---------------------------------------------------------------------------

import { TellusError } from "../../../../lib/errors/envelope";
import { EgressBlocked } from "../../../../lib/errors/connectivity.errors";

export interface EgressHostEntry {
  kind: "host";
  host: string;
  port: number;
}
export interface EgressCidrEntry {
  kind: "cidr";
  cidr: string;
  port: number;
}
export type EgressEntry = EgressHostEntry | EgressCidrEntry;

export interface EgressPolicyShape {
  allowlist?: EgressEntry[];
}

/** Parse a dotted-quad IPv4 string into a uint32, or null if not an IPv4. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  let acc = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    acc = (acc << 8) | octet;
  }
  // `>>> 0` coerces to unsigned so comparisons are correct for high addresses.
  return acc >>> 0;
}

/** True when a literal IPv4 host falls inside `a.b.c.d/len`. */
function ipv4InCidr(host: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return false;
  const base = ipv4ToInt(cidr.slice(0, slash));
  const len = Number(cidr.slice(slash + 1));
  const target = ipv4ToInt(host);
  if (base === null || target === null || !Number.isInteger(len) || len < 0 || len > 32) {
    return false;
  }
  if (len === 0) return true;
  const mask = (0xffffffff << (32 - len)) >>> 0;
  return (base & mask) === (target & mask);
}

/** True when host:port is permitted by the allowlist. */
export function isEgressAllowed(
  host: string,
  port: number,
  policy: EgressPolicyShape | null | undefined,
): boolean {
  const allowlist = policy?.allowlist ?? [];
  const h = host.trim().toLowerCase();
  for (const entry of allowlist) {
    if (entry.port !== port) continue;
    if (entry.kind === "host") {
      if (entry.host.trim().toLowerCase() === h) return true;
    } else if (entry.kind === "cidr") {
      if (ipv4InCidr(host, entry.cidr)) return true;
    }
  }
  return false;
}

/**
 * Throws Tellus:Connectivity:EgressBlocked (403) when host:port is not covered
 * by the connection's egress allowlist. Call immediately before opening a
 * driver connection to a persisted source.
 */
export function assertEgressAllowed(
  connectionRid: string,
  host: string,
  port: number,
  policy: EgressPolicyShape | null | undefined,
): void {
  if (!isEgressAllowed(host, port, policy)) {
    throw new TellusError(EgressBlocked, {
      connectionRid,
      host,
      port,
    });
  }
}

// ---------------------------------------------------------------------------
// SSRF guard for the config-less probe (`POST /connections/test-config`).
//
// The wizard's "Test connection" runs BEFORE a connection (and therefore an
// egress allowlist) exists, so `assertEgressAllowed` has no policy to match
// against. Without a guard an authenticated principal could aim the probe at
// loopback, link-local (cloud metadata 169.254.169.254), or RFC-1918 internal
// hosts and use the server as an SSRF pivot. `assertEgressForConfig` denies
// those reserved destinations; public targets pass and the per-principal rate
// limit bounds sweep velocity. DNS-rebinding (a hostname that resolves to a
// private IP) is out of scope here — literal IPs and obvious internal
// hostnames are blocked.
// ---------------------------------------------------------------------------

/** RFC-1918 / reserved IPv4 ranges a transient probe must never reach. */
const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/** Hostnames that resolve to the local host or a cloud metadata endpoint. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/** True when host is a literal private/reserved address or internal hostname. */
function isReservedTarget(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (BLOCKED_HOSTNAMES.has(h) || h.endsWith(".localhost")) return true;
  // IPv6 loopback / unspecified / unique-local / link-local literals.
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and fall through to the v4 check.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  if (ipv4ToInt(v4) !== null) {
    for (const cidr of BLOCKED_IPV4_CIDRS) {
      if (ipv4InCidr(v4, cidr)) return true;
    }
  }
  return false;
}

/**
 * Throws Tellus:Connectivity:EgressBlocked (403) when `host` is a reserved or
 * internal destination. Use for the persisted-policy-less test-config probe.
 */
export function assertEgressForConfig(host: string, port: number): void {
  if (isReservedTarget(host)) {
    throw new TellusError(EgressBlocked, {
      host,
      port,
      reason: "target resolves to a reserved or internal address range",
    });
  }
}
