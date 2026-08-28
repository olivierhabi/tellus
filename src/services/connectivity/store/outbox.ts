// ---------------------------------------------------------------------------
// Connectivity → Compass outbox (B1).
//
// Pattern. Callers enqueue() inside the SAME transaction as the connection
// insert/update/delete. A separate poller (started via startPoller from
// server.ts) reads unclaimed (or stale-claimed) rows using
// FOR UPDATE SKIP LOCKED, dispatches to compass.client, then markDelivered.
// At-least-once delivery; Compass-side ops are idempotent.
//
// Stale-claim sweep: claimed rows older than STALE_CLAIM_MS are eligible to
// be re-claimed (worker crash detection without a separate sweep job).
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { hostname } from "node:os";
import { Counter, Histogram, register as metricsRegistry } from "prom-client";
import { pool } from "../../../db";
import * as compassClient from "../clients/compass.client";

export type OutboxOperation =
  | "registerResource"
  | "unregisterResource"
  | "renameResource";

export interface OutboxRow {
  id: number;
  connection_rid: string;
  folder_rid: string;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  attempts: number;
}

const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 32;

function getOrCreateHistogram(
  opts: ConstructorParameters<typeof Histogram>[0],
): Histogram<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(opts);
}

function getOrCreateCounter(
  opts: ConstructorParameters<typeof Counter>[0],
): Counter<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

const outboxLatency = getOrCreateHistogram({
  name: "tellus_connectivity_outbox_dispatch_duration_seconds",
  help: "Latency of a single outbox dispatch to Compass.",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  labelNames: ["operation"] as const,
});

const outboxDeliveries = getOrCreateCounter({
  name: "tellus_connectivity_outbox_deliveries_total",
  help: "Total outbox dispatches, by operation and outcome.",
  labelNames: ["operation", "result"] as const,
});

const outboxDepth = getOrCreateCounter({
  name: "tellus_connectivity_outbox_enqueued_total",
  help: "Total outbox rows enqueued, by operation.",
  labelNames: ["operation"] as const,
});

/** Enqueue an outbox row inside an existing transaction (caller's tx). */
export async function enqueue(
  client: PoolClient,
  row: {
    connectionRid: string;
    folderRid: string;
    operation: OutboxOperation;
    payload: Record<string, unknown>;
  },
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO connectivity_outbox
       (connection_rid, folder_rid, operation, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [row.connectionRid, row.folderRid, row.operation, JSON.stringify(row.payload)],
  );
  outboxDepth.labels({ operation: row.operation }).inc();
  return result.rows[0].id;
}

/**
 * Claim a batch of unclaimed (or stale-claimed) rows.
 * Uses FOR UPDATE SKIP LOCKED so multiple pollers may run safely in HA.
 */
export async function claimBatch(
  workerId: string,
  batchSize: number = BATCH_SIZE,
): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OutboxRow>(
      `WITH claim AS (
         SELECT id FROM connectivity_outbox
         WHERE delivered_at IS NULL
           AND attempts < $2
           AND (
             claimed_at IS NULL
             OR claimed_at < now() - ($3::int || ' milliseconds')::interval
           )
         ORDER BY enqueued_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       UPDATE connectivity_outbox o
          SET claimed_at = now(), claimed_by = $1
         FROM claim
        WHERE o.id = claim.id
        RETURNING o.id, o.connection_rid, o.folder_rid,
                  o.operation, o.payload, o.attempts`,
      [workerId, MAX_ATTEMPTS, STALE_CLAIM_MS, batchSize],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function markDelivered(id: number): Promise<void> {
  await pool.query(
    `UPDATE connectivity_outbox SET delivered_at = now() WHERE id = $1`,
    [id],
  );
}

export async function markFailed(id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE connectivity_outbox
        SET claimed_at = NULL,
            claimed_by = NULL,
            attempts = attempts + 1,
            last_error = $2
      WHERE id = $1`,
    [id, error.slice(0, 4000)],
  );
}

/** Dispatch a single claimed row. Compass-side ops MUST be idempotent. */
export async function dispatch(row: OutboxRow): Promise<void> {
  const stopTimer = outboxLatency
    .labels({ operation: row.operation })
    .startTimer();
  try {
    const client = await pool.connect();
    try {
      const payload = row.payload as Record<string, unknown>;
      switch (row.operation) {
        case "registerResource":
          await compassClient.registerConnectionResource(client, {
            rid: row.connection_rid,
            displayName: String(payload.displayName ?? ""),
            description: String(payload.description ?? ""),
            parentFolderRid: row.folder_rid,
            spaceRid: String(payload.spaceRid ?? ""),
            createdBy: String(payload.createdBy ?? "system"),
            metadata: (payload.metadata as Record<string, unknown>) ?? {},
          });
          break;
        case "unregisterResource":
          await compassClient.unregisterConnectionResource(
            client,
            row.connection_rid,
            String(payload.deletedBy ?? "system"),
          );
          break;
        case "renameResource":
          await compassClient.renameConnectionResource(
            client,
            row.connection_rid,
            String(payload.newDisplayName ?? ""),
            String(payload.updatedBy ?? "system"),
          );
          break;
      }
    } finally {
      client.release();
    }
    await markDelivered(row.id);
    outboxDeliveries
      .labels({ operation: row.operation, result: "ok" })
      .inc();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markFailed(row.id, msg);
    outboxDeliveries
      .labels({ operation: row.operation, result: "failure" })
      .inc();
    throw e;
  } finally {
    stopTimer();
  }
}

let pollerHandle: NodeJS.Timeout | null = null;
let pollerStopping = false;

/** Start the outbox poller. Idempotent. Call from server bootstrap. */
export function startPoller(
  workerId: string = `${hostname()}-${process.pid}`,
): void {
  if (pollerHandle !== null) return;
  pollerStopping = false;
  const tick = async (): Promise<void> => {
    try {
      const rows = await claimBatch(workerId);
      for (const row of rows) {
        if (pollerStopping) break;
        try {
          await dispatch(row);
        } catch {
          // Already accounted for via markFailed + counter.
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[connectivity_outbox] poll tick failed:", e);
    } finally {
      if (!pollerStopping) {
        pollerHandle = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };
  pollerHandle = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopPoller(): void {
  pollerStopping = true;
  if (pollerHandle !== null) {
    clearTimeout(pollerHandle);
    pollerHandle = null;
  }
}

/**
 * Self-heal dead-letter outbox rows that hit MAX_ATTEMPTS due to
 * FK violations (the `resources_created_by_fkey` bug before the
 * compass.client.ts fallback).  Resetting them to attempts=0 makes
 * the poller retry with the fixed code.  Idempotent and safe to run
 * on every boot.
 */
export async function resetDeadLetters(): Promise<number> {
  const result = await pool.query(
    `UPDATE connectivity_outbox
        SET attempts = 0,
            last_error = NULL,
            claimed_at = NULL,
            claimed_by = NULL
      WHERE delivered_at IS NULL
        AND attempts >= $1
      RETURNING id`,
    [MAX_ATTEMPTS],
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.warn(
      JSON.stringify({
        evt: "connectivity_outbox.reset_dead_letters",
        count,
      }),
    );
  }
  return count;
}

/** Test helper — drains all pending rows synchronously. */
export async function drainForTest(
  workerId: string = "test-drain",
): Promise<number> {
  let total = 0;
  while (true) {
    const rows = await claimBatch(workerId);
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await dispatch(row);
      } catch {
        // ignore; markFailed records it
      }
      total++;
    }
  }
  return total;
}
