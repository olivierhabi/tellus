// B02 — k6 load test for the standalone validate endpoint.
// Target: P95 ≤ 80ms (CPU-bound).

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { BASE, authHeaders, ensureEnv } from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT"]);

export const options = {
  vus: 30,
  duration: "30s",
  thresholds: {
    "validate_seconds": ["p(50)<0.04", "p(95)<0.08", "p(99)<0.2"],
    "checks{stage:body}": ["rate>0.99"],
  },
};

const t = new Trend("validate_seconds", true);

const VALID = {
  schemaVersion: 4,
  variables: [],
  widgets: [],
  sections: [{ id: "s_root", layout: "rows", children: [] }],
  layout: { rootSection: "s_root" },
};

export default function () {
  const t0 = Date.now();
  const r = http.post(
    `${BASE}/api/v1/workshop/modules/_validate`,
    JSON.stringify({ definition: VALID }),
    { headers: authHeaders() },
  );
  t.add((Date.now() - t0) / 1000);
  check(r, { "200 valid": (x) => x.status === 200 }, { stage: "body" });
}
