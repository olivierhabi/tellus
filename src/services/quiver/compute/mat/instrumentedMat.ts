/**
 * B7 — Instrumentation wrapper for `MatPort`.
 *
 * Records `tellus_quiver_mat_compute_seconds{tier,operation}`,
 * `tellus_quiver_mat_input_rows{percentile}` (sampled), and
 * `tellus_quiver_mat_iceberg_snapshot_age_seconds`.
 *
 * Tier-selection counters are emitted from the backend (see matBackend.ts)
 * because the wrapper does not know the chosen tier ahead of execute.
 */

import type { MatPort } from "./matPort";
import {
  matComputeSeconds,
  matInputRows,
  matIcebergSnapshotAgeSeconds,
} from "../../metrics";

export function instrumentMatPort(inner: MatPort): MatPort {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      return async (...args: any[]) => {
        const op = String(prop);
        const start = process.hrtime.bigint();
        const result = await (orig as Function).apply(target, args);
        const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
        if (op === "polarsExecute") matComputeSeconds.observe({ tier: "polars", operation: tagFor(op) }, elapsedSec);
        if (op === "sparkExecute")  matComputeSeconds.observe({ tier: "spark",  operation: tagFor(op) }, elapsedSec);
        if (op === "polarsExecute" || op === "sparkExecute") {
          const rows = (result?.rows?.length ?? 0) as number;
          if (rows > 0) matInputRows.observe(rows);
        }
        if (op === "pinSnapshots") {
          // age-since-pin is 0 at pin time; the cache row will compute drift.
          matIcebergSnapshotAgeSeconds.observe(0);
        }
        return result;
      };
    },
  });
}

function tagFor(op: string): string {
  // Subsumed by the backend's per-card-type op label; kept here for the
  // direct port-level metric so we still capture wall time when the
  // backend is bypassed.
  if (op === "polarsExecute" || op === "sparkExecute") return "execute";
  return op;
}
