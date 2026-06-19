// ---------------------------------------------------------------------------
// B6 — Agent allowlist (spec §B6 line 308; prompt §6 hard requirement).
//
// Reads /etc/tellus/agent/allowlist.yml. Refuses to start if file ownership
// is not root or mode != 0644 on POSIX. On Windows the check is skipped (the
// agent isn't supported on Windows in v1; documented in agent/conf/README).
//
// Allowlist file format (YAML):
//   targets:
//     - host: db.internal
//       port: 5432
//     - host: 10.0.5.0/24
//       port: 5432
//   updated_at: '2025-01-01T00:00:00Z'
//
// Exports:
//   - loadAllowlist(path?): Promise<Allowlist>
//   - assertCanReach(allow, host, port): void  (throws AgentAllowlistDenied)
// ---------------------------------------------------------------------------

import { promises as fs, statSync } from "node:fs";

export interface AllowlistTarget {
  host: string;
  port: number;
}

export interface Allowlist {
  targets: AllowlistTarget[];
  updatedAt?: string;
}

export class AgentAllowlistDenied extends Error {
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number) {
    super(`AgentAllowlistDenied: ${host}:${port} not in allowlist`);
    this.name = "AgentAllowlistDenied";
    this.host = host;
    this.port = port;
  }
}

export class AgentAllowlistMisconfigured extends Error {
  constructor(reason: string) {
    super(`AgentAllowlistMisconfigured: ${reason}`);
    this.name = "AgentAllowlistMisconfigured";
  }
}

const DEFAULT_PATH = "/etc/tellus/agent/allowlist.yml";
const REQUIRED_MODE = 0o644;
const REQUIRED_UID = 0;

export async function loadAllowlist(path = DEFAULT_PATH): Promise<Allowlist> {
  if (process.platform !== "win32") {
    let st;
    try {
      st = statSync(path);
    } catch (err) {
      throw new AgentAllowlistMisconfigured(
        `cannot stat ${path}: ${(err as Error).message}`,
      );
    }
    if ((st.mode & 0o777) !== REQUIRED_MODE) {
      throw new AgentAllowlistMisconfigured(
        `${path} mode must be 0${REQUIRED_MODE.toString(8)}; found 0${(st.mode & 0o777).toString(8)}`,
      );
    }
    if (st.uid !== REQUIRED_UID) {
      throw new AgentAllowlistMisconfigured(
        `${path} must be owned by uid 0 (root); found uid ${st.uid}`,
      );
    }
  }
  const raw = await fs.readFile(path, "utf8");
  return parseAllowlist(raw);
}

export function parseAllowlist(raw: string): Allowlist {
  // Tiny YAML subset parser (avoid pulling in a runtime dep). Supports:
  //   key: value
  //   key:
  //     - host: x
  //       port: 5432
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .filter((l) => l.trim().length > 0);
  const out: Allowlist = { targets: [] };
  let inTargets = false;
  let current: Partial<AllowlistTarget> | null = null;
  for (const line of lines) {
    if (/^targets\s*:/.test(line)) {
      inTargets = true;
      continue;
    }
    const m = line.match(/^updated_at\s*:\s*(.+)$/);
    if (m) {
      out.updatedAt = m[1].trim().replace(/^['"]|['"]$/g, "");
      continue;
    }
    if (inTargets) {
      const itemStart = line.match(/^\s*-\s*host\s*:\s*(.+)$/);
      if (itemStart) {
        if (current) out.targets.push(finalizeTarget(current));
        current = { host: stripQuotes(itemStart[1]) };
        continue;
      }
      const hk = line.match(/^\s*host\s*:\s*(.+)$/);
      if (hk) {
        if (!current) current = {};
        current.host = stripQuotes(hk[1]);
        continue;
      }
      const pk = line.match(/^\s*port\s*:\s*(\d+)/);
      if (pk) {
        if (!current) current = {};
        current.port = Number(pk[1]);
        continue;
      }
    }
  }
  if (current) out.targets.push(finalizeTarget(current));
  return out;
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^['"]|['"]$/g, "");
}

function finalizeTarget(p: Partial<AllowlistTarget>): AllowlistTarget {
  if (!p.host || typeof p.port !== "number") {
    throw new AgentAllowlistMisconfigured(
      `incomplete target entry: ${JSON.stringify(p)}`,
    );
  }
  return { host: p.host, port: p.port };
}

export function assertCanReach(
  allow: Allowlist,
  host: string,
  port: number,
): void {
  for (const t of allow.targets) {
    if (t.host === host && t.port === port) return;
    if (t.host.includes("/") && t.port === port) {
      // CIDR match (delegate to caller; we don't resolve here).
      // Conservative: deny unless exact match — full CIDR support deferred.
    }
  }
  throw new AgentAllowlistDenied(host, port);
}
