// ---------------------------------------------------------------------------
// LT-B2 — Cardinality estimation + ClickHouse escalation
//
// Implements the "estimate first, escalate on demand" model described in
// tasks-02 §LT-B2. We reuse the existing searchAround/clickhouseClient +
// linkMaterializedView infrastructure — no parallel MVs.
// ---------------------------------------------------------------------------

import { client as osClient } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import type { LinkTypeRow } from "../models/linkType";
import { getClickHouseClient } from "./searchAround/clickhouseClient";
import { linkTableName } from "./searchAround/linkMaterializedView";
import type { ResolverConfigRow } from "../models/linkResolverConfig";

export interface CardinalityEstimate {
  estimatedPks: number;
  method: "opensearch_count" | "clickhouse_count" | "iceberg_manifest" | "skipped";
  latencyMs: number;
}

export interface EscalationMetadata {
  estimatedPks: number;
  actualPks: number;
  backendUsed: "opensearch" | "quickwit" | "clickhouse" | "iceberg";
  escalated: boolean;
  latencyMs: number;
  capApplied?: number;
}

/**
 * Estimate the number of PKs a forward resolve would return.
 *
 * For FK links we use OpenSearch _count on the source filter.
 * For M2M CSV we use a cheap cached row count.
 * For M2M Iceberg we lean on the `iceberg_table_name.row_count` manifest
 * statistic (collected into Postgres by the LT-B1 Iceberg writer).
 */
export async function estimateCardinality(
  linkType: LinkTypeRow,
  sourceFilter?: Record<string, unknown>
): Promise<CardinalityEstimate> {
  const start = Date.now();

  if (linkType.cardinality === "ONE_TO_ONE") {
    return { estimatedPks: 1, method: "skipped", latencyMs: Date.now() - start };
  }

  if (linkType.storage_backend === "iceberg" && linkType.iceberg_table_name) {
    // Manifest stats come from LT-B1's PyIceberg writer: it copies the
    // total `record_count` of the table into funnel_snapshot / the
    // manifest audit table. We consult a lightweight cache here to
    // avoid paying a DuckDB scan per estimate call.
    const { rows } = await query(
      `SELECT record_count FROM funnel_snapshot
         WHERE table_identifier = $1
         ORDER BY committed_at DESC
         LIMIT 1`,
      [linkType.iceberg_table_name]
    ).catch(() => ({ rows: [] as Array<{ record_count: number }> }));
    if (rows.length > 0) {
      return {
        estimatedPks: Number(rows[0].record_count) || 0,
        method: "iceberg_manifest",
        latencyMs: Date.now() - start,
      };
    }
  }

  // FK path — count via OpenSearch using the source-side index + filter.
  try {
    const sourceOt = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [linkType.source_object_type]
    );
    if (sourceOt.rows.length === 0) {
      return { estimatedPks: 0, method: "skipped", latencyMs: Date.now() - start };
    }
    const indexName = getIndexName(sourceOt.rows[0].api_name as string);
    const osQuery: Record<string, unknown> =
      sourceFilter && Object.keys(sourceFilter).length > 0
        ? {
            bool: {
              must: Object.entries(sourceFilter).map(([k, v]) => ({
                term: { [k.endsWith(".keyword") || k.startsWith("__") ? k : `${k}.keyword`]: v },
              })),
            },
          }
        : { match_all: {} };
    const { body } = await osClient.count({ index: indexName, body: { query: osQuery } });
    const count = (body as any).count ?? 0;
    return { estimatedPks: count, method: "opensearch_count", latencyMs: Date.now() - start };
  } catch {
    return { estimatedPks: 0, method: "skipped", latencyMs: Date.now() - start };
  }
}

export interface EscalationDecision {
  shouldEscalate: boolean;
  backend: "none" | "clickhouse" | "furnace";
  reason: string;
}

export function decideEscalation(
  estimate: CardinalityEstimate,
  config: ResolverConfigRow
): EscalationDecision {
  if (config.escalation_backend === "none") {
    return {
      shouldEscalate: false,
      backend: "none",
      reason: "escalation_disabled_by_config",
    };
  }
  if (estimate.estimatedPks <= config.escalation_threshold_pks) {
    return {
      shouldEscalate: false,
      backend: "none",
      reason: `estimate (${estimate.estimatedPks}) ≤ threshold (${config.escalation_threshold_pks})`,
    };
  }
  return {
    shouldEscalate: true,
    backend: config.escalation_backend,
    reason: `estimate (${estimate.estimatedPks}) > threshold (${config.escalation_threshold_pks})`,
  };
}

/**
 * Execute a forward traversal by querying the existing
 * `link_<src>__<link>__<tgt>` materialised view. Used by the resolver
 * when `decideEscalation` says `clickhouse`.
 *
 * Returns `null` if the MV is unavailable so the caller can fall back
 * to the OpenSearch path gracefully.
 */
export async function clickhouseForwardLookup(
  linkType: LinkTypeRow,
  sourcePks: string[],
  limit: number
): Promise<{ pks: string[]; source: "clickhouse" } | null> {
  if (sourcePks.length === 0) return { pks: [], source: "clickhouse" };
  try {
    const sourceOt = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [linkType.source_object_type]
    );
    const targetOt = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [linkType.target_object_type]
    );
    if (sourceOt.rows.length === 0 || targetOt.rows.length === 0) return null;
    const tableName = linkTableName({
      sourceObjectType: sourceOt.rows[0].api_name as string,
      linkName: linkType.api_name,
      targetObjectType: targetOt.rows[0].api_name as string,
    });
    const ch = getClickHouseClient();
    const inList = sourcePks
      .map((pk) => `'${pk.replace(/'/g, "''")}'`)
      .join(",");
    const rows = await ch.exec<{ target_pk: string }>(
      `SELECT DISTINCT target_pk FROM ${tableName}
        WHERE source_pk IN (${inList})
        LIMIT ${limit}`
    );
    return { pks: rows.map((r) => r.target_pk), source: "clickhouse" };
  } catch (err) {
    console.warn(
      `[cardinalityEstimator] clickhouse escalation failed: ${(err as Error).message}`
    );
    return null;
  }
}

export async function clickhouseReverseLookup(
  linkType: LinkTypeRow,
  targetPks: string[],
  limit: number
): Promise<{ pks: string[]; source: "clickhouse" } | null> {
  if (targetPks.length === 0) return { pks: [], source: "clickhouse" };
  try {
    const sourceOt = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [linkType.source_object_type]
    );
    const targetOt = await query(
      "SELECT api_name FROM object_type WHERE object_type_id = $1",
      [linkType.target_object_type]
    );
    if (sourceOt.rows.length === 0 || targetOt.rows.length === 0) return null;
    const tableName = linkTableName({
      sourceObjectType: sourceOt.rows[0].api_name as string,
      linkName: linkType.api_name,
      targetObjectType: targetOt.rows[0].api_name as string,
    });
    const ch = getClickHouseClient();
    const inList = targetPks
      .map((pk) => `'${pk.replace(/'/g, "''")}'`)
      .join(",");
    const rows = await ch.exec<{ source_pk: string }>(
      `SELECT DISTINCT source_pk FROM ${tableName}
        WHERE target_pk IN (${inList})
        LIMIT ${limit}`
    );
    return { pks: rows.map((r) => r.source_pk), source: "clickhouse" };
  } catch (err) {
    console.warn(
      `[cardinalityEstimator] clickhouse reverse escalation failed: ${(err as Error).message}`
    );
    return null;
  }
}
