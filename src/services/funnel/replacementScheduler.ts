// ---------------------------------------------------------------------------
// Replacement pipeline scheduler — Task B9
//
// Background loop that drives the dual-index cutover state machine end-
// to-end without manual intervention:
//
//   REPLACEMENT_SOAK → evaluateSoak() → cutover() → CUTOVER_COMPLETE
//   CUTOVER_COMPLETE → after old_index_retained_until → finalizeCutover()
//                                                    → OLD_INDEX_DROPPED
//
// Also:
//   - Records soak attempts (success + reason) via recordSoakEvaluation()
//     so an on-call engineer can see WHY a flip didn't fire.
//   - Surfaces every state transition via the existing /replacement/:ot
//     GET endpoint (versionManager writes the same rows).
//
// The scheduler is idempotent — multiple instances running concurrently
// coordinate via `FOR UPDATE SKIP LOCKED` inside versionManager.cutover()
// so duplicate flips are impossible.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { evaluateSoak, SoakVerdict } from "../quickwit/replacement/soakMonitor";
import {
  beginReplacementBackfill,
  cutover,
  finalizeCutover,
  getActiveVersion,
} from "../quickwit/replacement/versionManager";
import {
  AUTO_TRIGGER_THRESHOLD,
  shouldTriggerReplacementForVolume,
} from "../quickwit/replacement/schemaChangeDetector";

export interface SchedulerOptions {
  intervalMs?: number;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startReplacementScheduler(options: SchedulerOptions = {}): void {
  if (timer) return;
  const intervalMs = options.intervalMs ?? 60_000; // 1 minute default.
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      console.warn(`[replacement/scheduler] tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopReplacementScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Exposed for unit tests and the /replacement/scheduler-tick endpoint. */
export async function tick(): Promise<SchedulerTickResult> {
  const result: SchedulerTickResult = {
    evaluated: 0,
    cutoverCount: 0,
    finalizedCount: 0,
    autoTriggered: 0,
    verdicts: [],
  };

  // --- Stage 0: auto-trigger scan — Palantir's >80% heuristic ------------
  // We look for LIVE object types whose latest changelog emission touched
  // more than AUTO_TRIGGER_THRESHOLD of the merged table and promote them
  // to a replacement backfill. Without this the orchestrator never
  // auto-starts — only manual `POST /replacement/:ot/start` does.
  try {
    result.autoTriggered += await autoTriggerVolumeReplacements();
  } catch (err) {
    console.warn(
      `[replacement/scheduler] auto-trigger scan failed: ${(err as Error).message}`
    );
  }

  // --- Stage 1: REPLACEMENT_SOAK → evaluate gate → cutover ----------------
  const soaking = await query(
    `SELECT object_type_api_name
       FROM object_type_active_index_version
      WHERE state = 'REPLACEMENT_SOAK'`
  );
  for (const row of soaking.rows as Array<{ object_type_api_name: string }>) {
    result.evaluated++;
    try {
      const verdict = await evaluateSoak(row.object_type_api_name);
      result.verdicts.push({ objectType: row.object_type_api_name, verdict });
      await recordSoakEvaluation(row.object_type_api_name, verdict);
      if (verdict.eligible) {
        await cutover(row.object_type_api_name);
        result.cutoverCount++;
      }
    } catch (err) {
      console.warn(
        `[replacement/scheduler] evaluate/cutover ${row.object_type_api_name}: ${(err as Error).message}`
      );
    }
  }

  // --- Stage 2: CUTOVER_COMPLETE past retention → drop old ----------------
  const dueForDrop = await query(
    `SELECT object_type_api_name
       FROM object_type_active_index_version
      WHERE state = 'CUTOVER_COMPLETE'
        AND old_index_retained_until IS NOT NULL
        AND old_index_retained_until <= now()`
  );
  for (const row of dueForDrop.rows as Array<{ object_type_api_name: string }>) {
    try {
      await finalizeCutover(row.object_type_api_name);
      result.finalizedCount++;
    } catch (err) {
      console.warn(
        `[replacement/scheduler] finalize ${row.object_type_api_name}: ${(err as Error).message}`
      );
    }
  }

  return result;
}

export interface SchedulerTickResult {
  evaluated: number;
  cutoverCount: number;
  finalizedCount: number;
  autoTriggered: number;
  verdicts: Array<{ objectType: string; verdict: SoakVerdict }>;
}

async function autoTriggerVolumeReplacements(): Promise<number> {
  // Per object type: compare the most recent changelog emission (from
  // the watermark table B4 populates) against the current merged row
  // count. If rowsChanged/totalRows > 80% AND the OT is currently LIVE,
  // kick off a replacement pipeline. Requires the merged table to have
  // a row count — we read it from object_instances which is the B1
  // system of record.
  const candidates = await query(
    `SELECT ot.api_name                 AS object_type_api_name,
            COALESCE(w.last_rows_emitted, 0)::bigint AS rows_changed,
            (SELECT COUNT(*)::bigint FROM object_instances oi
              WHERE oi.object_type_api_name = ot.api_name)
                                        AS total_rows,
            COALESCE(v.state, 'LIVE')   AS state
       FROM object_type ot
       LEFT JOIN LATERAL (
         SELECT last_rows_emitted
           FROM funnel_changelog_watermark fw
          WHERE fw.object_type_api_name = ot.api_name
          ORDER BY fw.last_run_at DESC
          LIMIT 1
       ) w ON TRUE
       LEFT JOIN object_type_active_index_version v
              ON v.object_type_api_name = ot.api_name`
  );
  let triggered = 0;
  for (const row of candidates.rows as Array<{
    object_type_api_name: string;
    rows_changed: number | string | null;
    total_rows: number | string | null;
    state: string;
  }>) {
    if (row.state !== "LIVE" && row.state !== "CUTOVER_COMPLETE") continue;
    const rowsChanged = Number(row.rows_changed ?? 0);
    const totalRows = Number(row.total_rows ?? 0);
    if (totalRows <= 0 || rowsChanged <= 0) continue;
    const verdict = shouldTriggerReplacementForVolume({ rowsChanged, totalRows });
    if (!verdict.shouldTrigger) continue;
    try {
      await beginReplacementBackfill(row.object_type_api_name);
      console.info(
        `[replacement/scheduler] auto-trigger ${row.object_type_api_name}: ` +
          `${verdict.ratio.toFixed(3)} > ${AUTO_TRIGGER_THRESHOLD}`
      );
      triggered++;
    } catch (err) {
      const msg = (err as Error).message;
      // Already in replacement — not a failure.
      if (!/already/i.test(msg) && !/pending/i.test(msg)) {
        console.warn(
          `[replacement/scheduler] auto-trigger ${row.object_type_api_name}: ${msg}`
        );
      }
    }
  }
  return triggered;
}

async function recordSoakEvaluation(
  objectTypeApiName: string,
  verdict: SoakVerdict
): Promise<void> {
  // The replacement_diff_log is shared across observations + verdicts —
  // we encode verdict as a pseudo-observation with an empty query hash
  // and diff_count=0/total_hits=0, distinguished by query_body.type.
  // This gives the on-call a single table to look at.
  try {
    await query(
      `INSERT INTO replacement_diff_log
         (object_type_api_name, old_version, new_version,
          query_hash, query_body, diff_count, total_hits)
       SELECT $1, active_version, pending_version,
              'scheduler-verdict',
              $2::jsonb, 0, 0
         FROM object_type_active_index_version
        WHERE object_type_api_name = $1
        LIMIT 1`,
      [
        objectTypeApiName,
        JSON.stringify({
          type: "soak-verdict",
          eligible: verdict.eligible,
          reason: verdict.reason,
          diff_rate: verdict.diffRate,
          observations: verdict.totalObservations,
        }),
      ]
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Helper for tests + the `/replacement/:ot/force-cutover` endpoint:
 * try the gate ONCE and return the verdict without actually doing the
 * cutover. Callers decide whether to proceed based on `eligible`.
 */
export async function previewCutover(
  objectTypeApiName: string
): Promise<{ verdict: SoakVerdict; active: Awaited<ReturnType<typeof getActiveVersion>> }> {
  const [verdict, active] = await Promise.all([
    evaluateSoak(objectTypeApiName),
    getActiveVersion(objectTypeApiName),
  ]);
  return { verdict, active };
}
