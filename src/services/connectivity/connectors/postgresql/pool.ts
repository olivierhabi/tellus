// ---------------------------------------------------------------------------
// B3 — pg.Pool factory keyed by connection RID (spec §B3 line 137).
//
// One pool per (connectionRid, credential-version). When a credential rotates
// (B2 bumps version), the old pool is drained and a new one created lazily on
// next request. Pools are evicted on idle > 10 min to prevent leaks across
// hundreds of dormant tenants.
//
// `getPool(rid)` returns a ready pg.Pool whose connections are TLS-validated
// per the connection's tlsMode. Credentials are unwrapped from B2 each time
// the pool is constructed (not per-query) — short-lived in heap then GC'd.
// ---------------------------------------------------------------------------

import { Pool } from "pg";
import * as connectionsRepo from "../../store/connections.repo";
import * as egressPoliciesRepo from "../../store/egress-policies.repo";
import * as vault from "../../credentials/vault";
import * as credStore from "../../credentials/store.repo";
import { installPgTypeParsers } from "./pg-types-config";
import { assemblePgPoolOptions, type PgCredentialMaterial } from "./config";
import {
  assertEgressAllowed,
  assertEgressResolved,
  assertReservedTargetRequiresApprovedPolicy,
  isTrulyReservedTarget,
} from "./egress";
import { setPoolCountProvider } from "../../metrics";
import { assertAgentAvailable } from "../../agent/proxy";
import { TellusError } from "../../../../lib/errors/envelope";
import {
  ConnectionNotFound,
  DriverMismatch,
  EgressPolicyNotApproved,
  EgressPolicyNotFound,
} from "../../../../lib/errors/connectivity.errors";

installPgTypeParsers();

interface PoolEntry {
  pool: Pool;
  credentialVersion: number;
  clientKeyVersion: number;
  lastUsedMs: number;
}

const POOLS = new Map<string, PoolEntry>();
const IDLE_TTL_MS = 10 * 60_000;
let sweeper: NodeJS.Timeout | null = null;

// Expose the cache size to the pools_open gauge, read at scrape time.
setPoolCountProvider(() => POOLS.size);

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [rid, entry] of POOLS) {
      if (entry.lastUsedMs < cutoff) {
        entry.pool.end().catch(() => undefined);
        POOLS.delete(rid);
      }
    }
  }, 60_000);
  sweeper.unref?.();
}

export async function getPool(connectionRid: string): Promise<Pool> {
  ensureSweeper();
  // Look up connection without tenant filter (system caller);
  // the connection record contains its tenant for credential lookups.
  const conn = await connectionsRepo.findByRidAnyTenant(connectionRid);
  if (!conn) {
    throw new TellusError(ConnectionNotFound, { connectionRid });
  }
  if (conn.connectorType !== "postgresql") {
    throw new TellusError(DriverMismatch, {
      connectionRid,
      connectorType: conn.connectorType,
    });
  }

  // Agent-proxy gate: an agentProxy connection must route through a live agent
  // in its group, never a direct platform socket. Fails closed with
  // AgentUnavailable when no connected agent exists. No-op for foundryWorker.
  await assertAgentAvailable({
    workerType: conn.workerType,
    agentGroupRid: conn.agentGroupRid,
  });

  // Resolve current credential versions + plaintext (read-through LRU in vault).
  // Both the password and the mTLS client key are versioned secrets; a rotation
  // of EITHER must rebuild the pool, so both versions key the cache entry.
  const head = await credStore.headVersion(connectionRid, conn.tenant, "password");
  const version = head?.version ?? 0;
  const clientKeyHead = await credStore.headVersion(
    connectionRid,
    conn.tenant,
    "client_key",
  );
  const clientKeyVersion = clientKeyHead?.version ?? 0;

  const cached = POOLS.get(connectionRid);
  if (
    cached &&
    cached.credentialVersion === version &&
    cached.clientKeyVersion === clientKeyVersion
  ) {
    cached.lastUsedMs = Date.now();
    return cached.pool;
  }
  // Stale or absent — drain and rebuild.
  if (cached) {
    cached.pool.end().catch(() => undefined);
    POOLS.delete(connectionRid);
  }

  let password = "";
  if (head) {
    const plaintext = await vault.unwrap(
      connectionRid,
      conn.tenant,
      "password",
      "system:pool",
    );
    password = Buffer.from(plaintext).toString("utf8");
    plaintext.fill(0);
  }

  // Unwrap the mTLS client key (private key) only when one has been stored. It
  // is a vault secret (never persisted in plaintext config); its presence is
  // mirrored by pgConfig.clientKeyEncrypted on the connection record. Without
  // this, verify-ca/verify-full connections that require client-cert auth would
  // hand pg an `undefined` key and the TLS handshake would always fail.
  let clientKeyPem: string | undefined;
  if (clientKeyHead) {
    const keyPlain = await vault.unwrap(
      connectionRid,
      conn.tenant,
      "client_key",
      "system:pool",
    );
    clientKeyPem = Buffer.from(keyPlain).toString("utf8");
    keyPlain.fill(0);
  }

  // Discriminated union: the connection's config is `{connectorType:'postgresql', postgres:PostgresConfig}`.
  const pgConfig =
    conn.config.connectorType === "postgresql" ? conn.config.postgres : null;
  if (!pgConfig) {
    throw new TellusError(DriverMismatch, {
      connectionRid,
      connectorType: conn.config.connectorType,
    });
  }

  // Resolve the effective egress allowlist. When the connection references a
  // named egress policy, that policy is authoritative and MUST be APPROVED —
  // a PENDING/REJECTED (or missing) policy fails closed before any socket is
  // opened. Otherwise the connection's inline allowlist applies.
  let effectivePolicy = conn.egressPolicy;
  let namedStatus: string | null = null;
  if (conn.egressPolicyRid) {
    const named = await egressPoliciesRepo.resolveForEnforcement(
      conn.egressPolicyRid,
    );
    if (!named) {
      throw new TellusError(EgressPolicyNotFound, {
        connectionRid,
        egressPolicyRid: conn.egressPolicyRid,
      });
    }
    if (named.status !== "APPROVED") {
      throw new TellusError(EgressPolicyNotApproved, {
        connectionRid,
        egressPolicyRid: conn.egressPolicyRid,
        status: named.status,
      });
    }
    namedStatus = named.status;
    effectivePolicy = { allowlist: named.allowlist };
  }

  // SSRF gate (registration rule, enforced again at dial time so a connection
  // whose stored target was written before the gate — or whose policy was
  // revoked/rejected after registration — cannot dial): a truly-reserved
  // target (IGNORING the CONNECTIVITY_EGRESS_ALLOW_RESERVED opt-in) requires
  // an operator-APPROVED named policy; an inline allowlist never suffices.
  // This also covers the on-demand POST /connections/:rid/test probe, which
  // dials through getPool and therefore loads the stored policy the same way.
  const trulyReserved = isTrulyReservedTarget(pgConfig.host);
  if (trulyReserved) {
    assertReservedTargetRequiresApprovedPolicy(
      pgConfig.host,
      pgConfig.port,
      { egressPolicyRid: conn.egressPolicyRid ?? null, policyStatus: namedStatus },
    );
  }

  // Zero-trust egress gate: the source may only reach the host:port its own
  // allowlist permits. Throws Tellus:Connectivity:EgressBlocked (403) before a
  // socket is ever opened, so a connection whose target drifts outside its
  // approved policy cannot be used to exfiltrate to an unapproved endpoint.
  assertEgressAllowed(connectionRid, pgConfig.host, pgConfig.port, effectivePolicy);

  // DNS-pinned egress: resolve + validate EVERY address now and connect to the
  // pinned IP (keeping the original hostname for TLS `servername`), closing the
  // resolution-time TOCTOU / DNS-rebinding window the string-only guard leaves.
  // allowReserved is set ONLY after the approved-policy gate above passed: in
  // production the env opt-in is unset, so without this bypass an approved
  // loopback policy could never actually dial.
  const pinnedHost = await assertEgressResolved(pgConfig.host, pgConfig.port, {
    allowReserved: trulyReserved,
  });

  const creds: PgCredentialMaterial = {
    user: pgConfig.user,
    password,
    clientCertPem: pgConfig.clientCertPem,
    clientKeyPem,
    serverCaPem: pgConfig.serverCaPem,
  };
  const opts = assemblePgPoolOptions(pgConfig, creds);
  const pinnedOpts =
    opts.ssl && typeof opts.ssl === "object"
      ? { ...opts, host: pinnedHost, ssl: { ...opts.ssl, servername: pgConfig.host } }
      : { ...opts, host: pinnedHost };
  const pool = new Pool(pinnedOpts);
  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[connectivity.pg.pool] background pool error", {
      connectionRid,
      err: err.message,
    });
  });
  POOLS.set(connectionRid, {
    pool,
    credentialVersion: version,
    clientKeyVersion,
    lastUsedMs: Date.now(),
  });
  return pool;
}

/** Force-evict a pool (e.g. after credential rotation or connection delete). */
export async function evict(connectionRid: string): Promise<void> {
  const entry = POOLS.get(connectionRid);
  if (!entry) return;
  POOLS.delete(connectionRid);
  await entry.pool.end().catch(() => undefined);
}

/** Drain all pools (graceful shutdown). */
export async function drainAll(): Promise<void> {
  const entries = [...POOLS.values()];
  POOLS.clear();
  await Promise.all(entries.map((e) => e.pool.end().catch(() => undefined)));
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Test helper: how many pools are currently cached. */
export function _poolCount(): number {
  return POOLS.size;
}
