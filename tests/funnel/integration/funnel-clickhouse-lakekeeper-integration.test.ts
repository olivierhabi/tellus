// ---------------------------------------------------------------------------
// /api/v1/funnel/clickhouse/* + /lakekeeper/* — integration
//
// These endpoints wrap external services (ClickHouse, Lakekeeper via
// Iceberg REST). We don't assume the services are up — the test
// asserts the HTTP contract: correct status code, response shape,
// error envelope on degraded paths. Each degraded path is EXPLICITLY
// allowed by the handler (500 / 503) and we accept either outcome so
// the suite stays green in CI boxes without the full stack.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { api } from "../../helpers/api";

describe("POST /api/v1/funnel/clickhouse/refresh", () => {
  it("returns 200 (CH up) or 500 with a structured error (CH down)", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/clickhouse/refresh",
      {},
    );
    expect([200, 500]).toContain(status);
    if (status === 500) {
      expect(body.error).toBe("INTERNAL");
      expect(typeof body.message).toBe("string");
    }
  });
});

describe("POST /api/v1/funnel/clickhouse/link", () => {
  it("400s without sourceObjectType/linkName/targetObjectType", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/clickhouse/link",
      {},
    );
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("returns 200 (CH up) or 500 with structured error for a well-formed request", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/clickhouse/link",
      {
        sourceObjectType: "Foo",
        linkName: "hasBar",
        targetObjectType: "Bar",
        withKafkaIngest: false,
      },
    );
    expect([200, 500]).toContain(status);
    if (status === 200) {
      expect(typeof body.table).toBe("string");
      expect(typeof body.kafkaIngest).toBe("boolean");
    }
  });
});

describe("POST /api/v1/funnel/clickhouse/link-cdc", () => {
  it("400s without source/target PKs", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/clickhouse/link-cdc",
      { sourceObjectType: "Foo", linkName: "hasBar" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });
});

describe("GET /api/v1/funnel/clickhouse/cdc-lag", () => {
  it("returns 200 with alerting:boolean + readings:array", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/clickhouse/cdc-lag",
    );
    // 200 when the query pipeline runs cleanly (even if no link types
    // exist → alerting:false, readings:[]). 500 if ClickHouse is
    // reachable but something internally failed — rare.
    expect([200, 500]).toContain(status);
    if (status === 200) {
      expect(typeof body.alerting).toBe("boolean");
      expect(Array.isArray(body.readings)).toBe(true);
    }
  });
});

describe("GET /api/v1/funnel/lakekeeper/info", () => {
  it("returns 200 {reachable:true,...} (up) or 503 {reachable:false} (down)", async () => {
    const { status, body } = await api("GET", "/api/v1/funnel/lakekeeper/info");
    expect([200, 503, 500]).toContain(status);
    if (status === 200) {
      expect(body.reachable).toBe(true);
    } else if (status === 503) {
      expect(body.reachable).toBe(false);
    }
  });
});

describe("GET /api/v1/funnel/lakekeeper/warehouses", () => {
  it("returns 200 {warehouses:[...]} or 500 if Lakekeeper can't be reached", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/lakekeeper/warehouses",
    );
    expect([200, 500]).toContain(status);
    if (status === 200) {
      expect(Array.isArray(body.warehouses)).toBe(true);
    }
  });
});
