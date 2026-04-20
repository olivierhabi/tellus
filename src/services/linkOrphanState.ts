// ---------------------------------------------------------------------------
// LT-B5 — FK orphan state + hourly scanner
//
// Replaces the silent "missing target = no link" behaviour with an
// explicit state per FK resolution:
//   resolved — target exists in the search index.
//   pending  — target missing but object_edits/link_edit has a recent
//              unindexed ADD (indexer catch-up window).
//   orphaned — target missing and no pending edit.
//
// The scanner samples source rows hourly and writes aggregate stats
// to link_orphan_stats with a Wilson 95% confidence interval so the
// UI can plot a trustworthy orphan-rate chart.
// ---------------------------------------------------------------------------

import { client as osClient } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import type { LinkTypeRow } from "../models/linkType";
import { appError } from "../utils/appError";

export type LinkResolutionState = "resolved" | "pending" | "orphaned";

export interface FKResolution {
  state: LinkResolutionState;
  target: Record<string, unknown> | null;
  orphanReason?: string;
}

interface ResolverDeps {
  getProperty: (id: string) => Promise<string>;
  getObjectType: (id: string) => Promise<string>;
}

async function loadDeps(): Promise<ResolverDeps> {
  return {
    getProperty: async (id) => {
      const r = await query(
        "SELECT api_name FROM property WHERE property_id = $1",
        [id]
      );
      if (r.rows.length === 0) {
        throw appError("PROPERTY_NOT_FOUND", `Property ${id} not found`);
      }
      return r.rows[0].api_name as string;
    },
    getObjectType: async (id) => {
      const r = await query(
        "SELECT api_name FROM object_type WHERE object_type_id = $1",
        [id]
      );
      if (r.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type ${id} not found`);
      }
      return r.rows[0].api_name as string;
    },
  };
}

async function hasPendingIndexWrite(
  ontologyId: string,
  objectTypeApiName: string,
  primaryKey: string
): Promise<boolean> {
  // B1 object_edits.applied_to_index_at (object SoR) — match by PK.
  const obj = await query(
    `SELECT 1 FROM object_edits
       WHERE ontology_id = $1
         AND object_type_api_name = $2
         AND primary_key = $3
         AND applied_to_index_at IS NULL
       LIMIT 1`,
    [ontologyId, objectTypeApiName, primaryKey]
  );
  if (obj.rows.length > 0) return true;

  // LT-B3 link_edit.applied_to_index_at — the FK target could be from a
  // link edit, not an object edit. Look for any recent unindexed add/remove
  // mentioning this PK.
  const linkRow = await query(
    `SELECT 1 FROM link_edit
       WHERE (source_primary_key = $1 OR target_primary_key = $1)
         AND applied_to_index_at IS NULL
       LIMIT 1`,
    [primaryKey]
  );
  return linkRow.rows.length > 0;
}

async function loadTarget(
  targetIndex: string,
  targetPk: string
): Promise<Record<string, unknown> | null> {
  try {
    const { body } = await osClient.get({ index: targetIndex, id: targetPk });
    return (body as any)._source as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve a FK from the given source object PK to its target, returning
 * an explicit state so the Action layer can surface a proper warning.
 */
export async function resolveFKWithState(
  linkType: LinkTypeRow,
  objectPK: string,
  direction: "forward" | "reverse",
  ontologyId: string
): Promise<FKResolution> {
  const deps = await loadDeps();
  const sourceOtApiName = await deps.getObjectType(linkType.source_object_type);
  const targetOtApiName = await deps.getObjectType(linkType.target_object_type);

  const sourceIndex = getIndexName(sourceOtApiName);
  const targetIndex = getIndexName(targetOtApiName);

  let targetPk: string | null = null;
  let targetOtForPending = targetOtApiName;

  if (direction === "forward") {
    if (linkType.source_property_id) {
      const propName = await deps.getProperty(linkType.source_property_id);
      try {
        const { body } = await osClient.get({ index: sourceIndex, id: objectPK });
        const doc = (body as any)._source as Record<string, unknown>;
        const fk = doc?.[propName];
        if (fk !== null && fk !== undefined && fk !== "") {
          targetPk = String(fk);
        }
      } catch {
        targetPk = null;
      }
      targetOtForPending = targetOtApiName;
    } else if (linkType.target_property_id) {
      // Target-side FK — forward lookup uses a term query on the target.
      const propName = await deps.getProperty(linkType.target_property_id);
      try {
        const { body } = await osClient.search({
          index: targetIndex,
          body: {
            size: 1,
            query: { term: { [`${propName}.keyword`]: objectPK } },
          },
        });
        const hits = ((body as any).hits?.hits ?? []) as Array<{ _source: Record<string, unknown> }>;
        if (hits.length > 0) {
          return { state: "resolved", target: hits[0]._source };
        }
      } catch {
        // fall through
      }
      // No hit — fall through to pending/orphan logic using `objectPK`.
      targetPk = null;
    }
  } else {
    if (linkType.target_property_id) {
      const propName = await deps.getProperty(linkType.target_property_id);
      try {
        const { body } = await osClient.get({ index: targetIndex, id: objectPK });
        const doc = (body as any)._source as Record<string, unknown>;
        const fk = doc?.[propName];
        if (fk !== null && fk !== undefined && fk !== "") {
          targetPk = String(fk);
        }
      } catch {
        targetPk = null;
      }
      targetOtForPending = sourceOtApiName;
    }
  }

  if (!targetPk) {
    return { state: "orphaned", target: null, orphanReason: "NO_FK_VALUE" };
  }

  const indexSide =
    direction === "forward" && linkType.source_property_id
      ? targetIndex
      : direction === "reverse"
        ? sourceIndex
        : targetIndex;

  const target = await loadTarget(indexSide, targetPk);
  if (target) {
    return { state: "resolved", target };
  }

  // Target missing — check pending window.
  const pending = await hasPendingIndexWrite(ontologyId, targetOtForPending, targetPk);
  return {
    state: pending ? "pending" : "orphaned",
    target: null,
    orphanReason: pending ? "PENDING_INDEXER" : "TARGET_NOT_FOUND",
  };
}

// ---------------------------------------------------------------------------
// Hourly orphan scanner
// ---------------------------------------------------------------------------

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(
  successes: number,
  trials: number,
  z = 1.96
): { lower: number; upper: number } {
  if (trials === 0) return { lower: 0, upper: 1 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  const lower = Math.max(0, (center - margin) / denom);
  const upper = Math.min(1, (center + margin) / denom);
  return { lower, upper };
}

export async function runOrphanScan(
  linkType: LinkTypeRow,
  ontologyId: string,
  sampleLimit = 100_000
): Promise<{
  sampleSize: number;
  orphanCount: number;
  pendingCount: number;
  resolvedCount: number;
  orphanRate: number;
  windowLower: number;
  windowUpper: number;
}> {
  const deps = await loadDeps();
  const sourceOtApiName = await deps.getObjectType(linkType.source_object_type);
  const sourceIndex = getIndexName(sourceOtApiName);

  let sampled: string[] = [];
  try {
    const { body } = await osClient.search({
      index: sourceIndex,
      body: {
        size: Math.min(sampleLimit, 10_000),
        _source: ["__pk"],
        query: { match_all: {} },
      } as unknown as Record<string, unknown>,
    });
    sampled = ((body as any).hits?.hits ?? []).map(
      (h: any) => String(h._source?.__pk ?? "")
    );
  } catch {
    sampled = [];
  }

  let orphan = 0;
  let pending = 0;
  let resolved = 0;

  for (const pk of sampled) {
    if (!pk) continue;
    try {
      const res = await resolveFKWithState(linkType, pk, "forward", ontologyId);
      if (res.state === "orphaned") orphan++;
      else if (res.state === "pending") pending++;
      else resolved++;
    } catch {
      // treat resolve errors as orphaned for the stats
      orphan++;
    }
  }

  const trials = orphan + pending + resolved;
  const rate = trials === 0 ? 0 : orphan / trials;
  const { lower, upper } = wilsonInterval(orphan, Math.max(trials, 1));

  await query(
    `INSERT INTO link_orphan_stats
       (link_type_id, link_type_api_name, ontology_id, sample_size,
        orphan_count, pending_count, resolved_count,
        orphan_rate, p_orphan_window_lower, p_orphan_window_upper)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      linkType.link_type_id,
      linkType.api_name,
      ontologyId,
      trials,
      orphan,
      pending,
      resolved,
      rate,
      lower,
      upper,
    ]
  );

  return {
    sampleSize: trials,
    orphanCount: orphan,
    pendingCount: pending,
    resolvedCount: resolved,
    orphanRate: rate,
    windowLower: lower,
    windowUpper: upper,
  };
}

export async function getLatestOrphanStats(
  ontologyId: string,
  linkTypeApiName: string,
  days = 30
): Promise<Array<{
  scanned_at: string;
  sample_size: number;
  orphan_count: number;
  pending_count: number;
  resolved_count: number;
  orphan_rate: number;
  p_orphan_window_lower: number;
  p_orphan_window_upper: number;
}>> {
  const result = await query(
    `SELECT scanned_at, sample_size, orphan_count, pending_count,
            resolved_count, orphan_rate,
            p_orphan_window_lower, p_orphan_window_upper
       FROM link_orphan_stats
      WHERE ontology_id = $1
        AND link_type_api_name = $2
        AND scanned_at >= now() - ($3 || ' days')::interval
      ORDER BY scanned_at DESC`,
    [ontologyId, linkTypeApiName, days]
  );
  return result.rows as Array<{
    scanned_at: string;
    sample_size: number;
    orphan_count: number;
    pending_count: number;
    resolved_count: number;
    orphan_rate: number;
    p_orphan_window_lower: number;
    p_orphan_window_upper: number;
  }>;
}

export async function listOrphans(input: {
  ontologyId: string;
  linkTypeApiName: string;
  limit?: number;
  cursor?: string;
}): Promise<{
  orphans: Array<{ source_pk: string; reason: string }>;
  nextCursor: string | null;
}> {
  // Pull a fresh sample (the stats table only keeps aggregates). This is
  // admin-only, so bounded to 1k per call.
  const r = await query(
    "SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2",
    [input.ontologyId, input.linkTypeApiName]
  );
  if (r.rows.length === 0) {
    return { orphans: [], nextCursor: null };
  }
  const linkType = r.rows[0] as LinkTypeRow;

  const deps = await loadDeps();
  const sourceOtApiName = await deps.getObjectType(linkType.source_object_type);
  const sourceIndex = getIndexName(sourceOtApiName);

  const limit = Math.min(input.limit ?? 100, 1000);
  const offset = input.cursor ? Number(Buffer.from(input.cursor, "base64").toString()) : 0;

  let pks: string[] = [];
  try {
    const { body } = await osClient.search({
      index: sourceIndex,
      body: {
        from: offset,
        size: limit,
        _source: ["__pk"],
        query: { match_all: {} },
        sort: [{ __pk: "asc" }],
      },
    });
    pks = ((body as any).hits?.hits ?? []).map((h: any) => String(h._source?.__pk ?? ""));
  } catch {
    pks = [];
  }

  const orphans: Array<{ source_pk: string; reason: string }> = [];
  for (const pk of pks) {
    const state = await resolveFKWithState(linkType, pk, "forward", input.ontologyId);
    if (state.state === "orphaned") {
      orphans.push({ source_pk: pk, reason: state.orphanReason ?? "ORPHANED" });
    }
  }

  const nextCursor =
    pks.length < limit ? null : Buffer.from(String(offset + limit)).toString("base64");
  return { orphans, nextCursor };
}
