// ---------------------------------------------------------------------------
// Edge-index confirmation watermarks (OSv2 serving-index parity).
//
// The transactional outbox (linkCdcOutbox.ts) proves broker acceptance
// (`published_at`) — NEVER serving-index visibility. This module is the
// read-after-write barrier for link traversals:
//
//   Action commit → outbox row (outbox_seq BIGSERIAL, globally monotonic)
//   → drainer → Kafka → ClickHouse (Kafka engine + MV, or insertLinkRows
//   backfill) → THIS MODULE confirms the row is queryable
//   → Action completion may proceed.
//
// Semantics:
//   * `confirmEdgeIndexVisibility` — SOUND per-event confirmation: resolves
//     only when every handle's `event_id` is visible in the versioned edge
//     table for the EXACT (tenant, ontology, branch) scope. Never fabricates:
//     on timeout or index outage it returns confirmed:false with a deferred
//     count and reason. The caller decides how to surface deferral; edits
//     remain durable in PG regardless.
//   * `waitForWatermark` (LinkServingStore contract) — SOUND set-difference
//     confirmation: resolves when every published outbox row with
//     outbox_seq <= minOffset for the scope is present in the index.
//     max(outbox_seq) alone would be unsound under multi-partition Kafka
//     delivery (a later seq can arrive earlier); the set-diff closes that.
//     Throws StoreWatermarkTimeout after the deadline.
//   * `resolveLinkDescriptor` — PG link_type ∪ object_type join used to
//     resolve the serving table name for a link type api name.
//
// Observability (funnel/metrics registry):
//   * histogram link_index_ack_wait_seconds            — per-confirm latency
//   * counter   link_index_ack_deferred_total{reason}  — timeout | index_outage
//   * gauge     link_edge_index_watermark              — max confirmed seq (latest probe)
//   * gauge     link_edge_index_lag                    — published-but-unconfirmed backlog
//   * table     link_edge_watermarks (migration 157)   — per-scope stats (ops UI)
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { incCounter, observeHistogram, setGauge } from "../funnel/metrics";
import { getClickHouseClient } from "../searchAround/clickhouseClient";
import {
  linkTableName,
  type LinkTypeDescriptor,
} from "../searchAround/linkMaterializedView";
import { sqlString } from "../searchAround/clickhouseTraversal";
import { StoreWatermarkTimeout, type IsolationScope } from "./contracts";
import { canonicalTenant } from "../searchAround/edgeVersion";

export interface EdgeIndexAckHandle {
  eventId: string;
  /** Monotonic outbox offset assigned at staging (migration 157). */
  outboxSeq: number;
  linkTypeApiName: string;
  sourceObjectType: string;
  /** Per-object-type ontology (carried so the Action barrier can group
   *  handles across ontologies; also applies the scope in staging). */
  ontologyId: string;
}

export interface EdgeAckConfirmation {
  /** True ONLY when every handle is visible in the edge index. */
  confirmed: boolean;
  /** Handles still invisible at the deadline. */
  deferred: number;
  waitedMs: number;
  reason?: "timeout" | "index_outage";
}

/** Injectable seams (unit tests substitute; production uses ambient PG/CH). */
export interface EdgeAckDeps {
  /** `opts.timeoutMs` is an ADVISORY per-call fetch abort (remaining ack
   *  deadline); implementations MAY ignore it — the barrier additionally
   *  races every probe against deadline + BARRIER_EPSILON_MS, so a seam
   *  that ignores the hint still cannot overrun the hard bound. */
  chExec?: <T>(sql: string, opts?: { timeoutMs?: number }) => Promise<T[]>;
  pgQuery?: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  resolveDescriptor?: (
    linkTypeApiName: string,
  ) => Promise<LinkTypeDescriptor | null>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 200;
/** Set-diff window guard — a single wait never scans beyond this many rows. */
export const WATERMARK_WINDOW_LIMIT = 10_000;
/**
 * Hard bound on barrier overshoot: resolution must land within
 * deadline + BARRIER_EPSILON_MS (a committed edit must be answered
 * 202-timely under the request budget — the middleware only grants the
 * ack deadline + headroom, so a barrier that outruns it re-introduces
 * the 504-on-commit hazard this contract exists to kill).
 */
export const BARRIER_EPSILON_MS = 250;

/** Sentinel thrown by the deadline race — a SLOW probe is NOT an outage:
 *  the index may simply be lagging behind the barrier window, which is
 *  exactly the "timeout" outcome (202 per-item pending), not "index_outage"
 *  (which must mean the index ERRORED, not lagged). Typed so the catch
 *  can distinguish it from a real probe throw. */
export class AckProbeDeadlineBound extends Error {
  constructor() {
    super("ack_probe_deadline_bound");
    this.name = "AckProbeDeadlineBound";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * link_type ∪ object_type join (same shape as funnel/clickhouseBootstrap's
 * loadLinkTypes): resolves the api names needed to derive the ClickHouse
 * serving table for a link type.
 */
export async function resolveLinkDescriptor(
  linkTypeApiName: string,
  pgQuery: NonNullable<EdgeAckDeps["pgQuery"]> = query,
): Promise<LinkTypeDescriptor | null> {
  const res = await pgQuery(
    `SELECT lt.api_name AS link_name,
            src.api_name AS source_api,
            tgt.api_name AS target_api
       FROM link_type lt
       JOIN object_type src ON lt.source_object_type = src.object_type_id
       JOIN object_type tgt ON lt.target_object_type = tgt.object_type_id
      WHERE lt.api_name = $1
      LIMIT 1`,
    [linkTypeApiName],
  );
  const row = res.rows[0] as
    | { link_name: string; source_api: string; target_api: string }
    | undefined;
  if (!row) return null;
  return {
    sourceObjectType: row.source_api,
    linkName: row.link_name,
    targetObjectType: row.target_api,
  };
}

function scopeClause(scope: IsolationScope): string {
  // Normalised scope keys: staging writes "" for a null tenant (matches the
  // ClickHouse String DEFAULT '' the MV would produce). Callers MUST pass
  // through the same values that were staged (see editApplicator).
  return [
    `tenant_id = ${sqlString(canonicalTenant(scope.tenantId))}`,
    `ontology_id = ${sqlString(scope.ontologyId ?? "")}`,
    `branch_id = ${sqlString(scope.branchId ?? "")}`,
  ].join(" AND ");
}

/**
 * Record the confirmation stats for a scope (upsert). Observability cells
 * only — completion NEVER reads this table (see module header).
 */
async function recordWatermark(
  pg: NonNullable<EdgeAckDeps["pgQuery"]>,
  scope: IsolationScope,
  linkTypeApiName: string,
  confirmedSeq: number,
  confirmedEventVersion: number,
): Promise<void> {
  try {
    await pg(
      `INSERT INTO link_edge_watermarks
         (tenant_id, ontology_id, branch_id, link_type_api_name,
          confirmed_seq, confirmed_event_version, last_confirmed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (tenant_id, ontology_id, branch_id, link_type_api_name)
       DO UPDATE SET
         confirmed_seq = GREATEST(link_edge_watermarks.confirmed_seq, EXCLUDED.confirmed_seq),
         confirmed_event_version = GREATEST(link_edge_watermarks.confirmed_event_version, EXCLUDED.confirmed_event_version),
         last_confirmed_at = now(),
         updated_at = now()`,
      [
        canonicalTenant(scope.tenantId),
        scope.ontologyId ?? "",
        scope.branchId ?? "",
        linkTypeApiName,
        confirmedSeq,
        confirmedEventVersion,
      ],
    );
    setGauge("link_edge_index_watermark", confirmedSeq);
  } catch (err) {
    // Watermark stats are best-effort; a stats failure must NOT degrade
    // the confirmation outcome, which is derived from per-event probes.
    console.warn(
      `[link-index-ack] watermark stats write failed: ${(err as Error).message}`,
    );
  }
}

/**
 * SOUND per-event confirmation. Resolves {confirmed:true} only when EVERY
 * handle's event is visible in its scope's versioned edge table. On the
 * deadline: confirmed:false, remaining count as `deferred`, and a
 * link_index_ack_deferred_total increment. A ClickHouse outage is NOT a
 * confirmation — the loop keeps probing until the deadline and the failure
 * surfaces as reason:"index_outage" when a probe errored during the wait.
 */
export async function confirmEdgeIndexVisibility(args: {
  scope: IsolationScope;
  handles: EdgeIndexAckHandle[];
  timeoutMs: number;
  pollMs?: number;
  deps?: EdgeAckDeps;
}): Promise<EdgeAckConfirmation> {
  const t0 = Date.now();
  const {
    timeoutMs,
    pollMs = DEFAULT_POLL_MS,
    deps = {},
  } = args;
  if (args.handles.length === 0) {
    return { confirmed: true, deferred: 0, waitedMs: 0 };
  }
  const chExec = deps.chExec ?? (<T>(sql: string, opts?: { timeoutMs?: number }) => getClickHouseClient().exec<T>(sql, opts));
  const pg = deps.pgQuery ?? query;
  const resolve = deps.resolveDescriptor ?? ((name: string) => resolveLinkDescriptor(name, pg));
  const sleep = deps.sleep ?? defaultSleep;

  // Resolve descriptors once per distinct link type.
  const descriptors = new Map<string, LinkTypeDescriptor | null>();
  for (const h of args.handles) {
    if (!descriptors.has(h.linkTypeApiName)) {
      descriptors.set(h.linkTypeApiName, await resolve(h.linkTypeApiName));
    }
  }
  const unresolvable = args.handles.filter((h) => !descriptors.get(h.linkTypeApiName));
  let remaining = args.handles.filter((h) => descriptors.get(h.linkTypeApiName));
  const scopeFilter = scopeClause(args.scope);
  let sawOutage = false;

  // Fast path for handles whose link type has no serving table: nothing to
  // confirm — those are immediately deferred (never confirmed).
  const deadline = t0 + timeoutMs;
  while (remaining.length > 0) {
    const stillPending: EdgeIndexAckHandle[] = [];
    for (const h of remaining) {
      // DEADLINE-AWARE PROBING: each probe is bounded by the REMAINING
      // deadline (never the client's 30 s default), and a race at
      // remaining + ε guarantees the barrier resolves by deadline + ε
      // even against injected chExec seams that ignore the advisory
      // hint (or the client's own retry stacking). Never START a probe
      // whose floor already exceeds the remaining deadline — the item
      // defers instead of blocking on latency it cannot possibly use.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        stillPending.push(h);
        continue;
      }
      const desc = descriptors.get(h.linkTypeApiName)!;
      const table = linkTableName(desc);
      try {
        // The seam's optional `timeoutMs` is not passed here on purpose:
        // bounding the per-attempt FETCH would abort a SLOW-but-healthy
        // probe mid-flight and present it as `index_outage` (a connect-
        // error) — losing the "timeout" semantics a lagging index must
        // keep. The Promise.race below is the ONLY bound: a slow probe
        // leaks in the background (capped by the client's own 30 s) and
        // the barrier stays reason="timeout".
        const rows = await Promise.race([
          chExec<{ hits: number; max_seq: number; max_version: number }>(
            `SELECT countIf(event_id = ${sqlString(h.eventId)}) AS hits,
                    max(outbox_seq) AS max_seq,
                    max(event_version) AS max_version
               FROM ${table}
              WHERE ${scopeFilter}`,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new AckProbeDeadlineBound()),
              remainingMs + BARRIER_EPSILON_MS,
            ),
          ),
        ]);
        const r = rows[0];
        if (r && Number(r.hits) > 0) {
          await recordWatermark(pg, args.scope, h.linkTypeApiName, Number(r.max_seq), Number(r.max_version));
          continue; // confirmed — drop from the pending set
        }
      } catch (err) {
        // A deadline-bound probe is NOT an outage — it's a lag that
        // exceeds the deadline window. "index_outage" stays reserved for
        // probes that ERRORED (real CH throw) so clients/readiness can
        // tell the two apart.
        if (!(err instanceof AckProbeDeadlineBound)) sawOutage = true;
      }
      stillPending.push(h);
    }
    remaining = stillPending;
    if (remaining.length === 0) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  const waitedMs = Date.now() - t0;
  observeHistogram("link_index_ack_wait_seconds", waitedMs / 1000, {
    resource_type: "link",
  });
  const deferred = remaining.length + unresolvable.length;
  if (deferred > 0) {
    const reason = sawOutage ? ("index_outage" as const) : ("timeout" as const);
    incCounter("link_index_ack_deferred_total", { reason }, deferred);
    return { confirmed: false, deferred, waitedMs, reason };
  }
  return { confirmed: true, deferred: 0, waitedMs };
}

/**
 * LinkServingStore.waitForWatermark — SOUND set-difference confirmation.
 * Resolves when ALL published outbox rows with outbox_seq <= minOffset for
 * this scope are present in the index (dedup by outbox_seq). Throws
 * StoreWatermarkTimeout on the deadline; rejects immediately if the window
 * exceeds WATERMARK_WINDOW_LIMIT.
 */
export async function waitForLinkWatermark(args: {
  scope: IsolationScope;
  linkTypeApiName: string;
  minOffset: number;
  timeoutMs: number;
  pollMs?: number;
  deps?: EdgeAckDeps;
}): Promise<void> {
  const { pollMs = DEFAULT_POLL_MS, deps = {} } = args;
  const t0 = Date.now();
  const chExec = deps.chExec ?? (<T>(sql: string) => getClickHouseClient().exec<T>(sql));
  const pg = deps.pgQuery ?? query;
  const descriptor =
    (await (deps.resolveDescriptor ?? ((n: string) => resolveLinkDescriptor(n, pg)))(
      args.linkTypeApiName,
    )) ??
    null;
  if (!descriptor) {
    throw new Error(
      `waitForLinkWatermark: unknown link type '${args.linkTypeApiName}' — cannot identify the serving table`,
    );
  }
  const table = linkTableName(descriptor);
  const sleep = deps.sleep ?? defaultSleep;

  const deadline = t0 + args.timeoutMs;
  for (;;) {
    const pending = await pg(
      `SELECT outbox_seq FROM link_cdc_outbox
        WHERE outbox_seq <= $1
          AND published_at IS NOT NULL
          AND dead_lettered_at IS NULL
          AND COALESCE(NULLIF(tenant_id, ''), 'default') = $2 AND COALESCE(ontology_id, '') = $3 AND COALESCE(branch_id, '') = $4
          AND link_type_api_name = $5`,
      [args.minOffset, canonicalTenant(args.scope.tenantId), args.scope.ontologyId ?? "", args.scope.branchId ?? "", args.linkTypeApiName],
    );
    const pgSeqs = pending.rows.map((r) => Number(r.outbox_seq as unknown as number));
    if (pgSeqs.length > WATERMARK_WINDOW_LIMIT) {
      throw new Error(
        `waitForLinkWatermark: window of ${pgSeqs.length} published rows exceeds limit ${WATERMARK_WINDOW_LIMIT}; use confirmEdgeIndexVisibility`,
      );
    }
    if (pgSeqs.length > 0) {
      try {
        const chRows = await chExec<{ outbox_seq: number }>(
          `SELECT DISTINCT outbox_seq
             FROM ${table}
            WHERE ${scopeClause(args.scope)} AND outbox_seq > 0 AND outbox_seq <= ${args.minOffset}`,
        );
        const seen = new Set(chRows.map((r) => Number(r.outbox_seq)));
        const missing = pgSeqs.filter((s) => !seen.has(s)).length;
        setGauge("link_edge_index_lag", missing);
        if (missing === 0) {
          const t1 = await chExec<{ max_seq: number; max_version: number }>(
            `SELECT max(outbox_seq) AS max_seq, max(event_version) AS max_version
               FROM ${table} WHERE ${scopeClause(args.scope)}`,
          );
          const row = t1[0];
          if (row) {
            await recordWatermark(pg, args.scope, args.linkTypeApiName, Number(row.max_seq), Number(row.max_version));
          }
          return;
        }
      } catch (err) {
        if (err instanceof StoreWatermarkTimeout) throw err;
        // Index outage: keep polling until the deadline below.
      }
    }
    if (Date.now() >= deadline) {
      incCounter("link_index_ack_deferred_total", { reason: "timeout" });
      throw new StoreWatermarkTimeout(
        args.scope,
        `link:${args.linkTypeApiName}`,
        args.minOffset,
      );
    }
    await sleep(pollMs);
  }
}
