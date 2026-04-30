// ---------------------------------------------------------------------------
// ClickHouse bootstrap — Task B10
//
// On server boot, scan `link_type` in Postgres and ensure a corresponding
// `link_<source>__<link>__<target>` MergeTree table exists in ClickHouse.
// The ingest path (Kafka CDC → ClickHouse Kafka engine) is a deployment
// concern — this module only owns DDL for the target tables so traversal
// queries have something to aim at the moment a link_type is registered.
//
// Entirely best-effort: if ClickHouse is unreachable, we log and move on;
// the server keeps serving. A later `/api/v1/funnel/clickhouse/refresh`
// call will retry.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  ensureLinkTable,
  ensureLinkIngestTopology,
  LinkTypeDescriptor,
} from "../searchAround/linkMaterializedView";
import { getClickHouseClient } from "../searchAround/clickhouseClient";

export interface BootstrapResult {
  linkTypesFound: number;
  tablesEnsured: number;
  skippedUnreachable: boolean;
  errors: Array<{ link: string; message: string }>;
}

export async function ensureLinkTablesForAllLinkTypes(): Promise<BootstrapResult> {
  const errors: BootstrapResult["errors"] = [];
  const linkTypes = await loadLinkTypes();

  if (linkTypes.length === 0) {
    return {
      linkTypesFound: 0,
      tablesEnsured: 0,
      skippedUnreachable: false,
      errors: [],
    };
  }

  const reachable = await isClickHouseReachable();
  if (!reachable) {
    return {
      linkTypesFound: linkTypes.length,
      tablesEnsured: 0,
      skippedUnreachable: true,
      errors: [],
    };
  }

  const ch = getClickHouseClient();
  const kafkaBrokers = process.env.KAFKA_BROKERS;
  let ensured = 0;
  for (const link of linkTypes) {
    try {
      if (kafkaBrokers) {
        // Full CDC topology: target MergeTree + Kafka engine + MV.
        // Writing to the Kafka topic `cdc.links.<source>.<link>` on
        // Redpanda is enough to land rows in ClickHouse. If the Kafka
        // engine DDL fails (broker unreachable from ClickHouse's
        // perspective), fall back to the bare table so manual inserts
        // still work.
        try {
          await ensureLinkIngestTopology(link, ch);
        } catch (err) {
          console.warn(
            `[clickhouse-bootstrap] Kafka ingest DDL failed for ${link.linkName}, falling back to bare table: ${(err as Error).message}`
          );
          await ensureLinkTable(link, ch);
        }
      } else {
        await ensureLinkTable(link, ch);
      }
      ensured++;
    } catch (err) {
      errors.push({
        link: `${link.sourceObjectType}__${link.linkName}__${link.targetObjectType}`,
        message: (err as Error).message,
      });
    }
  }

  return { linkTypesFound: linkTypes.length, tablesEnsured: ensured, skippedUnreachable: false, errors };
}

// Query Postgres for the set of registered link types. The Tellus schema
// stores the link type's endpoints as UUIDs to `object_type.object_type_id`
// so we join back to resolve human-readable api names.
async function loadLinkTypes(): Promise<LinkTypeDescriptor[]> {
  try {
    const res = await query(
      `SELECT lt.api_name AS link_name,
              src.api_name AS source_api,
              tgt.api_name AS target_api
         FROM link_type lt
         JOIN object_type src ON src.object_type_id = lt.source_object_type
         JOIN object_type tgt ON tgt.object_type_id = lt.target_object_type`
    );
    return res.rows.map((r: { link_name: string; source_api: string; target_api: string }) => ({
      linkName: r.link_name,
      sourceObjectType: r.source_api,
      targetObjectType: r.target_api,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Transitional deployments: the migration hasn't created the table yet.
    if (/relation .*link_type.* does not exist/i.test(msg)) return [];
    // Shutdown race: the `void (async …)()` at boot was still running when
    // `shutdown()` called `pool.end()`. Treat this as a clean no-op — the
    // bootstrap will re-run on next boot via the same loop. Throwing
    // here just pollutes logs with a scary stacktrace during nodemon
    // restarts and does nothing useful.
    if (/pool after calling end on the pool|Pool is ending|cannot use a pool/i.test(msg)) {
      return [];
    }
    throw err;
  }
}

let lastProbe = 0;
let lastOk = false;

export async function isClickHouseReachable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbe < 5_000) return lastOk;
  lastProbe = now;
  const base = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`${base}/ping`, { signal: ctrl.signal });
    clearTimeout(tid);
    const body = await res.text();
    lastOk = res.ok && body.trim() === "Ok.";
  } catch {
    lastOk = false;
  }
  return lastOk;
}
