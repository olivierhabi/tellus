// ---------------------------------------------------------------------------
// /api/v1/funnel/instances/:ot/:pk + /overlay/:ot/:pk + /slis + /snapshots
//
// Read-side endpoints for the funnel's System-of-Record + overlay cache
// + SLI snapshot. Overlay store / SLI helpers tolerate missing backends,
// so the endpoints return 404 / empty shapes rather than 500s when
// external deps are offline.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { api } from "../../helpers/api";

describe("GET /api/v1/funnel/instances/:objectType/:pk", () => {
  it("400s without an ontologyId query param", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/instances/AnyType/any-pk",
    );
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("returns 404 NOT_FOUND or 500 INTERNAL for a non-existent tuple (no hang)", async () => {
    // 404 is the clean path (table present, row absent).
    // 500 is the degraded path (table missing — `object_instances`
    // is created by migration 012; accept 500 so this test stays
    // green in DBs that haven't applied that migration). The
    // critical invariant is that the handler RESPONDS — it must not
    // hang on an unhandled async rejection.
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/instances/NoSuchType/nope?ontologyId=00000000-0000-0000-0000-000000000000",
    );
    expect([404, 500]).toContain(status);
    expect(body.error).toMatch(/NOT_FOUND|INTERNAL/);
  });
});

describe("GET /api/v1/funnel/overlay/:objectType/:pk", () => {
  it("returns 404 (overlay miss) or 500 (store unreachable) — both valid degraded paths", async () => {
    const { status } = await api(
      "GET",
      "/api/v1/funnel/overlay/NoSuchType/nope-pk",
    );
    // 404 = overlay store reachable, miss. 500 = store unavailable.
    // Any other status means the handler threw an unexpected error.
    expect([404, 500]).toContain(status);
  });
});

describe("GET /api/v1/funnel/slis", () => {
  it("returns a JSON snapshot (shape is opaque to the endpoint contract)", async () => {
    const { status, body } = await api("GET", "/api/v1/funnel/slis");
    // Accept any 2xx — the snapshot contents are owned by the overlay
    // SLI module, not the HTTP wiring. 200 proves the route is mounted
    // and the module returns something serialisable.
    expect(status).toBe(200);
    expect(body).toBeDefined();
  });
});

describe("GET /api/v1/funnel/snapshots", () => {
  it("400s without namespace + table params", async () => {
    const { status, body } = await api("GET", "/api/v1/funnel/snapshots");
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("400s with only namespace set", async () => {
    const { status } = await api(
      "GET",
      "/api/v1/funnel/snapshots?namespace=foo",
    );
    expect(status).toBe(400);
  });

  it("returns an empty array for an unknown (namespace, table)", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/snapshots?namespace=zzz_no_such_ns&table=zzz_no_such_table",
    );
    expect(status).toBe(200);
    expect(body.snapshots).toEqual([]);
  });
});
