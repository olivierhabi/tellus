// ---------------------------------------------------------------------------
// Funnel fleet invariant checker (read-only).
//
// Answers "is any object type in a state the close-out fixes should have made
// impossible?" for a live database — or for the simulated fleet seeded by
// scripts/sim/tellusFleetSim.ts, which plants each failure mode on purpose
// (docs/adr/2026-10-09-funnel-fleet-simulation.md).
//
// Every check is a SELECT (plus optional S3 HEAD/ranged GET through the
// injected probe); nothing is repaired here. Thresholds come from the
// versioned funnelRuntime profile so the checker judges "stale"/"stalled"
// with the same numbers the watchdogs use.
//
// Codes (severity):
//   MALFORMED_LOCATOR    (error) `#foundry-dataset:` tag that the changelog
//                                now rejects (pre-fix these ran as 0 rows).
//   DANGLING_LOCATOR     (error) well-formed locator, object missing.  [S3]
//   GHOST_INDEXED_EMPTY  (error) state=indexed, 0 objects, no live rows, but
//                                the source has a data row.             [S3]
//   GHOST_SUSPECT        (warn)  same as above when S3 is not probed.
//   STALE_LEASE          (error) state=indexing, lease older than
//                                indexingDeadAfterMs (owner dead).
//   STALLED_PROGRESS     (warn)  state=indexing, lease fresh, no progress
//                                for indexingStallAfterMs.
//   ORPHAN_STAGING       (warn)  merge_staging_instances rows older than
//                                mergeCliTimeoutMs (crashed promote).
//   NULL_PROVENANCE      (warn)  live rows of a foundry-backed type with
//                                NULL source_transaction_id.
//   COUNT_DRIFT          (error) state=indexed but objects_indexed differs
//                                from the live main-branch row count.
//   REPLAY_REQUIRED      (error) latest run failed with the pre-fix
//                                "properties differ" jsonb key-order bug.
// ---------------------------------------------------------------------------

import { deriveMainBranchId } from "../branchContext";
import { funnelRuntimeConfig } from "../../config/funnelRuntime";

export type InvariantCode =
  | "MALFORMED_LOCATOR"
  | "DANGLING_LOCATOR"
  | "GHOST_INDEXED_EMPTY"
  | "GHOST_SUSPECT"
  | "STALE_LEASE"
  | "STALLED_PROGRESS"
  | "ORPHAN_STAGING"
  | "NULL_PROVENANCE"
  | "COUNT_DRIFT"
  | "REPLAY_REQUIRED";

export const INVARIANT_SEVERITY: Record<InvariantCode, "error" | "warn"> = {
  MALFORMED_LOCATOR: "error",
  DANGLING_LOCATOR: "error",
  GHOST_INDEXED_EMPTY: "error",
  GHOST_SUSPECT: "warn",
  STALE_LEASE: "error",
  STALLED_PROGRESS: "warn",
  ORPHAN_STAGING: "warn",
  NULL_PROVENANCE: "warn",
  COUNT_DRIFT: "error",
  REPLAY_REQUIRED: "error",
};

export interface InvariantViolation {
  code: InvariantCode;
  severity: "error" | "warn";
  ontologyId: string | null;
  objectTypeApiName: string;
  objectTypeId: string | null;
  detail: Record<string, unknown>;
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Optional storage probe. `hasDataRow` = the object holds at least one
 *  non-empty line after the header (ranged read; never the whole object). */
export interface SourceProbe {
  probe(key: string): Promise<{ exists: boolean; hasDataRow: boolean }>;
}

export interface CheckFunnelInvariantsOptions {
  /** Restrict to object types whose api_name starts with this prefix. */
  objectTypeApiNamePrefix?: string;
  ontologyId?: string;
  sourceProbe?: SourceProbe;
  now?: Date;
}

export interface FunnelInvariantReport {
  generatedAt: string;
  profile: string;
  thresholds: {
    indexingDeadAfterMs: number;
    indexingStallAfterMs: number;
    orphanStagingAfterMs: number;
  };
  sourceProbed: boolean;
  objectTypesChecked: number;
  violations: InvariantViolation[];
  counts: Partial<Record<InvariantCode, number>>;
  errors: number;
  warnings: number;
}

/** Same grammar as `parseFoundryMarker` in temporal/activities.ts (kept
 *  local so this read-only checker does not import the Temporal activity
 *  module); funnel-invariants-unit.test.ts pins the two together. */
const LOCATOR_RE = /^(.+)#foundry-dataset:([0-9a-f-]{36})#object-type:([0-9a-f-]{36})$/i;

/** `bridgedById` = backing_datasource.foundry_dataset_id IS NOT NULL — such a
 *  row must carry a marker even if file_path lacks the tag. */
export function classifyLocator(
  filePath: string,
  bridgedById = false,
): { kind: "legacy-local" } | { kind: "foundry"; key: string } | { kind: "malformed"; reason: string } {
  if (!bridgedById && !filePath.includes("#foundry-dataset:")) return { kind: "legacy-local" };
  const m = LOCATOR_RE.exec(filePath);
  if (!m) {
    return { kind: "malformed", reason: "does not match '<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>'" };
  }
  return { kind: "foundry", key: m[1] };
}

interface TypeRow {
  object_type_id: string;
  ontology_id: string;
  api_name: string;
  status: string | null;
  objects_indexed: string | number | null;
  last_progress_at: Date | null;
  lease_heartbeat_at: Date | null;
  updated_at: Date | null;
  file_path: string | null;
  bridged_by_id: boolean | null;
}

export async function checkFunnelInvariants(
  db: Queryable,
  opts: CheckFunnelInvariantsOptions = {},
): Promise<FunnelInvariantReport> {
  const cfg = funnelRuntimeConfig();
  const now = opts.now ?? new Date();
  const thresholds = {
    indexingDeadAfterMs: cfg.indexingDeadAfterMs,
    indexingStallAfterMs: cfg.indexingStallAfterMs,
    orphanStagingAfterMs: cfg.mergeCliTimeoutMs,
  };
  const prefix = opts.objectTypeApiNamePrefix ?? "";
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const ont = opts.ontologyId ?? null;
  const violations: InvariantViolation[] = [];
  const push = (
    code: InvariantCode,
    t: { ontology_id: string | null; api_name: string; object_type_id: string | null },
    detail: Record<string, unknown>,
  ) =>
    violations.push({
      code,
      severity: INVARIANT_SEVERITY[code],
      ontologyId: t.ontology_id,
      objectTypeApiName: t.api_name,
      objectTypeId: t.object_type_id,
      detail,
    });

  const types = (
    await db.query(
      `SELECT ot.object_type_id::text, ot.ontology_id::text, ot.api_name,
              fs.status, fs.objects_indexed, fs.last_progress_at, fs.lease_heartbeat_at, fs.updated_at,
              bd.file_path, bd.bridged_by_id
         FROM object_type ot
         LEFT JOIN funnel_state fs ON fs.object_type_id = ot.object_type_id
         LEFT JOIN LATERAL (
           SELECT file_path, foundry_dataset_id IS NOT NULL AS bridged_by_id FROM backing_datasource b
            WHERE b.object_type_id = ot.object_type_id AND b.file_path IS NOT NULL
            ORDER BY b.mapping_id LIMIT 1
         ) bd ON true
        WHERE ot.api_name LIKE $1 AND ($2::uuid IS NULL OR ot.ontology_id = $2::uuid)
        ORDER BY ot.api_name`,
      [like, ont],
    )
  ).rows as unknown as TypeRow[];

  // Live main-branch counts for the scoped types, one grouped scan.
  const liveByType = new Map<string, { live: number; nullProv: number }>();
  if (types.length > 0) {
    const r = await db.query(
      `SELECT oi.ontology_id::text AS ontology_id, oi.object_type_api_name AS api_name, oi.branch_id::text AS branch_id,
              count(*)::bigint AS live,
              count(*) FILTER (WHERE oi.source_transaction_id IS NULL)::bigint AS null_prov
         FROM object_instances oi
        WHERE oi.object_type_api_name LIKE $1 AND ($2::uuid IS NULL OR oi.ontology_id = $2::uuid)
        GROUP BY 1, 2, 3`,
      [like, ont],
    );
    for (const row of r.rows) {
      if (row.branch_id !== deriveMainBranchId(String(row.ontology_id))) continue;
      liveByType.set(`${row.ontology_id}/${row.api_name}`, {
        live: Number(row.live),
        nullProv: Number(row.null_prov),
      });
    }
  }

  for (const t of types) {
    const live = liveByType.get(`${t.ontology_id}/${t.api_name}`) ?? { live: 0, nullProv: 0 };
    const indexed = Number(t.objects_indexed ?? 0);
    const loc = t.file_path ? classifyLocator(t.file_path, Boolean(t.bridged_by_id)) : null;

    if (loc?.kind === "malformed") push("MALFORMED_LOCATOR", t, { filePath: t.file_path, reason: loc.reason });

    let probe: { exists: boolean; hasDataRow: boolean } | null = null;
    if (opts.sourceProbe && loc?.kind === "foundry") {
      probe = await opts.sourceProbe.probe(loc.key);
      if (!probe.exists) push("DANGLING_LOCATOR", t, { key: loc.key });
    }

    if (t.status === "indexed" && indexed === 0 && live.live === 0 && loc?.kind === "foundry") {
      if (probe?.hasDataRow) push("GHOST_INDEXED_EMPTY", t, { key: loc.key });
      else if (!probe) push("GHOST_SUSPECT", t, { key: loc.key });
    }

    if (t.status === "indexing") {
      const lease = t.lease_heartbeat_at ?? t.updated_at;
      const leaseAge = lease ? now.getTime() - new Date(lease).getTime() : Number.POSITIVE_INFINITY;
      if (leaseAge > thresholds.indexingDeadAfterMs) {
        push("STALE_LEASE", t, { leaseAgeMs: Number.isFinite(leaseAge) ? leaseAge : null });
      } else if (t.last_progress_at) {
        const progressAge = now.getTime() - new Date(t.last_progress_at).getTime();
        if (progressAge > thresholds.indexingStallAfterMs) push("STALLED_PROGRESS", t, { progressAgeMs: progressAge });
      }
    }

    if (t.status === "indexed" && indexed !== live.live && !(indexed === 0 && live.live === 0)) {
      push("COUNT_DRIFT", t, { objectsIndexed: indexed, liveRows: live.live });
    }

    if (loc?.kind === "foundry" && live.nullProv > 0) {
      push("NULL_PROVENANCE", t, { rows: live.nullProv, liveRows: live.live });
    }
  }

  // Orphan staging: whole staging runs whose newest row is older than the
  // merge CLI ceiling — no live merge can still own them.
  const orphan = await db.query(
    `SELECT staging_run_id::text, ontology_id::text, object_type_api_name AS api_name,
            count(*)::bigint AS rows, max(staged_at) AS newest
       FROM merge_staging_instances
      WHERE object_type_api_name LIKE $1 AND ($2::uuid IS NULL OR ontology_id = $2::uuid)
      GROUP BY 1, 2, 3
     HAVING max(staged_at) < $3::timestamptz - make_interval(secs => $4::double precision / 1000)`,
    [like, ont, now.toISOString(), thresholds.orphanStagingAfterMs],
  );
  for (const o of orphan.rows) {
    push(
      "ORPHAN_STAGING",
      { ontology_id: String(o.ontology_id), api_name: String(o.api_name), object_type_id: null },
      { stagingRunId: o.staging_run_id, rows: Number(o.rows), newest: o.newest },
    );
  }

  // Latest run per type failed with the pre-canonicalJson verification bug.
  const replay = await db.query(
    `SELECT DISTINCT ON (ontology_id, object_type_api_name)
            run_id::text, ontology_id::text, object_type_api_name AS api_name, status, error_message
       FROM funnel_run
      WHERE object_type_api_name LIKE $1 AND ($2::uuid IS NULL OR ontology_id = $2::uuid)
      ORDER BY ontology_id, object_type_api_name, COALESCE(completed_at, started_at) DESC`,
    [like, ont],
  );
  for (const r of replay.rows) {
    if (r.status === "failed" && /properties differ/i.test(String(r.error_message ?? ""))) {
      push(
        "REPLAY_REQUIRED",
        { ontology_id: String(r.ontology_id), api_name: String(r.api_name), object_type_id: null },
        { runId: r.run_id, error: String(r.error_message).slice(0, 300) },
      );
    }
  }

  const counts: Partial<Record<InvariantCode, number>> = {};
  for (const v of violations) counts[v.code] = (counts[v.code] ?? 0) + 1;
  return {
    generatedAt: now.toISOString(),
    profile: cfg.profile,
    thresholds,
    sourceProbed: Boolean(opts.sourceProbe),
    objectTypesChecked: types.length,
    violations,
    counts,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warn").length,
  };
}

/** S3/MinIO probe backed by storageService: HEAD-free existence check plus a
 *  bounded read (≤64 KiB) to decide whether a data row follows the header. */
export async function createStorageSourceProbe(): Promise<SourceProbe> {
  const storage = await import("../storageService");
  return {
    async probe(key: string) {
      if (!(await storage.objectExists(key))) return { exists: false, hasDataRow: false };
      const stream = await storage.getObjectStream(key);
      let buf = "";
      try {
        for await (const chunk of stream) {
          buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (buf.length >= 64 * 1024) break;
        }
      } finally {
        stream.destroy();
      }
      const lines = buf.split(/\r?\n/);
      return { exists: true, hasDataRow: lines.slice(1).some((l) => l.trim().length > 0) };
    },
  };
}
