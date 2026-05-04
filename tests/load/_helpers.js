// Shared helpers for the workshop k6 scripts.
//
// These are intentionally simple — k6 has no node ecosystem; everything
// is plain ES module-style JS that the k6 runtime understands.

import http from "k6/http";
import { fail } from "k6";

export const BASE = __ENV.WORKSHOP_BASE_URL || "http://localhost:3000";
export const JWT = __ENV.WORKSHOP_JWT || "";
export const FOLDER = __ENV.WORKSHOP_FOLDER_RID || "";
export const ONTOLOGY = __ENV.WORKSHOP_ONTOLOGY_RID || "";

export function ensureEnv(required) {
  for (const name of required) {
    if (!__ENV[name]) {
      fail(
        `${name} env var is required. See tests/load/README.md for setup.`,
      );
    }
  }
}

export function authHeaders(extra) {
  return Object.assign(
    { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json" },
    extra || {},
  );
}

export function uuidv4() {
  // k6 has no node:crypto; small RFC4122 v4 from Math.random.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function freshIdempotencyHeaders() {
  return authHeaders({ "Idempotency-Key": uuidv4() });
}

// Bootstrap a module so module-bound load scripts have something to point
// at. Returns { rid, etag }.
export function bootstrapModule(displayName) {
  const r = http.post(
    `${BASE}/api/v1/workshop/modules:bootstrap`,
    JSON.stringify({
      parentFolderRid: FOLDER,
      ontologyRid: ONTOLOGY,
      displayName,
    }),
    { headers: freshIdempotencyHeaders() },
  );
  if (r.status !== 201) {
    fail(`bootstrap failed: ${r.status} ${r.body}`);
  }
  const body = JSON.parse(r.body);
  return { rid: body.rid, etag: r.headers["Etag"] || r.headers["ETag"] || "" };
}

// Default thresholds match the spec's §B01..§B10 P95 targets. Override
// per-script when needed.
export function p95Threshold(seconds) {
  return [
    `p(50)<${seconds * 1000}`,
    `p(95)<${seconds * 1000}`,
    `p(99)<${seconds * 1000 * 2}`,
  ];
}
