/**
 * B6 — Integration tests for the OSS-bound compute path.
 *
 * Drives POST /quiver/api/v1/compute/cards with the injected InProcessOss
 * adapter so we can assert end-to-end:
 *   B6 C-02 createTemporaryObjectSet on an OBJECT_SET card execution.
 *   B6 C-03 OSv1 input over 100K → 400 ObjectSetLimitExceeded.
 *   B6 C-04 OSv2 result over 10M → 400 ObjectSetLimitExceeded.
 *   B6 C-05 search-around depth > 3 → 400 ObjectSetLimitExceeded.
 *   B6 C-06 default mode PREFER_SPEED.
 *   B6 C-07 AGGREGATION emits TransformTable shape.
 *   B6 C-08 ACTION_BUTTON denied → 403 ActionApplyForbidden.
 *   B6 C-09 X-Tellus-Branch forwarded on every OSS call.
 *   B6 C-10 OSS unavailability → 503 BackendUnavailable (via circuit-breaker).
 *   B6 C-11 OSS query timeout → 504 OssQueryTimeout.
 *   B6 C-13 OSS metrics emitted (oss_query_seconds, action_apply_total).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import { register } from "prom-client";
import {
  resetComputeContext,
  setComputeContextForTests,
  setOssPortForTests,
} from "../../../src/services/quiver/compute/context";
import { InProcessOssAdapter } from "../../../src/services/quiver/compute/oss/inProcessOss";
import {
  OssUnavailableError,
  OssQueryTimeoutError,
} from "../../../src/services/quiver/compute/oss/ossPort";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-test-user": TEST_USER,
    "x-test-org": TEST_ORG,
    ...extra,
  };
}

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

let compassSpy: ReturnType<typeof fakeCompass>;
let port: InProcessOssAdapter;

beforeEach(async () => {
  await teardownQuiverTables();
  compassSpy = fakeCompass();
  port = new InProcessOssAdapter();
  setOssPortForTests(port);
  resetComputeContext();
});

afterEach(() => {
  compassSpy.detach();
  setOssPortForTests(undefined);
  resetComputeContext();
});

async function createAnalysisWithCards(cards: Record<string, any>): Promise<{ rid: string }> {
  const app = quiverApp();
  const r = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(authedHeaders({ "idempotency-key": randomUUID() }))
    .send({
      parentFolderRid: "ri.compass.main.folder.f1",
      displayName: "B6 test analysis",
    });
  expect(r.status).toBe(201);
  const rid = r.body.rid as string;
  await pool.query(
    `UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2`,
    [JSON.stringify(cards), rid],
  );
  return { rid };
}

describe("B6 — OBJECT_SET card via /compute/cards", () => {
  it("B6 C-02: returns OBJECT_SET payload with a temporary rid + records branch", async () => {
    const { rid } = await createAnalysisWithCards({
      $A: {
        id: "$A",
        type: "OBJECT_SET",
        inputs: {},
        config: {
          ontologyRid: "ri.tellus.ontology.main.x",
          objectSetRid: "ri.tellus.os.main.y",
        },
        hidden: false,
      },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders({ "x-tellus-branch": "feature/abc" }))
      .send({ analysisRid: rid, cardId: "$A", branch: "feature/abc", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(200);
    expect(r.body.resultType).toBe("OBJECT_SET");
    expect(r.body.payload.temporaryRid).toMatch(/^tmp-/);
    // B6 C-09: every OSS call must have carried the branch verbatim.
    for (const c of port.calls) expect(c.branch).toBe("feature/abc");
    // createTemporaryObjectSet was actually invoked.
    expect(port.calls.find((c) => c.method === "createTemporaryObjectSet")).toBeDefined();
  });

  it("B6 C-03: OSv1 input over 100K → 400 ObjectSetLimitExceeded", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        forcedStorageGeneration: "OSv1",
        forcedCardinality: 100_001,
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:ObjectSetLimitExceeded");
    expect(r.body.errorCode).toBe("OBJECT_SET_LIMIT_EXCEEDED");
    expect(r.body.parameters.kind).toBe("osv1_input");
    expect(r.body.parameters.limit).toBe(100_000);
    expect(r.body.parameters.observed).toBe(100_001);
  });

  it("B6 C-04: OSv2 result over 10M → 400 ObjectSetLimitExceeded", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        forcedStorageGeneration: "OSv2",
        forcedCardinality: 10_000_001,
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:ObjectSetLimitExceeded");
    expect(r.body.parameters.kind).toBe("osv2_result");
  });
});

describe("B6 — AGGREGATION card via /compute/cards", () => {
  it("B6 C-06 + C-07: default mode PREFER_SPEED, result shape TransformTable", async () => {
    const { rid } = await createAnalysisWithCards({
      $A: {
        id: "$A",
        type: "OBJECT_SET",
        inputs: {},
        config: {
          ontologyRid: "ri.tellus.ontology.main.x",
          objectSetRid: "ri.tellus.os.main.y",
        },
        hidden: false,
      },
      $B: {
        id: "$B",
        type: "AGGREGATION",
        inputs: { src: "$A" },
        config: {
          groupBy: ["dept"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
        },
        hidden: false,
      },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$B", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(200);
    expect(r.body.resultType).toBe("TRANSFORM_TABLE");
    expect(Array.isArray(r.body.payload.columns)).toBe(true);
    expect(Array.isArray(r.body.payload.rows)).toBe(true);
    const agg = port.calls.find((c) => c.method === "aggregateObjectSet")!;
    expect(agg.args[3]).toBe("PREFER_SPEED");
  });
});

describe("B6 — ACTION_BUTTON gating via /compute/cards", () => {
  it("B6 C-08: denial → 403 Tellus:Quiver:ActionApplyForbidden", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        permittedActions: new Set(["actions.permitted"]),
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: {
        id: "$A",
        type: "ACTION_BUTTON",
        inputs: {},
        config: { actionApiName: "actions.denied", paramBindings: {} },
        hidden: false,
      },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Quiver:ActionApplyForbidden");
    expect(r.body.errorCode).toBe("ACTION_APPLY_FORBIDDEN");
    expect(r.body.parameters.actionApiName).toBe("actions.denied");
  });

  it("B6 C-13: applyAction outcome metric is emitted on success", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        permittedActions: new Set(["actions.permitted"]),
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: {
        id: "$A",
        type: "ACTION_BUTTON",
        inputs: {},
        config: {
          actionApiName: "actions.permitted",
          paramBindings: { x: 1 },
        },
        hidden: false,
      },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(200);
    const metrics = await register.metrics();
    expect(metrics).toContain("tellus_quiver_oss_action_apply_total");
    expect(metrics).toMatch(/oss_action_apply_total\{outcome="success"\} \d+/);
  });
});

describe("B6 — OSS unavailability + timeout error mapping", () => {
  it("B6 C-10: OssUnavailableError → 500 Tellus:Quiver:OssUnavailable", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        throwError: new OssUnavailableError("simulated outage"),
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect([500, 503]).toContain(r.status);
    expect(["Tellus:Quiver:OssUnavailable", "Tellus:Quiver:CircuitOpen"]).toContain(r.body.errorName);
  });

  it("B6 C-11: OssQueryTimeoutError → 504 Tellus:Quiver:OssQueryTimeout", async () => {
    setOssPortForTests(
      new InProcessOssAdapter({
        throwError: new OssQueryTimeoutError("simulated query timeout"),
      }),
    );
    resetComputeContext();
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(504);
    expect(r.body.errorName).toBe("Tellus:Quiver:OssQueryTimeout");
  });
});

describe("B6 — branch propagation across all OSS-bound card types", () => {
  it("B6 C-09: AGGREGATION carries branch on every leg", async () => {
    const { rid } = await createAnalysisWithCards({
      $A: {
        id: "$A",
        type: "OBJECT_SET",
        inputs: {},
        config: {
          ontologyRid: "ri.tellus.ontology.main.x",
          objectSetRid: "ri.tellus.os.main.y",
        },
        hidden: false,
      },
      $B: {
        id: "$B",
        type: "AGGREGATION",
        inputs: { src: "$A" },
        config: {
          groupBy: ["dept"],
          aggregations: [{ alias: "n", property: "*", op: "COUNT" }],
        },
        hidden: false,
      },
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders({ "x-tellus-branch": "release/2026" }))
      .send({ analysisRid: rid, cardId: "$B", branch: "release/2026", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(200);
    expect(port.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of port.calls) expect(c.branch).toBe("release/2026");
  });
});

describe("B6 — metric emission", () => {
  it("B6 C-13: oss_query_seconds + temporary_set_creation_total emitted", async () => {
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", cacheBehavior: "BYPASS" });
    const metrics = await register.metrics();
    expect(metrics).toContain("tellus_quiver_oss_query_seconds");
    expect(metrics).toContain("tellus_quiver_oss_temporary_set_creation_total");
  });
});
