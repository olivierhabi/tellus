// B10 — chaos: stale-object scenarios.
//
// Spec §B10 acceptance + Forbidden Behaviors:
//   - Apply against a stale object MUST fail with 409
//     `Tellus:Workshop:ActionStaleObject`.
//   - Client MUST NOT auto-retry — surface the envelope, do not set a
//     Retry-After or any retry signal.
//   - The validate path MUST NOT incidentally fire stale-object errors;
//     stale-object is exclusive to mutation.
//
// We exercise this by installing a `WorkshopActionsAdapter` that throws
// `StaleObjectError` from `apply()` and a benign result from `validate()`.
// The route layer is hit via supertest so we observe the wire-level
// envelope, status code, and the absence of any retry hint header.
//
// Contract IDs:
//   B10 chaos C-01 — apply with stale object → 409 Tellus:Workshop:ActionStaleObject
//   B10 chaos C-02 — envelope echoes expectedVersion + actualVersion
//   B10 chaos C-03 — response carries no Retry-After header (no auto-retry)
//   B10 chaos C-04 — validate path is unaffected by the stale-object adapter
//   B10 chaos C-05 — counterStaleObject metric is incremented exactly once

import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

import workshopModulesRouter from "../../../src/routes/workshopModules";
import {
  setActions,
  StaleObjectError,
  type WorkshopActionsAdapter,
  type ActionApplyRequest,
} from "../../../src/services/workshop/actionsAdapter";
import { counterStaleObject } from "../../../src/services/workshop/metrics";

let app: Express;
let prevAdapter: WorkshopActionsAdapter | null = null;

const stalePayload = {
  ontologyRid: "ri.ontology.main.ontology.b10c1a05-0000-0000-0000-000000000001",
  actionTypeApiName: "assignOrder",
  parameters: { assignee: "user:olivier", status: "assigned" },
};

const validatePayload = {
  ontologyRid: "ri.ontology.main.ontology.b10c1a05-0000-0000-0000-000000000001",
  actionTypeApiName: "assignOrder",
  parameters: { assignee: "user:olivier", status: "assigned" },
};

class StaleApplyAdapter implements WorkshopActionsAdapter {
  readonly applyCalls: ActionApplyRequest[] = [];
  readonly validateCalls: ActionApplyRequest[] = [];
  async validate(req: ActionApplyRequest) {
    this.validateCalls.push(req);
    return { valid: true as const, errors: [] };
  }
  async apply(req: ActionApplyRequest): Promise<never> {
    this.applyCalls.push(req);
    throw new StaleObjectError("Order", "80060", "v1", "v2");
  }
}

beforeAll(() => {
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-stale" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterEach(() => {
  if (prevAdapter) {
    setActions(prevAdapter);
    prevAdapter = null;
  }
});

async function getMetric(): Promise<number> {
  // counterStaleObject is a Prometheus Counter; .get() returns
  // { values: [{ value, labels }] } across the registry.
  const m = await counterStaleObject.get();
  return m.values[0]?.value ?? 0;
}

describe("B10 chaos — stale-object", () => {
  it(
    "B10 chaos C-01/C-02/C-03: apply with stale object → 409 envelope, no Retry-After",
    async () => {
      const adapter = new StaleApplyAdapter();
      prevAdapter = setActions(adapter);

      const r = await request(app)
        .post("/api/v1/workshop/actions/_apply")
        .set("Idempotency-Key", randomUUID())
        .send(stalePayload);

      expect(r.status).toBe(409);
      expect(r.body.errorName).toBe("Tellus:Workshop:ActionStaleObject");
      expect(r.body.parameters.expectedVersion).toBe("v1");
      expect(r.body.parameters.actualVersion).toBe("v2");
      expect(r.body.parameters.objectTypeApiName).toBe("Order");
      expect(r.body.parameters.primaryKey).toBe("80060");
      // Forbidden Behaviors: client MUST NOT auto-retry — server MUST NOT
      // signal "retry" via the Retry-After header.
      expect(r.headers["retry-after"]).toBeUndefined();
      // Adapter saw exactly one apply call (no automatic retry).
      expect(adapter.applyCalls).toHaveLength(1);
    },
  );

  it("B10 chaos C-04: validate path is not poisoned by stale-object adapter", async () => {
    const adapter = new StaleApplyAdapter();
    prevAdapter = setActions(adapter);

    const r = await request(app)
      .post("/api/v1/workshop/actions/_validate")
      .send(validatePayload);

    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(adapter.validateCalls).toHaveLength(1);
    // Validate MUST NOT call apply.
    expect(adapter.applyCalls).toHaveLength(0);
  });

  it(
    "B10 chaos C-05: counterStaleObject Prometheus counter increments per stale apply",
    async () => {
      const adapter = new StaleApplyAdapter();
      prevAdapter = setActions(adapter);

      const before = await getMetric();
      await request(app)
        .post("/api/v1/workshop/actions/_apply")
        .set("Idempotency-Key", randomUUID())
        .send(stalePayload);
      await request(app)
        .post("/api/v1/workshop/actions/_apply")
        .set("Idempotency-Key", randomUUID())
        .send(stalePayload);
      const after = await getMetric();

      // Every stale apply MUST bump the counter by exactly 1.
      expect(after - before).toBe(2);
    },
  );
});
