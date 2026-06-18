// B10 — k6 load test for POST /actions/_validate and /actions/_apply.
// Targets: validate P95 ≤ 250ms; apply P95 ≤ 900ms.

import http from "k6/http";
import { check, group } from "k6";
import { Trend } from "k6/metrics";
import { BASE, authHeaders, ensureEnv, freshIdempotencyHeaders } from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT"]);

export const options = {
  vus: 20,
  duration: "30s",
  thresholds: {
    "validate_seconds": ["p(50)<0.12", "p(95)<0.25", "p(99)<0.5"],
    "apply_seconds": ["p(50)<0.45", "p(95)<0.9", "p(99)<2.0"],
  },
};

const tValidate = new Trend("validate_seconds", true);
const tApply = new Trend("apply_seconds", true);

const PARAMS = { assignee: "loaduser", status: "assigned" };

export default function () {
  group("validate", () => {
    const t0 = Date.now();
    const r = http.post(
      `${BASE}/api/v1/workshop/actions/_validate`,
      JSON.stringify({
        actionTypeApiName: "olivierAssignOrder",
        parameters: PARAMS,
      }),
      { headers: authHeaders() },
    );
    tValidate.add((Date.now() - t0) / 1000);
    check(r, { "validate 200": (x) => x.status === 200 });
  });

  group("apply", () => {
    const t0 = Date.now();
    const r = http.post(
      `${BASE}/api/v1/workshop/actions/_apply`,
      JSON.stringify({
        actionTypeApiName: "olivierAssignOrder",
        parameters: PARAMS,
      }),
      { headers: freshIdempotencyHeaders() },
    );
    tApply.add((Date.now() - t0) / 1000);
    // 200 (applied) or 409 IdempotencyKeyReused (server already applied)
    // are both success-shaped per F10 lifecycle. 409 ActionStaleObject
    // (per spec edge case) is success-shaped at this layer too.
    check(r, { "apply 200|409": (x) => x.status === 200 || x.status === 409 });
  });
}
