// ---------------------------------------------------------------------------
// Soak-monitor — Task B9
//
// Gates the cutover step. A cutover is approved iff:
//
//   1. the Object Type is in state REPLACEMENT_SOAK
//   2. the soak window (soak_days) has elapsed since `soak_started_at`
//   3. the aggregate shadow-diff rate over the window is ≤ diff_rate_threshold
//
// This module computes (2) and (3) from the `replacement_diff_log`. The
// actual state transition is performed by versionManager.cutover() once
// the soak monitor returns `eligible: true`.
// ---------------------------------------------------------------------------

import { query } from "../../../db";
import { getActiveVersion, ActiveIndexRecord } from "./versionManager";

export interface SoakVerdict {
  eligible: boolean;
  reason: string;
  diffRate: number;
  totalObservations: number;
  observedWindowMs: number;
  requiredWindowMs: number;
  threshold: number;
}

export async function evaluateSoak(
  objectTypeApiName: string,
  now: Date = new Date()
): Promise<SoakVerdict> {
  const record = await getActiveVersion(objectTypeApiName);
  if (!record) {
    return failed("no active-version record found", 0);
  }
  if (record.state !== "REPLACEMENT_SOAK") {
    return failed(`state is ${record.state}, not REPLACEMENT_SOAK`, record.diffRateThreshold);
  }
  if (!record.soakStartedAt) {
    return failed("soak_started_at is null", record.diffRateThreshold);
  }
  const observedMs = now.getTime() - record.soakStartedAt.getTime();
  const requiredMs = record.soakDays * 86_400_000;
  const { diffRate, totalObservations } = await computeDiffRate(record);

  if (observedMs < requiredMs) {
    return {
      eligible: false,
      reason: `soak window not yet elapsed: ${fmtDays(observedMs)} / ${record.soakDays}d`,
      diffRate,
      totalObservations,
      observedWindowMs: observedMs,
      requiredWindowMs: requiredMs,
      threshold: record.diffRateThreshold,
    };
  }
  if (totalObservations === 0) {
    return {
      eligible: false,
      reason: "no shadow-query observations recorded",
      diffRate,
      totalObservations,
      observedWindowMs: observedMs,
      requiredWindowMs: requiredMs,
      threshold: record.diffRateThreshold,
    };
  }
  if (diffRate > record.diffRateThreshold) {
    return {
      eligible: false,
      reason: `diff rate ${diffRate.toExponential(2)} exceeds threshold ${record.diffRateThreshold}`,
      diffRate,
      totalObservations,
      observedWindowMs: observedMs,
      requiredWindowMs: requiredMs,
      threshold: record.diffRateThreshold,
    };
  }
  return {
    eligible: true,
    reason: `diff rate ${diffRate.toExponential(2)} ≤ ${record.diffRateThreshold}, soak complete`,
    diffRate,
    totalObservations,
    observedWindowMs: observedMs,
    requiredWindowMs: requiredMs,
    threshold: record.diffRateThreshold,
  };
}

async function computeDiffRate(
  record: ActiveIndexRecord
): Promise<{ diffRate: number; totalObservations: number }> {
  if (!record.soakStartedAt || record.pendingVersion === null) {
    return { diffRate: 0, totalObservations: 0 };
  }
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS observations,
              COALESCE(SUM(diff_count), 0)::int AS diffs,
              COALESCE(SUM(total_hits), 0)::int AS totals
         FROM replacement_diff_log
        WHERE object_type_api_name = $1
          AND old_version = $2
          AND new_version = $3
          AND recorded_at >= $4`,
      [
        record.objectTypeApiName,
        record.activeVersion,
        record.pendingVersion,
        record.soakStartedAt.toISOString(),
      ]
    );
    const row = res.rows[0];
    const observations = Number(row.observations ?? 0);
    const diffs = Number(row.diffs ?? 0);
    const totals = Number(row.totals ?? 0);
    return {
      totalObservations: observations,
      diffRate: totals > 0 ? diffs / totals : 0,
    };
  } catch {
    return { diffRate: 0, totalObservations: 0 };
  }
}

function fmtDays(ms: number): string {
  const days = ms / 86_400_000;
  return days >= 1 ? `${days.toFixed(1)}d` : `${(ms / 3600_000).toFixed(1)}h`;
}

function failed(reason: string, threshold: number): SoakVerdict {
  return {
    eligible: false,
    reason,
    diffRate: 0,
    totalObservations: 0,
    observedWindowMs: 0,
    requiredWindowMs: 0,
    threshold,
  };
}
