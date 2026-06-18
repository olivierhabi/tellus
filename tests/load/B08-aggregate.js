// B08 — k6 load test for POST /object-sets/_aggregate.
// Target: P95 ≤ 1s for PREFER_SPEED with bucket count ≤ 1000.

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { BASE, authHeaders, ensureEnv } from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT"]);

export const options = {
  vus: 25,
  duration: "30s",
  thresholds: {
    "aggregate_seconds": ["p(50)<0.5", "p(95)<1.0", "p(99)<2.0"],
  },
};

const t = new Trend("aggregate_seconds", true);

const PAYLOAD = JSON.stringify({
  objectTypeApiName: "order",
  filters: [],
  groupBy: { kind: "fixedWidthBuckets", propertyApiName: "daysUntilDue", bucketCount: 20 },
  aggregations: [{ kind: "count", as: "count" }],
  chartHint: { kind: "bar-xy" },
  executionMode: "PREFER_SPEED",
});

export default function () {
  const t0 = Date.now();
  const r = http.post(`${BASE}/api/v1/workshop/object-sets/_aggregate`, PAYLOAD, {
    headers: authHeaders(),
  });
  t.add((Date.now() - t0) / 1000);
  check(r, { "200": (x) => x.status === 200 });
}
