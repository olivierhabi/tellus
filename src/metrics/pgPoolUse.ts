// ---------------------------------------------------------------------------
// src/metrics/pgPoolUse.ts
//
// F-P4-16 closure — PG pool USE (Utilization/Saturation/Errors) metrics.
//
// Previous state: `db.ts` exposed `pool.totalCount`, `pool.idleCount`,
// `pool.waitingCount` via the /health endpoint but NOT as Prometheus
// gauges. Operators could not alert on pool saturation; F-P5-06 (pool
// exhaustion under 2+ K8s replicas) was undetectable until it
// cascaded into 503s.
//
// This module samples the pool at 1 s cadence and emits:
//   - tellus_pg_pool_total{pool}      gauge
//   - tellus_pg_pool_idle{pool}       gauge
//   - tellus_pg_pool_active{pool}     gauge
//   - tellus_pg_pool_waiting{pool}    gauge
//   - tellus_pg_pool_saturation{pool} gauge  (waiting / max)
//
// pool label distinguishes the 3 PG pools: main, foundry, worker. Each
// is registered separately via registerPoolMetrics(pool, label).
// ---------------------------------------------------------------------------

import { setGauge } from "../services/funnel/metrics";

interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options?: { max?: number };
}

const registered = new Map<string, PoolLike>();
let timer: ReturnType<typeof setInterval> | null = null;
const SAMPLE_INTERVAL_MS = 1000;

/**
 * Register a PG pool for metric collection. Called from db.ts and
 * foundryDb.ts after pool construction. Idempotent per label.
 */
export function registerPoolMetrics(pool: PoolLike, label: string): void {
  registered.set(label, pool);
  if (timer === null) startSampler();
}

function sample(): void {
  for (const [label, pool] of registered) {
    const total = pool.totalCount ?? 0;
    const idle = pool.idleCount ?? 0;
    const active = total - idle;
    const waiting = pool.waitingCount ?? 0;
    const max = pool.options?.max ?? 0;
    const saturation = max > 0 ? waiting / max : 0;
    try {
      setGauge("tellus_pg_pool_total", total, { pool: label });
      setGauge("tellus_pg_pool_idle", idle, { pool: label });
      setGauge("tellus_pg_pool_active", active, { pool: label });
      setGauge("tellus_pg_pool_waiting", waiting, { pool: label });
      setGauge("tellus_pg_pool_saturation", saturation, { pool: label });
    } catch {
      // metrics unavailable — silent
    }
  }
}

function startSampler(): void {
  if (timer !== null) return;
  timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopPoolMetricsSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
