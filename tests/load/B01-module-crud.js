// B01 — k6 load test for module CRUD.
//
// Targets: GET /modules/{rid} P95 ≤ 180ms, PUT /modules/{rid} P95 ≤ 250ms.
// Each VU bootstraps once, then alternates GET → PUT → GET against the
// same rid (with the new ETag fed forward). 50 VUs for 60s.

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";

import {
  BASE,
  authHeaders,
  bootstrapModule,
  ensureEnv,
} from "./_helpers.js";

ensureEnv(["WORKSHOP_BASE_URL", "WORKSHOP_JWT", "WORKSHOP_FOLDER_RID", "WORKSHOP_ONTOLOGY_RID"]);

export const options = {
  vus: 50,
  duration: "60s",
  thresholds: {
    "module_get_seconds": ["p(50)<0.09", "p(95)<0.18", "p(99)<0.36"],
    "module_put_seconds": ["p(50)<0.12", "p(95)<0.25", "p(99)<0.5"],
    "checks{tag:status}": ["rate>0.99"],
  },
};

const tGet = new Trend("module_get_seconds", true);
const tPut = new Trend("module_put_seconds", true);

export function setup() {
  return bootstrapModule(`load-B01-${Date.now()}`);
}

export default function ({ rid, etag }) {
  let curEtag = etag;

  group("GET /modules/{rid}", () => {
    const t0 = Date.now();
    const r = http.get(`${BASE}/api/v1/workshop/modules/${encodeURIComponent(rid)}`, {
      headers: authHeaders(),
    });
    tGet.add((Date.now() - t0) / 1000);
    check(r, { "GET 200": (x) => x.status === 200 }, { status: "ok" });
    if (r.status === 200) {
      curEtag = r.headers["Etag"] || r.headers["ETag"] || curEtag;
    }
  });

  group("PUT /modules/{rid}", () => {
    const body = JSON.stringify({
      definition: {
        schemaVersion: 1,
        header: { title: `iter-${__VU}-${__ITER}`, icon: null, color: null },
        sections: [{ id: "s_root", type: "horizontal", children: [] }],
        layout: { rootSection: "s_root" },
      },
    });
    const t0 = Date.now();
    const r = http.put(`${BASE}/api/v1/workshop/modules/${encodeURIComponent(rid)}`, body, {
      headers: authHeaders({ "If-Match": curEtag }),
    });
    tPut.add((Date.now() - t0) / 1000);
    if (r.status === 200) {
      curEtag = r.headers["Etag"] || r.headers["ETag"] || curEtag;
    }
    // 412 is acceptable under contention — the spec says exactly one wins
    // per ETag generation. Count both as success-shaped.
    check(r, { "PUT 200|412": (x) => x.status === 200 || x.status === 412 }, { status: "ok" });
  });

  sleep(0.05);
}
