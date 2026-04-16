/**
 * /api/metrics — Prometheus exposition endpoint.
 *
 * Implements the Action Type "Near Real-Time Metrics" feature (#35) with
 * a tiny in-process counter store. No external metric SDK so the route
 * stays dependency-free; the format matches Prometheus 0.0.4 text
 * exposition spec verbatim.
 */

import { Router, Request, Response } from 'express';

interface CounterMap {
  [key: string]: number;
}

// Ontology Platform spec §2.6 metric names (seconds-based histograms, not ms).
// Legacy names retained as aliases so existing callers continue to work.
const counters: CounterMap = {
  http_requests_total: 0,
  ontology_http_requests_total: 0,
  ontology_actions_applied_total: 0,
  ontology_action_executions_total: 0,
  ontology_edits_total: 0,
  ontology_objects_indexed_total: 0,
  ontology_funnel_documents_indexed_total: 0,
  ontology_funnel_pk_violations_total: 0,
  ontology_search_queries_total: 0,
};

const histograms: { [name: string]: number[] } = {
  http_request_duration_ms: [],
  ontology_action_duration_ms: [],
  // Spec §2.6 canonical names
  ontology_http_request_duration_seconds: [],
  ontology_search_query_duration_seconds: [],
  ontology_funnel_pipeline_duration_seconds: [],
  ontology_action_execution_duration_seconds: [],
};

// Gauges — process/cluster state metrics.
const gauges: CounterMap = {
  ontology_funnel_pipeline_status: 0,
  ontology_kafka_consumer_lag: 0,
  ontology_es_cluster_health: 1,
};

export function setGauge(name: string, value: number): void {
  gauges[name] = value;
}

export function incrementCounter(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function observeHistogram(name: string, value: number): void {
  if (!histograms[name]) histograms[name] = [];
  histograms[name].push(value);
  // Keep at most the last 1000 samples to bound memory.
  if (histograms[name].length > 1000) {
    histograms[name] = histograms[name].slice(-1000);
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

const router = Router();

router.get('/metrics', (_req: Request, res: Response) => {
  const lines: string[] = [];
  lines.push('# HELP tellus_info Tellus build info');
  lines.push('# TYPE tellus_info gauge');
  lines.push('tellus_info{version="0.3.0"} 1');

  for (const [name, value] of Object.entries(counters)) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }
  for (const [name, samples] of Object.entries(histograms)) {
    if (samples.length === 0) continue;
    const sum = samples.reduce((a, b) => a + b, 0);
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}{quantile="0.5"} ${samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.5)]}`);
    lines.push(`${name}{quantile="0.95"} ${p95(samples)}`);
    lines.push(`${name}_sum ${sum}`);
    lines.push(`${name}_count ${samples.length}`);
  }

  for (const [name, value] of Object.entries(gauges)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  // ---------------------------------------------------------------------
  // Process / runtime gauges — match the names emitted by the official
  // `prom-client` library so existing dashboards work unchanged.
  // ---------------------------------------------------------------------
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const uptime = process.uptime();
  lines.push('# HELP process_resident_memory_bytes Resident set size in bytes');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);
  lines.push('# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds');
  lines.push('# TYPE process_cpu_user_seconds_total counter');
  lines.push(`process_cpu_user_seconds_total ${(cpu.user / 1e6).toFixed(6)}`);
  lines.push('# HELP process_cpu_system_seconds_total Total system CPU time spent in seconds');
  lines.push('# TYPE process_cpu_system_seconds_total counter');
  lines.push(`process_cpu_system_seconds_total ${(cpu.system / 1e6).toFixed(6)}`);
  lines.push('# HELP process_uptime_seconds Number of seconds the process has been running');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${uptime.toFixed(3)}`);
  lines.push('# HELP nodejs_heap_size_used_bytes Process heap used in bytes');
  lines.push('# TYPE nodejs_heap_size_used_bytes gauge');
  lines.push(`nodejs_heap_size_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP nodejs_heap_size_total_bytes Process heap total in bytes');
  lines.push('# TYPE nodejs_heap_size_total_bytes gauge');
  lines.push(`nodejs_heap_size_total_bytes ${mem.heapTotal}`);
  lines.push('# HELP nodejs_external_memory_bytes V8 external memory in bytes');
  lines.push('# TYPE nodejs_external_memory_bytes gauge');
  lines.push(`nodejs_external_memory_bytes ${mem.external}`);
  lines.push('# HELP nodejs_eventloop_lag_seconds Approximate event-loop lag');
  lines.push('# TYPE nodejs_eventloop_lag_seconds gauge');
  lines.push(`nodejs_eventloop_lag_seconds 0`);

  res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

export default router;
