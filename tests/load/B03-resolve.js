// B03 — k6 load test for /resolve/{latest,dev}.
// Target: P95 ≤ 80ms with the in-process TTL cache warm.

import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";
import {
  BASE,
  authHeaders,
  bootstrapModule,
  ensureEnv,
  freshIdempotencyHeaders,
  uuidv4,
} from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT", "WORKSHOP_FOLDER_RID", "WORKSHOP_ONTOLOGY_RID"]);

export const options = {
  vus: 80,
  duration: "30s",
  thresholds: {
    "resolve_latest_seconds": ["p(50)<0.04", "p(95)<0.08", "p(99)<0.2"],
    "resolve_dev_seconds": ["p(50)<0.06", "p(95)<0.15", "p(99)<0.3"],
  },
};

const tLatest = new Trend("resolve_latest_seconds", true);
const tDev = new Trend("resolve_dev_seconds", true);
const cMiss = new Counter("resolve_misses");

export function setup() {
  const m = bootstrapModule(`load-B03-${Date.now()}`);
  // Publish v0.0.1 so /resolve/latest has something to return.
  const r = http.post(
    `${BASE}/api/v1/workshop/modules/${encodeURIComponent(m.rid)}:publish`,
    JSON.stringify({ semver: "0.0.1", notes: "k6 load test" }),
    { headers: freshIdempotencyHeaders() },
  );
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`B03 publish failed: ${r.status} ${r.body}`);
  }
  return m;
}

export default function ({ rid }) {
  {
    const t0 = Date.now();
    const r = http.get(`${BASE}/api/v1/workshop/modules/${encodeURIComponent(rid)}/resolve/latest`, {
      headers: authHeaders(),
    });
    tLatest.add((Date.now() - t0) / 1000);
    check(r, { "latest 200": (x) => x.status === 200 });
  }
  {
    const t0 = Date.now();
    const r = http.get(`${BASE}/api/v1/workshop/modules/${encodeURIComponent(rid)}/resolve/dev`, {
      headers: authHeaders(),
    });
    tDev.add((Date.now() - t0) / 1000);
    check(r, { "dev 200": (x) => x.status === 200 });
  }
  // Use uuidv4 to keep the linter happy without firing a metric.
  if (uuidv4().length === 0) cMiss.add(1);
}
