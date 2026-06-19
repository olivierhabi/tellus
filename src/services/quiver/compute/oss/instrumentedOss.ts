/**
 * B6 — Instrumentation wrapper for OssPort.
 *
 * Records `tellus_quiver_oss_query_seconds{operation}`,
 * `tellus_quiver_oss_query_errors_total{errorCode}`,
 * `tellus_quiver_oss_temporary_set_creation_total`,
 * `tellus_quiver_oss_action_apply_total{outcome}`.
 */

import type { OssPort } from "./ossPort";
import {
  ossActionApplyTotal,
  ossQueryErrorsTotal,
  ossQuerySeconds,
  ossTemporarySetCreationTotal,
} from "../../metrics";

export function instrumentOssPort(inner: OssPort): OssPort {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      return async (...args: any[]) => {
        const operation = String(prop);
        const start = process.hrtime.bigint();
        try {
          const result = await (orig as Function).apply(target, args);
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          ossQuerySeconds.observe({ operation }, elapsedMs / 1000);
          if (operation === "createTemporaryObjectSet") {
            ossTemporarySetCreationTotal.inc();
          }
          if (operation === "applyAction") {
            const outcome = (result as any)?.outcome === "success" ? "success" : "failure";
            ossActionApplyTotal.inc({ outcome });
          }
          return result;
        } catch (e: any) {
          ossQueryErrorsTotal.inc({ errorCode: e?.code ?? "INTERNAL" });
          if (operation === "applyAction") {
            ossActionApplyTotal.inc({ outcome: "failure" });
          }
          throw e;
        }
      };
    },
  }) as OssPort;
}
