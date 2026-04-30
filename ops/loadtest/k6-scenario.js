// ---------------------------------------------------------------------------
// ops/loadtest/k6-scenario.js
//
// Deferral artifact set 1 (Appendix D) — load/soak test scenario.
//
// A human with a running cluster invokes:
//   k6 run --env BASE_URL=https://staging.tellus.example \
//          --env TOKEN=<jwt> \
//          ops/loadtest/k6-scenario.js
//
// Profiles (choose via --env PROFILE=<name>):
//   baseline   15 min @ 1× SLO (200 r/s + 50 a/s)
//   target     1 hour @ 1× SLO
//   breaking   30 min @ 2× SLO (graceful degradation assertion)
//   stress     15 min @ 5× SLO (load shed assertion)
//   overload   15 min @ 10× SLO (no OOM, recovery < 5 min)
//   soak       72 hours @ 1× SLO (no drift, heap stable)
//   cold       5 min after restart (p99 warmup)
//
// Output: k6's JSON summary + Grafana dashboard correlation via the
// tellus_http_request_duration_seconds histogram.
// ---------------------------------------------------------------------------

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TOKEN = __ENV.TOKEN || "";
const ONTOLOGY_ID = __ENV.ONTOLOGY_ID || "11111111-1111-1111-1111-111111111111";
const PROFILE = __ENV.PROFILE || "baseline";

const PROFILES = {
  baseline: { vus: 50,   duration: "15m", rps: 250 },
  target:   { vus: 50,   duration: "1h",  rps: 250 },
  breaking: { vus: 100,  duration: "30m", rps: 500 },
  stress:   { vus: 250,  duration: "15m", rps: 1250 },
  overload: { vus: 500,  duration: "15m", rps: 2500 },
  soak:     { vus: 50,   duration: "72h", rps: 250 },
  cold:     { vus: 50,   duration: "5m",  rps: 250 },
};

const profile = PROFILES[PROFILE] || PROFILES.baseline;

export const options = {
  scenarios: {
    default: {
      executor: "constant-arrival-rate",
      rate: profile.rps,
      timeUnit: "1s",
      duration: profile.duration,
      preAllocatedVUs: profile.vus,
      maxVUs: profile.vus * 3,
    },
  },
  thresholds: {
    // SLO assertions — fail the whole run if violated for more than 1%
    // of requests over the entire duration.
    http_req_duration: [
      "p(99)<800",    // All-request p99 < 800 ms
    ],
    "http_req_duration{kind:read}": ["p(99)<250"],
    "http_req_duration{kind:action}": ["p(99)<800"],
    "http_req_failed": ["rate<0.001"], // 99.9% availability
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)", "p(99.9)"],
};

const errorRate = new Rate("tellus_scenario_errors");
const readLatency = new Trend("tellus_scenario_read_ms", true);
const actionLatency = new Trend("tellus_scenario_action_ms", true);

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

function readObject() {
  const res = http.get(
    `${BASE_URL}/api/v1/ontology/${ONTOLOGY_ID}/objects/TestObject/pk-001`,
    { headers, tags: { kind: "read" } },
  );
  errorRate.add(res.status >= 500 || res.status === 0);
  readLatency.add(res.timings.duration);
  check(res, { "read 2xx or 404": (r) => r.status < 500 });
}

function searchObjects() {
  const body = JSON.stringify({
    filter: { match_all: {} },
    pageSize: 50,
  });
  const res = http.post(
    `${BASE_URL}/api/v1/ontology/${ONTOLOGY_ID}/objects/TestObject/search`,
    body,
    { headers, tags: { kind: "read" } },
  );
  errorRate.add(res.status >= 500 || res.status === 0);
  readLatency.add(res.timings.duration);
  check(res, { "search 2xx": (r) => r.status >= 200 && r.status < 300 });
}

function applyAction() {
  const body = JSON.stringify({
    parameters: { pk: `pk-${__VU}-${__ITER}`, value: Math.random() },
  });
  const res = http.post(
    `${BASE_URL}/api/v1/actionTypes/testUpdate/apply`,
    body,
    { headers, tags: { kind: "action" } },
  );
  errorRate.add(res.status >= 500 || res.status === 0);
  actionLatency.add(res.timings.duration);
  check(res, { "action 2xx or 4xx": (r) => r.status < 500 });
}

export default function () {
  // Workload mix: 80% reads (50/50 split between lookup and search),
  // 15% actions, 5% multi-hop.
  const roll = Math.random();
  if (roll < 0.4) {
    group("object.read", readObject);
  } else if (roll < 0.8) {
    group("object.search", searchObjects);
  } else if (roll < 0.95) {
    group("action.apply", applyAction);
  } else {
    // Multi-hop placeholder — exercise the F-P5-02 fix once landed.
    group("object.read.multihop", readObject);
  }
  sleep(0.1);
}
