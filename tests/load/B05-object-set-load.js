// B05 — k6 load test for POST /object-sets/_load.
// Target: P95 ≤ 800ms for pageSize ≤ 1000.

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { BASE, authHeaders, ensureEnv } from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT"]);

export const options = {
  vus: 25,
  duration: "60s",
  thresholds: {
    "object_set_load_seconds": ["p(50)<0.4", "p(95)<0.8", "p(99)<1.5"],
    "checks{stage:body}": ["rate>0.99"],
  },
};

const t = new Trend("object_set_load_seconds", true);

const PAYLOAD = JSON.stringify({
  objectTypeApiName: "order",
  filters: [],
  pageSize: 500,
  executionMode: "PREFER_SPEED",
  snapshotConsistency: "READ_COMMITTED",
});

export default function () {
  const t0 = Date.now();
  const r = http.post(`${BASE}/api/v1/workshop/object-sets/_load`, PAYLOAD, {
    headers: authHeaders(),
  });
  t.add((Date.now() - t0) / 1000);
  check(r, { "200": (x) => x.status === 200 }, { stage: "body" });
}
