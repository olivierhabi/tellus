// ---------------------------------------------------------------------------
// functionWorkerPool — unit tests.
//
// Covers the sync fallback (runSandboxedWithSdkSync) for correctness of output,
// edits, and error handling, plus the async API's correctness (which succeeds
// via the worker pool OR the sync fallback). The definitive "does not block
// the main event loop" proof lives in scripts/verify-function-worker.ts (run
// under tsx, where the worker is guaranteed to load).
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  runSandboxedWithSdkSync,
  runSandboxedWithSdkAsync,
  __resetPoolForTests,
} from "../../../src/services/functionWorkerPool";
import type { OntologySnapshot } from "../../../src/services/functions/ontologyRuntime";

function snapshotWith(
  rows: Array<{ type: string; pk: string; props: Record<string, unknown> }>,
): OntologySnapshot {
  const byType = new Map<string, Map<string, unknown>>();
  for (const r of rows) {
    let bucket = byType.get(r.type);
    if (!bucket) {
      bucket = new Map();
      byType.set(r.type, bucket);
    }
    bucket.set(r.pk, {
      ...r.props,
      $apiName: r.type,
      $primaryKey: r.pk,
      $title: String(r.props.title ?? r.pk),
    });
  }
  return {
    byType,
    ontologyId: "ont-1",
    objectCount: rows.length,
    objectTypes: [...byType.keys()],
  };
}

const EMPTY: OntologySnapshot = {
  byType: new Map(),
  ontologyId: "ont-1",
  objectCount: 0,
  objectTypes: [],
};

describe("runSandboxedWithSdkSync (fallback / inline)", () => {
  it("returns the function's output", () => {
    const src = `module.exports = function(input){ return input.x + 1; };`;
    const r = runSandboxedWithSdkSync(src, { x: 41 }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(42);
    expect(r.edits).toEqual([]);
  });

  it("exposes the Objects SDK (ambient + via @ontology/sdk)", () => {
    const snap = snapshotWith([
      { type: "Order", pk: "o1", props: { status: "open", amount: 10 } },
      { type: "Order", pk: "o2", props: { status: "open", amount: 20 } },
    ]);
    const src = `module.exports = function(){ return Objects.search("Order").count(); };`;
    const r = runSandboxedWithSdkSync(src, {}, snap);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(2);
  });

  it("collects side-channel edits via the Edits API", () => {
    const src = `module.exports = function(){ Edits.update("Order","o1",{status:"closed"}); return "done"; };`;
    const r = runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe("done");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ op: "update", objectType: "Order", primaryKey: "o1" });
  });

  it("surfaces a thrown error as status=error", () => {
    const src = `module.exports = function(){ throw new Error("boom"); };`;
    const r = runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("boom");
    expect(r.edits).toEqual([]);
  });

  it("rejects async functions", () => {
    const src = `module.exports = async function(){ return 1; };`;
    const r = runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toMatch(/async/i);
  });
});

describe("runSandboxedWithSdkAsync (worker pool or fallback)", () => {
  it("returns the function's output (via worker or fallback)", async () => {
    __resetPoolForTests();
    const src = `module.exports = function(input){ return input.x * 2; };`;
    const r = await runSandboxedWithSdkAsync(src, { x: 21 }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(42);
    expect(r.edits).toEqual([]);
  });

  it("collects edits across the worker boundary", async () => {
    __resetPoolForTests();
    const src = `module.exports = function(){ Edits.update("Order","o9",{status:"x"}); return 7; };`;
    const r = await runSandboxedWithSdkAsync(src, {}, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(7);
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ op: "update", objectType: "Order", primaryKey: "o9" });
  });
});
