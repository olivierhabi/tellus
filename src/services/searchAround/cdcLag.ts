// ---------------------------------------------------------------------------
// Per-link-type CDC lag — Task B10
//
// Each link materialized view is fed from a Kafka topic. If the ClickHouse
// Kafka engine falls behind (consumer lag), the materialized view desyncs
// from the source of truth. The B10 SLO:
//
//   alert when cdc_lag_seconds > 30s for any link type
//
// The lag metric we track here is `now - max(source_ts)` per link table.
// source_ts is the producer-side timestamp of the record (carried through
// the Kafka message). If the lag exceeds 30s and the link table has rows
// at all, we flag `alerting=true` and the health endpoint fires.
// ---------------------------------------------------------------------------

import { ClickHouseClient, getClickHouseClient } from "./clickhouseClient";
import {
  LinkTypeDescriptor,
  linkTableName,
} from "./linkMaterializedView";

export interface CdcLagReading {
  linkType: LinkTypeDescriptor;
  table: string;
  rowCount: number;
  maxSourceTsMs: number | null;
  lagSeconds: number | null;
  alerting: boolean;
}

export const CDC_LAG_ALERT_SECONDS = 30;

export async function readCdcLag(
  link: LinkTypeDescriptor,
  client: ClickHouseClient = getClickHouseClient(),
  now: Date = new Date()
): Promise<CdcLagReading> {
  const table = linkTableName(link);
  const rows = await client
    .exec<{ rc: string; ts: string | null }>(
      `SELECT count()::String AS rc, toString(max(source_ts)) AS ts FROM ${table}`
    )
    .catch(() => [{ rc: "0", ts: null }]);
  const first = rows[0] ?? { rc: "0", ts: null };
  const rowCount = Number(first.rc ?? 0);
  const maxSourceTsMs = first.ts ? new Date(first.ts).getTime() : null;
  const lagSeconds =
    maxSourceTsMs === null ? null : Math.max(0, (now.getTime() - maxSourceTsMs) / 1000);
  const alerting = lagSeconds !== null && rowCount > 0 && lagSeconds > CDC_LAG_ALERT_SECONDS;
  return { linkType: link, table, rowCount, maxSourceTsMs, lagSeconds, alerting };
}

export async function readAllCdcLag(
  links: LinkTypeDescriptor[],
  client: ClickHouseClient = getClickHouseClient()
): Promise<CdcLagReading[]> {
  const out: CdcLagReading[] = [];
  for (const link of links) {
    out.push(await readCdcLag(link, client));
  }
  return out;
}
