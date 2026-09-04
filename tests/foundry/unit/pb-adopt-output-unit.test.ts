// ---------------------------------------------------------------------------
// Foundry parity — "Overwrite dataset" (ownership grant).
//
// Doc (pipeline-builder/outputs-add-dataset-output):
//   "### Overwrite dataset
//    A one time action that grants ownership of an existing dataset to a new
//    output in Pipeline Builder. Note that this action may require additional
//    actions outside of Pipeline Builder."
//
// Acceptance: a recreated output node can reclaim an orphaned dataset instead
// of forking a new one; the action requires explicit confirmation; a dataset
// owned by another active output is rejected; the adoption is audit-logged.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

const auditWrite = vi.fn(async () => "audit-row-id");
vi.mock("../../../src/services/audit", () => ({
  AuditWriter: class {},
  auditWriter: { write: auditWrite },
}));

import { PipelineService } from "../../../src/services/pipelineService";
import { AppError } from "../../../src/utils/foundryAppError";

const PROJECT = "22222222-2222-2222-2222-222222222222";
const PIPELINE = "a74ac39b-a0d1-4ea0-9b3c-cf16917417cf";
const NODE = "ff51bebc-2790-4bc8-8610-06f8fbdc6f52";
const ORPHAN = "cdb81fc0-7f8e-4ee4-b2cb-3d17e61de155";
const OTHER_NODE = "ab09c019-7c63-4237-87a5-40570bac7f52";
const OTHER_PROJECT = "99999999-9999-9999-9999-999999999999";

interface Call {
  table: string;
  method: string;
  payload?: unknown;
}

/**
 * Chainable thenable knex stub. `.first()` and `await builder` consume the
 * next queued response; `.update(payload)` records and resolves 1.
 */
function stubKnex(queue: unknown[]) {
  const calls: Call[] = [];
  const knex = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["where", "whereNot", "whereNotIn", "whereNull", "orWhereNull"]) {
      chain[m] = () => chain;
    }
    chain.whereNotExists = () => chain;
    chain.select = () => chain;
    chain.first = async () => {
      if (queue.length === 0) throw new Error(`stub: no response queued for ${table}`);
      return queue.shift();
    };
    chain.update = (payload: unknown) => {
      calls.push({ table, method: "update", payload });
      return Promise.resolve(1);
    };
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (queue.length === 0) return Promise.reject(new Error(`stub: no response queued for ${table}`)).then(resolve, reject);
      return Promise.resolve(queue.shift()).then(resolve, reject);
    };
    return chain;
  };
  return { knex, calls };
}

function service(queue: unknown[]) {
  const stub = stubKnex(queue);
  return { svc: new PipelineService(stub.knex as never), calls: stub.calls };
}

describe("adoptOutputDataset", () => {
  const baseArgs = { datasetId: ORPHAN, confirm: true };

  it("requires explicit confirmation (one-time action)", async () => {
    const { svc } = service([]);
    let err: AppError | undefined;
    try {
      await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, { ...baseArgs, confirm: false }, "u1");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(400);
    expect(err!.code).toBe("CONFIRMATION_REQUIRED");
    expect(err!.message).toContain("confirm");
  });

  it("rejects non-output nodes", async () => {
    const { svc } = service([
      { id: PIPELINE }, // ensurePipelineExists
      { id: NODE, node_type: "union", config: {} },
    ]);
    let err: AppError | undefined;
    try {
      await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(400);
    expect(err!.message).toContain("output");
  });

  it("404s with Foundry errorName DatasetNotFound on a missing RID", async () => {
    const { svc } = service([
      { id: PIPELINE },
      { id: NODE, node_type: "output", label: "Fraud Signal", config: {} },
      undefined, // dataset lookup
    ]);
    let err: AppError | undefined;
    try {
      await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(404);
    expect(err!.errorName).toBe("DatasetNotFound");
  });

  it("refuses a dataset from another project (403)", async () => {
    const { svc } = service([
      { id: PIPELINE },
      { id: NODE, node_type: "output", label: "Fraud Signal", config: {} },
      { id: ORPHAN, name: "Fraud Signal", project_id: OTHER_PROJECT },
    ]);
    let err: AppError | undefined;
    try {
      await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(403);
  });

  it("rejects a dataset owned by another ACTIVE output (409 OUTPUT_OWNERSHIP_CONFLICT)", async () => {
    const { svc } = service([
      { id: PIPELINE },
      { id: NODE, node_type: "output", label: "Fraud Signal", config: {} },
      { id: ORPHAN, name: "Fraud Signal", project_id: PROJECT },
      [{ id: OTHER_NODE, pipeline_id: PIPELINE }], // owners scan
    ]);
    let err: AppError | undefined;
    try {
      await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");
    } catch (e) {
      err = e as AppError;
    }
    expect(err!.statusCode).toBe(409);
    expect(err!.code).toBe("OUTPUT_OWNERSHIP_CONFLICT");
    expect(err!.errorName).toBe("OutputOwnershipConflict");
    expect(err!.message).toContain(OTHER_NODE);
    expect(err!.parameters).toMatchObject({ ownerNodeId: OTHER_NODE, datasetId: ORPHAN });
  });

  it("grants ownership: wires outputDatasetId, stamps adoption, audit-logs (ALLOW)", async () => {
    const stub = stubKnex([
      { id: PIPELINE },
      { id: NODE, node_type: "output", label: "Fraud Signal", config: { foo: 1 }, dataset_id: null },
      { id: ORPHAN, name: "Fraud Signal", project_id: PROJECT },
      [], // no other owners
    ]);
    auditWrite.mockClear();
    const svc = new PipelineService(stub.knex as never);

    const result = await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");

    expect(result.datasetId).toBe(ORPHAN);
    expect(result.previousOutputDatasetId).toBeNull();
    expect(result.adoptedAt).toBeTruthy();

    const update = stub.calls.find((c) => c.method === "update");
    expect(update).toBeTruthy();
    const payload = update!.payload as { dataset_id: string; config: string };
    expect(payload.dataset_id).toBe(ORPHAN);
    const cfg = JSON.parse(payload.config);
    // Subsequent deploys key off cfg.outputDatasetId — the fork is impossible.
    expect(cfg.outputDatasetId).toBe(ORPHAN);
    expect(cfg.foo).toBe(1); // pre-existing config preserved
    expect(cfg.adoptedBy).toBe("u1");

    expect(auditWrite).toHaveBeenCalledTimes(1);
    const event = auditWrite.mock.calls[0]![0] as {
      operationId: string;
      decision: string;
      resourceRid: string;
      metadata: Record<string, unknown>;
    };
    expect(event.operationId).toBe("pipeline.output.adopt_dataset");
    expect(event.decision).toBe("ALLOW");
    expect(event.resourceRid).toBe(`ri.compass.main.foundry-dataset.${ORPHAN}`);
    expect(event.metadata).toMatchObject({
      projectId: PROJECT,
      pipelineId: PIPELINE,
      nodeId: NODE,
      datasetId: ORPHAN,
      previousOutputDatasetId: null,
    });
  });

  it("relinquishes the node's previous output dataset (reported in the result + audit)", async () => {
    const PREV = "de965e8b-0626-4ebe-86c6-5cd4487f78cc";
    const stub = stubKnex([
      { id: PIPELINE },
      { id: NODE, node_type: "output", label: "Fraud Signal", config: { outputDatasetId: PREV }, dataset_id: PREV },
      { id: ORPHAN, name: "Fraud Signal", project_id: PROJECT },
      [],
    ]);
    auditWrite.mockClear();
    const svc = new PipelineService(stub.knex as never);

    const result = await svc.adoptOutputDataset(PROJECT, PIPELINE, NODE, baseArgs, "u1");
    expect(result.previousOutputDatasetId).toBe(PREV);
    const event = auditWrite.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(event.metadata.previousOutputDatasetId).toBe(PREV);
  });
});
