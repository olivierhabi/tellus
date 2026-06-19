/**
 * B8 — Instrumentation wrapper for `CodexPort`.
 *
 * Records `tellus_quiver_ts_hydration_seconds{state}`,
 * `tellus_quiver_ts_buckets_returned`,
 * `tellus_quiver_ts_event_detection_seconds`,
 * `tellus_quiver_ts_hydration_timeouts_total`.
 */

import type { CodexPort } from "./codexPort";
import {
  tsBucketsReturned,
  tsEventDetectionSeconds,
  tsHydrationSeconds,
  tsHydrationTimeoutsTotal,
} from "../../metrics";
import { HydrationTokenExpiredError } from "./codexPort";

export function instrumentCodexPort(inner: CodexPort): CodexPort {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      return async (...args: any[]) => {
        const op = String(prop);
        const start = process.hrtime.bigint();
        try {
          const result = await (orig as Function).apply(target, args);
          const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
          if (op === "getSeries") {
            const state = (result as any).kind === "warm" ? "warm" : "cold";
            tsHydrationSeconds.observe({ state }, elapsedSec);
            if ((result as any).kind === "warm") {
              tsBucketsReturned.observe(((result as any).data?.points?.length ?? 0) as number);
            }
          }
          if (op === "pollHydration" && (result as any).kind === "ready") {
            tsHydrationSeconds.observe({ state: "cold" }, elapsedSec);
            tsBucketsReturned.observe(((result as any).data?.points?.length ?? 0) as number);
          }
          if (op === "aggregateSeries") {
            tsBucketsReturned.observe(((result as any)?.points?.length ?? 0) as number);
          }
          if (op === "detectEvents") {
            tsEventDetectionSeconds.observe(elapsedSec);
          }
          return result;
        } catch (e) {
          if (e instanceof HydrationTokenExpiredError) tsHydrationTimeoutsTotal.inc();
          throw e;
        }
      };
    },
  });
}
