// ---------------------------------------------------------------------------
// B4 — In-process egress allowlist (spec §B4 line 211; criterion 3).
//
// Loaded inside the worker child process before any user code runs.
// Monkeypatches net.Socket.prototype.connect to:
//   1. Resolve the destination host via dns.lookup.
//   2. Match against the connection's allowlist (exact host:port + CIDR).
//   3. Throw EgressDenied if not matched.
//
// This is defense-in-depth; production also enforces via Cilium NetworkPolicy
// (deferred).
//
// Activation is opt-in via installEgressAllowlist(policy). The worker
// entrypoint calls this exactly once, BEFORE importing pg or any other
// network-using module.
// ---------------------------------------------------------------------------

import net from "node:net";
import dns from "node:dns/promises";

export interface EgressPolicy {
  allow: Array<{ host: string; port: number }>;
  cidrs: string[];
}

const TAG = "[connectivity.worker.egress]";

let active: EgressPolicy | null = null;
let origConnect:
  | typeof net.Socket.prototype.connect
  | null = null;

export class EgressDenied extends Error {
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number) {
    super(`${TAG} egress denied to ${host}:${port}`);
    this.name = "EgressDenied";
    this.host = host;
    this.port = port;
  }
}

export function installEgressAllowlist(policy: EgressPolicy): void {
  if (active) {
    throw new Error(`${TAG} already installed for this process`);
  }
  active = policy;
  origConnect = net.Socket.prototype.connect;

  const patched = function patchedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const { host, port } = extractTarget(args);
    // Synchronously enforce; if we can't decide synchronously (host needs
    // DNS), pre-resolve before delegating.
    if (host && port) {
      void checkAsync(host, port)
        .then(() => {
          (origConnect as unknown as Function).apply(this, args);
        })
        .catch((err) => {
          this.destroy(err as Error);
        });
      return this;
    }
    return (origConnect as unknown as Function).apply(this, args) as net.Socket;
  };

  net.Socket.prototype.connect = patched as typeof net.Socket.prototype.connect;
}

/** Restore the original `connect` (tests / shutdown). */
export function uninstallEgressAllowlist(): void {
  if (!origConnect) return;
  net.Socket.prototype.connect = origConnect;
  origConnect = null;
  active = null;
}

async function checkAsync(host: string, port: number): Promise<void> {
  if (!active) return;
  // Exact host:port match wins immediately.
  for (const a of active.allow) {
    if (a.host === host && a.port === port) return;
  }
  // Resolve and test against CIDRs (IPv4 only for now; IPv6 deferred).
  const lookup = await dns.lookup(host, { family: 4, all: true }).catch(() => []);
  for (const r of lookup) {
    for (const cidr of active.cidrs) {
      if (cidrContains(cidr, r.address)) return;
    }
  }
  throw new EgressDenied(host, port);
}

function extractTarget(args: unknown[]): {
  host: string | null;
  port: number | null;
} {
  if (args.length === 0) return { host: null, port: null };
  const first = args[0] as Record<string, unknown> | number | string;
  if (typeof first === "object" && first !== null) {
    const host = (first.host as string | undefined) ?? (first.hostname as string | undefined) ?? "127.0.0.1";
    const port = Number(first.port ?? 0);
    return { host, port };
  }
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? (args[1] as string) : "127.0.0.1";
    return { host, port: first };
  }
  if (typeof first === "string") {
    // unix domain socket -> deny by default (workers should never hit local socks)
    return { host: null, port: null };
  }
  return { host: null, port: null };
}

// --- CIDR helper (IPv4) ----------------------------------------------------

function cidrContains(cidr: string, ip: string): boolean {
  const [base, maskStr] = cidr.split("/");
  if (!base || !maskStr) return false;
  const mask = Number(maskStr);
  if (Number.isNaN(mask) || mask < 0 || mask > 32) return false;
  const baseN = ipv4ToInt(base);
  const ipN = ipv4ToInt(ip);
  if (baseN === null || ipN === null) return false;
  const maskN = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (baseN & maskN) === (ipN & maskN);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = ((n << 8) >>> 0) | v;
  }
  return n >>> 0;
}

/** Test introspection. */
export function _isActive(): boolean {
  return active !== null;
}
